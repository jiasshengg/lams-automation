import { expect, test } from '@playwright/test';
import { parsePlaceholderRepair, projectPlaceholderRepairs, verifyRepairResult } from '../src/lams/ae-placeholder.js';
import { expectedTBLGraph } from '../src/lams/tbl-preflight.js';
import { buildAEPlan } from '../src/ae/plan.js';
import type { AuthoringGraph, GraphNode } from '../src/lams/authoring.js';
import type { LamsConfig } from '../src/config.js';

function node(uiid: number, name: string, type: GraphNode['type']): GraphNode {
  return { uiid, name, type, grouped: false, groupingUiid: null, x: null, y: null, toolId: null, gateType: null, description: null, dynamicPassword: null, rotationSeconds: null, stopAtPrecedingActivity: null, gradebookOutput: null };
}
const graph: AuthoringGraph = { rendering: 'svg', modelAvailable: true, nodes: [node(1, 'AE Gate Entry', 'gate'), node(2, 'AE Placeholder', 'tool'), node(3, 'AE 1', 'tool')], transitions: [{uiid: 4, fromUiid: 1, toUiid: 2}, {uiid: 5, fromUiid: 2, toUiid: 3}] };
const repair = parsePlaceholderRepair({lessonTitle:'Copy',removals:[{title:'AE Placeholder',predecessor:'AE Gate Entry',successor:'AE 1'}]});

test('projects only the exact approved placeholder and edges; rerun is a no-op', () => {
  const result = projectPlaceholderRepairs(graph, repair);
  expect(result.nodes.map(n => n.name)).toEqual(['AE Gate Entry', 'AE 1']);
  expect(result.transitions.map(t => [t.fromUiid,t.toUiid])).toEqual([[1,3]]);
  expect(projectPlaceholderRepairs(result, repair)).toEqual(result);
  expect(graph.nodes).toHaveLength(3);
});

test('rejects extra incident edges, ambiguous identities and unknown endpoints before mutation', () => {
  for (const changed of [
    {...graph, transitions:[...graph.transitions,{uiid:6,fromUiid:2,toUiid:1}]},
    {...graph, nodes:[...graph.nodes,node(7,'AE Placeholder','tool')]},
    {...graph, transitions:[{uiid:6,fromUiid:null,toUiid:2}]},
    {...graph, modelAvailable:false}
  ]) expect(() => projectPlaceholderRepairs(changed, repair)).toThrow();
});

test('rejects overlapping or implicit repair plans', () => {
  expect(() => parsePlaceholderRepair({lessonTitle:'Copy',removals:[{title:'AE Placeholder',predecessor:'Gate'}]})).toThrow();
  expect(() => parsePlaceholderRepair({lessonTitle:'Copy',removals:[...repair.removals,...repair.removals]})).toThrow();
});

test('detects unrelated deletion in post-save verification', () => {
  const expected = projectPlaceholderRepairs(graph, repair);
  expect(() => verifyRepairResult({...expected,nodes:[]},expected)).toThrow('unexpected nodes');
});

