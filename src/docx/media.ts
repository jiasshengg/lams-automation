import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { paragraphContent, readParagraphsWithListLabels, readSOTDocxParts } from '../ae/sot-paragraphs.js';
import { readZipEntries, requireZipEntry } from './archive.js';
import { paragraphBlocks, textBoxContents, withoutCompatibilityFallback } from './blocks.js';
import {
  ANSWER_OR_RATIONALE,
  NUMBERED_STEM,
  SECTION_BOUNDARY,
  isOptionLine,
  isStructuralLine,
  numberQuestionStems,
  questionForEachParagraph
} from './question-numbering.js';

/** Where the image sits relative to its question stem in the source document. */
export type ImagePlacement = 'before' | 'after';

/**
 * Word crops a picture for display while still embedding the whole file, so the archived bytes are
 * not what the document shows. Each edge is the fraction of the original trimmed away.
 */
export interface ImageCrop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DocxImage {
  id: string;
  relationshipId: string;
  sourcePart: string;
  sourceFilename: string;
  contentType: string;
  questionNumber: number | null;
  placement: ImagePlacement;
  /** Display crop from the document, or null when the whole picture is shown. */
  crop: ImageCrop | null;
  /** Inline HTML of the caption line printed under the image, or '' when there is none. */
  caption: string;
  /**
   * Text boxes Word lays over the picture (lane markers, panel letters). They are not part of the
   * embedded file, so an upload loses them; '' when the picture has none.
   */
  overlayText: string;
  /**
   * The document prints this figure after its own question's answer key, so it illustrates the
   * rationale rather than the question. Importing it would show learners part of the answer.
   */
  afterAnswerKey: boolean;
  paragraphIndex: number;
  imageIndex: number;
  altText: string;
  widthPx: number | null;
  heightPx: number | null;
  sha256: string;
  data: Buffer;
}

export interface ExtractedDocxImage {
  id: string;
  relationshipId: string;
  sourceFilename: string;
  outputPath: string;
  contentType: string;
  questionNumber: number | null;
  placement: ImagePlacement;
  /** Display crop from the document, or null when the whole picture is shown. */
  crop: ImageCrop | null;
  caption: string;
  overlayText: string;
  afterAnswerKey: boolean;
  paragraphIndex: number;
  imageIndex: number;
  altText: string;
  widthPx: number | null;
  heightPx: number | null;
  sha256: string;
}

export interface DocxMediaManifest {
  sourceDocx: string;
  imageCount: number;
  unassignedImageIds: string[];
  images: ExtractedDocxImage[];
}

/**
 * The question each paragraph belongs to, in document order. Images and inline formatting share
 * this rule so both are assigned to the same question numbers.
 */
export function questionNumbersForParagraphs(texts: string[]): (number | null)[] {
  return questionForEachParagraph(numberQuestionStems(texts, { inferUnnumbered: true }));
}

type ReadParagraph = ReturnType<typeof paragraphContent> & { xml: string };

