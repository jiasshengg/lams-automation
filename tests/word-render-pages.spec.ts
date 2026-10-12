import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePng, encodePng, type RgbaImage } from '../src/docx/png.js';
import type { RenderTarget } from '../src/docx/render-targets.js';
import { renderWithWordPages, type PageExporter } from '../src/docx/word-render-pages.js';
import { drawing, mediaDocx, paragraph } from './helpers/docx-media.js';

// Blocks: 0 heading, 1 table, 2 figure, 3-4 empty lines the figure is drawn over, 5 END.
const DOCX = mediaDocx(
  paragraph('Results') +
  '<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>Hb</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
  paragraph('', drawing) +
  '<w:p/><w:p/>' +
  paragraph('END')
);
const TABLE: RenderTarget = { id: 'b1', kind: 'table', firstBlock: 1, lastBlock: 1, hasPictures: false };
const FIGURE: RenderTarget = { id: 'b2', kind: 'figure', firstBlock: 2, lastBlock: 2, hasPictures: true };

/** A 200 px square white page with grey rectangles: [left, top, right, bottom, grey]. */
function page(boxes: [number, number, number, number, number][]): RgbaImage {
  const data = new Uint8Array(200 * 200 * 4).fill(255);
  for (const [left, top, right, bottom, grey] of boxes) {
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) data.set([grey, grey, grey, 255], (y * 200 + x) * 4);
  }
  return { width: 200, height: 200, data };
}

/**
 * Stands in for Word: draws each copy as its name says Word would print it. The table (rows
 * 50-100) is shaded black in its own copy; the figure (rows 120-160) vanishes in its copies; a bar
 * typed into the first empty line prints at row 140, under the figure, and into the second at 165.
 */
const fakeWord: PageExporter = async (documents, { workspace }) => {
  const pages = new Map<string, string[]>();
  for (const { name } of documents) {
    const boxes: [number, number, number, number, number][] = [[10, 10, 90, 20, 0]];
    boxes.push(name === 'hidden-0' ? [18, 49, 182, 101, 0] : [20, 50, 180, 100, 90]);
    if (!/^(hidden|paged|marked)-1/.test(name)) boxes.push([40, 120, 120, 160, 60]);
    if (name === 'marked-1-even') boxes.push([30, 140, 33, 146, 0]);
    if (name === 'marked-1-odd') boxes.push([30, 165, 33, 171, 0]);
    const file = path.join(workspace, `${name}-1.png`);
    await writeFile(file, encodePng(page(boxes)));
    pages.set(name, [file]);
  }
  return pages;
};

async function inDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-pages-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('pictures a table and a figure where their painted-out copies differ from the document', () => inDirectory(async (directory) => {
  const outcome = await renderWithWordPages(DOCX, [
    { target: TABLE, outputPath: path.join(directory, 'table.png') },
    { target: FIGURE, outputPath: path.join(directory, 'figure.png') }
  ], { exporter: fakeWord, workspace: path.join(directory, 'work'), scale: 2 });

  expect(outcome.failures).toEqual(new Map());
  const table = outcome.rendered.get('b1')!;
  // The ink of the table, with a 6 px white margin; sizes are in CSS pixels (scale 2).
  expect(table.parts).toEqual([{ firstBlock: 1, lastBlock: 1, path: path.join(directory, 'table.png'), widthPx: 86, heightPx: 31 }]);
  const picture = decodePng(await readFile(path.join(directory, 'table.png')));
  expect([picture.width, picture.height]).toEqual([172, 62]);
  // The figure is drawn over the first empty line below it, not the second.
  const figure = outcome.rendered.get('b2')!;
  expect(figure.parts[0]).toMatchObject({ firstBlock: 2, lastBlock: 2, widthPx: 46, heightPx: 26 });
  expect(figure.coveredAfter).toBe(1);
}));

test('a figure holding a chart is refused with the reason, and a missing Word stops everything', () => inDirectory(async (directory) => {
  const chart = mediaDocx(paragraph('', '<w:r><w:drawing><c:chart r:id="rId1"/></w:drawing></w:r>'));
  const refused = await renderWithWordPages(chart, [
    { target: { id: 'b0', kind: 'figure', firstBlock: 0, lastBlock: 0, hasPictures: false }, outputPath: path.join(directory, 'chart.png') }
  ], { exporter: fakeWord, workspace: path.join(directory, 'work'), scale: 2 });
  expect(refused.failures.get('b0')).toContain('a chart');

  const missing: PageExporter = async () => {
    throw new Error('Microsoft Word for Mac is not installed or could not be started.');
  };
  const unavailable = await renderWithWordPages(DOCX, [{ target: TABLE, outputPath: path.join(directory, 't.png') }], {
    exporter: missing, workspace: path.join(directory, 'work'), scale: 2
  });
  expect(unavailable.unavailable).toContain('not installed');
}));
