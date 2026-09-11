import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectDocxImages } from '../src/docx/media.js';
import { resolveAEQuestionImages } from '../src/docx/question-images.js';
import { buildAEPlan } from '../src/ae/plan.js';
import { drawing, mediaDocx, paragraph } from './helpers/docx-media.js';

test('extracts embedded images and preserves question associations and dimensions', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('15. Compare the charts.', drawing + drawing) + paragraph('16. Describe the chart.', drawing)
  ));
  expect(images).toHaveLength(3);
  expect(images.map((image) => image.questionNumber)).toEqual([15, 15, 16]);
  expect(images[0]).toMatchObject({ contentType: 'image/png', widthPx: 600, heightPx: 300, altText: 'A & B' });
  expect(images.every((image) => image.sha256.length === 64)).toBe(true);
});

test('infers question order for unnumbered marked questions', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('First question (1 mark)') + paragraph('Second question (mark 1)') + paragraph('', drawing)
  ));
  expect(images).toHaveLength(1);
  expect(images[0]?.questionNumber).toBe(2);
});

test('resolves a supplied DOCX path outside the repository', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-attached-docx-'));
  try {
    const sourceDocx = path.join(directory, 'Attached source.docx');
    await writeFile(sourceDocx, mediaDocx(paragraph('1. Describe the chart.', drawing)));
    const plan = buildAEPlan({
      sourceLabel: 'Attachment', sourceDocx, breakMarkerCount: 0,
      nodes: [{ title: 'AE 1', questions: [{ number: 1, type: 'essay', prompt: 'Describe the chart.' }] }], gates: []
    });
    const images = await resolveAEQuestionImages(plan);
    expect(images.get(1)).toHaveLength(1);
    expect(images.get(1)?.[0]).toMatchObject({ filename: 'chart.png', contentType: 'image/png', widthPx: 600 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('mid-sentence marks do not shift later iRAT image associations', () => {
  const questions = Array.from({ length: 25 }, (_, i) => paragraph(
    i === 5 ? 'Which interpretation is most (mark 1) appropriate?' : `Prompt ${i+1} (mark 1)`,
    i === 22 ? drawing : ''
  )).join('');
  expect(inspectDocxImages(mediaDocx(questions)).map(image => image.questionNumber)).toEqual([23]);
});
