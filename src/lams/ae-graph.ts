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
  gatesToReplace: string[];
  invalidGates: string[];
  ready: boolean;
}

export interface AEGraphReconciliationResult {
  plan: AEGraphReconciliationPlan;
  writtenNodes: AEWriteResult[];
  createdNodes: string[];
  createdGates: string[];
  createdTransitions: Array<{ from: string; to: string }>;
  replacedGates: string[];
  removedTransitions: Array<{ from: string; to: string }>;
}

export function planAEGraphReconciliation(graph: AuthoringGraph, plan: AEPlan): AEGraphReconciliationPlan {
  const desiredFlow = buildDesiredAEFlow(plan);
  const duplicateNames = desiredFlow.filter((name, index) => desiredFlow.indexOf(name) !== index);
  if (duplicateNames.length > 0) throw new Error(`AE graph plan contains duplicate titles: ${[...new Set(duplicateNames)].join(', ')}`);
  const byName = new Map(graph.nodes.map((node) => [node.name, node]));
  const missingNodeTitles = plan.nodes.map((node) => node.title).filter((title) => !byName.has(title));
  const missingGateTitles = plan.gates.map((gate) => gate.title).filter((title) => !byName.has(title));
  const gateChecks = plan.gates.map((gate) => {
    const matches = graph.nodes.filter((node) => node.name === gate.title);
    if (matches.length === 0) return { title: gate.title, replace: false, error: null };
    if (matches.length !== 1 || matches[0]!.type !== 'gate') {
      return { title: gate.title, replace: false, error: `"${gate.title}" must identify exactly one gate` };
    }
    const existing = matches[0]!;
    if (existing.gateType === null || existing.stopAtPrecedingActivity === null) {
      return {
        title: gate.title,
        replace: false,
        error: `"${gate.title}" settings could not be verified (found ${existing.gateType ?? 'unknown'}, ${existing.stopAtPrecedingActivity ?? 'unknown'})`
      };
    }
    const matchesSettings = existing.gateType === 'permission' && existing.stopAtPrecedingActivity === true;
    if (matchesSettings) return { title: gate.title, replace: false, error: null };
    const topologyErrors = replacementGateTopologyErrors(graph, desiredFlow, existing);
    return topologyErrors.length === 0
      ? { title: gate.title, replace: true, error: null }
      : { title: gate.title, replace: false, error: `"${gate.title}" cannot be safely replaced: ${topologyErrors.join('; ')}` };
  });
  const gatesToReplace = gateChecks.filter((check) => check.replace).map((check) => check.title);
  const invalidGates = gateChecks.flatMap((check) => check.error ? [check.error] : []);
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
    gatesToReplace,
    invalidGates,
    ready: bypassTransitions.length === 0 && gatesToReplace.length === 0 && invalidGates.length === 0
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
  await preflightGraphRepairs(page, initial);

  const writtenNodes: AEWriteResult[] = [];
  const createdNodes: string[] = [];
  const createdGates: string[] = [];
  const createdTransitions: Array<{ from: string; to: string }> = [];
  const replacedGates: string[] = [];
  const removedTransitions: Array<{ from: string; to: string }> = [];

  for (const edge of initial.bypassTransitions) {
    await removeAuthoringTransition(page, edge.from, edge.to, timeoutMs);
    removedTransitions.push(edge);
  }

  for (const title of initial.gatesToReplace) {
    const graph = await inspectAuthoringGraph(page);
    const gate = uniqueByName(graph, title);
    if (gate.type !== 'gate') throw new Error(`Refusing to replace non-gate node "${title}".`);
    await removeAuthoringNode(page, gate, timeoutMs);
    replacedGates.push(title);
  }

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
  return { plan: finalPlan, writtenNodes, createdNodes, createdGates, createdTransitions, replacedGates, removedTransitions };
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

async function preflightGraphRepairs(page: Page, plan: AEGraphReconciliationPlan): Promise<void> {
  if (plan.bypassTransitions.length === 0 && plan.gatesToReplace.length === 0) return;
  const runtimeAvailable = await page.evaluate(() => {
    const runtime = window as typeof window & {
      ActivityLib?: { removeActivity?: unknown; removeTransition?: unknown };
    };
    return {
      removeActivity: typeof runtime.ActivityLib?.removeActivity === 'function',
      removeTransition: typeof runtime.ActivityLib?.removeTransition === 'function'
    };
  });
  if (plan.bypassTransitions.length > 0 && !runtimeAvailable.removeTransition) {
    throw new Error('AE graph repair requires ActivityLib.removeTransition, but the verified LAMS runtime API is unavailable. No AE changes applied.');
  }
  if (plan.gatesToReplace.length > 0 && !runtimeAvailable.removeActivity) {
    throw new Error('AE graph repair requires ActivityLib.removeActivity, but the verified LAMS runtime API is unavailable. No AE changes applied.');
  }
  const graph = await inspectAuthoringGraph(page);
  for (const edge of plan.bypassTransitions) {
    const from = uniqueByName(graph, edge.from);
    const to = uniqueByName(graph, edge.to);
    const matches = graph.transitions.filter((transition) => transition.fromUiid === from.uiid && transition.toUiid === to.uiid);
    if (matches.length !== 1) {
      throw new Error(`Expected one transition ${edge.from} -> ${edge.to}; found ${matches.length}. No AE changes applied.`);
    }
  }
  for (const title of plan.gatesToReplace) {
    const gate = uniqueByName(graph, title);
    if (gate.type !== 'gate') throw new Error(`Refusing to replace non-gate node "${title}". No AE changes applied.`);
    const topologyErrors = replacementGateTopologyErrors(graph, plan.desiredFlow, gate);
    if (topologyErrors.length > 0) {
      throw new Error(`Refusing to replace gate "${title}": ${topologyErrors.join('; ')}. No AE changes applied.`);
    }
  }
}

function replacementGateTopologyErrors(graph: AuthoringGraph, desiredFlow: string[], gate: GraphNode): string[] {
  const gateIndex = desiredFlow.indexOf(gate.name);
  if (gateIndex <= 0 || gateIndex >= desiredFlow.length - 1) {
    return ['the gate is not between two activities in the reviewed AE flow'];
  }

  const unverifiedTransitions = graph.transitions.filter(
    (transition) => transition.fromUiid === null || transition.toUiid === null
  );
  if (unverifiedTransitions.length > 0) {
    return [`${unverifiedTransitions.length} graph transition(s) have unverified endpoints`];
  }

  const precedingTitle = desiredFlow[gateIndex - 1]!;
  const followingTitle = desiredFlow[gateIndex + 1]!;
  const preceding = graph.nodes.filter((node) => node.name === precedingTitle);
  const following = graph.nodes.filter((node) => node.name === followingTitle);
  const incoming = graph.transitions.filter((transition) => transition.toUiid === gate.uiid);
  const outgoing = graph.transitions.filter((transition) => transition.fromUiid === gate.uiid);
  const errors: string[] = [];

  if (incoming.length > 0 && preceding.length !== 1) {
    errors.push(`expected one preceding node "${precedingTitle}" before checking ${incoming.length} incoming transition(s), found ${preceding.length}`);
  } else if (preceding.length === 1) {
    const expected = incoming.filter((transition) => transition.fromUiid === preceding[0]!.uiid);
    const unexpected = incoming.filter((transition) => transition.fromUiid !== preceding[0]!.uiid);
    if (expected.length > 1) errors.push(`found ${expected.length} duplicate transitions from "${precedingTitle}"`);
    if (unexpected.length > 0) errors.push(`found ${unexpected.length} incoming transition(s) outside the reviewed AE flow`);
  }

  if (outgoing.length > 0 && following.length !== 1) {
    errors.push(`expected one following node "${followingTitle}" before checking ${outgoing.length} outgoing transition(s), found ${following.length}`);
  } else if (following.length === 1) {
    const expected = outgoing.filter((transition) => transition.toUiid === following[0]!.uiid);
    const unexpected = outgoing.filter((transition) => transition.toUiid !== following[0]!.uiid);
    if (expected.length > 1) errors.push(`found ${expected.length} duplicate transitions to "${followingTitle}"`);
    if (unexpected.length > 0) errors.push(`found ${unexpected.length} outgoing transition(s) outside the reviewed AE flow`);
  }

  return errors;
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

export async function removeAuthoringTransition(
  page: Page,
  fromTitle: string,
  toTitle: string,
  timeoutMs: number
): Promise<void> {
  const graph = await inspectAuthoringGraph(page);
  const from = uniqueByName(graph, fromTitle);
  const to = uniqueByName(graph, toTitle);
  const matches = graph.transitions.filter((transition) => transition.fromUiid === from.uiid && transition.toUiid === to.uiid);
  if (matches.length !== 1) {
    throw new Error(`Expected one transition ${fromTitle} -> ${toTitle}; found ${matches.length}.`);
  }
  const transitionUiid = matches[0]!.uiid;
  await page.evaluate((uiid) => {
    const runtime = window as typeof window & {
      layout?: { activities?: Array<{ transitions?: { from?: Array<{ uiid?: number }> } }> };
      ActivityLib?: { removeTransition?: (transition: { uiid?: number }) => void };
    };
    const transition = (runtime.layout?.activities ?? [])
      .flatMap((activity) => activity.transitions?.from ?? [])
      .find((candidate) => candidate.uiid === uiid);
    if (!transition || typeof runtime.ActivityLib?.removeTransition !== 'function') {
      throw new Error(`Runtime transition ${uiid} or ActivityLib.removeTransition is unavailable.`);
    }
    runtime.ActivityLib.removeTransition(transition);
  }, transitionUiid);
  await page.waitForFunction(
    (uiid) => !((window as typeof window & { layout?: { activities?: Array<{ transitions?: { from?: Array<{ uiid?: number }> } }> } }).layout?.activities ?? [])
      .some((activity) => activity.transitions?.from?.some((transition) => transition.uiid === uiid)),
    transitionUiid,
    { timeout: timeoutMs }
  );
}

export async function removeAuthoringNode(page: Page, node: GraphNode, timeoutMs: number): Promise<void> {
  const current = (await inspectAuthoringGraph(page)).nodes.filter((candidate) => candidate.uiid === node.uiid && candidate.name === node.name);
  if (current.length !== 1) throw new Error(`Runtime UIID ${node.uiid} did not resolve to exact node "${node.name}".`);
  await page.evaluate((uiid) => {
    const runtime = window as typeof window & {
      layout?: { activities?: Array<{ uiid?: number }> };
      ActivityLib?: { removeActivity?: (activity: { uiid?: number }, forceRemove?: boolean) => void };
    };
    const activity = (runtime.layout?.activities ?? []).find((candidate) => candidate.uiid === uiid);
    if (!activity || typeof runtime.ActivityLib?.removeActivity !== 'function') {
      throw new Error(`Runtime activity ${uiid} or ActivityLib.removeActivity is unavailable.`);
    }
    runtime.ActivityLib.removeActivity(activity, true);
  }, node.uiid);
  await page.waitForFunction(
    (uiid) => !((window as typeof window & { layout?: { activities?: Array<{ uiid?: number }> } }).layout?.activities ?? [])
      .some((activity) => activity.uiid === uiid),
    node.uiid,
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
