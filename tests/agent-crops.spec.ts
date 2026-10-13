import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRenderedAEDraft } from '../src/ae/render-figures.js';
import { readSOTDocxParts } from '../src/ae/sot-paragraphs.js';
import { agentCropRenderer, CROPS_FILE, TARGETS_FILE, type CropManifest } from '../src/docx/agent-crops.js';
import { inspectDocxImages } from '../src/docx/media.js';
import { decodePng, encodePng } from '../src/docx/png.js';
import type { RenderTarget } from '../src/docx/render-targets.js';
import type { PageExporter } from '../src/docx/word-render-pages.js';
import type { RenderOutcome } from '../src/docx/word-render.js';
import { drawing, mediaDocx, paragraph } from './helpers/docx-media.js';

const floatingArrow = '<w:r><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wps:wsp><wps:spPr/></wps:wsp></wp:anchor></w:drawing></w:r>';
const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Hb</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>9.7 g/dl</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';

// Blocks: 0 title, 1 case, 2 Q1 stem, 3 table, 4 question, 5 answer,
// 6 Q2 stem, 7 picture, 8 caption with an arrow drawn over the picture, 9 answer, 10 END.
const SOT = mediaDocx(
  paragraph('Application title: Cropping') +
  paragraph('Case 1') +
  paragraph('1. Read the results below.') +
  table +
  paragraph('Which diagnosis fits?') +
  paragraph('Answer: Anaemia') +
  paragraph('2. Name the arrowed bone.') +
  paragraph('', drawing) +
  paragraph('Figure 1. Femur', floatingArrow) +
  paragraph('Answer: Femur') +
  paragraph('END')
);

/** Stands in for Word: one 400 px square page (200 px as looked at), the table at rows 100-200 and a figure at 260-300. */
const fakeWord: PageExporter = async (_documents, { workspace }) => {
  const data = new Uint8Array(400 * 400 * 4).fill(255);
  for (let y = 100; y < 200; y += 1) for (let x = 40; x < 360; x += 1) data.set([90, 90, 90, 255], (y * 400 + x) * 4);
  for (let y = 260; y < 300; y += 1) for (let x = 80; x < 240; x += 1) data.set([60, 60, 60, 255], (y * 400 + x) * 4);
  const file = path.join(workspace, 'pages-1.png');
  await writeFile(file, encodePng({ width: 400, height: 400, data }));
  return new Map([['pages', [file]]]);
};

/** Stands in for the renderer: pictures everything but the `refused` kind, as Word for Mac refuses some. */
const rendererWithout = (refused: RenderTarget['kind']) =>
  async (_docx: Buffer, requests: { target: RenderTarget; outputPath: string }[]): Promise<RenderOutcome> => {
    const done = requests.filter(({ target }) => target.kind !== refused);
    return {
      rendered: new Map(done.map(({ target, outputPath }) => [target.id, {
        id: target.id,
        parts: [{ firstBlock: target.firstBlock, lastBlock: target.lastBlock, path: outputPath, widthPx: 320, heightPx: 120 }],
        coveredAfter: 0
      }])),
      failures: new Map(requests.filter(({ target }) => target.kind === refused).map(({ target }) => [target.id, 'It runs onto a second page.']))
    };
  };

async function inDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-crops-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Drafts as the command does: first with the renderer alone, then with the agent's crops for what it missed. */
function draftOf(directory: string, options: { docx?: Buffer; refused?: RenderTarget['kind']; crops?: boolean } = {}) {
  const docx = options.docx ?? SOT;
  const renderer = rendererWithout(options.refused ?? 'table');
  const pages = path.join(directory, 'pages');
  return buildRenderedAEDraft(docx, readSOTDocxParts(docx), {
    sourceLabel: 'fallback',
    sourceDocx: path.join(directory, 'AE.docx'),
    images: inspectDocxImages(docx),
    figuresDirectory: directory,
    render: true,
    ...(options.crops
      ? { renderer: agentCropRenderer(pages, renderer) }
      : { renderer, pagesDirectory: pages, pageExporter: { exporter: fakeWord, workspace: path.join(directory, 'work') } })
  });
}

const writeCrops = (directory: string, crops: unknown[]) =>
  writeFile(path.join(directory, 'pages', CROPS_FILE), JSON.stringify({ crops }), 'utf8');
const manifestOf = async (directory: string) =>
  JSON.parse(await readFile(path.join(directory, 'pages', TARGETS_FILE), 'utf8')) as CropManifest;

test('what the renderer cannot picture stops the draft and is handed to the agent with its pages', () => inDirectory(async (directory) => {
  const stopped = draftOf(directory);
  await expect(stopped).rejects.toThrow('Q1 table (blocks 3-3): It runs onto a second page.');
  await expect(stopped).rejects.toThrow(`run again with --figure-crops ${path.join(directory, 'pages')}`);

  const manifest = await manifestOf(directory);
  expect(manifest.pages).toEqual([{ page: 1, file: 'page-1.png', widthPx: 200, heightPx: 200 }]);
  // Only the table: the figure was pictured, and nothing else may be cropped by hand.
  expect(manifest.targets).toEqual([
    { id: 'b3', question: 1, kind: 'table', blocks: [3, 3], text: 'Hb 9.7 g/dl', reason: 'It runs onto a second page.' }
  ]);
  const full = decodePng(await readFile(path.join(directory, 'pages', 'full', 'page-1.png')));
  expect([full.width, full.height]).toEqual([400, 400]);
}));

