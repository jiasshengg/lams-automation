import { expect, test } from '@playwright/test';
import { analyzeAESOT, extractSOTParagraphs } from '../src/ae/sot-docx.js';

function paragraph(text: string, options: { bold?: boolean; drawing?: boolean } = {}): string {
  const bold = options.bold ? '<w:rPr><w:b/></w:rPr>' : '';
  const drawing = options.drawing ? '<w:drawing><wp:inline/></w:drawing>' : '';
  return `<w:p><w:r>${bold}<w:t>${text}</w:t>${drawing}</w:r></w:p>`;
}

test('extracts split runs, bold answer options, and image counts from Word XML', () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>--- </w:t></w:r><w:r><w:t>BREAK ---</w:t></w:r></w:p>
    ${paragraph('B. Correct answer', { bold: true, drawing: true })}
  </w:body></w:document>`;

  expect(extractSOTParagraphs(xml)).toEqual([
    { text: '--- BREAK ---', bold: false, imageCount: 0 },
    { text: 'B. Correct answer', bold: true, imageCount: 1 }
  ]);
});

test('derives variable AE node and gate counts from literal break markers', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Module: Example module')}
    ${paragraph('Session Title: Example session')}
    ${paragraph('Application title: Example AE')}
    ${paragraph('Case 1')}
    ${paragraph('1. First question? (4 marks)')}
    ${paragraph('A. Wrong')}
    ${paragraph('B. Correct', { bold: true })}
    ${paragraph('--- BREAK ---')}
    ${paragraph('2. Select TWO answers.')}
    ${paragraph('A. Correct', { bold: true })}
    ${paragraph('B. Correct', { bold: true })}
    ${paragraph('C. Wrong')}
    ${paragraph('--- BREAK ---')}
    ${paragraph('3. Explain your answer.')}
    ${paragraph('END')}
    ${paragraph('Version Tracking')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'fallback');

  expect(analysis.requestVariables).toEqual({ expectedAENodes: 3, expectedAEGates: 2 });
  expect(analysis.nodes.map((node) => node.questionNumbers)).toEqual([[1], [2], [3]]);
  expect(analysis.gates).toEqual([
    {
      index: 1,
      afterNodeIndex: 1,
      beforeNodeIndex: 2,
      beforeQuestionNumber: 2,
      suggestedTitle: 'AE Gate before Q2'
    },
    {
      index: 2,
      afterNodeIndex: 2,
      beforeNodeIndex: 3,
      beforeQuestionNumber: 3,
      suggestedTitle: 'AE Gate before Q3'
    }
  ]);
  expect(analysis.questions.map((question) => question.type)).toEqual([
    'single-select',
    'multiple-select',
    'open-response'
  ]);
  expect(analysis.questions[0]?.correctAnswerLabels).toEqual(['B']);
  expect(analysis.questions[1]?.correctAnswerLabels).toEqual(['A', 'B']);
  expect(analysis.questionsWithoutExplicitMarks).toEqual([2, 3]);
  expect(analysis.warnings.join('\n')).toContain('Multiple-select questions detected: Q2');
});

test('does not use page or Case headings as AE separators', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('1. First question?')}
    ${paragraph('Case 2')}
    ${paragraph('2. Second question?')}
    ${paragraph('END')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'Example');
  expect(analysis.requiredAENodes).toBe(1);
  expect(analysis.requiredAEGates).toBe(0);
  expect(analysis.nodes[0]?.questionNumbers).toEqual([1, 2]);
});

test('rejects an empty break-derived group and non-sequential questions', () => {
  const emptyGroup = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. First question?')}
    ${paragraph('--- BREAK ---')}
    ${paragraph('END')}
  </w:body></w:document>`);
  expect(() => analyzeAESOT(emptyGroup, 'Example')).toThrow('group 2 does not contain a numbered question');

  const skippedQuestion = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. First question?')}
    ${paragraph('--- BREAK ---')}
    ${paragraph('3. Third question?')}
    ${paragraph('END')}
  </w:body></w:document>`);
  expect(() => analyzeAESOT(skippedQuestion, 'Example')).toThrow('expected 2, found 3');
});

test('splits a single paragraph holding an inline option run into separate labels', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Assuming a genetic basis, what is the most likely inheritance pattern?')}
    ${paragraph('A. Autosomal dominant B. Autosomal recessive C. Mitochondrial D. X-linked dominant E. X-linked recessive')}
    ${paragraph('Answer: E', { bold: true })}
    ${paragraph('Rationale - The pedigree suggests an X-linked disorder.')}
    ${paragraph('END')}
  </w:body></w:document>`);

  const question = analyzeAESOT(paragraphs, 'Example').questions[0]!;
  expect(question.optionLabels).toEqual(['A', 'B', 'C', 'D', 'E']);
  expect(question.type).toBe('single-select');
  expect(question.correctAnswerLabels).toEqual(['E']);
});

