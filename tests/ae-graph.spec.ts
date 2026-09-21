import { expect, test } from '@playwright/test';
import { buildAEPlan } from '../src/ae/plan.js';
import {
  arrangeAEActivities,
  buildDesiredAEFlow,
  planAEGraphReconciliation,
  renameLeadingAEGate,
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

// Reproduces authoringGeneral.js: #arrangeButton calls GeneralLib.arrangeActivities(), which lays
// every activity on the 240x120 grid and, in a TBL sequence, breaks the row after each gate so the
// gate sits in the next column half a row down. The observed coordinates are the ones LAMS writes.
function canvasMarkup(options: { arranges: boolean; confirms?: boolean }): string {
  const placed = [
    { uiid: 1, gate: false, x: 40, y: 420 },
    { uiid: 2, gate: true, x: 360, y: 480 },
    { uiid: 3, gate: false, x: 40, y: 520 }
  ];
  const arranged = [
    { uiid: 1, x: 40, y: 400 },
    { uiid: 2, x: 360, y: 420 },
    { uiid: 3, x: 40, y: 520 }
  ];
  return `
    <button id="arrangeButton" onclick="arrangeActivities()">Arrange</button>
    <button id="confirmationDialogConfirmButton" style="display:${options.confirms ? 'block' : 'none'}"
            onclick="this.style.display='none'; doArrange()">OK</button>
    <div id="canvas"><svg>${placed
      .map(
        (activity) =>
          `<g class="svg-activity ${activity.gate ? 'svg-activity-gate' : 'svg-activity-tool'}" ` +
          `uiid="${activity.uiid}" data-x="${activity.x}" data-y="${activity.y}"></g>`
      )
      .join('')}</svg></div>
    <script>
      function doArrange() {
        ${options.arranges ? JSON.stringify(arranged) : '[]'}.forEach(function (move) {
          var activity = document.querySelector('g.svg-activity[uiid="' + move.uiid + '"]');
          activity.setAttribute('data-x', move.x);
          activity.setAttribute('data-y', move.y);
        });
      }
      function arrangeActivities() {
        if (document.getElementById('confirmationDialogConfirmButton').style.display === 'none') doArrange();
      }
    </script>`;
}

test('presses LAMS Arrange and confirms every activity landed on the arrange grid', async ({ page }) => {
  await page.setContent(canvasMarkup({ arranges: true }));

  await arrangeAEActivities(page, 5000);

  expect(await page.locator('g.svg-activity[uiid="1"]').getAttribute('data-y')).toBe('400');
  expect(await page.locator('g.svg-activity[uiid="2"]').getAttribute('data-y')).toBe('420');
});

test('answers the annotation confirmation rather than leaving the canvas untouched', async ({ page }) => {
  await page.setContent(canvasMarkup({ arranges: true, confirms: true }));

  await arrangeAEActivities(page, 5000);

  expect(await page.locator('g.svg-activity[uiid="1"]').getAttribute('data-y')).toBe('400');
});

test('reports an Arrange that left an activity off the grid', async ({ page }) => {
  await page.setContent(canvasMarkup({ arranges: false }));

  await expect(arrangeAEActivities(page, 1500)).rejects.toThrow(/Timeout/i);
});

// Reproduces the authoring surface: the SVG canvas plus the properties dialog LAMS opens for the
// selected activity. The gate the template supplies before the AE chain arrives under its own
// title, so the reconciler renames it after the node it leads into.
function leadGateMarkup(gate: { uiid: number; title: string; gateType: string }): string {
  return `
    <div id="canvas"><svg>
      <g class="svg-activity svg-activity-gate" uiid="${gate.uiid}" data-x="40" data-y="40"></g>
      <g class="svg-activity svg-activity-tool" uiid="20" data-x="40" data-y="160"></g>
    </svg></div>
    <div id="propertiesDialog" style="display: block">
      <input class="propertiesContentFieldTitle" value="${gate.title}">
      <textarea class="propertiesContentFieldDescription"></textarea>
      <select class="propertiesContentFieldGateType"><option value="permission">Permission</option></select>
      <input type="checkbox" class="propertiesContentFieldStopAtPrecedingActivity">
    </div>
    <script>
      window.layout = { activities: [
        { uiid: ${gate.uiid}, title: ${JSON.stringify(gate.title)}, gateType: ${JSON.stringify(gate.gateType)},
          gateStopAtPrecedingActivity: true,
          transitions: { from: [{ uiid: 30, fromActivity: { uiid: ${gate.uiid} }, toActivity: { uiid: 20 } }] } },
        { uiid: 20, title: 'AE 1', transitions: { from: [] } }
      ] };
      document.querySelector('.propertiesContentFieldTitle').addEventListener('input', function (event) {
        window.layout.activities[0].title = event.target.value;
      });
    </script>`;
}

const leadPlan = buildAEPlan({
  sourceLabel: 'Test',
  breakMarkerCount: 0,
  nodes: [{ title: 'AE 1', questions: [{ number: 1, type: 'essay', prompt: 'Question 1' }] }],
  gates: []
});

test('derives the leading gate title from the node it leads into', () => {
  expect(leadPlan.leadingGateTitle).toBe('AE Gate AE 1');
  expect(plan.leadingGateTitle).toBe('AE Gate AE 1');
});

test('renames the template gate in front of the AE chain after that node', async ({ page }) => {
  await page.setContent(leadGateMarkup({ uiid: 7, title: 'AE Gate Application Exercise 1', gateType: 'permission' }));

  expect(await renameLeadingAEGate(page, leadPlan, 20, 5000)).toEqual([
    { from: 'AE Gate Application Exercise 1', to: 'AE Gate AE 1' }
  ]);
  await expect(page.locator('.propertiesContentFieldTitle')).toHaveValue('AE Gate AE 1');
  await expect(page.locator('.propertiesContentFieldDescription')).toHaveValue('AE Gate AE 1');
  await expect(page.locator('.propertiesContentFieldStopAtPrecedingActivity')).toBeChecked();
});

test('leaves the leading gate alone when it already carries its reviewed title', async ({ page }) => {
  await page.setContent(leadGateMarkup({ uiid: 7, title: 'AE Gate AE 1', gateType: 'permission' }));

  expect(await renameLeadingAEGate(page, leadPlan, 20, 5000)).toEqual([]);
});

test('refuses to rename a gate in front of the AE chain that is not a permission gate', async ({ page }) => {
  await page.setContent(leadGateMarkup({ uiid: 7, title: 'iRAT Gate', gateType: 'password' }));

  await expect(renameLeadingAEGate(page, leadPlan, 20, 5000)).rejects.toThrow(
    /is a password gate, not the permission gate/
  );
});
