import type { Page } from '@playwright/test';
import type { AEPlan } from '../ae/plan.js';
import type { LamsAEEditor, AEWriteResult } from './ae-editor.js';
import { inspectAuthoringGraph, openActivityProperties, type AuthoringGraph, type GraphNode } from './authoring.js';

export interface AEGraphReconciliationPlan {
  desiredFlow: string[];
  missingNodeTitles: string[];
  missingGateTitles: string[];
  missingTransitions: Array<{ from: string; to: string }>;
  bypassTransitions: Array<{ from: string; to: string }>;
  invalidGates: string[];
  ready: boolean;
}

export interface AEGraphReconciliationResult {
  plan: AEGraphReconciliationPlan;
  writtenNodes: AEWriteResult[];
  createdNodes: string[];
  createdGates: string[];
  createdTransitions: Array<{ from: string; to: string }>;
}

export function planAEGraphReconciliation(graph: AuthoringGraph, plan: AEPlan): AEGraphReconciliationPlan {
  const desiredFlow = buildDesiredAEFlow(plan);
  const duplicateNames = desiredFlow.filter((name, index) => desiredFlow.indexOf(name) !== index);
  if (duplicateNames.length > 0) throw new Error(`AE graph plan contains duplicate titles: ${[...new Set(duplicateNames)].join(', ')}`);
  const byName = new Map(graph.nodes.map((node) => [node.name, node]));
  const missingNodeTitles = plan.nodes.map((node) => node.title).filter((title) => !byName.has(title));
  const missingGateTitles = plan.gates.map((gate) => gate.title).filter((title) => !byName.has(title));
  const invalidGates = plan.gates.flatMap((gate) => {
    const matches = graph.nodes.filter((node) => node.name === gate.title);
    if (matches.length === 0) return [];
    if (matches.length !== 1 || matches[0]!.type !== 'gate') {
      return [`"${gate.title}" must identify exactly one gate`];
    }
    const existing = matches[0]!;
    return existing.gateType === 'permission' && existing.stopAtPrecedingActivity === true
      ? []
      : [`"${gate.title}" requires permission type and Stop at preceding activity enabled (found ${existing.gateType ?? 'unknown'}, ${existing.stopAtPrecedingActivity ?? 'unknown'})`];
  });
  const desiredPairs = consecutivePairs(desiredFlow);
  const missingTransitions = desiredPairs.filter(({ from, to }) => {
    const fromNode = byName.get(from);
    const toNode = byName.get(to);
    return !fromNode || !toNode || !hasTransition(graph, fromNode.uiid, toNode.uiid);
  });
  const bypassTransitions = plan.gates.flatMap((gate) => {
    const from = byName.get(gate.afterNodeTitle);
    const to = byName.get(gate.beforeNodeTitle);
    return from && to && hasTransition(graph, from.uiid, to.uiid)
      ? [{ from: gate.afterNodeTitle, to: gate.beforeNodeTitle }]
      : [];
  });
  return {
    desiredFlow,
    missingNodeTitles,
    missingGateTitles,
    missingTransitions,
    bypassTransitions,
    invalidGates,
    ready: bypassTransitions.length === 0 && invalidGates.length === 0
  };
}

