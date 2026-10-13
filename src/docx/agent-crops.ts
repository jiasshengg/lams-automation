import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZipEntries, requireZipEntry } from './archive.js';
import { topLevelBlocks } from './blocks.js';
import { cropImage, decodePng, encodePng, type Box, type RgbaImage } from './png.js';
import { asFinallyPrinted, emptyParagraphsAfter, withoutHighlights, withPaintedBlocks, wordsPaintedOut } from './render-variants.js';
import type { RenderTarget } from './render-targets.js';
import { emptyWorkspace, type PageExporter } from './word-render-pages.js';
import type { RenderOutcome, RenderRequest } from './word-render.js';
import { writeZipEntries } from './zip-writer.js';

/** The white margin round a picture, in image pixels, as the renderers leave. */
const PADDING = 6;
/** Below this on any channel a pixel is ink, as the renderers count it. */
const INK_THRESHOLD = 245;
/** How many empty paragraphs after a figure are taken as the room left for it. */
const COVERED_PARAGRAPHS = 30;
export const TARGETS_FILE = 'targets.json';
export const CROPS_FILE = 'crops.json';

/** What the agent is handed: Word's pages of the document, and what the renderer could not picture. */
export interface CropManifest {
  /** The document the pages were printed from; crops are refused for any other. */
  sourceSha256: string;
  /** Image pixels of a full-size page per pixel of the page the agent looks at. */
  scale: number;
  pages: { page: number; file: string; widthPx: number; heightPx: number }[];
  targets: CropManifestTarget[];
}

export interface CropManifestTarget {
  id: string;
  question: number;
  kind: RenderTarget['kind'];
  blocks: [number, number];
  /** The words it holds, to find it on the page by. */
  text: string;
  /** Why the renderer could not picture it. */
  reason: string;
}

/**
 * One box the agent chose: `[left, top, right, bottom]` in pixels of the looked-at page. A table or
 * figure printed across two pages is given one box per page, in page order, under the same `id`.
 */
export interface AgentCrop {
  id: string;
  page: number;
  box: [number, number, number, number];
}

/**
 * Prints the document with Word and writes its pages to `directory` for the agent to look at:
 * `page-N.png` at printed size, and `full/page-N.png` at `scale` times that, which the crops are
 * cut from. Highlighting is removed from the targets first (it marks answers), and the words of a
 * figure's paragraphs are painted out, since they stay in the prompt as text.
 */
export async function exportTargetPages(
  docx: Buffer,
  targets: readonly RenderTarget[],
  options: { exporter: PageExporter; workspace: string; scale: number; directory: string }
): Promise<CropManifest['pages']> {
  const entries = readZipEntries(docx);
  const original = requireZipEntry(entries, 'word/document.xml').toString('utf8');
  const printed = asFinallyPrinted(original);
  // Accepting changes must not add or drop a block, or the targets would point elsewhere.
  const documentXml = topLevelBlocks(printed).length === topLevelBlocks(original).length ? printed : original;
  const figures = targets.filter((target) => target.kind === 'figure');
  const xml = withPaintedBlocks(withPaintedBlocks(documentXml, targets, withoutHighlights), figures, wordsPaintedOut);

  await emptyWorkspace(options.workspace);
  const copyPath = path.join(options.workspace, 'pages.docx');
  const copy = new Map(entries);
  copy.set('word/document.xml', Buffer.from(xml, 'utf8'));
  await writeFile(copyPath, writeZipEntries(copy));
  try {
    const files = (await options.exporter([{ name: 'pages', docx: copyPath }], { scale: options.scale, workspace: options.workspace })).get('pages') ?? [];
    if (files.length === 0) throw new Error('Word produced no pages for the document.');
    return await pagesForAgent(files, options);
  } finally {
    if (!process.env.LAMS_WORD_RENDER_KEEP) await emptyWorkspace(options.workspace);
  }
}

