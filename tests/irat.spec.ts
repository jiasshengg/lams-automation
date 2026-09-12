import { expect, test } from '@playwright/test';
import type { IratRequest } from '../src/config.js';
import type { AuthoringGraph, GraphNode } from '../src/lams/authoring.js';
import {
  createIratPlan,
  executeIratAutomation,
  validateIratReadiness,
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

test('preflight verifies exact iRAT nodes, connection, and Team Setup association', () => {
  const nodes: GraphNode[] = [
    graphNode(1, 'Team Setup', 'grouping'),
    graphNode(2, 'iRAT Gate', 'gate'),
    { ...graphNode(3, 'iRAT', 'tool'), grouped: true, groupingUiid: 1 }
  ];
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes,
    transitions: [{ uiid: 10, fromUiid: 2, toUiid: 3 }]
  };

  const report = validateIratReadiness(graph, request);
  expect(report.passed).toBe(true);
  expect(report.plan.some((step) => step.action.includes('rotation 10s'))).toBe(true);
});

test('preflight fails when iRAT is not grouped with Team Setup', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes: [graphNode(1, 'Team Setup', 'grouping'), graphNode(2, 'iRAT Gate', 'gate'), graphNode(3, 'iRAT', 'tool')],
    transitions: [{ uiid: 10, fromUiid: 2, toUiid: 3 }]
  };

  const report = validateIratReadiness(graph, request);
  expect(report.passed).toBe(false);
  expect(report.checks.find((check) => check.label === 'Team Setup association')?.passed).toBe(false);
});

test('dry run inspects but performs no iRAT writes', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);

  const result = await executeIratAutomation(editor, request, { commit: false });

  expect(result.committed).toBe(false);
  expect(calls).toEqual(['inspect']);
});

test('commit applies gate, grouping, questions, advanced settings, print verification, then save', async () => {
  const calls: string[] = [];
  const editor = fakeEditor(calls);

  const result = await executeIratAutomation(editor, request, { commit: true });

  expect(result.committed).toBe(true);
  expect(result.updatedQuestions).toEqual(['Question 1']);
  expect(calls).toEqual([
    'inspect',
    'gate:iRAT Gate',
    'team:Team Setup',
    'question:Question 1',
    'advanced',
    'print',
    'save'
  ]);
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
    async createQuestion(question) {
      calls.push(`create:${question.title}`);
    },
    async updateQuestion(question) {
      calls.push(`question:${question.title}`);
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

function graphNode(uiid: number, name: string, type: GraphNode['type']): GraphNode {
  return {
    uiid,
    name,
    type,
    grouped: false,
    groupingUiid: null,
    x: null,
    y: null,
    toolId: null,
    gateType: type === 'gate' ? 'password' : null,
    description: type === 'gate' ? name : null,
    dynamicPassword: type === 'gate',
    rotationSeconds: type === 'gate' ? 10 : null,
    stopAtPrecedingActivity: null,
    gradebookOutput: null
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

test('SoT-sized run updates matching questions and creates the remaining 24', async () => {
  const calls: string[] = [];
  const fullRequest = { ...request, questions: Array.from({ length: 25 }, (_, i) => ({ ...request.questions[0]!, title: `Question ${i+1}`, answers: Array.from({length: 5}, (_, a) => ({text: `Option ${a+1}`, correct: a===0, weight: a===0 ? 100 : 0})) })) };
  const result = await executeIratAutomation(fakeEditor(calls), fullRequest, { commit: true });
  expect(result.updatedQuestions).toEqual(['Question 1']);
  expect(result.createdQuestions).toHaveLength(24);
  expect(calls.at(-1)).toBe('save');
});

for (const scenario of ['extra', 'duplicate', 'wrong type', 'duplicate request', 'unsupported distribution']) {
  test(`preflight rejects ${scenario} before any writes`, async () => {
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
    await expect(executeIratAutomation(editor, input, { commit: true })).rejects.toThrow('preflight failed');
    expect(calls).toEqual(['inspect']);
  });
}
