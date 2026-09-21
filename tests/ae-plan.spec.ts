import { expect, test } from '@playwright/test';
import { buildAEPlan, formatAEPlanSummary } from '../src/ae/plan.js';
import { TEMPLATE_LIBRARY_TITLES } from '../src/lams/ae-graph.js';

function validInput() {
  return {
    sourceLabel: 'FOM TBL06 AE Source of Truth',
    breakMarkerCount: 1,
    expectedTotalMarks: 16,
    nodes: [
      {
        title: 'AE Case 1',
        questions: [
          {
            number: 1,
            type: 'mcq',
            prompt: 'Case 1\n[4 marks]\nQUESTION 1\nWhich action is best?',
            options: [
              { text: 'A) First option', correct: false },
              { text: 'B) Correct option', correct: true },
              { text: 'C) Third option', correct: false }
            ]
          },
          {
            number: 2,
            type: 'essay',
            prompt: 'QUESTION 2\nExplain your reasoning.',
            marks: 8
          }
        ]
      },
      {
        title: 'AE Case 2',
        questions: [
          {
            number: 3,
            type: 'mcq',
            prompt: 'Case 2\n[X marks]\nQUESTION 3\nWhat should happen next?',
            marks: 4,
            options: [
              { text: 'A. Continue', correct: true },
              { text: 'B. Stop', correct: false }
            ]
          }
        ]
      }
    ],
    gates: [
      {
        title: 'AE Gate Case 1 to Case 2 Question 3',
        afterNodeTitle: 'AE Case 1',
        beforeNodeTitle: 'AE Case 2',
        beforeQuestionNumber: 3
      }
    ]
  };
}

test('builds a deterministic AE execution plan from validated structured input', () => {
  const input = validInput();
  delete input.nodes[1]!.questions[0]!.marks;

  const plan = buildAEPlan(input);

  expect(plan.requiredAENodes).toBe(2);
  expect(plan.requiredAEGates).toBe(1);
  expect(plan.totalMarks).toBe(16);
  expect(plan.nodes[0]?.description).toBe('');
  expect(plan.nodes[0]?.questions[0]).toEqual(
    expect.objectContaining({
      number: 1,
      marks: 4,
      answerRequired: true,
      prefixSequentialLetters: true,
      multipleAnswersAllowed: false,
      saveAsNewVersion: true,
      selectLatestVersion: true
    })
  );
  expect(plan.nodes[0]?.questions[0]?.promptHtml).toBe(
    '<div><strong><u>Case 1</u></strong></div><div><br></div><div>QUESTION 1</div><div><br></div><div>Which action is best?</div>'
  );
  expect(plan.nodes[0]?.questions[0]?.options).toEqual([
    { text: 'First option', html: 'First option', creditPercent: 0 },
    { text: 'Correct option', html: 'Correct option', creditPercent: 100 },
    { text: 'Third option', html: 'Third option', creditPercent: 0 }
  ]);
  expect(plan.activitySettings).toEqual({
    shuffleQuestions: false,
    shuffleAnswers: false,
    questionNumbering: false,
    displayAllAfterCompletion: true,
    questionFeedback: false,
    discloseAnswersInMonitor: true,
    peerRating: false,
    answerJustification: true,
    burningQuestions: false,
    focusTracking: false,
    discussionNotepad: false,
    discussionSentimentVoting: true,
    confidenceLevel: false,
    useSelectLeaderToolLeaders: true,
    attempts: 1,
    passingMark: null
  });
});

test('allows explicit SoT overrides for marks, attempts, and passing mark', () => {
  const input = validInput();
  input.expectedTotalMarks = 16;
  input.nodes[1]!.questions[0]!.marks = 4;
  Object.assign(input, { attempts: 2, passingMark: 10 });

  const plan = buildAEPlan(input);

  expect(plan.activitySettings.attempts).toBe(2);
  expect(plan.activitySettings.passingMark).toBe(10);
  expect(plan.totalMarks).toBe(16);
});

test('rejects an AE node count that does not equal breaks plus one', () => {
  const input = validInput();
  input.breakMarkerCount = 2;
  expect(() => buildAEPlan(input)).toThrow('breakMarkerCount 2 requires 3 AE nodes; found 2');
});

test('rejects non-sequential question numbers', () => {
  const input = validInput();
  input.nodes[1]!.questions[0]!.number = 4;
  expect(() => buildAEPlan(input)).toThrow('Question numbers must be sequential from 1; expected 3, found 4');
});

