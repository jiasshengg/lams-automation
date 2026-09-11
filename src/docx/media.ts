import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readZipEntries, requireZipEntry } from './archive.js';

export interface DocxImage {
  id: string;
  relationshipId: string;
  sourcePart: string;
  sourceFilename: string;
  contentType: string;
  questionNumber: number | null;
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

export function inspectDocxImages(buffer: Buffer): DocxImage[] {
  const entries = readZipEntries(buffer);
  const documentXml = requireZipEntry(entries, 'word/document.xml').toString('utf8');
  const relationships = parseRelationships(
    requireZipEntry(entries, 'word/_rels/document.xml.rels').toString('utf8')
  );
  const paragraphs = [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)];
  const images: DocxImage[] = [];
  let currentQuestion: number | null = null;
  let inferredQuestion = 0;
  let imageIndex = 0;

  paragraphs.forEach((paragraphMatch, paragraphIndex) => {
    const xml = paragraphMatch[1] ?? '';
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((match) => decodeXml(match[1] ?? ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    const question = text.match(QUESTION_START);
    if (question) {
      currentQuestion = Number(question[1]);
      inferredQuestion = Math.max(inferredQuestion, currentQuestion);
    } else if (UNNUMBERED_MARKED_QUESTION.test(text)) {
      inferredQuestion += 1;
      currentQuestion = inferredQuestion;
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
      const docProperties = /<wp:docPr\b([^>]*)\/?>(?:<\/wp:docPr>)?/.exec(drawingXml)?.[1] ?? '';
      const altText = attribute(docProperties, 'descr') || attribute(docProperties, 'title') || '';
      const extension = path.extname(sourcePart).toLowerCase();
      const sha256 = createHash('sha256').update(data).digest('hex');
      images.push({
        id: `image-${imageIndex}`,
        relationshipId,
        sourcePart,
        sourceFilename: path.basename(sourcePart),
        contentType: contentTypeFor(extension),
        questionNumber: currentQuestion,
        paragraphIndex,
        imageIndex,
        altText,
        widthPx: extent ? emuToPixels(Number(extent[1])) : null,
        heightPx: extent ? emuToPixels(Number(extent[2])) : null,
        sha256,
        data
      });
    }
  });
  return images;
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
      paragraphIndex: image.paragraphIndex,
      imageIndex: image.imageIndex,
      altText: image.altText,
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

function decodeXml(value: string): string {
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
