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
  expect(expectedTBLGraph(source,config,plan,terminal)).toMatchObject({expectedAENodes:2,expectedAEGates:2,expectedFlow:['AE Gate Entry','AE 1','AE Gate 2','AE 2']});
});
