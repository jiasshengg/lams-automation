import { expect, test } from '@playwright/test';
import { buildAEPlan } from '../src/ae/plan.js';
import { buildDesiredAEFlow, planAEGraphReconciliation } from '../src/lams/ae-graph.js';
import type { AuthoringGraph, GraphNode } from '../src/lams/authoring.js';

const plan = buildAEPlan({
  sourceLabel: 'Test',
  breakMarkerCount: 1,
  nodes: [
    { title: 'AE 1', questions: [{ number: 1, type: 'essay', prompt: 'Question 1' }] },
    { title: 'AE 2', questions: [{ number: 2, type: 'mcq', prompt: 'Question 2', options: [
      { text: 'A. Yes', correct: true }, { text: 'B. No', correct: false }
    ] }] }
  ],
  gates: [{ title: 'AE Gate 2', afterNodeTitle: 'AE 1', beforeNodeTitle: 'AE 2', beforeQuestionNumber: 2 }]
});

test('builds an interleaved AE node and gate flow', () => {
  expect(buildDesiredAEFlow(plan)).toEqual(['AE 1', 'AE Gate 2', 'AE 2']);
});

test('plans missing AE graph additions without treating unrelated nodes as changes', () => {
  const graph: AuthoringGraph = { rendering: 'svg', modelAvailable: true, nodes: [node(1, 'Team Setup', 'grouping')], transitions: [] };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.missingNodeTitles).toEqual(['AE 1', 'AE 2']);
  expect(result.missingGateTitles).toEqual(['AE Gate 2']);
  expect(result.missingTransitions).toEqual([
    { from: 'AE 1', to: 'AE Gate 2' },
    { from: 'AE Gate 2', to: 'AE 2' }
  ]);
  expect(result.ready).toBe(true);
});

test('reports an existing transition that bypasses a planned AE gate', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [node(1, 'AE 1', 'tool'), node(2, 'AE Gate 2', 'gate'), node(3, 'AE 2', 'tool')],
    transitions: [{ uiid: 10, fromUiid: 1, toUiid: 3 }]
  };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.bypassTransitions).toEqual([{ from: 'AE 1', to: 'AE 2' }]);
  expect(result.ready).toBe(false);
});

function node(uiid: number, name: string, type: GraphNode['type']): GraphNode {
  return {
    uiid, name, type, grouped: false, groupingUiid: null, x: null, y: null, toolId: null,
    gateType: null, description: null, dynamicPassword: null, rotationSeconds: null,
    stopAtPrecedingActivity: null, gradebookOutput: null
  };
}

for (const settings of [
  { gateType: 'time', stopAtPrecedingActivity: true },
  { gateType: 'permission', stopAtPrecedingActivity: false },
  { gateType: null, stopAtPrecedingActivity: null }
]) {
  test(`blocks existing gate with settings ${JSON.stringify(settings)}`, () => {
    const graph: AuthoringGraph = {
      rendering: 'svg', modelAvailable: true,
      nodes: [{ ...node(2, 'AE Gate 2', 'gate'), ...settings }], transitions: []
    };
    const result = planAEGraphReconciliation(graph, plan);
    expect(result.ready).toBe(false);
    expect(result.invalidGates).toHaveLength(1);
  });
}

test('accepts existing permission gate with stop at preceding activity enabled', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [{ ...node(2, 'AE Gate 2', 'gate'), gateType: 'permission', stopAtPrecedingActivity: true }], transitions: []
  };
  expect(planAEGraphReconciliation(graph, plan).ready).toBe(true);
});