export async function reconcileAndWriteAEGraph(
  page: Page,
  plan: AEPlan,
  editor: Pick<LamsAEEditor, 'writeExistingNode' | 'writeNode' | 'associateWithTeamSetup' | 'saveDesign'>,
  teamSetupName: string,
  timeoutMs: number
): Promise<AEGraphReconciliationResult> {
  const initial = planAEGraphReconciliation(await inspectAuthoringGraph(page), plan);
  if (initial.invalidGates.length > 0) {
    throw new Error(`Existing AE gates do not match required settings: ${initial.invalidGates.join('; ')}. No AE changes applied.`);
  }
  if (!initial.ready) {
    throw new Error(
      `AE graph contains direct transition(s) that would bypass a planned gate: ${initial.bypassTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ')}. Automatic transition deletion is not supported.`
    );
  }

  const writtenNodes: AEWriteResult[] = [];
  const createdNodes: string[] = [];
  const createdGates: string[] = [];
  const createdTransitions: Array<{ from: string; to: string }> = [];
  for (const nodePlan of plan.nodes) {
    const graph = await inspectAuthoringGraph(page);
    const existing = graph.nodes.filter((node) => node.type === 'tool' && node.name === nodePlan.title);
    let result: AEWriteResult;
    if (existing.length === 1) {
      result = await editor.writeExistingNode(nodePlan);
    } else if (existing.length === 0) {
      const shell = await createTemplateNode(page, 'Assessment', 'tool', timeoutMs);
      result = await editor.writeNode(shell, nodePlan);
      createdNodes.push(nodePlan.title);
    } else {
      throw new Error(`AE node title "${nodePlan.title}" is ambiguous; found ${existing.length}.`);
    }
    await editor.associateWithTeamSetup(nodePlan.title, teamSetupName);
    writtenNodes.push(result);
  }

  for (const gatePlan of plan.gates) {
    const graph = await inspectAuthoringGraph(page);
    const matches = graph.nodes.filter((node) => node.type === 'gate' && node.name === gatePlan.title);
    if (matches.length > 1) throw new Error(`AE gate title "${gatePlan.title}" is ambiguous; found ${matches.length}.`);
    if (matches.length === 0) {
      const gate = await createTemplateNode(page, 'Gate', 'gate', timeoutMs);
      await configurePermissionGate(page, gate, gatePlan.title, timeoutMs);
      createdGates.push(gatePlan.title);
    }
  }

  for (const edge of consecutivePairs(buildDesiredAEFlow(plan))) {
    const graph = await inspectAuthoringGraph(page);
    const from = uniqueByName(graph, edge.from);
    const to = uniqueByName(graph, edge.to);
    if (hasTransition(graph, from.uiid, to.uiid)) continue;
    await createTransition(page, from, to, timeoutMs);
    createdTransitions.push(edge);
  }
  await editor.saveDesign();
  const finalPlan = planAEGraphReconciliation(await inspectAuthoringGraph(page), plan);
  if (!finalPlan.ready || finalPlan.missingTransitions.length > 0 || finalPlan.missingNodeTitles.length > 0 || finalPlan.missingGateTitles.length > 0) {
    throw new Error('Post-save AE graph verification reports invalid gates, bypasses, or missing nodes, gates, or transitions.');
  }
  return { plan: finalPlan, writtenNodes, createdNodes, createdGates, createdTransitions };
}

export function buildDesiredAEFlow(plan: AEPlan): string[] {
  const flow: string[] = [];
  plan.nodes.forEach((node, index) => {
    flow.push(node.title);
    const next = plan.nodes[index + 1];
    if (!next) return;
    const gate = plan.gates.find((candidate) => candidate.afterNodeTitle === node.title && candidate.beforeNodeTitle === next.title);
    if (!gate) throw new Error(`No reviewed AE gate connects "${node.title}" to "${next.title}".`);
    flow.push(gate.title);
  });
  return flow;
}

