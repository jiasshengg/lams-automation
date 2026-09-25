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
  /**
   * Set when this figure sits immediately before the next sequentially-numbered
   * question's stem (only its caption, if any, comes between them) — the same
   * mechanical signal a reviewer uses to notice a figure is shared between the
   * question it follows and the one it introduces. Null when no numbered question
   * immediately follows, so nothing else can be inferred automatically.
   */
  sharedWithQuestionNumber: number | null;
  /**
   * Set when the text immediately after this figure reads like it introduces another
   * question referencing the same image (an "above" reference paired with a labelled-
   * diagram stem or an explicit figure noun — see `sharingSignals`), but no sequentially-
   * numbered question was found there to confirm it — the source likely has no numbering
   * to anchor to. This is a hint for a warning, never a resolved question association.
   */
  possibleUnresolvedSharing: boolean;
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
  sharedWithQuestionNumber: number | null;
  possibleUnresolvedSharing: boolean;
}

export interface DocxMediaManifest {
  sourceDocx: string;
  imageCount: number;
  unassignedImageIds: string[];
  images: ExtractedDocxImage[];
}

/** A bold "Q25-27 relate to this case" (or "Q16 to 20 relate…", singular "Q25 relates…") heading. */
export const CASE_RELATES_HEADING = /^Q\s*\d+(?:\s*(?:[-–—]|to)\s*\d+)?\s+relates?\s+to\s+this\s+case\b/i;
// A case heading opens the narrative for the question that follows it, like any section
// boundary, so a figure printed under it illustrates that next question, not the last one.
const IMAGE_SECTION_BOUNDARY = new RegExp(`${SECTION_BOUNDARY.source}|${CASE_RELATES_HEADING.source}`, 'i');

/**
 * The question each paragraph belongs to, in document order. Images and inline formatting share
 * this rule so both are assigned to the same question numbers.
 */
export function questionNumbersForParagraphs(texts: string[]): (number | null)[] {
  return questionForEachParagraph(numberQuestionStems(texts, { inferUnnumbered: true }));
}

type ReadParagraph = ReturnType<typeof paragraphContent> & { xml: string };

export interface CaseHeadingObservation {
  /** Exact heading text as printed, e.g. "Q25-27 relate to this case". */
  text: string;
  paragraphIndex: number;
  /**
   * The SoT's own sequential question number this heading introduces — only set when a
   * numbered question stem is the next thing found (no other section boundary between
   * them), matching how `questionNumbersForParagraphs`/`inspectDocxImages` resolve numbering.
   */
  nextQuestionNumber: number | null;
}

/**
 * Finds every bold "Qxx[-yy] relate(s) to this case" heading and the sequentially-numbered
 * question it introduces. Only mechanical, regex-detectable signals are used — this never
 * guesses at boundaries in text that carries no explicit question numbering.
 */
