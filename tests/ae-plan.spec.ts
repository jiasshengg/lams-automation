import { expect, test } from '@playwright/test';
import { buildAEPlan, formatAEPlanSummary } from '../src/ae/plan.js';

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
  expect(plan.nodes[0]?.description).toBe('AE Case 1');
  expect(plan.nodes[0]?.questions[0]).toEqual(
    expect.objectContaining({
      number: 1,
      marks: 4,
      answerRequired: true,
      prefixSequentialLetters: true,
      saveAsNewVersion: true,
      selectLatestVersion: true
    })
  );
  expect(plan.nodes[0]?.questions[0]?.promptHtml).toBe(
    '<p><strong><u>Case 1</u></strong></p><p><br></p><p>QUESTION 1</p><p><br></p><p>Which action is best?</p>'
  );
  expect(plan.nodes[0]?.questions[0]?.options).toEqual([
    { text: 'First option', creditPercent: 0 },
    { text: 'Correct option', creditPercent: 100 },
    { text: 'Third option', creditPercent: 0 }
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

test('rejects an MCQ without exactly one correct answer', () => {
  const input = validInput();
  input.nodes[0]!.questions[0]!.options![1]!.correct = false;
  expect(() => buildAEPlan(input)).toThrow('Question 1 must have exactly one correct answer; found 0');
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

test('accepts a leading AE gate that precedes the first AE node', () => {
  // Observed live: a TBL lesson can gate entry to its first AE node (the gate sits
  // after tRAT), which the strictly-between-nodes model could not express.
  const input = validInput() as Record<string, unknown>;
  const gates = input.gates as Array<Record<string, unknown>>;
  input.gates = [
    { title: 'AE Gate AE Case 1', beforeNodeTitle: 'AE Case 1', beforeQuestionNumber: 1 },
    ...gates
  ];

  const plan = buildAEPlan(input);
  expect(plan.requiredAENodes).toBe(2);
  expect(plan.requiredAEGates).toBe(2);
  expect(plan.gates.map((gate) => gate.title)).toEqual(['AE Gate AE Case 1', 'AE Gate Case 1 to Case 2 Question 3']);
  expect(plan.gates[0]?.afterNodeTitle ?? null).toBeNull();
  expect(formatAEPlanSummary(plan)).toContain('AE Gate AE Case 1: (lesson entry) -> AE Case 1 (question 1)');
});

test('rejects a leading AE gate that does not point at the first AE node', () => {
  const input = validInput() as Record<string, unknown>;
  const gates = input.gates as Array<Record<string, unknown>>;
  input.gates = [
    { title: 'AE Gate wrong', beforeNodeTitle: 'AE Case 2', beforeQuestionNumber: 3 },
    ...gates
  ];

  expect(() => buildAEPlan(input)).toThrow(/leading gate/i);
});