export function inspectDocxImages(buffer: Buffer): DocxImage[] {
  const entries = readZipEntries(buffer);
  const documentXml = requireZipEntry(entries, 'word/document.xml').toString('utf8');
  const relationships = parseRelationships(
    requireZipEntry(entries, 'word/_rels/document.xml.rels').toString('utf8')
  );
  const parts = readSOTDocxParts(buffer);
  const read = readParagraphsWithListLabels(documentXml, parts);
  const paragraphs: ReadParagraph[] = read.map(({ xml, content }) => ({ ...content, xml: withoutCompatibilityFallback(xml) }));
  const texts = read.map((paragraph) => paragraph.structureText);
  const stems = numberQuestionStems(texts, { inferUnnumbered: true });
  const images: DocxImage[] = [];
  // Images seen after a section boundary, or in the narrative leading into the next stem; they
  // illustrate the question that follows, so their number is only known once it is reached.
  const awaitingQuestion: DocxImage[] = [];
  // Images whose caption, if any, is the next paragraph that carries text.
  const awaitingCaption: DocxImage[] = [];
  let currentQuestion: number | null = null;
  let currentStem = -1;
  let imageIndex = 0;
  let sectionStarted = false;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const xml = paragraph.xml;
    const text = paragraph.text;
    if (text !== '' && paragraph.imageCount === 0) {
      const caption = isCaption(text, xml) ? withHyperlinkTargets(paragraph.html, text, xml, relationships) : '';
      for (const pending of awaitingCaption.splice(0)) pending.caption = caption;
    }
    const stem = stems[paragraphIndex];
    if (stem !== null && stem !== undefined) {
      currentQuestion = stem;
      currentStem = paragraphIndex;
    } else if (SECTION_BOUNDARY.test(text)) {
      currentQuestion = null;
      currentStem = -1;
      sectionStarted = true;
    }
    if (currentQuestion !== null && currentStem === paragraphIndex) {
      for (const pending of awaitingQuestion.splice(0)) pending.questionNumber = currentQuestion;
    }
    const leadIn = currentQuestion !== null && inNextQuestionLeadIn(texts, stems, currentStem, paragraphIndex);

    for (const picture of pictureReferences(xml)) {
      const target = relationships.get(picture.relationshipId);
      if (!target || target.external) continue;
      const sourcePart = normalizeWordTarget(target.value);
      const data = entries.get(sourcePart);
      if (!data) throw new Error(`Image relationship ${picture.relationshipId} points to missing DOCX entry ${sourcePart}.`);
      imageIndex += 1;
      const drawingXml = picture.drawingXml;
      const extent = /<wp:extent\b[^>]*\bcx=["'](\d+)["'][^>]*\bcy=["'](\d+)["']/.exec(drawingXml);
      const crop = parseSourceRectangle(picture.pictureXml);
      const docProperties = /<wp:docPr\b([^>]*)\/?>(?:<\/wp:docPr>)?/.exec(drawingXml)?.[1] ?? '';
      const altText = attribute(docProperties, 'descr') || attribute(docProperties, 'title') || '';
      const extension = path.extname(sourcePart).toLowerCase();
      const sha256 = createHash('sha256').update(data).digest('hex');
      const assigned = leadIn ? null : currentQuestion;
      const image: DocxImage = {
        id: `image-${imageIndex}`,
        relationshipId: picture.relationshipId,
        sourcePart,
        sourceFilename: path.basename(sourcePart),
        contentType: contentTypeFor(extension),
        questionNumber: assigned,
        placement: assigned === null ? 'before' : 'after',
        caption: '',
        overlayText: picture.overlayText,
        afterAnswerKey:
          !leadIn && currentStem >= 0 && texts.slice(currentStem + 1, paragraphIndex + 1).some((text) => ANSWER_OR_RATIONALE.test(text)),
        paragraphIndex,
        imageIndex,
        altText,
        crop,
        ...displaySize(picture, extent),
        sha256,
        data
      };
      images.push(image);
      awaitingCaption.push(image);
      // Before the document's first section boundary there is no question to wait
      // for, so cover art and logos stay unassigned instead of joining question 1.
      if (leadIn || (currentQuestion === null && sectionStarted)) awaitingQuestion.push(image);
    }
  });
  return images;
}

/**
 * A figure printed in the case narrative after a question has closed (its options already
 * given, then fresh prose) belongs to the next question: "You noticed this rhythm on his cardiac
 * monitoring." Nothing structural may sit between the figure and that next stem.
 */
function inNextQuestionLeadIn(
  texts: string[],
  stems: (number | null)[],
  currentStem: number,
  index: number
): boolean {
  if (currentStem < 0 || currentStem === index) return false;
  const nextStem = stems.findIndex((stem, stemIndex) => stemIndex > index && stem !== null);
  if (nextStem < 0) return false;
  if (texts.slice(index + 1, nextStem).some((text) => isStructuralLine(text))) return false;
  // The figure's own paragraph counts: a vignette can carry its figure inline.
  const before = texts.slice(currentStem + 1, index + 1);
  let lastOption = -1;
  before.forEach((text, offset) => {
    if (isOptionLine(text)) lastOption = offset;
  });
  if (lastOption < 0) return false;
  const afterOptions = before.slice(lastOption + 1);
  if (afterOptions.some((text) => ANSWER_OR_RATIONALE.test(text))) return false;
  return afterOptions.some((text) => text !== '' && !isCaption(text));
}

/**
 * A lone picture shows at the drawing's extent. A grouped one shows at its own extent in the
 * group's child coordinates, scaled by how large the whole group is drawn on the page.
 */
