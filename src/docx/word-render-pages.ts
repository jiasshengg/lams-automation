import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readZipEntries, requireZipEntry } from './archive.js';
import { topLevelBlocks } from './blocks.js';
import { changedBands, changedBox, inkPicture, withBorderLines } from './page-diff.js';
import { decodePng, encodePng, type Box, type RgbaImage } from './png.js';
import {
  asFinallyPrinted,
  paintedOut,
  shadedOver,
  unpaintableContent,
  emptyParagraphsAfter,
  withMarkedParagraphs,
  withoutHighlights,
  withPaintedBlocks,
  wordsPaintedOut
} from './render-variants.js';
import type { RenderTarget } from './render-targets.js';
import { writeZipEntries } from './zip-writer.js';

/**
 * Turns Word documents into page images: Word lays each document out and saves it as a PDF, and
 * each page is drawn at `scale` image pixels per CSS pixel. Returns each document's page images,
 * in page order, keyed by the document's name.
 */
export type PageExporter = (documents: { name: string; docx: string }[], options: { scale: number; workspace: string }) => Promise<Map<string, string[]>>;

export interface PageRenderRequest {
  target: RenderTarget;
  outputPath: string;
}

export interface PageRenderedPart {
  firstBlock: number;
  lastBlock: number;
  path: string;
  widthPx: number;
  heightPx: number;
}

export interface PageRenderOutcome {
  rendered: Map<string, { id: string; parts: PageRenderedPart[]; coveredAfter: number }>;
  failures: Map<string, string>;
  unavailable?: string;
}

/** The white margin round a picture, in image pixels, as the Windows renderer leaves. */
const PADDING = 6;
/** Half the widest border Word draws (6 pt), which lies outside a table's shaded cells. */
const BORDER_REACH_POINTS = 3;
/** PDF pages are measured in points (1/72 inch); CSS pixels are 1/96 inch. */
const CSS_PIXELS_PER_POINT = 96 / 72;
/** Rows apart that two bands of change still count as one mark. */
const JOINED_ROWS = 3;
/** How many empty paragraphs after a floating figure are checked for lying under it. */
const MARKED_PARAGRAPHS = 30;

/**
 * Pictures each table and drawn figure by comparing Word's own pages with and without it: a copy in
 * which only the target is painted out differs from the document exactly where Word printed the
 * target, and that area of the page is the picture. Nothing moves between the copies, so the
 * picture is Word's layout, list numbering and floating positions included. This needs nothing of
 * Word but opening a document and saving it as a PDF, which Word for Mac can do.
 */
