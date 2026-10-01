import { expect, test } from '@playwright/test';
import { buildAEPlan } from '../src/ae/plan.js';
import type { AuthoringGraph, GraphNode } from '../src/lams/authoring.js';
import {
  aeRangeKey, assertRenamesFollowPlan, parseAERenamePlan, projectAERenames, renameSource, withRangeSpellingRenames
} from '../src/lams/ae-rename.js';

function node(uiid: number, name: string, type: GraphNode['type']): GraphNode {
  return {
    uiid, name, type, grouped: false, groupingUiid: null, x: null, y: null, toolId: null,
    gateType: type === 'gate' ? 'permission' : null, description: null, dynamicPassword: null,
    rotationSeconds: null, stopAtPrecedingActivity: type === 'gate' ? true : null, gradebookOutput: null
  };
}

// A copy of last year's lesson: every AE gate carries the title of the activity it leads to.
const graph: AuthoringGraph = {
  rendering: 'svg',
  modelAvailable: true,
  nodes: [
    node(1, 'tRAT', 'tool'),
    node(2, 'AE Q1 to Q2', 'gate'),
    node(3, 'AE Q1 to Q2', 'tool'),
    node(4, 'AE Q3', 'gate'),
    node(5, 'AE Q3', 'tool')
  ],
  transitions: []
};

const plan = buildAEPlan({
  sourceLabel: 'Example',
  breakMarkerCount: 1,
  nodes: [
    { title: 'AE Case 1 Q1-2', questions: [
      { number: 1, type: 'essay', prompt: '1. First?' },
      { number: 2, type: 'essay', prompt: '2. Second?' }
    ] },
    { title: 'AE Case 1 Q3', questions: [{ number: 3, type: 'essay', prompt: '3. Third?' }] }
  ],
  gates: [{ title: 'AE Gate AE Case 1 Q3', afterNodeTitle: 'AE Case 1 Q1-2', beforeNodeTitle: 'AE Case 1 Q3', beforeQuestionNumber: 3 }]
});

const renames = parseAERenamePlan({
  lessonTitle: 'Copy',
  renames: [
    { type: 'tool', from: 'AE Q1 to Q2', to: 'AE Case 1 Q1-2' },
    { type: 'tool', from: 'AE Q3', to: 'AE Case 1 Q3' },
    { type: 'gate', from: 'AE Q1 to Q2', to: 'AE Gate AE Case 1 Q1-2' },
    { type: 'gate', from: 'AE Q3', to: 'AE Gate AE Case 1 Q3' }
  ]
});

test('an authorised rename finds the one earlier node of its type, even when a gate shares its title', () => {
  assertRenamesFollowPlan(renames, plan);
  expect(renameSource(graph, renames, 'tool', 'AE Case 1 Q1-2')?.uiid).toBe(3);
  expect(renameSource(graph, renames, 'gate', 'AE Gate AE Case 1 Q3')?.uiid).toBe(4);
  expect(renameSource(graph, renames, 'tool', 'AE Case 9 Q9')).toBeNull();
});

test('projecting the renames leaves every title unique for the expectations', () => {
  const projected = projectAERenames(graph, renames);
  expect(projected.nodes.map((entry) => entry.name)).toEqual([
    'tRAT', 'AE Gate AE Case 1 Q1-2', 'AE Case 1 Q1-2', 'AE Gate AE Case 1 Q3', 'AE Case 1 Q3'
  ]);
});

test('a rename to a title the reviewed plan does not name is refused', () => {
  const stray = parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'AE Q3', to: 'AE Something Else' }] });
  expect(() => assertRenamesFollowPlan(stray, plan)).toThrow('not a reviewed AE node title');
});

test('duplicate, self, and non-AE renames are refused before anything opens', () => {
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'AE Q3', to: 'AE Q3' }] })).toThrow('to itself');
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'iRAT', to: 'AE Case 1 Q3' }] })).toThrow('exact AE title');
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [
    { type: 'tool', from: 'AE Q3', to: 'AE Case 1 Q3' },
    { type: 'tool', from: 'AE Q3', to: 'AE Case 1 Q1-2' }
  ] })).toThrow('only once');
});

test('a rename whose source is missing or ambiguous stops instead of guessing', () => {
  const doubled: AuthoringGraph = { ...graph, nodes: [...graph.nodes, node(6, 'AE Q3', 'tool')] };
  expect(() => renameSource(doubled, renames, 'tool', 'AE Case 1 Q3')).toThrow('exactly one tool; found 2');
  expect(() => projectAERenames({ ...graph, nodes: graph.nodes.filter((entry) => entry.uiid !== 5) }, renames)).toThrow('found 0');
});

