import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import type { AuthoringGraph, GraphNode } from '../src/lams/authoring.js';
import { buildAEPlan } from '../src/ae/plan.js';
import { validateAEPlanGraph, validateAuthoringGraph } from '../src/lams/validation.js';

const expectedFlow = [
  'Team Setup',
  'iRAT Gate',
  'iRAT',
  'Leader Selection',
  'tRAT Gate',
  'tRAT',
  'AE Gate Application Exercise 1',
  'AE Test Qns'
];

test('passes the observed reference lesson flow', () => {
  const nodes: GraphNode[] = expectedFlow.map((name, index) => ({
    uiid: index + 6,
    name,
    type: name === 'Team Setup' ? 'grouping' : /Gate/.test(name) ? 'gate' : 'tool',
    grouped: name !== 'Team Setup' && !/Gate/.test(name),
    groupingUiid: name !== 'Team Setup' && !/Gate/.test(name) ? 6 : null,
    x: null,
    y: null,
    toolId: null,
    gateType: /Gate/.test(name) ? (name === 'iRAT Gate' ? 'password' : 'permission') : null,
    description: /Gate/.test(name) ? name : null,
    dynamicPassword: name === 'iRAT Gate' ? true : null,
    rotationSeconds: name === 'iRAT Gate' ? 10 : null,
    stopAtPrecedingActivity: null,
    gradebookOutput: null
  }));
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes,
    transitions: nodes.slice(0, -1).map((node, index) => ({
      uiid: index + 20,
      fromUiid: node.uiid,
      toUiid: nodes[index + 1]!.uiid
    }))
  };
  const config = {
    expectedFlow,
    expectedAENodes: 1,
    expectedAEGates: 1,
    expectedGateProperties: [
      { name: 'iRAT Gate', type: 'password', description: 'iRAT Gate', dynamicPassword: true, rotationSeconds: 10 },
      { name: 'tRAT Gate', type: 'permission', description: 'tRAT Gate' },
      { name: 'AE Gate Application Exercise 1', type: 'permission', description: 'AE Gate Application Exercise 1' }
    ]
  } as LamsConfig;

  const report = validateAuthoringGraph(graph, config);
  expect(report.passed).toBe(true);
  expect(report.checks.find((check) => check.label === 'Connectivity')?.passed).toBe(true);
  expect(report.checks.find((check) => check.label === 'Team Setup associations')?.passed).toBe(true);
  expect(report.checks.find((check) => check.label === 'Gate properties — iRAT Gate')?.passed).toBe(true);
});

test('reports an incorrect iRAT Gate rotation time', () => {
  const nodes: GraphNode[] = expectedFlow.map((name, index) => ({
    uiid: index + 6,
    name,
    type: name === 'Team Setup' ? 'grouping' : /Gate/.test(name) ? 'gate' : 'tool',
    grouped: name !== 'Team Setup' && !/Gate/.test(name),
    groupingUiid: name !== 'Team Setup' && !/Gate/.test(name) ? 6 : null,
    x: null,
    y: null,
    toolId: null,
    gateType: name === 'iRAT Gate' ? 'password' : /Gate/.test(name) ? 'permission' : null,
    description: /Gate/.test(name) ? name : null,
    dynamicPassword: name === 'iRAT Gate' ? true : null,
    rotationSeconds: name === 'iRAT Gate' ? 15 : null,
    stopAtPrecedingActivity: null,
    gradebookOutput: null
  }));
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes,
    transitions: nodes.slice(0, -1).map((node, index) => ({
      uiid: index + 20,
      fromUiid: node.uiid,
      toUiid: nodes[index + 1]!.uiid
    }))
  };
  const config = {
    expectedFlow,
    expectedAENodes: 1,
    expectedAEGates: 1,
    expectedGateProperties: [{ name: 'iRAT Gate', rotationSeconds: 10 }]
  } as LamsConfig;

  const report = validateAuthoringGraph(graph, config);
  const gateCheck = report.checks.find((check) => check.label === 'Gate properties — iRAT Gate');
  expect(gateCheck?.passed).toBe(false);
  expect(gateCheck?.detail).toBe('rotation expected 10s; found 15s');
});

test('reports a missing AE node and broken connection', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes: [],
    transitions: []
  };
  const config = { expectedFlow, expectedAENodes: 1, expectedAEGates: 1 } as LamsConfig;

  const report = validateAuthoringGraph(graph, config);
  expect(report.passed).toBe(false);
  expect(report.checks.find((check) => check.label === 'AE Nodes')?.detail).toBe('Expected: 1; Found: 0');
  expect(report.checks.find((check) => check.label === 'Connectivity')?.passed).toBe(false);
});

