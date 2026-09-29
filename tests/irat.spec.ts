import { expect, test } from '@playwright/test';
import type { IratRequest } from '../src/config.js';
import {
  createIratPlan,
  executeIratAutomation,
  type IratEditor,
  type IratObservedState
} from '../src/lams/irat.js';

const request: IratRequest = {
  gate: {
    name: 'iRAT Gate',
    description: 'iRAT Gate',
    type: 'password',
    dynamicPassword: true,
    rotationSeconds: 10
  },
  activityName: 'iRAT',
  teamSetupName: 'Team Setup',
  questions: [
    {
      title: 'Question 1',
      marks: 1,
      type: 'multiple-choice',
      content: 'Question content',
      mandatory: true,
      answers: [
        { text: 'Correct', correct: true, weight: 100 },
        { text: 'Incorrect', correct: false, weight: 0 }
      ]
    }
  ],
  advanced: {
    shuffleQuestions: true,
    questionsNumbering: true,
    shuffleAnswers: true,
    displayAllQuestions: true,
    displayAllAfterCompletion: true,
    answerJustification: true,
    confidenceLevels: true
  }
};

test('dry run inspects but performs no iRAT writes', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);

  const result = await executeIratAutomation(editor, request, { commit: false });

  expect(result.committed).toBe(false);
  expect(calls).toEqual(['inspect']);
});

test('commit applies gate, grouping, questions, answer-required, advanced settings, print verification, then save', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);

  const result = await executeIratAutomation(editor, request, { commit: true });

  expect(result.committed).toBe(true);
  expect(result.deletedQuestions).toEqual([]);
  expect(result.updatedQuestions).toEqual(['Question 1']);
  expect(calls).toEqual([
    'inspect',
    'gate:iRAT Gate',
    'team:Team Setup',
    'question:Question 1',
    // Answer required is set once the last question editor has closed: toggling it while
    // questions are still being saved loses the flag to LAMS's reference-list rebuild.
    'required:Question 1',
    'advanced',
    'print',
    'save'
  ]);
});

test('resume skips only a question whose immutable live version and request hash still match', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);
  const inspect = editor.inspect.bind(editor);
  editor.inspect = async () => ({
    ...await inspect(),
    questions: [{ title: 'Question 1', type: 'multiple-choice', mandatory: true, currentUid: '103', currentLabel: 'Version 3' }]
  });
  const result = await executeIratAutomation(editor, request, {
    commit: true,
    resumeQuestions: { 'Question 1': { currentUid: '103', currentLabel: 'Version 3', requestHash: 'same' } },
    questionHash: () => 'same'
  });
  expect(result.resumedQuestions).toEqual(['Question 1']);
  expect(result.updatedQuestions).toEqual([]);
  expect(calls).not.toContain('question:Question 1');
  expect(calls.at(-1)).toBe('save');
});

test('checkpoint conflict stops before every mutation', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);
  const inspect = editor.inspect.bind(editor);
  editor.inspect = async () => ({
    ...await inspect(),
    questions: [{ title: 'Question 1', type: 'multiple-choice', mandatory: true, currentUid: '104', currentLabel: 'Version 4' }]
  });
  await expect(executeIratAutomation(editor, request, {
    commit: true,
    resumeQuestions: { 'Question 1': { currentUid: '103', currentLabel: 'Version 3', requestHash: 'same' } },
    questionHash: () => 'same'
  })).rejects.toThrow('checkpoint conflict');
  expect(calls).toEqual(['inspect']);
});

test('plan includes one versioned update for every configured question', () => {
  const plan = createIratPlan(request);
  expect(plan.filter((step) => step.phase === 'question')).toHaveLength(1);
  expect(plan.at(-1)?.action).toContain('re-inspect');
});

function fakeEditor(calls: string[]): IratEditor {
  const observed: IratObservedState = {
    gate: {
      name: 'iRAT Gate',
      description: 'old',
      type: 'permission',
      dynamicPassword: false,
      rotationSeconds: null
    },
    activityName: 'iRAT',
    tratActivityName: 'tRAT',
    teamSetupAssociated: true,
    questions: [{ title: 'Question 1', type: 'multiple-choice', mandatory: false }]
  };
  return {
    async inspect() {
      calls.push('inspect');
      return observed;
    },
    async updateGate(gate) {
      calls.push(`gate:${gate.name}`);
    },
    async associateWithTeamSetup(name) {
      calls.push(`team:${name}`);
    },
    async deleteQuestion(title) {
      calls.push(`delete:${title}`);
    },
    async createQuestion(question) {
      calls.push(`create:${question.title}`);
    },
    async updateQuestion(question) {
      calls.push(`question:${question.title}`);
    },
    async applyAnswerRequired(questions) {
      calls.push(`required:${questions.map((question) => question.title).join(',')}`);
      return questions.map((question) => question.title);
    },
    async updateAdvancedSettings() {
      calls.push('advanced');
    },
    async verifyPrintView() {
      calls.push('print');
    },
    async save() {
      calls.push('save');
    }
  };
}

