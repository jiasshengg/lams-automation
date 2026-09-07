import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { IratRequest, QuestionImageRequest } from '../config.js';
import type { AEPlan } from '../ae/plan.js';
import { resolveInputFile } from '../input-file.js';
import { inspectDocxImages } from './media.js';

export interface QuestionImageAsset {
  filename: string;
  contentType: string;
  data: Buffer;
  altText: string;
  widthPx: number | null;
  source: string;
}

export async function resolveIratQuestionImages(request: IratRequest): Promise<Map<string, QuestionImageAsset[]>> {
  const result = new Map<string, QuestionImageAsset[]>();
  const sourceImages = request.sourceDocx ? await imagesFromDocx(request.sourceDocx) : [];
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]!;
    const sourceNumber = question.sourceQuestionNumber ?? index + 1;
    const automatic = sourceImages.filter((image) => image.questionNumber === sourceNumber).map(toAsset);
    const explicit = await resolveExplicitImages(question.images ?? []);
    result.set(question.title, deduplicate([...automatic, ...explicit]));
  }
  return result;
}

export async function resolveAEQuestionImages(plan: AEPlan): Promise<Map<number, QuestionImageAsset[]>> {
  const result = new Map<number, QuestionImageAsset[]>();
  const sourceImages = plan.sourceDocx ? await imagesFromDocx(plan.sourceDocx) : [];
  for (const question of plan.nodes.flatMap((node) => node.questions)) {
    const automatic = sourceImages.filter((image) => image.questionNumber === question.sourceQuestionNumber).map(toAsset);
    const explicit = await resolveExplicitImages(question.images);
    result.set(question.number, deduplicate([...automatic, ...explicit]));
  }
  return result;
}

async function imagesFromDocx(query: string) {
  const filename = await resolveInputFile(query, '.docx');
  return inspectDocxImages(await readFile(filename));
}

async function resolveExplicitImages(images: QuestionImageRequest[]): Promise<QuestionImageAsset[]> {
  const result: QuestionImageAsset[] = [];
  for (const image of images) {
    const extension = path.extname(image.path) || '.png';
    const filename = await resolveInputFile(image.path, extension);
    result.push({
      filename: path.basename(filename),
      contentType: contentType(extension),
      data: await readFile(filename),
      altText: image.altText ?? '',
      widthPx: image.widthPx ?? null,
      source: filename
    });
  }
  return result;
}

function toAsset(image: ReturnType<typeof inspectDocxImages>[number]): QuestionImageAsset {
  return {
    filename: image.sourceFilename,
    contentType: image.contentType,
    data: image.data,
    altText: image.altText,
    widthPx: image.widthPx,
    source: `${image.sourcePart} (${image.relationshipId})`
  };
}

function deduplicate(images: QuestionImageAsset[]): QuestionImageAsset[] {
  const hashes = new Set<string>();
  return images.filter((image) => {
    const key = image.data.toString('base64');
    if (hashes.has(key)) return false;
    hashes.add(key);
    return true;
  });
}

function contentType(extension: string): string {
  const values: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.svg': 'image/svg+xml', '.webp': 'image/webp'
  };
  const value = values[extension.toLowerCase()];
  if (!value) throw new Error(`Unsupported question image type: ${extension}`);
  return value;
}
