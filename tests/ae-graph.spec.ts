import { expect, test } from '@playwright/test';
import { buildAEPlan } from '../src/ae/plan.js';
import {
  buildDesiredAEFlow,
  planAEGraphReconciliation,
  removeAuthoringNode,
  removeAuthoringTransition
} from '../src/lams/ae-graph.js';
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
  { gateType: 'permission', stopAtPrecedingActivity: false }
]) {
  test(`blocks existing gate with settings ${JSON.stringify(settings)}`, () => {
    const graph: AuthoringGraph = {
      rendering: 'svg', modelAvailable: true,
      nodes: [{ ...node(2, 'AE Gate 2', 'gate'), ...settings }], transitions: []
    };
    const result = planAEGraphReconciliation(graph, plan);
    expect(result.gatesToReplace).toEqual(['AE Gate 2']);
    expect(result.invalidGates).toEqual([]);
    expect(result.ready).toBe(false);
  });
}

test('refuses to replace a gate whose settings could not be observed', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [{ ...node(2, 'AE Gate 2', 'gate'), gateType: null, stopAtPrecedingActivity: null }], transitions: []
  };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.gatesToReplace).toEqual([]);
  expect(result.invalidGates).toEqual([
    '"AE Gate 2" settings could not be verified (found unknown, unknown)'
  ]);
  expect(result.ready).toBe(false);
});

test('refuses gate replacement when it would remove an unrelated transition', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [
      node(1, 'AE 1', 'tool'),
      { ...node(2, 'AE Gate 2', 'gate'), gateType: 'time', stopAtPrecedingActivity: true },
      node(3, 'AE 2', 'tool'),
      node(4, 'Unrelated activity', 'tool')
    ],
    transitions: [
      { uiid: 10, fromUiid: 1, toUiid: 2 },
      { uiid: 11, fromUiid: 2, toUiid: 3 },
      { uiid: 12, fromUiid: 4, toUiid: 2 }
    ]
  };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.gatesToReplace).toEqual([]);
  expect(result.invalidGates).toEqual([
    '"AE Gate 2" cannot be safely replaced: found 1 incoming transition(s) outside the reviewed AE flow'
  ]);
  expect(result.ready).toBe(false);
});

test('refuses gate replacement when a transition endpoint could not be observed', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [
      node(1, 'AE 1', 'tool'),
      { ...node(2, 'AE Gate 2', 'gate'), gateType: 'time', stopAtPrecedingActivity: true },
      node(3, 'AE 2', 'tool')
    ],
    transitions: [{ uiid: 10, fromUiid: null, toUiid: null }]
  };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.gatesToReplace).toEqual([]);
  expect(result.invalidGates).toEqual([
    '"AE Gate 2" cannot be safely replaced: 1 graph transition(s) have unverified endpoints'
  ]);
});

test('allows gate replacement when every incident transition belongs to the reviewed flow', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [
      node(1, 'AE 1', 'tool'),
      { ...node(2, 'AE Gate 2', 'gate'), gateType: 'time', stopAtPrecedingActivity: true },
      node(3, 'AE 2', 'tool')
    ],
    transitions: [
      { uiid: 10, fromUiid: 1, toUiid: 2 },
      { uiid: 11, fromUiid: 2, toUiid: 3 }
    ]
  };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.gatesToReplace).toEqual(['AE Gate 2']);
  expect(result.invalidGates).toEqual([]);
});

test('accepts existing permission gate with stop at preceding activity enabled', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [{ ...node(2, 'AE Gate 2', 'gate'), gateType: 'permission', stopAtPrecedingActivity: true }], transitions: []
  };
  expect(planAEGraphReconciliation(graph, plan).ready).toBe(true);
});

test('blocks an expected gate title that belongs to a non-gate node', () => {
  const graph: AuthoringGraph = {
    rendering: 'svg', modelAvailable: true,
    nodes: [node(2, 'AE Gate 2', 'tool')], transitions: []
  };
  const result = planAEGraphReconciliation(graph, plan);
  expect(result.gatesToReplace).toEqual([]);
  expect(result.invalidGates).toEqual(['"AE Gate 2" must identify exactly one gate']);
  expect(result.ready).toBe(false);
});