test('rejects an MCQ without a correct answer', () => {
  const input = validInput();
  input.nodes[0]!.questions[0]!.options![1]!.correct = false;
  expect(() => buildAEPlan(input)).toThrow('Question 1 must have at least one correct answer');
});

test('supports multiple correct answers with split credit', () => {
  const input = { ...validInput(), multipleAnswerCredit: 'split' };
  input.nodes[0]!.questions[0]!.options![0]!.correct = true;

  const question = buildAEPlan(input).nodes[0]!.questions[0]!;
  expect(question.multipleAnswersAllowed).toBe(true);
  expect(question.options).toEqual([
    { text: 'First option', html: 'First option', creditPercent: 50 },
    { text: 'Correct option', html: 'Correct option', creditPercent: 50 },
    { text: 'Third option', html: 'Third option', creditPercent: 0 }
  ]);
});

test('gives every correct answer 100% with full credit', () => {
  const input = { ...validInput(), multipleAnswerCredit: 'full' };
  input.nodes[0]!.questions[0]!.options![0]!.correct = true;

  const question = buildAEPlan(input).nodes[0]!.questions[0]!;
  expect(question.multipleAnswersAllowed).toBe(true);
  expect(question.options.map((option) => option.creditPercent)).toEqual([100, 100, 0]);
});

test('refuses multiple correct answers until the user chooses how to credit them', () => {
  const input = validInput();
  input.nodes[0]!.questions[0]!.options![0]!.correct = true;

  expect(() => buildAEPlan(input)).toThrow('Question 1 has 2 correct answers. Ask the user whether to split the credit');
  expect(() => buildAEPlan({ ...input, multipleAnswerCredit: 'half' })).toThrow('multipleAnswerCredit must be "split" or "full"');
});

test('opens the stem with an all-caps QUESTION heading and drops parenthesised marks', () => {
  const input = validInput();
  const questions = input.nodes[0]!.questions;
  questions[0]!.prompt = 'Case 1\nA patient reports:\n1. Swelling\n1. Which action is best? ( 2 marks )';
  questions[1]!.prompt = 'Question 2:\n2. Explain your reasoning. (2 mark)';

  const plan = buildAEPlan(input);
  // The narrative's own "1." list item precedes the stem, so only the stem is renumbered.
  expect(plan.nodes[0]!.questions[0]!.promptHtml).toBe(
    '<div><strong><u>Case 1</u></strong></div><div><br></div><div>A patient reports:</div><div>1. Swelling</div>' +
      '<div>QUESTION 1</div><div><br></div><div>Which action is best?</div>'
  );
  expect(plan.nodes[0]!.questions[1]!.promptHtml).toBe(
    '<div>QUESTION 2</div><div><br></div><div>Explain your reasoning.</div>'
  );
});

test('supports explicit multiple-answer weights and rejects invalid totals', () => {
  const input = validInput();
  const options = input.nodes[0]!.questions[0]!.options! as Array<Record<string, unknown>>;
  Object.assign(options[0]!, { correct: true, weight: 60 });
  Object.assign(options[1]!, { weight: 40 });

  expect(buildAEPlan(input).nodes[0]!.questions[0]!.options.map((option) => option.creditPercent)).toEqual([60, 40, 0]);
  options[1]!.weight = 30;
  expect(() => buildAEPlan(input)).toThrow('Question 1 correct-answer weights must total 100; found 90');
});

test('rejects incomplete multiple-answer weights and credit on an incorrect option', () => {
  const input = validInput();
  const options = input.nodes[0]!.questions[0]!.options! as Array<Record<string, unknown>>;
  Object.assign(options[0]!, { correct: true, weight: 60 });
  expect(() => buildAEPlan(input)).toThrow('must supply a weight for every correct answer');

  options[1]!.weight = 40;
  options[2]!.weight = 10;
  expect(() => buildAEPlan(input)).toThrow('option 3 is incorrect and must have weight 0');
});

test('rejects a total that differs from the SoT expectation', () => {
  const input = validInput();
  input.expectedTotalMarks = 99;
  expect(() => buildAEPlan(input)).toThrow('Expected total marks 99; calculated 16');
});

test('rejects a gate that does not describe the adjacent AE nodes', () => {
  const input = validInput();
  input.gates[0]!.beforeNodeTitle = 'AE Case 99';
  expect(() => buildAEPlan(input)).toThrow('Gate 1 must connect "AE Case 1" to "AE Case 2"');
});

