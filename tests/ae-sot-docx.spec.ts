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
