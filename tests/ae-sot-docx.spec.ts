import { expect, test } from '@playwright/test';
import { analyzeAESOT, extractSOTParagraphs } from '../src/ae/sot-docx.js';

function paragraph(text: string, options: { bold?: boolean; drawing?: boolean } = {}): string {
  const bold = options.bold ? '<w:rPr><w:b/></w:rPr>' : '';
  // Case headings in a real SoT are bold and underlined; the helper keeps them plain
  // unless a test opts in, so structural rules stay independent of styling.
  const drawing = options.drawing ? '<w:drawing><wp:inline><a:blip r:embed="rId1"/></wp:inline></w:drawing>' : '';
  return `<w:p><w:r>${bold}<w:t>${text}</w:t>${drawing}</w:r></w:p>`;
}

test('extracts split runs, bold answer options, and image counts from Word XML', () => {
  const xml = `<w:document><w:body>
    <w:p><w:r><w:t>--- </w:t></w:r><w:r><w:t>BREAK ---</w:t></w:r></w:p>
    ${paragraph('B. Correct answer', { bold: true, drawing: true })}
  </w:body></w:document>`;

  expect(extractSOTParagraphs(xml)).toEqual([
    { text: '--- BREAK ---', html: '--- BREAK ---', bold: false, imageCount: 0, blankLinesBefore: 0, pageBreakBefore: false, indentTwips: 0 },
    { text: 'B. Correct answer', html: '<strong>B. Correct answer</strong>', bold: true, imageCount: 1, blankLinesBefore: 0, pageBreakBefore: false, indentTwips: 0 }
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

  // A number the document skips is not a missing question: LAMS numbers 1..N in order, so the
  // stem becomes question 2 and the difference is reported rather than guessed at.
  const skippedQuestion = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('1. First question?')}
    ${paragraph('--- BREAK ---')}
    ${paragraph('3. Third question?')}
    ${paragraph('END')}
  </w:body></w:document>`);
  const analysis = analyzeAESOT(skippedQuestion, 'Example');
  expect(analysis.questions.map((question) => question.number)).toEqual([1, 2]);
  expect(analysis.warnings.join(' ')).toContain('numbers question 2 as "3"');
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
    'AE Case 1 Q1-Case 2 Q2',
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

test('reads Q-prefixed stems, starred breaks, and a stem whose full stop was dropped', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('1. Microcytosis')}
    ${paragraph('Answer - A')}
    ${paragraph('2 Increased LDH, undetectable haptoglobin')}
    ${paragraph('Answer - C')}
    ${paragraph('--- BREAK ---')}
    ${paragraph('Case 7')}
    ${paragraph('Q3 to 5 relate to this case')}
    ${paragraph('Q3. Which ECG applies?')}
    ${paragraph('A. ECG A')}
    ${paragraph('B. ECG B')}
    ${paragraph('Answer: B')}
    ${paragraph('***** BREAK *****')}
    ${paragraph('Q4. Name these T waves.')}
    ${paragraph('*** BREAK ***')}
    ${paragraph('Q5. What is stent thrombosis?')}
    ${paragraph('4 more runs of the rhythm followed.')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  expect(analysis.breakMarkerCount).toBe(3);
  expect(analysis.nodes.map((node) => node.questionNumbers)).toEqual([[1, 2], [3], [4], [5]]);
  expect(analysis.nodes.map((node) => node.suggestedTitle)).toEqual(['AE Case 1 Q1-2', 'AE Case 7 Q3', 'AE Case 7 Q4', 'AE Case 7 Q5']);
  expect(analysis.questions[2]).toMatchObject({ type: 'single-select', correctAnswerLabels: ['B'] });
  // "Q3 to 5 relate…" is a reference, not a stem, so it stays case narrative.
  expect(analysis.nodes[1]?.contextHtml).toContain('Q3 to 5 relate to this case');
});

test('keeps text-box labels drawn on a figure out of the prose and gives each grouped picture a slot', () => {
  const box = (label: string) => `<wps:txbx><w:txbxContent><w:p><w:r><w:t>${label}</w:t></w:r></w:p></w:txbxContent></wps:txbx>`;
  const group = `<w:r><mc:AlternateContent><mc:Choice><w:drawing><wpg:wgp><pic:pic/>${box('2000X')}<pic:pic/>${box('B')}</wpg:wgp></w:drawing></mc:Choice>` +
    `<mc:Fallback><w:pict>${box('2000X')}</w:pict></mc:Fallback></mc:AlternateContent></w:r>`;
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('Refer to the following blood films.')}
    <w:p>${group}</w:p>
    ${paragraph('1. Microcytosis')}
    ${paragraph('END')}
  </w:body></w:document>`);

  expect(paragraphs.map((entry) => entry.text)).toEqual(['Case 1', 'Refer to the following blood films.', '', '1. Microcytosis', 'END']);
  expect(paragraphs[2]?.imageCount).toBe(2);
  expect(analyzeAESOT(paragraphs, 'Example').nodes[0]?.contextHtml).toEqual([
    'Case 1', 'Refer to the following blood films.', '{{image}}', '{{image}}'
  ]);
});

