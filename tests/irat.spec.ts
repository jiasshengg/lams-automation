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
      type: 'multiple-choice',
      content: 'Question content',
      mandatory: true,
      fontFamily: 'Arial',
      fontSize: 12,
      answers: [
        { text: 'Correct', correct: true, weight: 100 },
        { text: 'Incorrect', correct: false, weight: 0 }
      ]
    }
  ],
  advanced: {
    shuffleAnswers: true,
    displayAllQuestions: true,
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
    rotationSeconds: type === 'gate' ? 10 : null
  };
}
