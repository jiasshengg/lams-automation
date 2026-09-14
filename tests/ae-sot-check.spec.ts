import { expect, test } from '@playwright/test';
import { buildAEDraft } from '../src/ae/draft.js';
import { buildAEPlan } from '../src/ae/plan.js';
import { compareAEPlanToSOT } from '../src/ae/sot-check.js';
import { analyzeAESOT, extractSOTParagraphs } from '../src/ae/sot-docx.js';

const paragraph = (text: string, bold = false) => `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t>${text}</w:t></w:r></w:p>`;

function analysis() {
  return analyzeAESOT(
    extractSOTParagraphs(`<w:document><w:body>
      ${paragraph('Case 1: A Patient')}
      ${paragraph('Ms Tan is admitted.')}
      ${paragraph('1. What dose? (4 marks)')}
      ${paragraph('A. 300 mg')}
      ${paragraph('B. 600 mg', true)}
      ${paragraph('--- BREAK ---')}
      ${paragraph('2. Explain.')}
      ${paragraph('A. Yes')}
      ${paragraph('B. No')}
      ${paragraph('END')}
    </w:body></w:document>`),
    'fallback'
  );
}

/** A reviewer resolves answer keys, which the comparison deliberately ignores. */
function reviewedDraft() {
  const draft = buildAEDraft(analysis());
  const second = draft.nodes[1]!.questions[0]!;
  second.options![0]!.correct = true;
  delete second.TODO_answerKey;
  return draft;
}

test('a plan generated from the Source-of-Truth matches it, even with answer keys resolved', () => {
  expect(compareAEPlanToSOT(buildAEPlan(reviewedDraft()), analysis())).toEqual([]);
});

test('reports a node title, prompt, or option that drifted from the Source-of-Truth', () => {
  const draft = reviewedDraft();
  draft.nodes[0]!.title = 'AE Case 1';
  draft.gates[0]!.afterNodeTitle = 'AE Case 1';
  draft.nodes[0]!.questions[0]!.prompt = 'Case 1\n1. What dose? (4 marks)';
  draft.nodes[1]!.questions[0]!.options![1]!.text = 'Maybe';

  const differences = compareAEPlanToSOT(buildAEPlan(draft), analysis());

  expect(differences).toHaveLength(3);
  expect(differences[0]).toContain('Node 1 title is "AE Case 1"; the Source-of-Truth names it "AE Case 1 Q1"');
  expect(differences[1]).toContain('Question 1 prompt differs');
  expect(differences[2]).toContain('Question 2 option 2 differs');
});

test('reports a different number of nodes or questions', () => {
  const draft = reviewedDraft();
  const merged = { ...draft, breakMarkerCount: 0, gates: [], nodes: [{ title: 'AE Case 1 Q1-2', questions: draft.nodes.flatMap((node) => node.questions) }] };
  expect(compareAEPlanToSOT(buildAEPlan(merged), analysis())[0]).toContain('has 1 AE node; the Source-of-Truth has 2');
});
