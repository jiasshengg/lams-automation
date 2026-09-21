import { expect, test } from '@playwright/test';
import { analyzeAESOT, extractSOTParagraphs } from '../src/ae/sot-docx.js';

function paragraph(text: string, options: { bold?: boolean; drawing?: boolean } = {}): string {
  const bold = options.bold ? '<w:rPr><w:b/></w:rPr>' : '';
  // Case headings in a real SoT are bold and underlined; the helper keeps them plain
  // unless a test opts in, so structural rules stay independent of styling.
  const drawing = options.drawing ? '<w:drawing><wp:inline/></w:drawing>' : '';
  return `<w:p><w:r>${bold}<w:t>${text}</w:t>${drawing}</w:r></w:p>`;
}

test('extracts split runs, bold answer options, and image counts from Word XML', () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>--- </w:t></w:r><w:r><w:t>BREAK ---</w:t></w:r></w:p>
    ${paragraph('B. Correct answer', { bold: true, drawing: true })}
  </w:body></w:document>`;

  expect(extractSOTParagraphs(xml)).toEqual([
    { text: '--- BREAK ---', html: '--- BREAK ---', bold: false, imageCount: 0, blankLinesBefore: 0, pageBreakBefore: false },
    { text: 'B. Correct answer', html: '<strong>B. Correct answer</strong>', bold: true, imageCount: 1, blankLinesBefore: 0, pageBreakBefore: false }
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
      suggestedTitle: 'AE Gate AE Case 1 Q2'
    },
    {
      index: 2,
      afterNodeIndex: 2,
      beforeNodeIndex: 3,
      beforeQuestionNumber: 3,
      suggestedTitle: 'AE Gate AE Case 1 Q3'
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
  expect(analysis.reviewRequired.join('\n')).toContain('multiple-select questions Q2');
  expect(analysis.warnings.join('\n')).not.toContain('requires exactly one correct');
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

function styledParagraph(runs: { text: string; tags?: string[] }[]): string {
  const body = runs
    .map(({ text, tags = [] }) => {
      const vertical: Record<string, string> = { sup: 'superscript', sub: 'subscript' };
      const properties = tags
        .map((tag) => (vertical[tag] ? `<w:vertAlign w:val="${vertical[tag]}"/>` : `<w:${tag}/>`))
        .join('');
      return `<w:r><w:rPr>${properties}</w:rPr><w:t>${text}</w:t></w:r>`;
    })
    .join('');
  return `<w:p>${body}</w:p>`;
}

test('names each AE node from its Case headings and question range', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('1. First question?')}
    ${paragraph('A. Wrong')}
    ${paragraph('B. Right', { bold: true })}
    ${paragraph('Case 2')}
    ${paragraph('2. Second question?')}
    ${paragraph('A. Wrong')}
    ${paragraph('B. Right', { bold: true })}
    ${paragraph('--- BREAK ---')}
    ${paragraph('Case 3')}
    ${paragraph('3. Third question?')}
    ${paragraph('4. Fourth question?')}
    ${paragraph('--- BREAK ---')}
    ${paragraph('5. Fifth question?')}
    ${paragraph('END')}
  </w:body></w:document>`);

  const analysis = analyzeAESOT(paragraphs, 'Example');
  expect(analysis.nodes.map((node) => node.suggestedTitle)).toEqual([
    'AE Case 1 Q1 to Case 2 Q2',
    'AE Case 3 Q3-4',
    // A node that continues the previous case states no heading of its own.
    'AE Case 3 Q5'
  ]);
});

test('omits the Case prefix and warns when a question sits outside any Case heading', () => {
  const analysis = analyzeAESOT(
    extractSOTParagraphs(`<w:document><w:body>
      ${paragraph('1. Only question?')}
      ${paragraph('END')}
    </w:body></w:document>`),
    'Example'
  );
  expect(analysis.nodes[0]?.suggestedTitle).toBe('AE Q1');
  expect(analysis.warnings.join('\n')).toContain('outside any numbered Case heading');
});

test('preserves underline, superscript, and italics observed in the question stem', () => {
  const analysis = analyzeAESOT(
    extractSOTParagraphs(`<w:document><w:body>
      ${paragraph('Case 1')}
      ${styledParagraph([
        { text: '1. A sample contains 10' },
        { text: '9', tags: ['sup'] },
        { text: ' molecules. For this ' },
        { text: 'highly albumin-bound', tags: ['u'] },
        { text: ' drug, which concentration may increase?' }
      ])}
      ${paragraph('A. The bound concentration')}
      ${paragraph('B. The unbound concentration', { bold: true })}
      ${paragraph('END')}
    </w:body></w:document>`),
    'Example'
  );
  expect(analysis.questions[0]?.promptHtml).toBe(
    '1. A sample contains 10<sup>9</sup> molecules. For this <u>highly albumin-bound</u> drug, which concentration may increase?'
  );
});

test('never copies the bold Word uses to mark the answer key into the option text', () => {
  const analysis = analyzeAESOT(
    extractSOTParagraphs(`<w:document><w:body>
      ${paragraph('Case 1')}
      ${paragraph('1. Which concentration may increase?')}
      ${paragraph('A. The bound concentration')}
      ${paragraph('B. The unbound concentration', { bold: true })}
      ${paragraph('END')}
    </w:body></w:document>`),
    'Example'
  );
  expect(analysis.questions[0]?.options).toEqual([
    { label: 'A', html: 'The bound concentration', correct: false },
    { label: 'B', html: 'The unbound concentration', correct: true }
  ]);
});

test('reads the case narrative before a node as its first question context', () => {
  const analysis = analyzeAESOT(
    extractSOTParagraphs(`<w:document><w:body>
      ${paragraph('Module: Example module')}
      ${paragraph('Case 1')}
      ${paragraph('1. First question?')}
      ${paragraph('--- BREAK ---')}
      ${paragraph('The team reviews other changes.')}
      ${paragraph('2. Second question?')}
      ${paragraph('END')}
    </w:body></w:document>`),
    'Example'
  );
  // Context is reproduced verbatim; the bold-underline house style is applied later,
  // and only to a Case heading the Source-of-Truth left unformatted.
  expect(analysis.nodes[0]?.contextHtml).toEqual(['Case 1']);
  expect(analysis.nodes[1]?.contextHtml).toEqual(['The team reviews other changes.']);
});