test('keeps free-standing label boxes as separate words and gives a picture inside a text line its slot', () => {
  const label = (text: string) => `<w:r><w:drawing><wps:txbx><w:txbxContent><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:txbxContent></wps:txbx></w:drawing></w:r>`;
  const picture = '<w:r><w:drawing><wp:inline><a:blip r:embed="rId1"/></wp:inline></w:drawing></w:r>';
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    <w:p>${label('B')}${label('A')}</w:p>
    <w:p>${picture}<w:r><w:t>From ASH Image Bank</w:t></w:r></w:p>
    ${paragraph('1. Microcytosis')}
    ${paragraph('END')}
  </w:body></w:document>`);

  expect(paragraphs[1]).toMatchObject({ text: 'B A', imageCount: 0 });
  expect(analyzeAESOT(paragraphs, 'Example').nodes[0]?.contextHtml).toEqual([
    'Case 1', 'B A', '{{image}}', 'From ASH Image Bank'
  ]);
});

test('counts a legacy VML picture that has no DrawingML version as a figure', () => {
  const paragraphs = extractSOTParagraphs(`<w:document><w:body>
    <w:p><w:r><w:pict><v:shape><v:imagedata r:id="rId5"/></v:shape></w:pict></w:r></w:p>
  </w:body></w:document>`);
  expect(paragraphs[0]?.imageCount).toBe(1);
});

test('keeps the lines between the stem and the options in the prompt', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 2')}
    ${paragraph('1. A 68 year old man was investigated for anaemia.')}
    ${paragraph('His serum iron studies gave the following results.')}
    <w:tbl><w:tr><w:tc>${paragraph('Serum iron')}</w:tc><w:tc>${paragraph('8 umol/L')}</w:tc></w:tr></w:tbl>
    ${paragraph('Which of the following is the MOST likely cause of his anaemia?')}
    ${paragraph('A. Thalassaemia minor')}
    ${paragraph('B. Iron deficiency anaemia', { bold: true })}
    ${paragraph('Answer - B')}
    ${paragraph('Rationale - Low MCV supports iron deficiency.')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  const prompt = analysis.questions[0]!;
  expect(prompt.bodyLines).toEqual([
    'His serum iron studies gave the following results.',
    '<table><tr><td>Serum iron</td><td>8 umol/L</td></tr></table>',
    'Which of the following is the MOST likely cause of his anaemia?'
  ]);
  // The answer key and rationale stay out of what the learner reads.
  expect(prompt.bodyLines.join(' ')).not.toContain('Rationale');
  expect(prompt.options.map((option) => option.html)).toEqual(['Thalassaemia minor', 'Iron deficiency anaemia']);
});

test('reads options the document declares inline as image labels', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 3')}
    ${paragraph('1. A 4-year-old boy was investigated for anaemia.')}
    ${paragraph('MCV 73 fL 71 - 85 fL')}
    ${paragraph('Which of the above electrophoresis tracings would BEST fit this case?')}
    ${paragraph('Select from above images: A, B, C, D')}
    ${paragraph('Answer - C')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  const question = analysis.questions[0]!;
  expect(question.type).toBe('single-select');
  expect(question.options.map((option) => option.html)).toEqual(['A', 'B', 'C', 'D']);
  expect(question.correctAnswerLabels).toEqual(['C']);
  // The lab line and the question sentence are still the learner's reading.
  expect(question.bodyLines).toContain('MCV 73 fL 71 - 85 fL');
});

test('reads a labelled figure sequence as the options', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 6')}
    ${paragraph('1. Which diagram depicts the injury?')}
    ${paragraph('', { drawing: true })}
    ${paragraph('Diagram A')}
    ${paragraph('', { drawing: true })}
    ${paragraph('Diagram B')}
    ${paragraph('', { drawing: true })}
    ${paragraph('Diagram C', { bold: true })}
    ${paragraph('Answer: Diagram C, central cord syndrome')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  const question = analysis.questions[0]!;
  expect(question.options.map((option) => option.html)).toEqual(['Diagram A', 'Diagram B', 'Diagram C']);
  expect(question.correctAnswerLabels).toEqual(['C']);
  expect(question.bodyLines).toEqual(['{{image}}', '{{image}}', '{{image}}']);
});

test('applies a label range declared for a group of matching questions', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('Match the following features described in questions 1-2 with the peripheral blood films (PBF) (A – D). There can be more than one film.')}
    ${paragraph('1. Microcytosis')}
    ${paragraph('Answer - A, D')}
    ${paragraph('2 Increased LDH, reduced haptoglobin')}
    ${paragraph('Answer - C, possibly D')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  // A hedged key ("possibly D") is ignored, so the second question has one answer.
  expect(analysis.questions.map((question) => question.type)).toEqual(['multiple-select', 'single-select']);
  expect(analysis.questions[0]!.options.map((option) => option.html)).toEqual(['A', 'B', 'C', 'D']);
  expect(analysis.questions[0]!.correctAnswerLabels).toEqual(['A', 'D']);
  expect(analysis.questions[1]!.correctAnswerLabels).toEqual(['C']);
});

const cell = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`;
const row = (...cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;

test('reads a matching set whose questions are the columns of a table', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('Match the features described in questions 1-2 with the peripheral blood films (PBF) (A – D).')}
    ${paragraph('1. Microcytosis')}
    ${paragraph('Answer - A')}
    ${paragraph('2. Inherited disorder')}
    ${paragraph('Answer - B')}
    ${paragraph('Next, match the full blood count features described in Q3 to Q4 with the peripheral blood films (PBF) (A – D). There can be more than one blood smear.')}
    <w:tbl>${row('Ref interval', 'Q3', 'Q4')}${row('Hb (g/dL)', '12.1', '9.5')}${row('Which PBF?', '', '')}</w:tbl>
    ${paragraph('Answer -')}
    <w:tbl>${row('Ref interval', 'Q3', 'Q4')}${row('Hb (g/dL)', '12.1', '9.5')}${row('Answer', 'A', 'C, possibly D')}</w:tbl>
    ${paragraph('END')}
  </w:body></w:document>`), 'Example', { columnQuestions: true });

  expect(analysis.questionCount).toBe(4);
  const [, , third, fourth] = analysis.questions;
  expect(third).toMatchObject({ number: 3, type: 'single-select', correctAnswerLabels: ['A'] });
  // "C, possibly D": the hedged D is ignored.
  expect(fourth).toMatchObject({ number: 4, type: 'single-select', correctAnswerLabels: ['C'] });
  expect(third!.options.map((option) => option.html)).toEqual(['A', 'B', 'C', 'D']);
  // Each column question shows the shared instruction and table, then names its own column.
  expect(third!.promptHtml).toContain('Q3');
  // Every column question repeats the instruction and the table it reads, because LAMS shows
  // each question on its own.
  expect(third!.leadInLines.join('\n')).toContain('<table>');
  expect(third!.leadInLines.join('\n')).toContain('Next, match the full blood count features');
  // The answer table stays out of what the learner reads.
  expect(analysis.questions.every((question) => !question.leadInLines.join('\n').includes('possibly'))).toBe(true);
});

test('renumbers a stem the document numbers again, and says so', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('1. First question?')}
    ${paragraph('A. One')}
    ${paragraph('B. Two', { bold: true })}
    ${paragraph('--- BREAK ---')}
    ${paragraph('Case 2')}
    ${paragraph('1. A question the document numbers 1 again?')}
    ${paragraph('A. One', { bold: true })}
    ${paragraph('B. Two')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  expect(analysis.questions.map((question) => question.number)).toEqual([1, 2]);
  expect(analysis.warnings.join(' ')).toContain('numbers question 2 as "1"');
});

test('refuses a column matching set whose answer table does not line up with its question table', () => {
  const sot = (answerHeader: string[]) => `<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('1. Microcytosis')}
    ${paragraph('Answer - A')}
    ${paragraph('Next, match the features described in Q2 to Q3 with the peripheral blood films (PBF) (A – D).')}
    <w:tbl>${row('Ref interval', 'Q2', 'Q3')}${row('Hb (g/dL)', '12.1', '9.5')}${row('Which PBF?', '', '')}</w:tbl>
    ${paragraph('Answer -')}
    <w:tbl>${row(...answerHeader)}${row('Answer', 'A', 'B')}</w:tbl>
    ${paragraph('END')}
  </w:body></w:document>`;

  // Q1 is printed before the matching instruction, so it states no options of its own.
  const aligned = analyzeAESOT(extractSOTParagraphs(sot(['Ref interval', 'Q2', 'Q3'])), 'Example', { columnQuestions: true });
  expect(aligned.questions.map((question) => question.correctAnswerLabels)).toEqual([[], ['A'], ['B']]);

  // The answer table names its columns in a different order, so which key belongs to which
  // question cannot be read from the position. The set is left to the reviewer instead.
  const shuffled = analyzeAESOT(extractSOTParagraphs(sot(['Ref interval', 'Q3', 'Q2'])), 'Example', { columnQuestions: true });
  expect(shuffled.questionCount).toBe(1);
  expect(shuffled.warnings.join(' ')).toContain('answer table does not line up');
});

test('a matching table is case reading by default, and questions only when asked for', () => {
  const sot = `<w:document><w:body>
    ${paragraph('Case 1')}
    ${paragraph('Match the features described in questions 1-2 with the peripheral blood films (PBF) (A – D).')}
    ${paragraph('1. Microcytosis')}
    ${paragraph('Answer - A')}
    ${paragraph('2. Inherited disorder')}
    ${paragraph('Answer - B')}
    ${paragraph('Next, match the full blood count features described in Q3 to Q4 with the peripheral blood films (PBF) (A – D).')}
    <w:tbl>${row('Ref interval', 'Q3', 'Q4')}${row('Hb (g/dL)', '12.1', '9.5')}</w:tbl>
    ${paragraph('Answer -')}
    <w:tbl>${row('Ref interval', 'Q3', 'Q4')}${row('Answer', 'A', 'B')}</w:tbl>
    ${paragraph('--- BREAK ---')}
    ${paragraph('Case 2')}
    ${paragraph('3. A 68 year old man was investigated for anaemia.')}
    ${paragraph('A. One')}
    ${paragraph('B. Two', { bold: true })}
    ${paragraph('END')}
  </w:body></w:document>`;

  // By default the document's own numbering stands: the table is reading for Case 1, and
  // question 3 is the one the document prints as "3.".
  const asPrinted = analyzeAESOT(extractSOTParagraphs(sot), 'Example');
  expect(asPrinted.questionCount).toBe(3);
  expect(asPrinted.nodes.map((node) => node.suggestedTitle)).toEqual(['AE Case 1 Q1-2', 'AE Case 2 Q3']);
  expect(asPrinted.questions[2]!.promptHtml).toContain('A 68 year old man');
  expect(asPrinted.warnings.join(' ')).toContain('--column-questions');

  const withColumns = analyzeAESOT(extractSOTParagraphs(sot), 'Example', { columnQuestions: true });
  expect(withColumns.questionCount).toBe(5);
  expect(withColumns.questions.map((question) => question.number)).toEqual([1, 2, 3, 4, 5]);
  expect(withColumns.questions[4]!.promptHtml).toContain('A 68 year old man');
});

test('a Case heading inside a question hands the case that follows to the next question', () => {
  // The document prints one question, its answer, and then the next case: heading, narrative, and
  // the figures that go with it. All of that introduces the question after it, not the one before.
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 5')}
    ${paragraph('1. Which drug would you recommend?')}
    ${paragraph('A. Hydroxychloroquine', { bold: true })}
    ${paragraph('B. Cyclosporin')}
    ${paragraph('Hydroxychloroquine directly interferes with TLR7/9 recognition of nucleic acids.')}
    ${paragraph('Case 6')}
    ${paragraph('Mr Kong, a 68-year-old man, fell in his kitchen.')}
    ${paragraph('<insert videos>')}
    ${paragraph('2. Which diagram shows the injury?')}
    ${paragraph('C. Diagram C', { bold: true })}
    ${paragraph('D. Diagram D')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  const [first, second] = analysis.questions;
  // The rationale under the options is not part of what the learner reads.
  expect(first!.bodyLines.join(' ')).not.toContain('Hydroxychloroquine directly interferes');
  expect(first!.leadInLines.join(' ') + first!.bodyLines.join(' ')).not.toContain('Mr Kong');
  // Mr Kong's case, and the video printed in it, lead into the question about him.
  expect(second!.leadInLines.join('\n')).toContain('Mr Kong, a 68-year-old man');
  expect(second!.leadInLines.join('\n')).toContain('&lt;insert videos&gt;');
  expect(second!.leadInLines.join('\n')).toContain('Case 6');
});

test('keeps figure labels under their figures, keeps a credit line, and drops answer-space rules', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Case 7')}
    ${paragraph('1. Which ECG applies?')}
    ${paragraph('', { drawing: true })}
    ${paragraph('ECG A.')}
    ${paragraph('', { drawing: true })}
    ${paragraph('ECG B.', { bold: true })}
    ${paragraph('Answer: B')}
    ${paragraph('Credit for above diagrams: http://www.orthobullets.com/spine/2008/incomplete-spinal-cord-injuries')}
    ${paragraph('2. What is stent thrombosis?')}
    ${paragraph('………………………………………………………………………………………………………………….')}
    ${paragraph('………………………………………………………………………………………………………………….')}
    ${paragraph('Answer: It is a thrombotic occlusion.')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  const [first, second] = analysis.questions;
  // The caption names the figure above it and is also what a learner picks, so it stays in both.
  expect(first!.bodyLines).toEqual(['{{image}}', 'ECG A.', '{{image}}', 'ECG B.']);
  expect(first!.options.map((option) => option.html)).toEqual(['ECG A.', 'ECG B.']);
  // A credit for the figures shown belongs with them, even though it follows the answer.
  expect(first!.bodyLines.concat(first!.creditLines).join('\n')).toContain('Credit for above diagrams');
  // The ruled lines are where a reader writes on paper; LAMS gives its own answer box.
  expect(second!.bodyLines.join(' ')).not.toContain('…');
  expect(second!.bodyLines).toEqual([]);
});

test('a tabbed results line is read as the columns it lays out', () => {
  // The document lays lab results out with tabs, not a table. A tab read as one space runs the
  // value into the reference range: "Hb 8.2 g/dL 13.6 - 16.6 g/dL".
  const paragraphs = extractSOTParagraphs(
    '<w:document><w:body><w:p><w:r><w:t>Hb</w:t><w:tab/><w:t>8.2 g/dL</w:t><w:tab/><w:t>13.6 – 16.6 g/dL</w:t></w:r></w:p></w:body></w:document>'
  );

  expect(paragraphs[0]!.html).toBe('<table data-layout="tabs"><tr><td>Hb</td><td>8.2 g/dL</td><td>13.6 – 16.6 g/dL</td></tr></table>');
  // Structure still reads the line the same way, whatever holds the columns apart.
  expect(paragraphs[0]!.text.replace(/\s+/g, ' ')).toBe('Hb 8.2 g/dL 13.6 – 16.6 g/dL');
});

test('an answer the key only hedges ("possibly H") is ignored', () => {
  const analysis = analyzeAESOT(extractSOTParagraphs(`<w:document><w:body>
    ${paragraph('Match the features with the films (A – H).')}
    ${paragraph('1. Increased LDH')}
    ${paragraph('Answer - C, E, F, G, possibly H')}
    ${paragraph('2. Inherited disorder')}
    ${paragraph('Answer - A, F, possibly C and G')}
    ${paragraph('3. Microcytosis')}
    ${paragraph('Answer - A, D')}
    ${paragraph('END')}
  </w:body></w:document>`), 'Example');

  const [first, second, third] = analysis.questions;
  expect(first!.correctAnswerLabels).toEqual(['C', 'E', 'F', 'G']);
  expect(first!.options.find((option) => option.label === 'H')!.correct).toBe(false);
  expect(second!.correctAnswerLabels).toEqual(['A', 'F']);
  expect(second!.options.filter((option) => option.correct).map((option) => option.label)).toEqual(['A', 'F']);
  expect(third!.correctAnswerLabels).toEqual(['A', 'D']);
  // Nothing is left for the reviewer to decide.
  expect(analysis.warnings.join(' ')).not.toMatch(/hedge/i);
});