test('validates exact AE node and gate titles plus their graph connections', () => {
  const plan = buildAEPlan({
    sourceLabel: 'Fixture',
    breakMarkerCount: 1,
    nodes: [
      {
        title: 'AE Case 1',
        questions: [
          {
            number: 1,
            type: 'mcq',
            prompt: 'QUESTION 1\nChoose.',
            options: [{ text: 'A) Yes', correct: true }, { text: 'B) No' }]
          }
        ]
      },
      {
        title: 'AE Case 2',
        questions: [
          {
            number: 2,
            type: 'essay',
            prompt: 'QUESTION 2\nExplain.'
          }
        ]
      }
    ],
    gates: [
      {
        title: 'AE Gate Case 1 to Case 2 Question 2',
        afterNodeTitle: 'AE Case 1',
        beforeNodeTitle: 'AE Case 2',
        beforeQuestionNumber: 2
      }
    ]
  });
  const nodes = [
    graphNode(1, 'AE Case 1', 'tool'),
    graphNode(2, 'AE Gate Case 1 to Case 2 Question 2', 'gate'),
    graphNode(3, 'AE Case 2', 'tool')
  ];
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes,
    transitions: [
      { uiid: 10, fromUiid: 1, toUiid: 2 },
      { uiid: 11, fromUiid: 2, toUiid: 3 }
    ]
  };

  const report = validateAEPlanGraph(graph, plan);
  expect(report.passed).toBe(true);
  expect(report.checks.find((check) => check.label === 'AE plan connectivity')?.passed).toBe(true);

  graph.transitions.pop();
  const failed = validateAEPlanGraph(graph, plan);
  expect(failed.passed).toBe(false);
  expect(failed.checks.find((check) => check.label === 'AE plan connectivity')?.detail).toContain(
    'AE Gate Case 1 to Case 2 Question 2 -> AE Case 2'
  );
});

function graphNode(uiid: number, name: string, type: GraphNode['type']): GraphNode {
  return {
    uiid,
    name,
    type,
    grouped: type === 'tool',
    groupingUiid: type === 'tool' ? 99 : null,
    x: null,
    y: null,
    toolId: null,
    gateType: type === 'gate' ? 'permission' : null,
    description: type === 'gate' ? name : null,
    dynamicPassword: null,
    rotationSeconds: null,
    stopAtPrecedingActivity: null,
    gradebookOutput: null
  };
}

test('reports an AE gate that does not stop students at the preceding activity', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes: [
      {
        uiid: 7, name: 'AE Gate AE Case 3 Q3-6', type: 'gate', grouped: false, groupingUiid: null,
        x: null, y: null, toolId: null, gateType: 'permission', description: 'AE Gate AE Case 3 Q3-6',
        dynamicPassword: null, rotationSeconds: null, stopAtPrecedingActivity: false, gradebookOutput: null
      }
    ],
    transitions: []
  };
  const config = {
    expectedFlow: ['AE Gate AE Case 3 Q3-6'],
    expectedAENodes: 0,
    expectedAEGates: 1,
    expectedGateProperties: [
      { name: 'AE Gate AE Case 3 Q3-6', type: 'permission', stopAtPrecedingActivity: true }
    ]
  } as LamsConfig;

  const report = validateAuthoringGraph(graph, config);
  const check = report.checks.find((item) => item.label === 'Gate properties — AE Gate AE Case 3 Q3-6');
  expect(check?.passed).toBe(false);
  expect(check?.detail).toContain('stop at preceding activity expected true; found false');
});

test('reports a tool activity whose gradebook output is not the expected one', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg',
    modelAvailable: true,
    nodes: [
      {
        uiid: 8, name: 'AE Case 3 Q3-6', type: 'tool', grouped: true, groupingUiid: 6, x: null, y: null,
        toolId: 19, gateType: null, description: null, dynamicPassword: null, rotationSeconds: null,
        stopAtPrecedingActivity: null, gradebookOutput: 'First total score'
      }
    ],
    transitions: []
  };
  const config = {
    expectedFlow: ['AE Case 3 Q3-6'],
    expectedAENodes: 1,
    expectedAEGates: 0,
    expectedGradebookOutput: 'Last total score'
  } as LamsConfig;

  const report = validateAuthoringGraph(graph, config);
  const check = report.checks.find((item) => item.label === 'Gradebook output');
  expect(check?.passed).toBe(false);
  expect(check?.detail).toContain('AE Case 3 Q3-6');
});