test('formats a preflight summary with counts, marks, nodes, and gates', () => {
  const plan = buildAEPlan(validInput());
  expect(formatAEPlanSummary(plan)).toContain('AE preflight: PASS');
  expect(formatAEPlanSummary(plan)).toContain('Nodes: 2 | Gates: 1 | Questions: 3 | Marks: 16');
  expect(formatAEPlanSummary(plan)).toContain('AE Case 1: questions 1–2');
  expect(formatAEPlanSummary(plan)).toContain('AE Gate Case 1 to Case 2 Question 3');
});

test('rejects an AE gate that precedes the first AE node', () => {
  // Documented process: the number of AE gates equals the number of SoT breaks and the
  // number of AE nodes is breaks + 1, so the first AE node is never gated. A lesson
  // with a leading gate is non-conforming and must be reported, not accepted.
  const input = validInput() as Record<string, unknown>;
  const gates = input.gates as Array<Record<string, unknown>>;
  input.gates = [
    { title: 'AE Gate AE Case 1', beforeNodeTitle: 'AE Case 1', beforeQuestionNumber: 1 },
    ...gates
  ];

  expect(() => buildAEPlan(input)).toThrow(/requires 1 AE gates; found 2|afterNodeTitle/i);
});

test('AE activities carry no description unless one is supplied', () => {
  const plan = buildAEPlan(validInput());
  expect(plan.nodes.map((node) => node.description)).toEqual(['', '']);
});

test('honors an explicit node description and rejects an empty one', () => {
  const input = validInput() as Record<string, unknown>;
  const nodes = input.nodes as Array<Record<string, unknown>>;
  nodes[0]!.description = 'Case 1: A Patient with Changing Antibiotic Exposure';
  const plan = buildAEPlan(input);
  expect(plan.nodes[0]!.description).toBe('Case 1: A Patient with Changing Antibiotic Exposure');
  expect(plan.nodes[1]!.description).toBe('');

  nodes[0]!.description = '   ';
  expect(() => buildAEPlan(input)).toThrow('nodes[0].description');
});

test('marks MCQ questions for sequential answer letters and essays against it', () => {
  const plan = buildAEPlan(validInput());
  const questions = plan.nodes.flatMap((node) => node.questions);
  expect(questions.map((question) => `${question.type}:${question.prefixSequentialLetters}`))
    .toEqual(['mcq:true', 'essay:false', 'mcq:true']);
});

test('carries Source-of-Truth emphasis into the prompt and options and escapes anything else', () => {
  const input = validInput();
  input.nodes[0]!.questions[0]!.prompt =
    'Case 1: <u>Changing exposure</u>\n1. A sample contains 10<sup>9</sup> molecules of <em>PK-101</em>? <script>x</script>';
  input.nodes[0]!.questions[0]!.options = [
    { text: 'A. <strong>600</strong> mg', correct: true },
    { text: 'I:1 and I:2', correct: false }
  ];

  const question = buildAEPlan(input).nodes[0]!.questions[0]!;
  expect(question.promptHtml).toBe(
    // The Source-of-Truth already styled this heading, so it keeps its own emphasis.
    '<div>Case 1: <u>Changing exposure</u></div><div><br></div>' +
    '<div>QUESTION 1</div><div><br></div><div>A sample contains 10<sup>9</sup> molecules of <em>PK-101</em>? &lt;script&gt;x&lt;/script&gt;</div>'
  );
  expect(question.options).toEqual([
    { text: '600 mg', html: '<strong>600</strong> mg', creditPercent: 100 },
    { text: 'I:1 and I:2', html: 'I:1 and I:2', creditPercent: 0 }
  ]);
});

test('still applies the house bold-underline to an unformatted Case heading', () => {
  const input = validInput();
  input.nodes[0]!.questions[0]!.prompt = 'Case 1\nWhich action is best?';
  expect(buildAEPlan(input).nodes[0]!.questions[0]!.promptHtml).toBe(
    '<div><strong><u>Case 1</u></strong></div><div><br></div><div>Which action is best?</div>'
  );
});

test('accepts reviewed image placement and captions and rejects an unknown placement', () => {
  const input = validInput() as Record<string, unknown>;
  const question = (input.nodes as Array<Record<string, unknown>>)[0]!.questions as Array<Record<string, unknown>>;
  question[0]!.images = [{ path: 'pedigree.png', placement: 'before', caption: '<strong>Figure 1.</strong> Pedigree' }];
  expect(buildAEPlan(input).nodes[0]!.questions[0]!.images).toEqual([
    { path: 'pedigree.png', placement: 'before', caption: '<strong>Figure 1.</strong> Pedigree' }
  ]);

  (question[0]!.images as Array<Record<string, unknown>>)[0]!.placement = 'beside';
  expect(() => buildAEPlan(input)).toThrow('placement must be "before" or "after"');
});