export async function renderWithWordPages(
  docx: Buffer,
  requests: PageRenderRequest[],
  options: { exporter: PageExporter; workspace: string; scale: number }
): Promise<PageRenderOutcome> {
  const outcome: PageRenderOutcome = { rendered: new Map(), failures: new Map() };
  if (requests.length === 0) return outcome;
  const entries = readZipEntries(docx);
  const original = requireZipEntry(entries, 'word/document.xml').toString('utf8');
  const printed = asFinallyPrinted(original);
  // Accepting changes must not add or drop a block, or the targets would point elsewhere.
  const documentXml = topLevelBlocks(printed).length === topLevelBlocks(original).length ? printed : original;
  const blocks = topLevelBlocks(documentXml);

  const usable = requests.filter(({ target }) => {
    const xml = blocks.slice(target.firstBlock, target.lastBlock + 1).map((block) => block.inner).join('');
    const reason = unpaintableContent(xml);
    if (reason) outcome.failures.set(target.id, `It holds ${reason}, which cannot be pictured this way; render it with Word on Windows.`);
    return reason === null;
  });
  if (usable.length === 0) return outcome;

  const ranges = usable.map(({ target }) => target);
  const asPrinted = withPaintedBlocks(documentXml, ranges, withoutHighlights);
  const figures = ranges.filter((target) => target.kind === 'figure');
  // The words around a figure stay in the prompt as text, so its picture shows only the drawing.
  const figureBase = figures.length > 0 ? withPaintedBlocks(asPrinted, figures, wordsPaintedOut) : asPrinted;
  const baseFor = (target: RenderTarget) => (target.kind === 'figure' ? 'figures' : 'document');

  const documents = new Map<string, string>([['document', asPrinted]]);
  if (figures.length > 0) documents.set('figures', figureBase);
  const marked = new Set<string>();
  usable.forEach(({ target }, index) => {
    const base = target.kind === 'figure' ? figureBase : asPrinted;
    const hidden = withPaintedBlocks(base, [target], target.kind === 'figure' ? paintedOut : shadedOver);
    documents.set(`hidden-${index}`, hidden);
    if (target.kind !== 'figure') return;
    // Where each of the figure's paragraphs prints, for a figure Word spreads over two pages.
    const own = Array.from({ length: target.lastBlock - target.firstBlock + 1 }, (_value, offset) => target.firstBlock + offset);
    documents.set(`paged-${index}`, withMarkedParagraphs(hidden, own, 'square'));
    // The empty lines below it, every other one per copy, so marks on neighbouring lines never meet.
    const empty = emptyParagraphsAfter(hidden, target.lastBlock, MARKED_PARAGRAPHS);
    if (empty.length > 0) {
      marked.add(target.id);
      documents.set(`marked-${index}-even`, withMarkedParagraphs(hidden, empty.filter((_block, at) => at % 2 === 0), 'bar'));
      documents.set(`marked-${index}-odd`, withMarkedParagraphs(hidden, empty.filter((_block, at) => at % 2 === 1), 'bar'));
    }
  });

  // The folder itself stays: Word for Mac remembers access to it, not to what it holds.
  await mkdir(options.workspace, { recursive: true });
  for (const entry of await readdir(options.workspace)) await rm(path.join(options.workspace, entry), { recursive: true, force: true });
  const files: { name: string; docx: string }[] = [];
  for (const [name, xml] of documents) {
    const file = path.join(options.workspace, `${name}.docx`);
    const copy = new Map(entries);
    copy.set('word/document.xml', Buffer.from(xml, 'utf8'));
    await writeFile(file, writeZipEntries(copy));
    files.push({ name, docx: file });
  }

  let pages: Map<string, string[]>;
  try {
    pages = await options.exporter(files, { scale: options.scale, workspace: options.workspace });
  } catch (error) {
    return { ...outcome, unavailable: error instanceof Error ? error.message : String(error) };
  }
  const images = new Map<string, Promise<RgbaImage>>();
  const renders: Renders = {
    count: (name) => pages.get(name)?.length ?? 0,
    page: (name, number) => {
      const file = pages.get(name)?.[number];
      if (!file) throw new Error(`Word produced no page ${number + 1} for ${name}.`);
      const key = `${name}#${number}`;
      if (!images.has(key)) images.set(key, readFile(file).then(decodePng));
      return images.get(key)!;
    }
  };

  for (const [index, { target, outputPath }] of usable.entries()) {
    try {
      const drawn = blocks.slice(target.firstBlock, target.lastBlock + 1).map((block) => DRAWING.test(block.inner));
      const pictured = await pictureTarget(renders, { target, index, outputPath, drawn, scale: options.scale });
      const lastPage = pictured.parts.at(-1)!;
      const coveredAfter = marked.has(target.id) ? await coveredParagraphs(renders, index, lastPage.page, lastPage.bottom) : 0;
      outcome.rendered.set(target.id, { id: target.id, parts: pictured.parts.map(({ page: _page, bottom: _bottom, ...part }) => part), coveredAfter });
    } catch (error) {
      outcome.failures.set(target.id, error instanceof Error ? error.message : String(error));
    }
  }
  return outcome;
}

const DRAWING = /<w:drawing\b|<w:pict\b/;

interface Renders {
  count(name: string): number;
  page(name: string, number: number): Promise<RgbaImage>;
}

type PicturedPart = PageRenderedPart & { page: number; bottom: number };

/**
 * Pictures one target from where its painted-out copy differs from the document. A table is one
 * picture on one page. A figure is one picture per page it is printed on, split as the Windows
 * renderer splits it: a paragraph that holds a drawing and prints on a new page starts the next
 * part, and an empty paragraph stays with the drawings above it.
 */