test('a crop is trimmed to its ink, and everything else is still pictured by the renderer', () => inDirectory(async (directory) => {
  await draftOf(directory).catch(() => undefined);
  // A loose box round the table, in pixels of the page as looked at.
  await writeCrops(directory, [{ id: 'b3', page: 1, box: [5, 30, 195, 120] }]);
  const draft = await draftOf(directory, { crops: true });
  const [first, second] = draft.nodes.flatMap((node) => node.questions);

  // The table's 320 x 100 pixels with the 6 px margin; its printed width is half that.
  expect(first!.renderedFigures).toMatchObject([{ path: path.join(directory, 'Q1-table-b3.png'), kind: 'table', blocks: [3, 3], widthPx: 166 }]);
  const picture = decodePng(await readFile(path.join(directory, 'Q1-table-b3.png')));
  expect([picture.width, picture.height]).toEqual([332, 112]);
  expect(second!.renderedFigures).toMatchObject([{ kind: 'figure', blocks: [7, 8], widthPx: 320 }]);
  expect(draft._review.some((note) => note.startsWith("Cropped from Word's page by the agent") && note.includes('Q1 table') && !note.includes('Q2'))).toBe(true);
}));

test('a crop that cannot be used stops the draft rather than passing unseen', () => inDirectory(async (directory) => {
  await draftOf(directory).catch(() => undefined);
  await writeCrops(directory, [{ id: 'b3', page: 1, box: [5, 160, 195, 190] }]);
  await expect(draftOf(directory, { crops: true })).rejects.toThrow('is blank on page 1');
  await writeCrops(directory, [{ id: 'b3', page: 1, box: [5, 30, 260, 120] }]);
  await expect(draftOf(directory, { crops: true })).rejects.toThrow('does not lie inside page 1');
  // The figure was pictured by the renderer, so it is not the agent's to crop.
  await writeCrops(directory, [{ id: 'b7-8', page: 1, box: [5, 30, 195, 120] }]);
  await expect(draftOf(directory, { crops: true })).rejects.toThrow('only what the renderer could not picture');
  // Leaving the missed table out is no way round it either.
  await writeCrops(directory, []);
  await expect(draftOf(directory, { crops: true })).rejects.toThrow('Q1 table (blocks 3-3)');
}));

test('pages printed from another document are refused', () => inDirectory(async (directory) => {
  await draftOf(directory).catch(() => undefined);
  await writeCrops(directory, [{ id: 'b3', page: 1, box: [5, 30, 195, 120] }]);
  const other = mediaDocx(paragraph('Application title: Other') + paragraph('1. Read.') + table + paragraph('Answer: A') + paragraph('END'));
  await expect(draftOf(directory, { docx: other, crops: true })).rejects.toThrow('printed from a different document');
}));

test('boxes on several pages join into one picture, and the empty lines after a cropped figure go with it', () => inDirectory(async (directory) => {
  // Blocks: 0 title, 1 stem, 2 picture, 3 caption with an arrow, 4-5 empty lines, 6 question, 7 answer, 8 END.
  const spaced = mediaDocx(
    paragraph('Application title: Cropping') + paragraph('1. Name the arrowed bone.') + paragraph('', drawing) +
    paragraph('Figure 1. Femur', floatingArrow) + '<w:p/><w:p/>' + paragraph('Which bone?') + paragraph('Answer: Femur') + paragraph('END')
  );
  await draftOf(directory, { docx: spaced, refused: 'figure' }).catch(() => undefined);
  const [target] = (await manifestOf(directory)).targets;
  expect(target).toMatchObject({ kind: 'figure', blocks: [2, 3] });
  // Two boxes, as for a figure printed across two pages: here the table's ink, then the figure's.
  await writeCrops(directory, [{ id: target!.id, page: 1, box: [5, 30, 195, 120] }, { id: target!.id, page: 1, box: [5, 125, 195, 160] }]);
  const draft = await draftOf(directory, { docx: spaced, refused: 'figure', crops: true });
  const [question] = draft.nodes.flatMap((node) => node.questions);

  expect(question!.renderedFigures).toMatchObject([{ kind: 'figure', blocks: [2, 5] }]);
  expect(question!.prompt).toBe('1. Name the arrowed bone.\n{{image}}\nFigure 1. Femur\nWhich bone?');
  // 100 + 40 rows of ink between the same left and right edges, with the margin.
  const picture = decodePng(await readFile(path.join(directory, `Q1-figure-${target!.id}.png`)));
  expect([picture.width, picture.height]).toEqual([332, 152]);
}));