test('an earlier "AEGate …" title with no space can be renamed, but other titles still cannot', () => {
  const parsed = parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'gate', from: 'AEGate Case1 Qns 1 - 2', to: 'AE Gate AE Case 1 Q1-2' }] });
  expect(parsed.renames[0]!.from).toBe('AEGate Case1 Qns 1 - 2');
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'gate', from: 'AEGates', to: 'AE Gate AE Case 1 Q3' }] })).toThrow('exact AE title');
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'AERIAL', to: 'AE Case 1 Q3' }] })).toThrow('exact AE title');
});

test('an earlier AE activity titled by case alone can be renamed, but only as a tool', () => {
  const parsed = parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'Case 1 Q2 to Q4', to: 'AE Case 1 Q3' }] });
  expect(parsed.renames[0]!.from).toBe('Case 1 Q2 to Q4');
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'gate', from: 'Case 1 Q2 to Q4', to: 'AE Gate AE Case 1 Q3' }] })).toThrow('exact AE title');
  expect(() => parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'Cases', to: 'AE Case 1 Q3' }] })).toThrow('exact AE title');
});

test('a range joined with "to" reads the same as the hyphenated title', () => {
  expect(aeRangeKey('AE Case 1 Q1 to Q4')).toBe(aeRangeKey('AE Case 1 Q1-4'));
  expect(aeRangeKey('AE Case 1 Q1-Q4')).toBe(aeRangeKey('AE Case 1 Q1-4'));
  expect(aeRangeKey('AE Case 1 Q1 to Case 2 Q2')).toBe(aeRangeKey('AE Case 1 Q1-Case 2 Q2'));
  expect(aeRangeKey('AE Gate AE Case 3 Q3 to Q6')).toBe(aeRangeKey('AE Gate AE Case 3 Q3-6'));
  expect(aeRangeKey('AE Case 1 Q1 to Q4')).not.toBe(aeRangeKey('AE Case 1 Q1-5'));
  expect(aeRangeKey('AE Q1 to Q2')).not.toBe(aeRangeKey('AE Case 1 Q1-2'));
});

test('an earlier chain titled with "to" is renamed in place to the reviewed hyphenated titles', () => {
  const earlier: AuthoringGraph = {
    ...graph,
    nodes: [
      node(1, 'tRAT', 'tool'),
      node(2, 'AE Gate AE Case 1 Q1 to Q2', 'gate'),
      node(3, 'AE Case 1 Q1 to Q2', 'tool'),
      node(4, 'AE Gate AE Case 1 Q3', 'gate'),
      node(5, 'AE Case 1 Q3', 'tool')
    ]
  };
  const derived = withRangeSpellingRenames(earlier, plan, 'Copy');
  expect(derived?.renames).toEqual([
    { type: 'tool', from: 'AE Case 1 Q1 to Q2', to: 'AE Case 1 Q1-2' },
    { type: 'gate', from: 'AE Gate AE Case 1 Q1 to Q2', to: 'AE Gate AE Case 1 Q1-2' }
  ]);
  assertRenamesFollowPlan(derived!, plan);
  expect(projectAERenames(earlier, derived!).nodes.map((entry) => entry.name)).toEqual([
    'tRAT', 'AE Gate AE Case 1 Q1-2', 'AE Case 1 Q1-2', 'AE Gate AE Case 1 Q3', 'AE Case 1 Q3'
  ]);
});

test('range spelling renames leave reviewed titles, ambiguous spellings and explicit renames alone', () => {
  const current: AuthoringGraph = { ...graph, nodes: [node(3, 'AE Case 1 Q1-2', 'tool'), node(5, 'AE Case 1 Q3', 'tool')] };
  expect(withRangeSpellingRenames(current, plan, 'Copy')).toBeUndefined();

  const doubled: AuthoringGraph = { ...graph, nodes: [node(3, 'AE Case 1 Q1 to Q2', 'tool'), node(6, 'AE Case 1 Q1-Q2', 'tool')] };
  expect(withRangeSpellingRenames(doubled, plan, 'Copy')).toBeUndefined();

  const explicit = parseAERenamePlan({ lessonTitle: 'Copy', renames: [{ type: 'tool', from: 'AE Q1 to Q2', to: 'AE Case 1 Q1-2' }] });
  const both: AuthoringGraph = { ...graph, nodes: [node(3, 'AE Q1 to Q2', 'tool'), node(6, 'AE Case 1 Q1 to Q2', 'tool')] };
  expect(withRangeSpellingRenames(both, plan, 'Copy', explicit)?.renames).toEqual(explicit.renames);
});
