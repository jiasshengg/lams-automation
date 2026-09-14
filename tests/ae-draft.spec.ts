import { expect, test } from '@playwright/test';
import { buildAEDraft } from '../src/ae/draft.js';
import { buildAEPlan } from '../src/ae/plan.js';
import { analyzeAESOT, extractSOTParagraphs } from '../src/ae/sot-docx.js';

function sot(): ReturnType<typeof analyzeAESOT> {
  const paragraph = (text: string, bold = false) =>
    `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t>${text}</w:t></w:r></w:p>`;
  return analyzeAESOT(
    extractSOTParagraphs(`<w:document><w:body>
      ${paragraph('Module: Clinical Pharmacology')}
      ${paragraph('Application title: Clinical Pharmacokinetics')}
      ${paragraph('Case 1: A Patient with Changing Antibiotic Exposure')}
      ${paragraph('Ms Tan is a 67-year-old woman admitted with severe pneumonia.')}
      ${paragraph('1. What loading dose is required? (4 marks)')}
      ${paragraph('A. 300 mg')}
      ${paragraph('B. 600 mg', true)}
      ${paragraph('Answer - B', true)}
      ${paragraph('--- BREAK ---')}
      ${paragraph('Case 2')}
      ${paragraph('2. Explain your reasoning.')}
      ${paragraph('END')}
    </w:body></w:document>`),
    'fallback'
  );
}

test('transcribes node titles, case context, and answer keys into a reviewable draft', () => {
  const draft = buildAEDraft(sot(), { sourceDocx: 'AE SOT.docx' });

  expect(draft.sourceLabel).toBe('Clinical Pharmacokinetics');
  expect(draft.sourceDocx).toBe('AE SOT.docx');
  expect(draft.nodes.map((node) => node.title)).toEqual(['AE Case 1 Q1', 'AE Case 2 Q2']);
  // Front matter is dropped; the case narrative leads the node's first question.
  expect(draft.nodes[0]!.questions[0]!.prompt).toBe(
    'Case 1: A Patient with Changing Antibiotic Exposure\n' +
    'Ms Tan is a 67-year-old woman admitted with severe pneumonia.\n' +
    '1. What loading dose is required? (4 marks)'
  );
  expect(draft.nodes[0]!.questions[0]).toMatchObject({
    type: 'mcq',
    marks: 4,
    options: [
      { text: '300 mg', correct: false },
      { text: '600 mg', correct: true }
    ]
  });
  expect(draft.nodes[1]!.questions[0]).toMatchObject({ type: 'essay' });
  expect(draft.gates).toEqual([
    {
      title: 'AE Gate before Q2',
      afterNodeTitle: 'AE Case 1 Q1',
      beforeNodeTitle: 'AE Case 2 Q2',
      beforeQuestionNumber: 2
    }
  ]);
});

test('the draft preflights without edits when the Source-of-Truth is unambiguous', () => {
  const plan = buildAEPlan(buildAEDraft(sot()));
  expect(plan.requiredAENodes).toBe(2);
  expect(plan.nodes[0]!.questions[0]!.promptHtml).toContain('<strong><u>Case 1: A Patient');
  expect(plan.nodes[0]!.description).toBe('');
});

test('flags a selectable question whose answer key the document never states', () => {
  const analysis = sot();
  analysis.questions[0]!.options.forEach((option) => { option.correct = false; });
  const question = buildAEDraft(analysis).nodes[0]!.questions[0]!;
  expect(question.TODO_answerKey).toContain('mark the correct option');
});