test('missing questions are planned in dry run and created on commit', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);
  const inspect = editor.inspect.bind(editor);
  editor.inspect = async () => ({ ...await inspect(), questions: [] });
  const preview = await executeIratAutomation(editor, request, { commit: false });
  expect(preview.readiness.passed).toBe(true);
  expect(preview.createdQuestions).toEqual([]);
  expect(calls).toEqual(['inspect']);
  calls.length = 0;
  const result = await executeIratAutomation(editor, request, { commit: true });
  expect(result.createdQuestions).toEqual(['Question 1']);
  expect(result.updatedQuestions).toEqual([]);
  expect(calls).toContain('create:Question 1');
});

test('deletes only an explicitly authorized extra question before writing the requested inventory', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);
  const inspect = editor.inspect.bind(editor);
  editor.inspect = async () => ({
    ...await inspect(),
    questions: [
      { title: 'Placeholder', type: 'multiple-choice', mandatory: true },
      { title: 'Question 1', type: 'multiple-choice', mandatory: false }
    ]
  });
  const input = { ...request, deleteQuestionTitles: ['Placeholder'] };

  const result = await executeIratAutomation(editor, input, { commit: true });

  expect(result.deletedQuestions).toEqual(['Placeholder']);
  expect(calls.indexOf('delete:Placeholder')).toBeLessThan(calls.indexOf('question:Question 1'));
  expect(result.readiness.checks.find((check) => check.label === 'Existing question — Placeholder')?.passed).toBe(true);
});

test('an authorized deletion title already absent is an idempotent no-op', async () => {
  const calls: string[] = [];
  const result = await executeIratAutomation(fakeEditor(calls), { ...request, deleteQuestionTitles: ['Old placeholder'] }, { commit: true });
  expect(result.deletedQuestions).toEqual([]);
  expect(calls).not.toContain('delete:Old placeholder');
});

test('warns about every unapproved extra question title and leaves those rows untouched', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);
  const inspect = editor.inspect.bind(editor);
  editor.inspect = async () => ({
    ...await inspect(),
    questions: [
      { title: 'Different placeholder A', type: 'multiple-choice', mandatory: true },
      { title: 'Question 1', type: 'multiple-choice', mandatory: false },
      { title: 'Legacy test row', type: 'multiple-choice', mandatory: true }
    ]
  });

  const result = await executeIratAutomation(editor, request, { commit: true });

  expect(result.readiness.passed).toBe(false);
  expect(result.readiness.checks.find((check) => check.label === 'Unexpected existing questions')?.detail)
    .toContain('"Different placeholder A", "Legacy test row"');
  expect(calls).not.toContain('delete:Different placeholder A');
  expect(calls).not.toContain('delete:Legacy test row');
  expect(calls.at(-1)).toBe('save');
});

test('SoT-sized run updates matching questions and creates the remaining 24', async () => {
  const calls: string[] = [];
  const fullRequest = { ...request, questions: Array.from({ length: 25 }, (_, i) => ({ ...request.questions[0]!, title: `Question ${i+1}`, answers: Array.from({length: 5}, (_, a) => ({text: `Option ${a+1}`, correct: a===0, weight: a===0 ? 100 : 0})) })) };
  const result = await executeIratAutomation(fakeEditor(calls), fullRequest, { commit: true });
  expect(result.updatedQuestions).toEqual(['Question 1']);
  expect(result.createdQuestions).toHaveLength(24);
  expect(calls.at(-1)).toBe('save');
});

for (const scenario of ['extra', 'duplicate', 'wrong type', 'duplicate request', 'unsupported distribution']) {
  test(`${scenario} is reported as a warning and does not stop the run`, async () => {
    const calls: string[] = [];
    const editor = fakeEditor(calls);
    const inspect = editor.inspect.bind(editor);
    editor.inspect = async () => {
      const state = await inspect();
      if (scenario === 'extra') state.questions.push({ ...state.questions[0]!, title: 'Unrelated' });
      if (scenario === 'duplicate') state.questions.push({ ...state.questions[0]!, title: '  Question   1 ' });
      if (scenario === 'wrong type') state.questions[0]!.type = 'essay';
      return state;
    };
    const input = structuredClone(request);
    if (scenario === 'duplicate request') input.questions.push({ ...input.questions[0]!, title: ' Question  1 ' });
    if (scenario === 'unsupported distribution') input.advanced.displayAllQuestions = false;
    const result = await executeIratAutomation(editor, input, { commit: true });
    expect(result.readiness.passed).toBe(false);
    expect(calls.at(-1)).toBe('save');
  });
}
