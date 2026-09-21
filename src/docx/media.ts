import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { paragraphContent } from '../ae/sot-paragraphs.js';
import { readZipEntries, requireZipEntry } from './archive.js';

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

const QUESTION_START = /^\s*(\d+)[.)]\s+\S/;
// Mark annotations can occur inside a question sentence (the iRAT baseline Q6 does so).
// Requiring the marker at the paragraph end shifts every later image association.
const UNNUMBERED_MARKED_QUESTION = /(?:\(\s*(?:mark\s*\d+|\d+\s*marks?)\s*\)|\[\s*\d+\s*marks?\s*\])/i;
// A new section opens the narrative for the question that follows it, so a figure
// printed under the heading illustrates that next question rather than the last one.
const SECTION_BOUNDARY = /^(?:-{3}\s*BREAK\s*-{3}$|Case\s+\d+\b)/i;

/**
 * Tracks which SoT question each paragraph belongs to, in document order. Images and
 * inline formatting share this rule so both are assigned to the same question numbers.
 */
export function createQuestionTracker(): (paragraphText: string) => number | null {
  let currentQuestion: number | null = null;
  let inferredQuestion = 0;
  return (text) => {
    const question = text.match(QUESTION_START);
    if (question) {
      currentQuestion = Number(question[1]);
      inferredQuestion = Math.max(inferredQuestion, currentQuestion);
    } else if (UNNUMBERED_MARKED_QUESTION.test(text)) {
      inferredQuestion += 1;
      currentQuestion = inferredQuestion;
    }
    return currentQuestion;
  };
}

export function inspectDocxImages(buffer: Buffer): DocxImage[] {
  const entries = readZipEntries(buffer);
  const documentXml = requireZipEntry(entries, 'word/document.xml').toString('utf8');
  const relationships = parseRelationships(
    requireZipEntry(entries, 'word/_rels/document.xml.rels').toString('utf8')
  );
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)].map((match) => ({
    xml: match[1] ?? '',
    ...paragraphContent(match[1] ?? '')
  }));
  const images: DocxImage[] = [];
  // Images seen after a section boundary but before the next stem; they illustrate
  // the question that follows, so their number is only known once it is reached.
  const awaitingQuestion: DocxImage[] = [];
  // Images whose caption, if any, is the next paragraph that carries text.
  const awaitingCaption: DocxImage[] = [];
  let currentQuestion: number | null = null;
  let inferredQuestion = 0;
  let imageIndex = 0;
  let sectionStarted = false;

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const xml = paragraph.xml;
    const text = paragraph.text;
    if (text !== '' && paragraph.imageCount === 0) {
      const caption = isCaption(text, xml) ? withHyperlinkTargets(paragraph.html, text, xml, relationships) : '';
      for (const pending of awaitingCaption.splice(0)) pending.caption = caption;
    }
    const question = text.match(QUESTION_START);
    if (question) {
      currentQuestion = Number(question[1]);
      inferredQuestion = Math.max(inferredQuestion, currentQuestion);
    } else if (UNNUMBERED_MARKED_QUESTION.test(text)) {
      inferredQuestion += 1;
      currentQuestion = inferredQuestion;
    } else if (SECTION_BOUNDARY.test(text)) {
      currentQuestion = null;
      sectionStarted = true;
    }
    if (currentQuestion !== null) {
      for (const pending of awaitingQuestion.splice(0)) pending.questionNumber = currentQuestion;
    }

    for (const drawing of xml.matchAll(/<(?:w:drawing|w:pict)\b[^>]*>([\s\S]*?)<\/(?:w:drawing|w:pict)>/g)) {
      const drawingXml = drawing[0];
      const relationshipId = /(?:r:embed|r:id)=["']([^"']+)["']/.exec(drawingXml)?.[1];
      if (!relationshipId) continue;
      const target = relationships.get(relationshipId);
      if (!target || target.external) continue;
      const sourcePart = normalizeWordTarget(target.value);
      const data = entries.get(sourcePart);
      if (!data) throw new Error(`Image relationship ${relationshipId} points to missing DOCX entry ${sourcePart}.`);
      imageIndex += 1;
      const extent = /<wp:extent\b[^>]*\bcx=["'](\d+)["'][^>]*\bcy=["'](\d+)["']/.exec(drawingXml);
      const crop = parseSourceRectangle(drawingXml);
      const docProperties = /<wp:docPr\b([^>]*)\/?>(?:<\/wp:docPr>)?/.exec(drawingXml)?.[1] ?? '';
      const altText = attribute(docProperties, 'descr') || attribute(docProperties, 'title') || '';
      const extension = path.extname(sourcePart).toLowerCase();
      const sha256 = createHash('sha256').update(data).digest('hex');
      const image: DocxImage = {
        id: `image-${imageIndex}`,
        relationshipId,
        sourcePart,
        sourceFilename: path.basename(sourcePart),
        contentType: contentTypeFor(extension),
        questionNumber: currentQuestion,
        placement: currentQuestion === null ? 'before' : 'after',
        caption: '',
        paragraphIndex,
        imageIndex,
        altText,
        crop,
        widthPx: extent ? emuToPixels(Number(extent[1])) : null,
        heightPx: extent ? emuToPixels(Number(extent[2])) : null,
        sha256,
        data
      };
      images.push(image);
      awaitingCaption.push(image);
      // Before the document's first section boundary there is no question to wait
      // for, so cover art and logos stay unassigned instead of joining question 1.
      if (currentQuestion === null && sectionStarted) awaitingQuestion.push(image);
    }
  });
  return images;
}

/**
 * A figure caption is the line printed directly under the image. Question stems,
 * answer options, answer keys, rationales, and new sections all belong to the
 * document structure instead, so an image followed by one of them has no caption.
 */
export function isCaption(text: string, paragraphXml = ''): boolean {
  const structurallyPossible = (
    !QUESTION_START.test(text) &&
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