async function pagesForAgent(files: string[], options: { scale: number; directory: string }): Promise<CropManifest['pages']> {
  await rm(options.directory, { recursive: true, force: true });
  await mkdir(path.join(options.directory, 'full'), { recursive: true });
  const pages: CropManifest['pages'] = [];
  for (const [index, file] of files.entries()) {
    const name = `page-${index + 1}.png`;
    await copyFile(file, path.join(options.directory, 'full', name));
    const view = shrunk(decodePng(await readFile(file)), options.scale);
    await writeFile(path.join(options.directory, name), encodePng(view));
    pages.push({ page: index + 1, file: name, widthPx: view.width, heightPx: view.height });
  }
  return pages;
}

/**
 * A renderer for what `renderer` could not picture: each target the agent gave a box for is cut out
 * of Word's page, trimmed to its ink the way the renderers trim, and every other target goes to
 * `renderer` as before. Boxes on several pages are joined top to bottom into one picture. Only a
 * target listed in the folder's `targets.json` can be cropped, and a box that cannot be used is an
 * error, never a silent fallback: the agent must see that its box was wrong.
 */
export function agentCropRenderer(
  directory: string,
  renderer: (docx: Buffer, requests: RenderRequest[]) => Promise<RenderOutcome>
): (docx: Buffer, requests: RenderRequest[]) => Promise<RenderOutcome> {
  return async (docx, requests) => {
    const manifest = JSON.parse(await readFile(path.join(directory, TARGETS_FILE), 'utf8')) as CropManifest;
    if (manifest.sourceSha256 !== sha256(docx)) {
      throw new Error(`The pages in ${directory} were printed from a different document; draft it again without --figure-crops.`);
    }
    const crops = readCrops(await readFile(path.join(directory, CROPS_FILE), 'utf8'));
    const requested = new Map(requests.map((request) => [request.target.id, request]));
    const listed = new Set(manifest.targets.map((target) => target.id));
    const documentXml = requireZipEntry(readZipEntries(docx), 'word/document.xml').toString('utf8');
    const pages = new Map<number, Promise<RgbaImage>>();
    const byTarget = new Map<string, AgentCrop[]>();
    for (const crop of crops) byTarget.set(crop.id, [...(byTarget.get(crop.id) ?? []), crop]);
    const rendered: RenderOutcome['rendered'] = new Map();

    for (const [id, boxes] of byTarget) {
      const request = requested.get(id);
      if (!request || !listed.has(id)) {
        throw new Error(`Crop ${id} names nothing in ${TARGETS_FILE}: only what the renderer could not picture is cropped by hand.`);
      }
      const inked: { page: RgbaImage; box: Box }[] = [];
      for (const crop of boxes) {
        const page = manifest.pages.find((candidate) => candidate.page === crop.page);
        if (!page) throw new Error(`Crop ${id} names page ${crop.page}, and the document has ${manifest.pages.length}.`);
        const [left, top, right, bottom] = crop.box;
        if (left < 0 || top < 0 || right > page.widthPx || bottom > page.heightPx || left >= right || top >= bottom) {
          throw new Error(`Crop ${id} box [${crop.box.join(', ')}] does not lie inside page ${crop.page} (${page.widthPx} x ${page.heightPx}).`);
        }
        if (!pages.has(crop.page)) pages.set(crop.page, readFile(path.join(directory, 'full', page.file)).then(decodePng));
        const full = await pages.get(crop.page)!;
        const box = inkBox(full, {
          left: left * manifest.scale,
          top: top * manifest.scale,
          right: Math.min(full.width, right * manifest.scale),
          bottom: Math.min(full.height, bottom * manifest.scale)
        });
        if (!box) throw new Error(`Crop ${id} box [${crop.box.join(', ')}] is blank on page ${crop.page}.`);
        inked.push({ page: full, box });
      }
      const picture = joined(inked);
      const file = path.resolve(request.outputPath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, encodePng(picture));
      const { target } = request;
      rendered.set(id, {
        id,
        parts: [{
          firstBlock: target.firstBlock,
          lastBlock: target.lastBlock,
          path: file,
          widthPx: Math.round(picture.width / manifest.scale),
          heightPx: Math.round(picture.height / manifest.scale)
        }],
        // How many of the empty lines typed after a figure it is drawn over cannot be seen on a
        // page, so all of them are taken as the room left for it.
        coveredAfter: target.kind === 'figure' ? emptyParagraphsAfter(documentXml, target.lastBlock, COVERED_PARAGRAPHS).length : 0
      });
    }

    const agentCropped = new Set(rendered.keys());
    const rest = requests.filter((request) => !rendered.has(request.target.id));
    if (rest.length === 0) return { rendered, failures: new Map(), agentCropped };
    const outcome = await renderer(docx, rest);
    for (const [id, figure] of outcome.rendered) rendered.set(id, figure);
    return { ...outcome, rendered, agentCropped };
  };
}

