import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectCaseHeadings, formatUnresolvedSotWarnings, inspectDocxImages, parseSourceRectangle } from '../src/docx/media.js';
import { resolveAEQuestionImages } from '../src/docx/question-images.js';
import { buildAEPlan } from '../src/ae/plan.js';
import { drawing, groupedDrawing, mediaDocx, paragraph } from './helpers/docx-media.js';

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

test('reads every picture in a grouped figure once, with its own size and the labels drawn on it', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('1. Which lane shows HbS?') + paragraph('', groupedDrawing) + paragraph('A. Lane A')
  ));
  // Two pictures in the group; the legacy VML fallback repeating one of them is not read again.
  expect(images).toHaveLength(2);
  expect(images.map((image) => image.questionNumber)).toEqual([1, 1]);
  // Each picture is half of a group drawn 4,000,000 EMU (420 px) wide.
  expect(images.map((image) => image.widthPx)).toEqual([210, 210]);
  expect(images[0]?.overlayText).toBe('A | B');
});

test('numbers unnumbered iRAT questions that follow numbered ones, so their figures stay with them', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('1. A numbered question?') +
    paragraph('A. One') + paragraph('B. Two') +
    paragraph('Explanation - A is correct.') +
    paragraph('Red cell disorders') +
    paragraph('What part of the neuron triggers an action potential?') +
    paragraph('', drawing) +
    paragraph('A. A') + paragraph('B. B') +
    paragraph('The electrical synapse is important for:') +
    paragraph('I. Synchronization of activity') + paragraph('II. Re-uptake of neurotransmitters') +
    paragraph('A. I') + paragraph('B. I &amp; II') +
    paragraph('Identify the epithelia depicted below.') +
    paragraph('', drawing) +
    paragraph('A. Simple cuboidal') + paragraph('B. Transitional')
  ));
  expect(images.map((image) => image.questionNumber)).toEqual([2, 4]);
});

test('a figure in the case narrative after a closed question introduces the next question', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('1. Earlier question?') + paragraph('A. One') + paragraph('B. Two') +
    paragraph('Q2-3 relate to this case') +
    paragraph('A 50 year-old man collapsed in the ED waiting area.') +
    paragraph('You noticed this rhythm on his cardiac monitoring.') +
    paragraph('', drawing) +
    paragraph('What is the definitive management of the condition?') +
    paragraph('A. Defibrillation') + paragraph('B. Digoxin')
  ));
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ questionNumber: 2, placement: 'before' });
});

test('keeps a figure with its own question when it follows the options or a rationale', () => {
  const underOptions = inspectDocxImages(mediaDocx(
    paragraph('1. In the image below, which letter marks a sulcus?') + paragraph('A. C') + paragraph('B. D') +
    paragraph('', drawing) +
    paragraph('2. In the brain above, which letter marks the diencephalon?') + paragraph('A. D') + paragraph('B. E')
  ));
  const inRationale = inspectDocxImages(mediaDocx(
    paragraph('1. Which diagram applies?') + paragraph('A. One') + paragraph('B. Two') +
    paragraph('Answer: A') + paragraph('Central cord syndrome is explained by the layering of the cord.') +
    paragraph('', drawing) +
    paragraph('2. Next question?')
  ));
  const essay = inspectDocxImages(mediaDocx(
    paragraph('1. Explain the tracing.') + paragraph('Consider the tracing below:') +
    paragraph('', drawing) + paragraph('2. Next question?')
  ));
  expect(underOptions[0]).toMatchObject({ questionNumber: 1, placement: 'after' });
  expect(inRationale[0]).toMatchObject({ questionNumber: 1, placement: 'after' });
  expect(essay[0]).toMatchObject({ questionNumber: 1, placement: 'after' });
});

test('reads Q-prefixed stems and starred break markers', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('Q16. Based on the diagram, which ECG applies?') + paragraph('A. One') +
    paragraph('***** BREAK *****') +
    paragraph('', drawing) +
    paragraph('Q17. What is the name of these T waves?')
  ));
  expect(images[0]).toMatchObject({ questionNumber: 17, placement: 'before' });
});

test('a figure inside the vignette of an unnumbered question belongs to that question', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('1. First question?') + paragraph('A. One') + paragraph('B. Two') +
    paragraph('A 55-year-old woman presents with chest pain. Her ECG is shown.', drawing) +
    paragraph('What is the most likely diagnosis?') +
    paragraph('A. MI') + paragraph('B. PE')
  ));
  expect(images[0]).toMatchObject({ questionNumber: 2, placement: 'before' });
});

