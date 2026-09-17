import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectDocxImages, parseSourceRectangle } from '../src/docx/media.js';
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

test('attaches a figure printed under a new Case heading to the question that follows it', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('6. Earlier question?') +
    paragraph('--- BREAK ---') +
    paragraph('Case 4 - A clinical genetics case study') +
    paragraph('', drawing) +
    paragraph('7. Study the given pedigree. What is the inheritance pattern?')
  ));
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ questionNumber: 7, placement: 'before' });
});

test('keeps cover art printed before any section unassigned', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('', drawing) + paragraph('Copyright Statement') + paragraph('Case 1') + paragraph('1. First question?')
  ));
  expect(images[0]).toMatchObject({ questionNumber: null, placement: 'before' });
});

test('captures the caption line printed under a figure', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('4. Which explanation best accounts for the change?') +
    paragraph('', drawing) +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Figure 1. </w:t></w:r><w:r><w:t>Plasma concentration-time profile</w:t></w:r></w:p>` +
    paragraph('A. Clearance has increased')
  ));
  expect(images[0]?.caption).toBe('<strong>Figure 1.</strong> Plasma concentration-time profile');
});

test('does not mistake an answer option or the next question for a caption', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('4. Which chart applies?') +
    paragraph('', drawing) +
    paragraph('A. The first chart') +
    paragraph('', drawing) +
    paragraph('5. Next question?')
  ));
  expect(images.map((image) => image.caption)).toEqual(['', '']);
});

test('does not mistake an unlabelled iRAT option after a figure for a caption', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('Refer to the curves below. Which statement is correct? (mark 1)') +
    paragraph('', drawing) +
    paragraph('Curve B has a shorter elimination half-life.')
  ));
  expect(images[0]?.caption).toBe('');
});

test('a figure printed before a stem is marked as belonging above it', () => {
  // Whether or not case narrative intervenes, a figure between a heading and the stem illustrates
  // the question below it. questionDescriptionHtml then places it under that narrative.
  const bare = inspectDocxImages(mediaDocx(
    paragraph('Case 4') +
    paragraph('', drawing) +
    paragraph('7. Which inheritance pattern applies? (4 marks)')
  ));
  const narrated = inspectDocxImages(mediaDocx(
    paragraph('Case 6') +
    paragraph('A patient has the resulting karyotype below:') +
    paragraph('', drawing) +
    paragraph('11. What syndrome does the patient have? (4 marks)')
  ));
  expect(bare.map((image) => image.placement)).toEqual(['before']);
  expect(narrated.map((image) => image.placement)).toEqual(['before']);
  expect(narrated.map((image) => image.questionNumber)).toEqual([11]);
});

test('reads the display crop Word applies to a picture', () => {
  // srcRect edges are thousandths of a percent trimmed from each side.
  expect(parseSourceRectangle('<a:srcRect l="9844" t="40201" r="56098" b="9548"/>')).toEqual({
    left: 0.09844,
    top: 0.40201,
    right: 0.56098,
    bottom: 0.09548
  });
  // Absent, empty, and all-zero rectangles all mean the whole picture is shown.
  expect(parseSourceRectangle('<a:blip r:embed="rId8"/>')).toBeNull();
  expect(parseSourceRectangle('<a:srcRect/>')).toBeNull();
  expect(parseSourceRectangle('<a:srcRect l="0" t="0"/>')).toBeNull();
  // A rectangle that trims everything away is a misread, not a blank image.
  expect(() => parseSourceRectangle('<a:srcRect l="60000" r="40000"/>')).toThrow('leaves nothing');
});