async function pictureTarget(
  renders: Renders,
  job: { target: RenderTarget; index: number; outputPath: string; drawn: boolean[]; scale: number }
): Promise<{ parts: PicturedPart[] }> {
  const { target, index, outputPath, scale } = job;
  const base = target.kind === 'figure' ? 'figures' : 'document';
  const hidden = `hidden-${index}`;
  const count = renders.count(base);
  if (renders.count(hidden) !== count) throw new Error('Word laid the copy out on a different number of pages.');
  const changed = new Map<number, Box>();
  for (let number = 0; number < count; number += 1) {
    const box = changedBox(await renders.page(base, number), await renders.page(hidden, number));
    if (box) changed.set(number, box);
  }
  if (changed.size === 0) throw new Error('Word printed nothing for it.');
  if (changed.size > 1 && target.kind === 'table') throw new Error('The table runs onto a second page, and only one page of it can be pictured.');

  const groups =
    changed.size === 1
      ? [{ first: 0, last: target.lastBlock - target.firstBlock, page: [...changed.keys()][0]! }]
      : pageGroups(await paragraphPages(renders, index, job.drawn.length), job.drawn);
  const parts: PicturedPart[] = [];
  for (const [number, group] of groups.entries()) {
    const box = changed.get(group.page);
    if (!box) throw new Error(`Word printed nothing of the figure on page ${group.page + 1}, where its paragraphs ${group.first + 1}-${group.last + 1} are.`);
    const page = await renders.page(base, group.page);
    const picture = inkPicture(page, target.kind === 'table' ? withBorderReach(box, page, scale) : box, PADDING);
    if (!picture) throw new Error('Word rendered it blank.');
    const file = path.resolve(groups.length > 1 ? outputPath.replace(/\.png$/i, `-p${number + 1}.png`) : outputPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, encodePng(picture));
    parts.push({
      firstBlock: target.firstBlock + group.first,
      lastBlock: target.kind === 'table' ? target.lastBlock : target.firstBlock + group.last,
      path: file,
      widthPx: Math.round(picture.width / scale),
      heightPx: Math.round(picture.height / scale),
      page: group.page,
      bottom: box.bottom
    });
  }
  return { parts };
}

/** Shading stops at the middle of a cell's border, so the border's outer half lies just outside. */
function withBorderReach(box: Box, page: RgbaImage, scale: number): Box {
  return withBorderLines(page, box, Math.ceil(BORDER_REACH_POINTS * scale * CSS_PIXELS_PER_POINT));
}

/**
 * The page each of a figure's paragraphs prints on, read from the marks typed into them: every
 * mark changes one band of its page, and the bands run in paragraph order down page after page.
 */
async function paragraphPages(renders: Renders, index: number, paragraphs: number): Promise<number[]> {
  const hidden = `hidden-${index}`;
  const paged = `paged-${index}`;
  if (renders.count(paged) !== renders.count(hidden)) throw new Error('Marking the figure moved it onto other pages.');
  const pages: number[] = [];
  for (let number = 0; number < renders.count(hidden); number += 1) {
    // A mark something unpainted is drawn across reads as two bands a row or two apart: one mark.
    const bands = changedBands(await renders.page(hidden, number), await renders.page(paged, number), JOINED_ROWS);
    for (let band = 0; band < bands.length; band += 1) pages.push(number);
  }
  if (pages.length !== paragraphs) {
    throw new Error(`The figure's ${paragraphs} paragraphs could not be placed on its pages (${pages.length} found); render it with Word on Windows.`);
  }
  return pages;
}

function pageGroups(pages: number[], drawn: boolean[]): { first: number; last: number; page: number }[] {
  const groups: { first: number; last: number; page: number }[] = [];
  pages.forEach((page, offset) => {
    const current = groups.at(-1);
    if (!current || (drawn[offset] && page !== current.page)) groups.push({ first: offset, last: offset, page });
    else current.last = offset;
  });
  return groups;
}

/**
 * How many of the empty paragraphs after a floating figure print above its bottom edge, on its page:
 * the room the document left for the figure, not blank lines a reader sees. Counted in order, and
 * stopped at the first that prints below the figure.
 */
async function coveredParagraphs(renders: Renders, index: number, number: number, figureBottom: number): Promise<number> {
  const hidden = await renders.page(`hidden-${index}`, number);
  const bands = [
    ...changedBands(hidden, await renders.page(`marked-${index}-even`, number), JOINED_ROWS),
    ...changedBands(hidden, await renders.page(`marked-${index}-odd`, number), JOINED_ROWS)
  ].sort((left, right) => left.top - right.top);
  let covered = 0;
  for (const band of bands) {
    if (band.top >= figureBottom) break;
    covered += 1;
  }
  return covered;
}