test('removes one exact authoring transition through the verified LAMS runtime API', async ({ page }) => {
  await page.setContent(`
    <div id="canvas"><svg>
      <g class="svg-activity svg-activity-tool" uiid="1"><text class="svg-activity-title-label">AE 1</text></g>
      <g class="svg-activity svg-activity-tool" uiid="2"><text class="svg-activity-title-label">AE 2</text></g>
      <g uiid="10"><path class="svg-transition"></path></g>
    </svg></div>
    <script>
      const transition = { uiid: 10, fromActivity: null, toActivity: null, items: { remove() {} } };
      const from = { uiid: 1, title: 'AE 1', toolID: 19, transitions: { from: [transition], to: [] } };
      const to = { uiid: 2, title: 'AE 2', toolID: 19, transitions: { from: [], to: [transition] } };
      transition.fromActivity = from;
      transition.toActivity = to;
      window.layout = { activities: [from, to] };
      window.ActivityLib = { removeTransition(item) {
        item.fromActivity.transitions.from = item.fromActivity.transitions.from.filter(candidate => candidate !== item);
        item.toActivity.transitions.to = item.toActivity.transitions.to.filter(candidate => candidate !== item);
        document.querySelector('g[uiid="' + item.uiid + '"]').remove();
      } };
    </script>
  `);

  await removeAuthoringTransition(page, 'AE 1', 'AE 2', 2_000);
  expect((await page.evaluate(() => (
    window as typeof window & { layout: { activities: Array<{ transitions: { from: unknown[] } }> } }
  ).layout.activities[0]!.transitions.from)).length).toBe(0);
});

test('removes one exact authoring node through the verified LAMS runtime API', async ({ page }) => {
  await page.setContent(`
    <div id="canvas"><svg>
      <g class="svg-activity svg-activity-gate" uiid="2"></g>
    </svg></div>
    <script>
      const gate = { uiid: 2, title: 'AE Gate 2', gateType: 'time', transitions: { from: [], to: [] } };
      window.layout = { activities: [gate] };
      window.ActivityLib = { removeActivity(item) {
        window.layout.activities = window.layout.activities.filter(candidate => candidate !== item);
        document.querySelector('g[uiid="' + item.uiid + '"]').remove();
      } };
    </script>
  `);

  await removeAuthoringNode(page, node(2, 'AE Gate 2', 'gate'), 2_000);
  expect(await page.locator('#canvas g.svg-activity').count()).toBe(0);
});

test('connection helper creates and verifies one edge, skips duplicates, and refuses stale nodes', async ({ page }) => {
  const { connectAuthoringNodes } = await import('../src/lams/ae-graph.js');
  const { inspectAuthoringGraph } = await import('../src/lams/authoring.js');
  await page.setContent(`<button id="transitionButton">Transition</button><div id="canvas" style="height:400px"><svg height="400" width="600">
    <g class="svg-activity svg-activity-tool" uiid="1" data-x="10" data-y="10" data-width="100" data-height="40"><rect x="10" y="10" width="100" height="40"/></g>
    <g class="svg-activity svg-activity-tool" uiid="2" data-x="10" data-y="100" data-width="100" data-height="40"><rect x="10" y="100" width="100" height="40"/></g>
    </svg></div><script>
    const a={uiid:1,title:'AE 1',toolID:19,transitions:{from:[],to:[]}};
    const b={uiid:2,title:'AE 2',toolID:19,transitions:{from:[],to:[]}};
    window.layout={activities:[a,b]};
    document.querySelector('g[uiid="2"]').onclick=()=>{ const edge={uiid:10,fromActivity:a,toActivity:b};a.transitions.from.push(edge);b.transitions.to.push(edge); };
    </script>`);
  const [from,to] = (await inspectAuthoringGraph(page)).nodes;
  const viewport = page.viewportSize();
  await connectAuthoringNodes(page,from!,to!,1000);
  await connectAuthoringNodes(page,from!,to!,1000);
  expect((await inspectAuthoringGraph(page)).transitions).toHaveLength(1);
  expect(page.viewportSize()).toEqual(viewport);
  await expect(connectAuthoringNodes(page,{...from!,uiid:99},to!,1000)).rejects.toThrow('Stale');
});
