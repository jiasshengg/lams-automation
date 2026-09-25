import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { IratRequest, QuestionImageRequest } from '../config.js';
import type { AEPlan } from '../ae/plan.js';
import { resolveInputFile } from '../input-file.js';
import { inspectDocxImages, type ImageCrop, type ImagePlacement } from './media.js';

export interface QuestionImageAsset {
  filename: string;
  contentType: string;
  data: Buffer;
  altText: string;
  widthPx: number | null;
  /** Whether the image precedes or follows the question stem in the source. */
  placement: ImagePlacement;
  /** Display crop the document applies to the embedded picture, or null for the whole file. */
  crop: ImageCrop | null;
  /** Inline HTML of the caption printed under the image, or '' when there is none. */
  caption: string;
  source: string;
}

export async function resolveIratQuestionImages(request: IratRequest): Promise<Map<string, QuestionImageAsset[]>> {
  const result = new Map<string, QuestionImageAsset[]>();
  const sourceImages = request.sourceDocx ? await imagesFromDocx(request.sourceDocx) : [];
  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]!;
    const sourceNumber = question.sourceQuestionNumber ?? index + 1;
    // A question that reviewed the automatic duplication below and rejected it says so with an
    // explicit empty `images: []` (distinct from omitting the field, which accepts whatever is
    // automatically detected) — this is the only way to suppress a duplicate the SoT's own
    // wording does not actually call for, such as two adjacent questions pointing at one shared
    // image via complementary "below"/"above" wording with no case narrative connecting them,
    // where the image belongs once to the earlier question and should not also land on this one.
    const suppressAutomatic = Array.isArray(question.images) && question.images.length === 0;
    const ownImages = suppressAutomatic
      ? []
      : sourceImages.filter((image) => image.questionNumber === sourceNumber).map(toAsset);
    // A figure the SoT prints once but visually serves this question and the one before
    // it (each phrased "image above"/"image below") is reproduced here too, matching
    // how it would be captured if a reviewer duplicated it by hand: same file and
    // caption, but placed ahead of this question's own content since it was already
    // shown after the previous question's.
    const shared = suppressAutomatic
      ? []
      : sourceImages
          .filter((image) => image.sharedWithQuestionNumber === sourceNumber)
          .map((image) => ({ ...toAsset(image), placement: 'before' as const }));
    const automatic = [...ownImages, ...shared];
    const explicit = await resolveExplicitImages(question.images ?? []);
    result.set(question.title, deduplicate([...automatic, ...explicit]));
  }
  return result;
}

export async function resolveAEQuestionImages(plan: AEPlan): Promise<Map<number, QuestionImageAsset[]>> {
  const result = new Map<number, QuestionImageAsset[]>();
  const sourceImages = plan.sourceDocx ? await imagesFromDocx(plan.sourceDocx) : [];
  for (const question of plan.nodes.flatMap((node) => node.questions)) {
    // A replaced figure means the reviewed images stand in for the document's own, which could
    // not be handed over; importing both would show the broken arrangement alongside the fix.
    const automatic = question.replaceSourceFigures
      ? []
      : sourceImages.filter((image) => image.questionNumber === question.sourceQuestionNumber).map(toAsset);
    const explicit = await resolveExplicitImages(question.images);
    result.set(question.number, deduplicate([...automatic, ...explicit]));
  }
  return result;
}

/**
 * The figures a question may import: everything the document prints for it except the ones under
 * its own answer key, which belong to the rationale. An excluded figure can still be imported by
 * naming its file in the question's own `images`.
 */
async function imagesFromDocx(query: string) {
  const filename = await resolveInputFile(query, '.docx');
  return inspectDocxImages(await readFile(filename)).filter((image) => !image.afterAnswerKey);
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
      // An explicit local file is used exactly as supplied; only Word applies display crops.
      crop: null,
      widthPx: image.widthPx ?? null,
      placement: image.placement ?? 'after',
      caption: image.caption ?? '',
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
    placement: image.placement,
    crop: image.crop,
    caption: image.caption,
    source: `${image.sourcePart} (${image.relationshipId})`
  };
}

/**
 * The same image bytes can be supplied twice for one question: once from automatic
 * SoT/shared-figure detection, once from an explicit `images` entry naming the same file to add
 * a caption, placement, or alt text the automatic pass missed — its caption heuristic only
 * recognises a handful of conventional phrasings (a Word Caption style, a "Figure/Table/…"
 * prefix, or a link), so a plain attribution line like "Medical gallery of Blausen Medical 2014"
 * is invisible to it and has to be added by hand. Both call sites always build this list as
 * `[...automatic, ...explicit]`, so the later occurrence of a duplicate is the deliberate,
 * reviewed one: it overrides whichever fields it actually sets, and a field it leaves at its
 * default falls back to the earlier occurrence's value. Losing that override silently — by
 * keeping whichever copy happened to come first — previously dropped a reviewed caption without
 * any warning; see `irat-image-placement-caption-bug` in project memory.
 */
function deduplicate(images: QuestionImageAsset[]): QuestionImageAsset[] {
  const order: string[] = [];
  const merged = new Map<string, QuestionImageAsset>();
  for (const image of images) {
    const key = image.data.toString('base64');
    const existing = merged.get(key);
    if (!existing) {
      order.push(key);
      merged.set(key, image);
      continue;
    }
    merged.set(key, {
      ...existing,
      placement: image.placement,
      caption: image.caption !== '' ? image.caption : existing.caption,
      altText: image.altText !== '' ? image.altText : existing.altText,
      widthPx: image.widthPx ?? existing.widthPx
    });
  }
  return order.map((key) => merged.get(key)!);
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