async function createTemplateNode(
  page: Page,
  templateTitle: 'Assessment' | 'Gate',
  expectedType: GraphNode['type'],
  timeoutMs: number
): Promise<GraphNode> {
  const before = await inspectAuthoringGraph(page);
  const beforeIds = new Set(before.nodes.map((node) => node.uiid));
  const heading = templateTitle === 'Assessment' ? '#collapse-heading-tool-category-3' : '#collapse-heading-tool-category-1';
  const panel = templateTitle === 'Assessment' ? '#collapse-tool-category-3' : '#collapse-tool-category-1';
  if (!(await page.locator(panel).isVisible())) await page.locator(heading).click();
  const template = page.locator(`.template[learninglibrarytitle="${templateTitle}"]`);
  await template.waitFor({ state: 'visible', timeout: timeoutMs });
  const canvas = page.locator('#canvas');
  const maxY = Math.max(0, ...before.nodes.map((node) => node.y ?? 0));
  const targetY = maxY + 120;
  await canvas.evaluate((element, height) => {
    const current = Number.parseFloat(getComputedStyle(element).height) || 0;
    if (height > current) (element as HTMLElement).style.height = `${height}px`;
  }, targetY + 140);
  await template.dragTo(canvas, { targetPosition: { x: expectedType === 'gate' ? 380 : 140, y: targetY } });
  await page.waitForFunction(
    (ids) => Array.from(document.querySelectorAll('#canvas > svg > g.svg-activity')).some((element) => !ids.includes(Number(element.getAttribute('uiid')))),
    [...beforeIds],
    { timeout: timeoutMs }
  );
  const created = (await inspectAuthoringGraph(page)).nodes.filter((node) => !beforeIds.has(node.uiid));
  if (created.length !== 1 || created[0]!.type !== expectedType) {
    throw new Error(`Creating ${templateTitle} produced ${created.length} new node(s); expected one ${expectedType}.`);
  }
  return created[0]!;
}

async function configurePermissionGate(page: Page, gate: GraphNode, title: string, timeoutMs: number): Promise<void> {
  await openActivityProperties(page, gate.uiid, gate.name, timeoutMs);
  const dialog = page.locator('#propertiesDialog');
  await dialog.locator('.propertiesContentFieldTitle:visible').fill(title);
  await dialog.locator('.propertiesContentFieldDescription:visible').fill(title);
  await dialog.locator('.propertiesContentFieldGateType:visible').selectOption('permission');
  const stop = dialog.locator('.propertiesContentFieldStopAtPrecedingActivity:visible');
  if (!(await stop.isChecked())) await stop.check();
  await dialog.locator('.propertiesContentFieldDescription:visible').blur();
  await page.waitForFunction(
    (expected) => ((window as typeof window & { layout?: { activities?: Array<{ title?: string }> } }).layout?.activities ?? [])
      .some((activity) => activity.title?.trim() === expected),
    title,
    { timeout: timeoutMs }
  );
}

async function createTransition(page: Page, from: GraphNode, to: GraphNode, timeoutMs: number): Promise<void> {
  if (await page.locator('#propertiesDialog').isVisible()) {
    await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  }
  await page.locator('#transitionButton').click();
  await page.locator(`#canvas > svg > g.svg-activity[uiid="${from.uiid}"]`).click();
  await page.locator(`#canvas > svg > g.svg-activity[uiid="${to.uiid}"]`).click();
  await page.waitForFunction(
    ([fromId, toId]) => {
      const activities = (window as typeof window & { layout?: { activities?: Array<{ uiid?: number; transitions?: { from?: Array<{ fromActivity?: { uiid?: number }; toActivity?: { uiid?: number } }> } }> } }).layout?.activities ?? [];
      return activities.some((activity) => activity.transitions?.from?.some((transition) => transition.fromActivity?.uiid === fromId && transition.toActivity?.uiid === toId));
    },
    [from.uiid, to.uiid],
    { timeout: timeoutMs }
  );
}

function uniqueByName(graph: AuthoringGraph, title: string): GraphNode {
  const matches = graph.nodes.filter((node) => node.name === title);
  if (matches.length !== 1) throw new Error(`Expected one graph node named "${title}"; found ${matches.length}.`);
  return matches[0]!;
}

function hasTransition(graph: AuthoringGraph, fromUiid: number, toUiid: number): boolean {
  return graph.transitions.some((transition) => transition.fromUiid === fromUiid && transition.toUiid === toUiid);
}

function consecutivePairs(flow: string[]): Array<{ from: string; to: string }> {
  return flow.slice(0, -1).map((from, index) => ({ from, to: flow[index + 1]! }));
}
