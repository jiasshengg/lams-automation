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

test('a declared figure replacement is compared against the document read the same way', () => {
  const documentXml = `<w:document><w:body>
    <w:p><w:r><w:t>Case 1</w:t></w:r></w:p>
    <w:p><w:r><w:t>Refer to the following blood films A to H.</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:blip r:embed="rId1"/></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>B A</w:t></w:r></w:p>
    <w:p><w:r><w:drawing><wp:inline><a:blip r:embed="rId1"/></wp:inline></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>1. Microcytosis</w:t></w:r></w:p>
    <w:p><w:r><w:t>Answer - A</w:t></w:r></w:p>
    <w:p><w:r><w:t>END</w:t></w:r></w:p>
  </w:body></w:document>`;
  const analysis = analyzeAESOT(extractSOTParagraphs(documentXml), 'Example');
  const draft = buildAEDraft(analysis, { sourceDocx: 'AE.docx' });
  const question = draft.nodes[0]!.questions[0]!;
  question.replaceSourceFigures = true;
  question.images = [{ path: 'films-page.png' }];

  expect(compareAEPlanToSOT(buildAEPlan(draft as never), analysis)).toEqual([]);

  // The declaration only excuses the figure. Changed words are still caught.
  const edited = JSON.parse(JSON.stringify(draft));
  edited.nodes[0].questions[0].prompt = edited.nodes[0].questions[0].prompt.replace('blood films A to H', 'blood films A to G');
  expect(compareAEPlanToSOT(buildAEPlan(edited), analysis).join(' ')).toContain('prompt differs');
});

test('a declared text replacement is applied, and compared against the document the same way', () => {
  // The document says "<insert videos>" where two videos belong. The reviewer supplies their
  // links; everything else in the prompt is still compared with the document.
  const documentXml = `<w:document><w:body>
    <w:p><w:r><w:t>Case 6</w:t></w:r></w:p>
    <w:p><w:r><w:t>Mr Kong fell in his kitchen.</w:t></w:r></w:p>
    <w:p><w:r><w:t>&lt;insert videos&gt;</w:t></w:r></w:p>
    <w:p><w:r><w:t>1. Which diagram applies?</w:t></w:r></w:p>
    <w:p><w:r><w:t>Answer: prose</w:t></w:r></w:p>
    <w:p><w:r><w:t>END</w:t></w:r></w:p>
  </w:body></w:document>`;
  const analysis = analyzeAESOT(extractSOTParagraphs(documentXml), 'Example');
  const draft = buildAEDraft(analysis, { sourceDocx: 'AE.docx' });
  draft.nodes[0]!.questions[0]!.promptReplacements = [
    { find: '<insert videos>', replaceWith: 'https://youtu.be/VY9L5tmSTas<br>https://youtu.be/wDOQFb1gpt4' }
  ];

  const plan = buildAEPlan(draft as never);
  expect(plan.nodes[0]!.questions[0]!.promptHtml).toContain('https://youtu.be/VY9L5tmSTas');
  expect(plan.nodes[0]!.questions[0]!.promptHtml).not.toContain('insert videos');
  expect(compareAEPlanToSOT(plan, analysis)).toEqual([]);

  // The declaration covers only the text it names; other edits are still reported.
  const edited = JSON.parse(JSON.stringify(draft));
  edited.nodes[0].questions[0].prompt = edited.nodes[0].questions[0].prompt.replace('Mr Kong fell', 'Mr Tan fell');
  expect(compareAEPlanToSOT(buildAEPlan(edited), analysis).join(' ')).toContain('prompt differs');
});