test('does not split prose that merely contains a capital letter followed by a period', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Which statement is correct?')}
    ${paragraph('A. Presystemic loss through incomplete absorption or first-pass metabolism')}
    ${paragraph('B. Deficiency of vitamin B. Supplementation resolves it', { bold: true })}
    ${paragraph('Answer - B', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const question = analyzeAESOT(paragraphs, 'Example').questions[0]!;
  expect(question.optionLabels).toEqual(['A', 'B']);
  expect(question.correctAnswerLabels).toEqual(['B']);
});

test('labels an unlabelled option block bounded by an explicit answer line', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Which individuals should be prioritised for immediate genetic testing?')}
    ${paragraph('I:1 and I:2')}
    ${paragraph('I:2 and II:3', { bold: true })}
    ${paragraph('II:2 and II:3')}
    ${paragraph('II:3 and II:4')}
    ${paragraph('III:1, III:2 and III:3')}
    ${paragraph('Answer: B', { bold: true })}
    ${paragraph('Rationale - The mother and maternal grandmother should be tested first.')}
    ${paragraph('END')}
  </w:body></w:document>`);

  const question = analyzeAESOT(paragraphs, 'Example').questions[0]!;
  expect(question.optionLabels).toEqual(['A', 'B', 'C', 'D', 'E']);
  expect(question.type).toBe('single-select');
  expect(question.correctAnswerLabels).toEqual(['B']);
});

test('keeps a question whose answer line immediately follows the prompt as open-response', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. What syndrome does the patient have?')}
    ${paragraph('ANSWER: Klinefelter or XXY', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'Example');
  expect(analysis.questions[0]?.type).toBe('open-response');
  expect(analysis.questions[0]?.optionLabels).toEqual([]);
});

test('warns about an unlabelled option block that has no answer line instead of guessing it', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Which medical sequencing tests would detect this syndrome?')}
    ${paragraph('Non-invasive pre-natal testing')}
    ${paragraph('Whole genome sequencing')}
    ${paragraph('Exome sequencing')}
    ${paragraph('Targeted Sequencing')}
    ${paragraph('All of the above', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'Example');
  expect(analysis.questions[0]?.type).toBe('open-response');
  expect(analysis.questions[0]?.optionLabels).toEqual([]);
  expect(analysis.warnings.find((warning) => warning.includes('unlabelled option block'))).toContain('Q1');
});

test('does not turn a multi-paragraph stem into options when the answer is prose', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Explain the mechanism of the deficiency. (2 marks)')}
    ${paragraph('The patient is a 45-year-old man with a six-month history of fatigue.')}
    ${paragraph('His laboratory results show a macrocytic anaemia with a low serum level.')}
    ${paragraph('Answer: Impaired absorption of vitamin B12 due to loss of intrinsic factor A.', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const question = analyzeAESOT(paragraphs, 'Example').questions[0]!;
  expect(question.type).toBe('open-response');
  expect(question.optionLabels).toEqual([]);
  expect(question.correctAnswerLabels).toEqual([]);
});

test('does not invent a duplicate label when prose inside option A looks like an inline run', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Which statement is correct? (1 mark)')}
    ${paragraph('A. Hepatitis B. Vaccination prevents transmission')}
    ${paragraph('B. Something else', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const question = analyzeAESOT(paragraphs, 'Example').questions[0]!;
  expect(question.optionLabels).toEqual(['A', 'B']);
  expect(question.correctAnswerLabels).toEqual(['B']);
});

test('never derives options from an answer or rationale paragraph', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Which one? (1 mark)')}
    ${paragraph('X marks the spot')}
    ${paragraph('Y marks nothing', { bold: true })}
    ${paragraph('Rationale - A. is the first option B. is the second')}
    ${paragraph('END')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'Example');
  expect(analysis.questions[0]?.optionLabels).toEqual([]);
  expect(analysis.questions[0]?.correctAnswerLabels).toEqual([]);
  expect(analysis.warnings.find((warning) => warning.includes('unlabelled option block'))).toContain('Q1');
});

test('treats a fully bold collapsed option run as having no bold-derived answer key', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Pick one. (1 mark)')}
    ${paragraph('A. Alpha B. Beta C. Gamma', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const question = analyzeAESOT(paragraphs, 'Example').questions[0]!;
  expect(question.optionLabels).toEqual(['A', 'B', 'C']);
  expect(question.correctAnswerLabels).toEqual([]);
  expect(question.type).toBe('single-select');
});

test('warns instead of silently dropping an option block the guard cannot resolve', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. Which individuals should be tested? (1 mark)')}
    ${paragraph('I:1 and I:2')}
    ${paragraph('Rationale - this note sits before the answer line.')}
    ${paragraph('II:2 and II:3')}
    ${paragraph('Answer: B', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'Example');
  expect(analysis.questions[0]?.optionLabels).toEqual([]);
  expect(analysis.warnings.find((warning) => warning.includes('unlabelled option block'))).toContain('Q1');
});