test('uses the spelling LAMS gives each toolkit template', () => {
  // The gate template's title is lower case in the DOM; CSS attribute matching is case-sensitive,
  // so "Gate" silently matches nothing and gate creation times out.
  expect(TEMPLATE_LIBRARY_TITLES.Gate).toBe('gate');
  expect(TEMPLATE_LIBRARY_TITLES.Assessment).toBe('Assessment');
});

// The grid style the renderer writes on every cell, because LAMS's stylesheet zeroes td borders.
const CELL = 'border:1px solid #000;padding:0 7px;vertical-align:top;line-height:1.15';

test('carries a Source-of-Truth table into the prompt as a table', () => {
  const plan = buildAEPlan({
    sourceLabel: 'Clinical Pharmacokinetics',
    breakMarkerCount: 0,
    nodes: [{
      title: 'AE Case 1 Q1',
      questions: [{
        number: 1,
        type: 'mcq',
        prompt: 'Her data are summarised below.\n<table><tr><td width="34%"><strong>Parameter</strong></td><td width="66%">Finding</td></tr><tr><td>Body weight</td><td>60 kg</td></tr></table>\n1. What loading dose is required?',
        options: [{ text: 'A. 300 mg', correct: true }, { text: 'B. 600 mg', correct: false }]
      }]
    }],
    gates: []
  });
  const html = plan.nodes[0]!.questions[0]!.promptHtml;
  // Every cell is a td: Word styles its header row with bold runs, not a th, so it stays
  // left-aligned, and the document's column proportions carry over.
  expect(html).toContain(`<tr><td width="34%" style="${CELL}"><strong>Parameter</strong></td><td width="66%" style="${CELL}">Finding</td></tr>`);
  expect(html).toContain(`<tr><td style="${CELL}">Body weight</td><td style="${CELL}">60 kg</td></tr>`);
  expect(html).not.toContain('<th');
  // The table is its own block, never wrapped in a div or escaped.
  expect(html).not.toContain('&lt;table&gt;');
  expect(html).not.toContain('<div><table');
});

test('a reviewed table cannot smuggle styling through its cell attributes', () => {
  const plan = buildAEPlan({
    sourceLabel: 'Clinical Pharmacokinetics',
    breakMarkerCount: 0,
    nodes: [{
      title: 'AE Case 1 Q1',
      questions: [{
        number: 1,
        type: 'mcq',
        prompt: '<table><tr><td width="34%" style="color:red" onclick="x()">Parameter</td></tr></table>\n1. Which dose? (4 marks)',
        options: [{ text: 'A. 300 mg', correct: true }, { text: 'B. 600 mg', correct: false }]
      }]
    }],
    gates: []
  });
  const html = plan.nodes[0]!.questions[0]!.promptHtml;
  // The width proportion survives because it is the document's own layout; the only style is
  // the fixed grid the renderer writes itself.
  expect(html).toContain(`<td width="34%" style="${CELL}">Parameter</td>`);
  expect(html).not.toContain('color:red');
  expect(html).not.toContain('onclick');
});

test('drops a full stop printed after a mark annotation only when the sentence already ended', () => {
  const input = validInput();
  const questions = input.nodes[0]!.questions;
  questions[0]!.prompt = 'QUESTION 1\nWhich THREE changes are expected? Select THREE answers. (4 marks).';
  questions[1]!.prompt = 'QUESTION 2\nExplain your reasoning (4 marks).';

  const plan = buildAEPlan(input);
  expect(plan.nodes[0]!.questions[0]!.promptHtml).toContain('<div>Which THREE changes are expected? Select THREE answers.</div>');
  expect(plan.nodes[0]!.questions[1]!.promptHtml).toContain('<div>Explain your reasoning.</div>');
});

test('writes a web address in the prompt as a clickable link', () => {
  const input = validInput();
  input.nodes[0]!.questions[1]!.prompt = 'QUESTION 2\nRead https://example.test/paper?a=1&b=2. Then explain.';

  expect(buildAEPlan(input).nodes[0]!.questions[1]!.promptHtml).toContain(
    '<div>Read <a href="https://example.test/paper?a=1&amp;b=2">https://example.test/paper?a=1&amp;b=2</a>. Then explain.</div>'
  );
});
