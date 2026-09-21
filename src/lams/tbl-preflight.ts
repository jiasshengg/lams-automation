import type { Page } from '@playwright/test';
import type { AEPlan } from '../ae/plan.js';
import type { IratRequest, LamsConfig } from '../config.js';
import { inspectAuthoringGraph, type AuthoringGraph } from './authoring.js';
import { buildDesiredAEFlow, planAEGraphReconciliation } from './ae-graph.js';
import { projectPlaceholderRepairs, type PlaceholderRepairPlan } from './ae-placeholder.js';
import { LamsIratEditor } from './irat-editor.js';
import { validateObservedState } from './irat.js';

/** Counts are derived from the approved template prefix plus the reviewed SoT flow. */
export function expectedTBLGraph(graph: AuthoringGraph, config: LamsConfig, plan: AEPlan, repair?: PlaceholderRepairPlan) {
  const projected = repair ? projectPlaceholderRepairs(graph, repair) : graph;
  if (!projected.modelAvailable || projected.transitions.some(edge => edge.fromUiid === null || edge.toUiid === null)) throw new Error('Template preflight requires verified graph endpoints.');
  if (new Set(projected.nodes.map(n => n.name)).size !== projected.nodes.length) throw new Error('Template node titles are ambiguous.');
  const desired = buildDesiredAEFlow(plan);
  const removed = new Set(repair?.removals.map(r => r.title) ?? []);
  if (desired.some(title => removed.has(title))) throw new Error('A planned AE node cannot also be removed as a placeholder.');
  const unplanned = projected.nodes.filter(n => n.type === 'tool' && /^AE\b/i.test(n.name) && !plan.nodes.some(p => p.title === n.name));
  if (unplanned.length) throw new Error(`Unplanned existing AE activities require an exact disposition before writes: ${unplanned.map(n => JSON.stringify(n.name)).join(', ')}. Inspect them; provide an authorized --repair-json for verified placeholders.`);
  const configured = config.expectedFlow.filter(name => !desired.includes(name) && !removed.has(name));
  // The gate at the end of the reviewed prefix leads into the AE chain, so it carries the same name
  // as every other AE gate: the title of the node after it. It is matched under the template's own
  // title on a first run and under its reviewed title once a run has renamed it.
  const configuredLead = configured.at(-1);
  const lead = configuredLead !== undefined && /^AE Gate\b/i.test(configuredLead)
    ? [configuredLead, plan.leadingGateTitle].find(name => projected.nodes.some(n => n.name === name && n.type === 'gate'))
    : undefined;
  const prefix = lead === undefined ? configured : [...configured.slice(0, -1), lead];
  const reviewedPrefix = lead === undefined ? configured : [...configured.slice(0, -1), plan.leadingGateTitle];
  if (!prefix.length || new Set(prefix).size !== prefix.length) throw new Error('A unique reviewed template prefix is required in expectedFlow.');
  for (const name of prefix) {
    if (projected.nodes.filter(n => n.name === name).length !== 1) throw new Error(`Reviewed template node "${name}" is missing or ambiguous.`);
  }
  for (let i = 0; i + 1 < prefix.length; i++) {
    const from = projected.nodes.find(n => n.name === prefix[i])!;
    const to = projected.nodes.find(n => n.name === prefix[i + 1])!;
    const outgoing = projected.transitions.filter(edge => edge.fromUiid === from.uiid);
    if (outgoing.length !== 1 || outgoing[0]!.toUiid !== to.uiid) throw new Error(`Reviewed template connection ${from.name} -> ${to.name} is missing or branched.`);
  }
  const unexpected = projected.nodes.filter(n => !prefix.includes(n.name) && !desired.includes(n.name));
  if (unexpected.length) throw new Error(`Nodes outside the reviewed template and AE plan: ${unexpected.map(n => n.name).join(', ')}.`);
  const extraGateNames = prefix.filter(name => projected.nodes.some(n => n.name === name && n.type === 'gate' && /^AE Gate\b/i.test(name)));
  // Both the name the gate is found under and the one configured for it are superseded by its
  // reviewed title, so neither is left behind as an expectation for a gate that no longer exists.
  const renamedLead = lead === undefined ? [] : [configuredLead!, lead, plan.leadingGateTitle];
  return {
    expectedFlow: [...reviewedPrefix, ...desired],
    expectedAENodes: plan.requiredAENodes,
    expectedAEGates: plan.requiredAEGates + extraGateNames.length,
    expectedGateProperties: [
      ...(config.expectedGateProperties ?? []).filter(g => !removed.has(g.name) && !plan.gates.some(p => p.title === g.name) && !renamedLead.includes(g.name)),
      ...(lead === undefined ? [] : [{ name: plan.leadingGateTitle, type: 'permission' as const, description: plan.leadingGateTitle, stopAtPrecedingActivity: true }]),
      ...plan.gates.map(g => ({ name: g.title, type: 'permission' as const, description: g.title, stopAtPrecedingActivity: true }))
    ]
  };
}

export async function preflightTBL(page: Page, config: LamsConfig, irat: IratRequest, ae?: AEPlan, repair?: PlaceholderRepairPlan) {
  if (repair && repair.lessonTitle !== config.lessonTitle) throw new Error('Repair plan lessonTitle does not match the requested destination lesson.');
  const graph = await inspectAuthoringGraph(page);
  const issues: string[] = [];
  let expectations;
  if (ae) {
    try {
      expectations = expectedTBLGraph(graph, config, ae, repair);
      const reconciler = planAEGraphReconciliation(repair ? projectPlaceholderRepairs(graph, repair) : graph, ae);
      issues.push(...reconciler.invalidGates);
    } catch (error) { issues.push(error instanceof Error ? error.message : String(error)); }
  } else if (repair) issues.push('Placeholder repairs in the combined workflow require an AE plan.');
  const observed = await new LamsIratEditor(page, irat, config.browser.actionTimeoutMs).inspect();
  issues.push(...validateObservedState(observed, irat).checks.filter(c => !c.passed).map(c => c.detail));
  const report = { ready: issues.length === 0, issues, existingQuestionTitles: observed.questions.map(q => q.title), expectations };
  console.log(`TBL preflight (no writes):\n${JSON.stringify(report, null, 2)}`);
  return report;
}
