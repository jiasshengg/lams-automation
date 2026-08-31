import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import type { AuthoringGraph, GraphNode } from '../src/lams/authoring.js';
import { validateAuthoringGraph } from '../src/lams/validation.js';

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
    gateType: null
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
  const config = { expectedFlow, expectedAENodes: 1, expectedAEGates: 1 } as LamsConfig;

  const report = validateAuthoringGraph(graph, config);
  expect(report.passed).toBe(true);
  expect(report.checks.find((check) => check.label === 'Connectivity')?.passed).toBe(true);
  expect(report.checks.find((check) => check.label === 'Team Setup associations')?.passed).toBe(true);
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