export function detectCaseHeadings(buffer: Buffer): CaseHeadingObservation[] {
  const { documentXml, ...parts } = readSOTDocxParts(buffer);
  const texts = readParagraphsWithListLabels(documentXml, parts).map((paragraph) => paragraph.structureText);
  // Explicitly numbered stems only: an inferred number is a guess this must not build on.
  const stems = numberQuestionStems(texts, { inferUnnumbered: false });
  const observations: CaseHeadingObservation[] = [];
  texts.forEach((text, paragraphIndex) => {
    if (!CASE_RELATES_HEADING.test(text)) return;
    let nextQuestionNumber: number | null = null;
    for (let index = paragraphIndex + 1; index < texts.length; index += 1) {
      const stem = stems[index];
      if (stem !== null && stem !== undefined) {
        nextQuestionNumber = stem;
        break;
      }
      // A different heading/case/break before any numbered question means this
      // heading's own case has no numbered question to introduce.
      if (IMAGE_SECTION_BOUNDARY.test(texts[index]!)) break;
    }
    observations.push({ text, paragraphIndex, nextQuestionNumber });
  });
  return observations;
}

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
    } else if (IMAGE_SECTION_BOUNDARY.test(text)) {
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
        // A lead-in figure already goes to the next question, so it is shared with nothing.
        ...(leadIn ? NOT_SHARED : sharingSignals(paragraphs, stems, paragraphIndex, currentQuestion)),
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
 * Human-readable review prompts for the two shared-content patterns that could not be
 * resolved automatically — a case heading with no numbered question to attach to, and a
 * figure whose neighbouring text reads like it is shared but has no confirming number.
 * Both stem from the same root cause: the source gives that content no digit to anchor
 * to, so nothing is silently applied and nothing is silently skipped without a prompt.
 */
export function formatUnresolvedSotWarnings(
  caseHeadings: readonly CaseHeadingObservation[],
  images: readonly Pick<DocxImage, 'id' | 'sourceFilename' | 'questionNumber' | 'possibleUnresolvedSharing'>[]
): string[] {
  const warnings: string[] = [];
  for (const heading of caseHeadings) {
    if (heading.nextQuestionNumber === null) {
      warnings.push(
        `Case heading "${heading.text}" (paragraph ${heading.paragraphIndex}) is not followed by a sequentially-numbered question, so it could not be attached automatically. If it introduces a group of questions, prepend it to the first one by hand.`
      );
    }
  }
  for (const image of images) {
    if (image.possibleUnresolvedSharing) {
      const owner = image.questionNumber === null ? 'an unassigned figure' : `the figure after question ${image.questionNumber}`;
      warnings.push(
        `${owner} (${image.sourceFilename}, ${image.id}) is immediately followed by text reading "image above", but no sequentially-numbered question confirms it. If the next question also needs this figure, add it to that question's images by hand.`
      );
    }
  }
  return warnings;
}

// What actually precedes "above" in a real SoT varies by what the figure depicts
// ("the brain above", "the ECG above", "the image above") — matching only the noun
// "image" would have missed the exact case that motivated this. Instead this pairs a
// generic "above" reference with the classic labelled-diagram stem ("which letter/
// arrow/label/point indicates…"), or falls back to an explicit image/figure noun for
// phrasing that names no label at all ("refer to the diagram above").
const ABOVE_REFERENCE = /\babove\b/i;
const LABELLED_DIAGRAM_STEM = /\bwhich\s+(?:letter|arrow|label|point|number|option)\b/i;
const GENERIC_FIGURE_NOUN = /\b(?:image|figure|diagram|picture|chart|graph|photo|photograph|scan)\b/i;
const NOT_SHARED = { sharedWithQuestionNumber: null, possibleUnresolvedSharing: false } as const;

/**
 * Mechanical "shared figure" signals, both read from whatever immediately follows this
 * image (skipping only a caption or a short uncaptioned attribution line — an answer
 * option, "Answer"/"Rationale" line, or another section boundary is never skipped past):
 * `sharedWithQuestionNumber` is set only when that following text is the very next
 * sequentially-numbered question's stem — a firm, resolved association. Independently,
 * `possibleUnresolvedSharing` notices the same "above" phrasing a reviewer would (see
 * `ABOVE_REFERENCE`/`LABELLED_DIAGRAM_STEM`/`GENERIC_FIGURE_NOUN`), even when no question
 * number confirms it (typically because the source gives
 * that next question no number to anchor to); it is a hint to flag for review, never a
 * resolved association, and `sharedWithQuestionNumber` already covers the case where a
 * number is present, so this never fires alongside it.
 */
function sharingSignals(
  paragraphs: { text: string; xml: string }[],
  stems: (number | null)[],
  imageParagraphIndex: number,
  ownQuestionNumber: number | null
): { sharedWithQuestionNumber: number | null; possibleUnresolvedSharing: boolean } {
  let index = imageParagraphIndex + 1;
  while (index < paragraphs.length && paragraphs[index]!.text === '') index += 1;
  if (index >= paragraphs.length) return NOT_SHARED;
  if (
    isCaption(paragraphs[index]!.text, paragraphs[index]!.xml) ||
    isInterstitialAttributionLine(paragraphs[index]!.text)
  ) {
    index += 1;
    while (index < paragraphs.length && paragraphs[index]!.text === '') index += 1;
    if (index >= paragraphs.length) return NOT_SHARED;
  }
  const candidate = paragraphs[index]!.text;
  const nextNumber = stems[index] ?? null;
  const resolved = ownQuestionNumber !== null && nextNumber === ownQuestionNumber + 1 ? nextNumber : null;
  return {
    sharedWithQuestionNumber: resolved,
    possibleUnresolvedSharing:
      resolved === null &&
      ABOVE_REFERENCE.test(candidate) &&
      (LABELLED_DIAGRAM_STEM.test(candidate) || GENERIC_FIGURE_NOUN.test(candidate))
  };
}

/** A short line that is not itself a question, option, answer key, or new section. */
function isInterstitialAttributionLine(text: string): boolean {
  return (
    text !== '' &&
    text.split(/\s+/).length <= 12 &&
    !NUMBERED_STEM.test(text) &&
    !/^[A-Z][.)]\s+\S/.test(text) &&
    !/^(?:Answer|Rationale)\b/i.test(text) &&
    !IMAGE_SECTION_BOUNDARY.test(text)
  );
}

/**
 * A figure caption is the line printed directly under the image. Question stems,
 * answer options, answer keys, rationales, and new sections all belong to the
 * document structure instead, so an image followed by one of them has no caption.
 */
export function isCaption(text: string, paragraphXml = ''): boolean {
  const structurallyPossible = (
    !NUMBERED_STEM.test(text) &&
    !IMAGE_SECTION_BOUNDARY.test(text) &&
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
      sha256: image.sha256,
      sharedWithQuestionNumber: image.sharedWithQuestionNumber,
      possibleUnresolvedSharing: image.possibleUnresolvedSharing
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