test('marks a figure printed after its own answer key as rationale, but not the next question\'s case figure', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('1. Which diagram applies?') + paragraph('A. One') + paragraph('B. Two') +
    paragraph('Answer: A') +
    paragraph('Rationale - the layering of the cord explains it.') +
    paragraph('', drawing) +
    paragraph('Case 4') +
    paragraph('A 42 year old man presents with chest pain.') +
    paragraph('', drawing) +
    paragraph('2. Which ECG applies?')
  ));
  expect(images.map((image) => [image.questionNumber, image.afterAnswerKey])).toEqual([[1, true], [2, false]]);
});

test('a question whose figure is replaced does not also import the document\'s own', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-replaced-figure-'));
  try {
    const sourceDocx = path.join(directory, 'AE.docx');
    await writeFile(sourceDocx, mediaDocx(paragraph('1. Which film applies?', drawing) + paragraph('2. Describe the film.', drawing)));
    const page = path.join(directory, 'films-page.png');
    await writeFile(page, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
    const plan = buildAEPlan({
      sourceLabel: 'Replacement', sourceDocx, breakMarkerCount: 0,
      nodes: [{ title: 'AE 1', questions: [
        { number: 1, type: 'essay', prompt: '1. Which film applies?\n{{image}}', replaceSourceFigures: true, images: [{ path: page }] },
        { number: 2, type: 'essay', prompt: '2. Describe the film.\n{{image}}' }
      ] }],
      gates: []
    });

    const images = await resolveAEQuestionImages(plan);
    expect(images.get(1)?.map((image) => image.filename)).toEqual(['films-page.png']);
    // The question that did not ask for a replacement still gets the document's figure.
    expect(images.get(2)?.map((image) => image.filename)).toEqual(['chart.png']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('detects a case-relates heading and the numbered question it introduces', () => {
  const headings = detectCaseHeadings(mediaDocx(
    paragraph('24. Earlier unrelated question?') +
    paragraph('Q25-27 relate to this case') +
    paragraph('A 50 year-old gentleman was in ED waiting area...') +
    paragraph('25. What is the definitive management of the condition?')
  ));
  expect(headings).toHaveLength(1);
  expect(headings[0]).toMatchObject({ text: 'Q25-27 relate to this case', nextQuestionNumber: 25 });
});

test('detects a singular case-relates heading regardless of case and spacing', () => {
  const headings = detectCaseHeadings(mediaDocx(
    paragraph('q 28   relates to this case') + paragraph('28. What is the diagnosis?')
  ));
  expect(headings[0]).toMatchObject({ text: 'q 28 relates to this case', nextQuestionNumber: 28 });
});

test('a case heading followed by no numbered question reports null rather than guessing', () => {
  const headings = detectCaseHeadings(mediaDocx(
    paragraph('Q19-20 relate to this case') + paragraph('An unnumbered stem with no digits at all.')
  ));
  expect(headings[0]).toMatchObject({ nextQuestionNumber: null });
});

test('a case heading followed by another heading before any number reports null', () => {
  const headings = detectCaseHeadings(mediaDocx(
    paragraph('Q1-2 relate to this case') + paragraph('Case 3') + paragraph('3. A real numbered question?')
  ));
  expect(headings[0]).toMatchObject({ text: 'Q1-2 relate to this case', nextQuestionNumber: null });
});

test('flags a figure as shared with the next question when only its caption separates them', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('19. In the image below, which letter indicates a sulcus?') +
    paragraph('A. C') +
    paragraph('', drawing) +
    paragraph('Medical gallery of Blausen Medical 2014') +
    paragraph('20. In the brain above, which letter indicates the diencephalon?')
  ));
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ questionNumber: 19, sharedWithQuestionNumber: 20 });
});

test('does not flag a figure as shared when more content follows before the next question', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('4. Which explanation best accounts for the change?') +
    paragraph('', drawing) +
    paragraph('A. Clearance has increased') +
    paragraph('5. Next question?')
  ));
  expect(images[0]).toMatchObject({ questionNumber: 4, sharedWithQuestionNumber: null });
});

test('does not flag a figure as shared with a non-adjacent question number', () => {
  const images = inspectDocxImages(mediaDocx(
    paragraph('4. Stem?') + paragraph('', drawing) + paragraph('9. A much later unrelated question?')
  ));
  expect(images[0]).toMatchObject({ questionNumber: 4, sharedWithQuestionNumber: null });
});