test('counts the approved entrance gate in addition to the SoT gates and rejects unplanned placeholders', () => {
  const plan = buildAEPlan({sourceLabel:'Test',breakMarkerCount:1,nodes:[
    {title:'AE 1',questions:[{number:1,type:'essay',prompt:'First'}]},
    {title:'AE 2',questions:[{number:2,type:'essay',prompt:'Second'}]}
  ],gates:[{title:'AE Gate 2',afterNodeTitle:'AE 1',beforeNodeTitle:'AE 2',beforeQuestionNumber:2}]});
  const source = {...graph,nodes:graph.nodes.slice(0,2),transitions:graph.transitions.slice(0,1)};
  const config = {expectedFlow:['AE Gate Entry','AE Placeholder']} as LamsConfig;
  expect(() => expectedTBLGraph(source,config,plan)).toThrow('exact disposition');
  const terminal = parsePlaceholderRepair({lessonTitle:'Copy',removals:[{title:'AE Placeholder',predecessor:'AE Gate Entry',successor:null}]});
  // The gate leading into the AE chain takes the name of the node after it, like every AE gate.
  expect(expectedTBLGraph(source,config,plan,terminal)).toMatchObject({expectedAENodes:2,expectedAEGates:2,expectedFlow:['AE Gate AE 1','AE 1','AE Gate 2','AE 2']});
  expect(expectedTBLGraph(source,config,plan,terminal).expectedGateProperties).toContainEqual({name:'AE Gate AE 1',type:'permission',description:'AE Gate AE 1',stopAtPrecedingActivity:true});
  // A re-run finds that gate under its reviewed name, so a stale configured name still resolves.
  const renamed = {...source, nodes: [node(1,'AE Gate AE 1','gate')], transitions: []};
  const staleConfig = {expectedFlow:['AE Gate Entry'],expectedGateProperties:[{name:'AE Gate Entry',type:'permission' as const,description:'AE Gate Entry',stopAtPrecedingActivity:true}]} as LamsConfig;
  const rerun = expectedTBLGraph(renamed,staleConfig,plan);
  expect(rerun.expectedFlow).toEqual(['AE Gate AE 1','AE 1','AE Gate 2','AE 2']);
  // The configured name is superseded, so nothing still expects a gate under the template's title.
  expect(rerun.expectedGateProperties.map(g => g.name)).toEqual(['AE Gate AE 1','AE Gate 2']);
});

test('persists a removal by saving, reopening and verifying the reloaded graph', async ({ page }) => {
  const { persistPlaceholderRepairs } = await import('../src/lams/ae-placeholder.js');
  // The canvas starts showing only the repaired graph, as it does right after removeActivity.
  await page.setContent(`
    <button id="saveButton">Save</button>
    <div id="canvas"><svg>
      <g class="svg-activity svg-activity-gate" uiid="1"></g>
      <g class="svg-activity svg-activity-tool" uiid="3"></g>
    </svg></div>
    <script>
      const gate = { uiid: 1, title: 'AE Gate Entry', gateType: 'permission', transitions: { from: [] } };
      const kept = { uiid: 3, title: 'AE 1', toolID: 19, transitions: { from: [] } };
      gate.transitions.from.push({ uiid: 4, fromActivity: gate, toActivity: kept });
      window.layout = { activities: [gate, kept] };
      window.saved = false;
      document.getElementById('saveButton').onclick = () => { window.saved = true; };
    </script>
  `);
  const expected = projectPlaceholderRepairs(graph, repair);

  let reopened = 0;
  await persistPlaceholderRepairs(page, expected, async () => { reopened += 1; });

  expect(await page.evaluate(() => (window as typeof window & { saved: boolean }).saved)).toBe(true);
  expect(reopened).toBe(1);
});

test('fails when the reopened lesson still shows the placeholder', async ({ page }) => {
  const { persistPlaceholderRepairs } = await import('../src/lams/ae-placeholder.js');
  // A save that did not land: reopening redraws the placeholder LAMS still has in the design.
  await page.setContent(`
    <button id="saveButton">Save</button>
    <div id="canvas"><svg>
      <g class="svg-activity svg-activity-gate" uiid="1"></g>
      <g class="svg-activity svg-activity-tool" uiid="2"></g>
      <g class="svg-activity svg-activity-tool" uiid="3"></g>
    </svg></div>
    <script>
      const gate = { uiid: 1, title: 'AE Gate Entry', gateType: 'permission', transitions: { from: [] } };
      const placeholder = { uiid: 2, title: 'AE Placeholder', toolID: 19, transitions: { from: [] } };
      const kept = { uiid: 3, title: 'AE 1', toolID: 19, transitions: { from: [] } };
      gate.transitions.from.push({ uiid: 4, fromActivity: gate, toActivity: placeholder });
      placeholder.transitions.from.push({ uiid: 5, fromActivity: placeholder, toActivity: kept });
      window.layout = { activities: [gate, placeholder, kept] };
      document.getElementById('saveButton').onclick = () => {};
    </script>
  `);
  const expected = projectPlaceholderRepairs(graph, repair);

  await expect(persistPlaceholderRepairs(page, expected, async () => {})).rejects.toThrow('did not persist');
});