function displaySize(
  picture: PictureReference,
  extent: RegExpExecArray | null
): { widthPx: number | null; heightPx: number | null } {
  if (!extent) return { widthPx: null, heightPx: null };
  if (!picture.grouped) return { widthPx: emuToPixels(Number(extent[1])), heightPx: emuToPixels(Number(extent[2])) };
  const own = /<a:ext\b[^>]*\bcx=["'](\d+)["'][^>]*\bcy=["'](\d+)["']/.exec(picture.pictureXml);
  const children = /<a:chExt\b[^>]*\bcx=["'](\d+)["'][^>]*\bcy=["'](\d+)["']/.exec(picture.drawingXml);
  if (!own || !children || Number(children[1]) === 0 || Number(children[2]) === 0) return { widthPx: null, heightPx: null };
  return {
    widthPx: emuToPixels((Number(own[1]) * Number(extent[1])) / Number(children[1])),
    heightPx: emuToPixels((Number(own[2]) * Number(extent[2])) / Number(children[2]))
  };
}

interface PictureReference {
  relationshipId: string;
  /** The whole drawing, whose extent and properties describe what the page shows. */
  drawingXml: string;
  /** The picture element itself, whose crop applies to this file only. */
  pictureXml: string;
  /** One of several pictures arranged in a group, so the drawing's extent is not its own size. */
  grouped: boolean;
  overlayText: string;
}

/**
 * Every embedded picture in a paragraph. A grouped drawing can hold several pictures with text
 * boxes laid over them, and each picture is its own upload.
 */
function pictureReferences(paragraphXml: string): PictureReference[] {
  const references: PictureReference[] = [];
  for (const drawing of paragraphXml.matchAll(/<(w:drawing|w:pict)\b[^>]*>[\s\S]*?<\/\1>/g)) {
    const drawingXml = drawing[0];
    const overlayText = textBoxContents(drawingXml)
      .map((xml) => paragraphBlocks(xml).map((paragraph) => paragraphContent(paragraph).text).join(' '))
      .map((text) => text.trim())
      .filter((text) => text !== '')
      .join(' | ');
    const pictures = drawing[1] === 'w:drawing'
      ? [...drawingXml.matchAll(/<pic:pic\b[\s\S]*?<\/pic:pic>|<a:blip\b[^>]*>/g)]
      : [...drawingXml.matchAll(/<v:imagedata\b[^>]*>/g)];
    // A bare <a:blip> is counted only when no <pic:pic> wraps it, so no picture is read twice.
    const wrapped = pictures.filter((match) => match[0].startsWith('<pic:pic'));
    const chosen = wrapped.length > 0 ? wrapped : pictures;
    for (const picture of chosen) {
      const relationshipId = /(?:r:embed|r:id)=["']([^"']+)["']/.exec(picture[0])?.[1];
      if (!relationshipId) continue;
      const pictureXml = wrapped.length > 0 ? picture[0] : drawingXml;
      references.push({ relationshipId, drawingXml, pictureXml, grouped: chosen.length > 1, overlayText });
    }
  }
  return references;
}

/**
 * A figure caption is the line printed directly under the image. Question stems,
 * answer options, answer keys, rationales, and new sections all belong to the
 * document structure instead, so an image followed by one of them has no caption.
 */
export function isCaption(text: string, paragraphXml = ''): boolean {
  const structurallyPossible = (
    !NUMBERED_STEM.test(text) &&
    !SECTION_BOUNDARY.test(text) &&
    !/^[A-Z][.)]\s+\S/.test(text) &&
    !/^(?:Answer|Rationale)\b/i.test(text)
  );
  if (!structurallyPossible) return false;
  // Unlabelled iRAT options can be plain sentences, so position alone cannot prove a
  // caption. Require either Word's Caption paragraph style or a conventional visible
  // caption prefix; otherwise the first option after a figure would be duplicated under
  // the image and inside the answer list.
  const captionStyle = /<w:pStyle\b[^>]*w:val=["']Caption["']/i.test(paragraphXml);
  const captionPrefix = /^(?:fig(?:ure)?|table|chart|diagram|image|illustration)\s*(?:\d+|[A-Z])?\s*[.:-]?\s+/i.test(text);
  // A source link printed under a figure is part of it, so it travels with the image.
  const sourceLink = /<w:hyperlink\b/.test(paragraphXml) || /^https?:\/\/\S+$/i.test(text.trim());
  return captionStyle || captionPrefix || sourceLink;
}

/**
 * A Word hyperlink can show text other than its address. The address is what the reader needs, so
 * any hyperlink target the visible text does not already show is appended after it.
 */
function withHyperlinkTargets(
  html: string,
  text: string,
  paragraphXml: string,
  relationships: Map<string, { value: string; external: boolean }>
): string {
  const targets = [...paragraphXml.matchAll(/<w:hyperlink\b[^>]*\br:id=["']([^"']+)["']/g)]
    .map((match) => relationships.get(match[1]!)?.value)
    .filter((target): target is string => target !== undefined && /^https?:\/\//i.test(target) && !text.includes(target));
  return [html, ...new Set(targets)].join(' ');
}

/** `a:srcRect` edges are thousandths of a percent of the original, and default to zero. */
export function parseSourceRectangle(drawingXml: string): ImageCrop | null {
  const attributes = /<a:srcRect\b([^>]*?)\/?>/.exec(drawingXml)?.[1];
  if (attributes === undefined) return null;
  const edges = new Map<string, number>();
  for (const edge of attributes.matchAll(/\b([ltrb])=["'](-?\d+)["']/g)) {
    edges.set(edge[1]!, Number(edge[2]) / 100000);
  }
  const crop = {
    left: edges.get('l') ?? 0,
    top: edges.get('t') ?? 0,
    right: edges.get('r') ?? 0,
    bottom: edges.get('b') ?? 0
  };
  if (!Object.values(crop).some((value) => value > 0)) return null;
  if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
    throw new Error(`Image crop leaves nothing of the picture: ${JSON.stringify(crop)}`);
  }
  return crop;
}

export async function extractDocxImages(
  buffer: Buffer,
  sourceDocx: string,
  outputDirectory: string
): Promise<DocxMediaManifest> {
  const images = inspectDocxImages(buffer);
  await mkdir(outputDirectory, { recursive: true });
  const occurrenceByHash = new Map<string, number>();
  const extracted: ExtractedDocxImage[] = [];
  for (const image of images) {
    const occurrence = (occurrenceByHash.get(image.sha256) ?? 0) + 1;
    occurrenceByHash.set(image.sha256, occurrence);
    const extension = safeExtension(image.sourceFilename, image.contentType);
    const assignment = image.questionNumber === null ? 'unassigned' : `q${image.questionNumber}`;
    const filename = `${assignment}-image-${image.imageIndex}${occurrence > 1 ? `-${occurrence}` : ''}${extension}`;
    const outputPath = path.resolve(outputDirectory, filename);
    await writeFile(outputPath, image.data);
    extracted.push({
      id: image.id,
      relationshipId: image.relationshipId,
      sourceFilename: image.sourceFilename,
      outputPath,
      contentType: image.contentType,
      questionNumber: image.questionNumber,
      placement: image.placement,
      caption: image.caption,
      overlayText: image.overlayText,
      afterAnswerKey: image.afterAnswerKey,
      paragraphIndex: image.paragraphIndex,
      imageIndex: image.imageIndex,
      altText: image.altText,
      crop: image.crop,
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      sha256: image.sha256
    });
  }
  return {
    sourceDocx: path.resolve(sourceDocx),
    imageCount: extracted.length,
    unassignedImageIds: extracted.filter((image) => image.questionNumber === null).map((image) => image.id),
    images: extracted
  };
}

function parseRelationships(xml: string): Map<string, { value: string; external: boolean }> {
  const result = new Map<string, { value: string; external: boolean }>();
  for (const match of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
    const attributes = match[1] ?? '';
    const id = attribute(attributes, 'Id');
    const target = attribute(attributes, 'Target');
    if (!id || !target) continue;
    result.set(id, { value: decodeXml(target), external: attribute(attributes, 'TargetMode') === 'External' });
  }
  return result;
}

function normalizeWordTarget(target: string): string {
  const normalized = path.posix.normalize(target.startsWith('/') ? target.slice(1) : `word/${target}`);
  if (!normalized.startsWith('word/')) throw new Error(`Image relationship escapes the Word package: ${target}`);
  return normalized;
}

function attribute(xml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return decodeXml(new RegExp(`\\b${escaped}=["']([^"']*)["']`).exec(xml)?.[1] ?? '');
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function emuToPixels(value: number): number {
  return Math.round(value / 9_525);
}

function contentTypeFor(extension: string): string {
  const types: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
  };
  const type = types[extension];
  if (!type) throw new Error(`Unsupported embedded image type: ${extension || '(no extension)'}`);
  return type;
}

function safeExtension(filename: string, contentType: string): string {
  const extension = path.extname(filename).toLowerCase();
  if (extension) return extension === '.jpeg' ? '.jpg' : extension;
  return contentType === 'image/jpeg' ? '.jpg' : `.${contentType.split('/')[1] ?? 'bin'}`;
}