/** The ink inside `region` of a page, or null when it is blank. */
function inkBox(page: RgbaImage, region: Box): Box | null {
  const box = { left: region.right, top: region.bottom, right: -1, bottom: -1 };
  for (let y = region.top; y < region.bottom; y += 1) {
    for (let x = region.left; x < region.right; x += 1) {
      const at = (y * page.width + x) * 4;
      if (page.data[at]! >= INK_THRESHOLD && page.data[at + 1]! >= INK_THRESHOLD && page.data[at + 2]! >= INK_THRESHOLD) continue;
      if (x < box.left) box.left = x;
      if (x > box.right) box.right = x;
      if (y < box.top) box.top = y;
      if (y > box.bottom) box.bottom = y;
    }
  }
  return box.right < 0 ? null : { left: box.left, top: box.top, right: box.right + 1, bottom: box.bottom + 1 };
}

/**
 * The boxes as one picture, top to bottom, with a white margin. Every part is cut between the same
 * left and right edges of its page, so the columns of a table split by a page break still line up.
 */
function joined(parts: { page: RgbaImage; box: Box }[]): RgbaImage {
  const left = Math.min(...parts.map(({ box }) => box.left));
  const right = Math.min(Math.max(...parts.map(({ box }) => box.right)), ...parts.map(({ page }) => page.width));
  const width = right - left + PADDING * 2;
  const height = parts.reduce((sum, { box }) => sum + box.bottom - box.top, 0) + PADDING * 2;
  const data = new Uint8Array(width * height * 4).fill(255);
  let row = PADDING;
  for (const { page, box } of parts) {
    const part = cropImage(page, { left, top: box.top, right, bottom: box.bottom });
    for (let y = 0; y < part.height; y += 1, row += 1) {
      data.set(part.data.subarray(y * part.width * 4, (y + 1) * part.width * 4), (row * width + PADDING) * 4);
    }
  }
  return { width, height, data };
}

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function readCrops(text: string): AgentCrop[] {
  const parsed = JSON.parse(text) as { crops?: unknown };
  if (!Array.isArray(parsed.crops)) throw new Error(`${CROPS_FILE} must hold { "crops": [{ "id", "page", "box": [left, top, right, bottom] }] }.`);
  return parsed.crops.map((entry: unknown) => {
    const { id, page, box } = (entry ?? {}) as Record<string, unknown>;
    const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
    if (typeof id !== 'string' || !whole(page) || !Array.isArray(box) || box.length !== 4 || !box.every(whole)) {
      throw new Error(`${CROPS_FILE}: every crop needs an "id", a "page" number and a "box" of four whole pixels; got ${JSON.stringify(entry)}.`);
    }
    return { id, page, box: box as [number, number, number, number] };
  });
}

/** The image at one `factor`th of its size, each pixel the average of the pixels it covers. */
function shrunk(image: RgbaImage, factor: number): RgbaImage {
  const width = Math.floor(image.width / factor);
  const height = Math.floor(image.height / factor);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy += 1) {
          for (let dx = 0; dx < factor; dx += 1) sum += image.data[((y * factor + dy) * image.width + x * factor + dx) * 4 + channel]!;
        }
        data[(y * width + x) * 4 + channel] = Math.round(sum / (factor * factor));
      }
    }
  }
  return { width, height, data };
}
