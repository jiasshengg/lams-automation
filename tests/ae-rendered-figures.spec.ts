import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAEPlan } from '../src/ae/plan.js';
import { buildRenderedAEDraft } from '../src/ae/render-figures.js';
import { assertAEPlanMatchesSOT } from '../src/ae/sot-check.js';
import { readSOTDocxParts } from '../src/ae/sot-paragraphs.js';
import { inspectDocxImages } from '../src/docx/media.js';
import { resolveAEQuestionImages } from '../src/docx/question-images.js';
import type { RenderTarget } from '../src/docx/render-targets.js';
import type { RenderOutcome } from '../src/docx/word-render.js';
import { drawing, groupedDrawing, mediaDocx, paragraph } from './helpers/docx-media.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const floatingArrow = '<w:r><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><wps:wsp><wps:spPr/></wps:wsp></wp:anchor></w:drawing></w:r>';
const table = (...rows: string[][]) =>
  `<w:tbl>${rows.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

// Blocks: 0 title, 1 case, 2 Q1 stem, 3 picture, 4 table, 5 question, 6 answer,
// 7 Q2 stem, 8 picture, 9 caption with an arrow drawn over the picture, 10 answer, 11 END.
const SOT = mediaDocx(
  paragraph('Application title: Rendering') +
  paragraph('Case 1') +
  paragraph('1. Read the results below.') +
  paragraph('', drawing) +
  table(['Test', 'Result'], ['Hb', '9.7 g/dl']) +
  paragraph('Which diagnosis fits?') +
  paragraph('Answer: Anaemia') +
  paragraph('2. Name the arrowed bone.') +
  paragraph('', drawing) +
  paragraph('Figure 1. Femur', floatingArrow) +
  paragraph('Answer: Femur') +
  paragraph('END')
);

/** Stands in for Word: every target renders, and each picture is written where it was asked for. */
function fakeWord(coveredAfter = 0) {
  return async (_docx: Buffer, requests: { target: RenderTarget; outputPath: string }[]): Promise<RenderOutcome> => {
    const rendered = new Map();
    for (const { target, outputPath } of requests) {
      await writeFile(outputPath, Buffer.concat([PNG, Buffer.from(target.id)]));
      rendered.set(target.id, {
        id: target.id,
        parts: [{ firstBlock: target.firstBlock, lastBlock: target.lastBlock, path: outputPath, widthPx: 320, heightPx: 120 }],
        coveredAfter: target.kind === 'figure' ? coveredAfter : 0
      });
    }
    return { rendered, failures: new Map() };
  };
}

async function draftOf(docx: Buffer, directory: string, renderer: ReturnType<typeof fakeWord> | (() => Promise<RenderOutcome>)) {
  const sourceDocx = path.join(directory, 'AE.docx');
  await writeFile(sourceDocx, docx);
  return buildRenderedAEDraft(docx, readSOTDocxParts(docx), {
    sourceLabel: 'fallback',
    sourceDocx,
    images: inspectDocxImages(docx),
    figuresDirectory: directory,
    render: true,
    renderer
  });
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-rendered-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a table and a drawn figure in a prompt are each shown as one rendered picture', () => withDirectory(async (directory) => {
  const draft = await draftOf(SOT, directory, fakeWord());
  const [first, second] = draft.nodes.flatMap((node) => node.questions);

  expect(first!.prompt).not.toContain('<table');
  expect(first!.prompt).toBe('Case 1\n1. Read the results below.\n{{image}}\n{{image}}\nWhich diagnosis fits?');
  expect(first!.renderedFigures).toEqual([
    { path: path.join(directory, 'Q1-table-b4.png'), kind: 'table', blocks: [4, 4], widthPx: 320, altText: 'Test Result Hb 9.7 g/dl' }
  ]);
  // The arrow's figure takes in the picture it is drawn over; the caption stays as text.
  expect(second!.prompt).toBe('2. Name the arrowed bone.\n{{image}}\nFigure 1. Femur');
  expect(second!.renderedFigures).toMatchObject([{ kind: 'figure', blocks: [8, 9] }]);
  expect(draft._review.some((note) => note.startsWith('Rendered with Word') && note.includes('Q1 table, Q2 figure'))).toBe(true);
}));

test('the plan follows its Source-of-Truth with the rendered pictures in place', () => withDirectory(async (directory) => {
  const plan = buildAEPlan(await draftOf(SOT, directory, fakeWord()));
  await expect(assertAEPlanMatchesSOT(plan, [])).resolves.toBeUndefined();
}));

test('rendered pictures stand in for the pictures inside them, in document order', () => withDirectory(async (directory) => {
  const plan = buildAEPlan(await draftOf(SOT, directory, fakeWord()));
  const images = await resolveAEQuestionImages(plan);
  // Q1's own photograph comes before the table picture, as printed; Q2's photograph is in the figure.
  expect(images.get(1)?.map((image) => image.filename)).toEqual(['chart.png', 'Q1-table-b4.png']);
  expect(images.get(2)?.map((image) => image.filename)).toEqual(['Q2-figure-b8-9.png']);
  expect(images.get(1)?.[1]).toMatchObject({ widthPx: 320, altText: 'Test Result Hb 9.7 g/dl', caption: '' });
}));

test('without Word no draft is written, and each table and figure is named with the reason', () => withDirectory(async (directory) => {
  const unavailable = async (): Promise<RenderOutcome> => ({
    rendered: new Map(), failures: new Map(), unavailable: 'Microsoft Word for Mac is not installed or could not be started.'
  });
  const stopped = draftOf(SOT, directory, unavailable);
  await expect(stopped).rejects.toThrow('could not be pictured with Microsoft Word');
  await expect(stopped).rejects.toThrow('Q1 table (blocks 4-4): Microsoft Word for Mac is not installed');
  await expect(stopped).rejects.toThrow('Q2 figure (blocks 8-9)');
}));

test('one table Word could not picture stops the draft, even when the others rendered', () => withDirectory(async (directory) => {
  const partly = async (docx: Buffer, requests: { target: RenderTarget; outputPath: string }[]): Promise<RenderOutcome> => {
    const outcome = await fakeWord()(docx, requests);
    const table = requests.find(({ target }) => target.kind === 'table')!.target;
    outcome.rendered.delete(table.id);
    outcome.failures.set(table.id, 'The table runs onto a second page, and only one page of it can be pictured.');
    return outcome;
  };
  await expect(draftOf(SOT, directory, partly)).rejects.toThrow('Q1 table (blocks 4-4): The table runs onto a second page');
}));

test('--no-render is the deliberate choice to rebuild tables and figures from the DOCX', () => withDirectory(async (directory) => {
  const docx = path.join(directory, 'AE.docx');
  await writeFile(docx, SOT);
  const draft = await buildRenderedAEDraft(SOT, readSOTDocxParts(SOT), {
    sourceLabel: 'fallback', sourceDocx: docx, images: inspectDocxImages(SOT), figuresDirectory: directory, render: false
  });
  const [first] = draft.nodes.flatMap((node) => node.questions);
  expect(first!.prompt).toContain('<table');
  expect(first!.renderedFigures).toBeUndefined();
}));

test('the empty lines a floating figure is drawn over become part of it', () => withDirectory(async (directory) => {
  const docx = mediaDocx(
    paragraph('Application title: Rendering') +
    paragraph('1. Study the graph.') +
    paragraph('', groupedDrawing) +
    '<w:p/><w:p/>' +
    paragraph('Explain the difference.') +
    paragraph('END')
  );
  const open = await draftOf(docx, directory, fakeWord(0));
  expect(open.nodes[0]!.questions[0]!.prompt).toBe('1. Study the graph.\n{{image}}\n\n\nExplain the difference.');
  const covered = await draftOf(docx, directory, fakeWord(2));
  expect(covered.nodes[0]!.questions[0]!.prompt).toBe('1. Study the graph.\n{{image}}\nExplain the difference.');
  expect(covered.nodes[0]!.questions[0]!.renderedFigures).toMatchObject([{ blocks: [2, 4] }]);
}));

test('a figure printed across two pages is shown as one picture per page', () => withDirectory(async (directory) => {
  // Blocks: 0 title, 1 stem, 2 first page's drawing, 3 empty, 4 second page's drawing, 5 question, 6 END.
  const docx = mediaDocx(
    paragraph('Application title: Rendering') +
    paragraph('1. Refer to films A to H.') +
    paragraph('', groupedDrawing) + '<w:p/>' + paragraph('', groupedDrawing) +
    paragraph('Which film shows spherocytes?') +
    paragraph('END')
  );
  const twoPages = async (_docx: Buffer, requests: { target: RenderTarget; outputPath: string }[]): Promise<RenderOutcome> => {
    const [{ target, outputPath }] = requests as [{ target: RenderTarget; outputPath: string }];
    const pages = [[2, 3], [4, 4]].map(([firstBlock, lastBlock], index) => ({
      firstBlock: firstBlock!, lastBlock: lastBlock!, path: outputPath.replace('.png', `-p${index + 1}.png`), widthPx: 300, heightPx: 400
    }));
    for (const page of pages) await writeFile(page.path, Buffer.concat([PNG, Buffer.from(page.path)]));
    return { rendered: new Map([[target.id, { id: target.id, parts: pages, coveredAfter: 0 }]]), failures: new Map() };
  };
  const draft = await draftOf(docx, directory, twoPages);
  const question = draft.nodes[0]!.questions[0]!;
  expect(question.prompt).toBe('1. Refer to films A to H.\n{{image}}\n{{image}}\nWhich film shows spherocytes?');
  expect(question.renderedFigures?.map((figure) => figure.blocks)).toEqual([[2, 3], [4, 4]]);
  await expect(assertAEPlanMatchesSOT(buildAEPlan(draft), [])).resolves.toBeUndefined();
}));

test('an option table keeps its HTML, so the answer emphasis removed from it cannot reappear', () => withDirectory(async (directory) => {
  const docx = mediaDocx(
    paragraph('Application title: Rendering') +
    paragraph('1. Which drug applies?') +
    table(['A.', 'Aspirin'], ['B.', 'Heparin']) +
    paragraph('Answer: B') +
    paragraph('END')
  );
  const draft = await draftOf(docx, directory, fakeWord());
  expect(draft.nodes[0]!.questions[0]!.renderedFigures).toBeUndefined();
  expect(draft._review.some((note) => note.startsWith('Rendered with Word'))).toBe(false);
}));

test('a rendered figure must name the blocks it pictures, first to last', () => {
  const question = { number: 1, type: 'essay', prompt: '1. Read.\n{{image}}' };
  const plan = (renderedFigures: unknown) => ({
    sourceLabel: 'x', breakMarkerCount: 0, gates: [], nodes: [{ title: 'AE Q1', questions: [{ ...question, renderedFigures }] }]
  });
  expect(buildAEPlan(plan([{ path: 'a.png', kind: 'table', blocks: [4, 4] }])).nodes[0]!.questions[0]!.renderedFigures).toHaveLength(1);
  expect(() => buildAEPlan(plan([{ path: 'a.png', kind: 'table', blocks: [5, 4] }]))).toThrow('blocks must run forward');
  expect(() => buildAEPlan(plan([{ path: 'a.png', kind: 'chart', blocks: [4, 4] }]))).toThrow('kind must be "table" or "figure"');
});
