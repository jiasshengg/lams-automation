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
  renamedGates: Array<{ from: string; to: string }>;
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
  editor: Pick<
    LamsAEEditor,
    'writeExistingNode' | 'writeNode' | 'associateWithTeamSetup' | 'associateNodeWithTeamSetup' | 'saveDesign'
  >,
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

  // Structure before content. LAMS disables the team-based Assessment settings until the activity
  // is grouped and a Leader Selection precedes it in the flow, so a node that is written before it
  // is wired in cannot receive them. Nodes are therefore created, grouped and connected first, and
  // titled and filled afterwards. Until that second pass every new shell is still called
  // "Assessment", so this phase addresses nodes by uiid rather than by title.
  const nodeRefs: GraphNode[] = [];
  for (const nodePlan of plan.nodes) {
    const graph = await inspectAuthoringGraph(page);
    const existing = graph.nodes.filter((node) => node.type === 'tool' && node.name === nodePlan.title);
    if (existing.length > 1) {
      throw new Error(`AE node title "${nodePlan.title}" is ambiguous; found ${existing.length}.`);
    }
    const node = existing.length === 1 ? existing[0]! : await createTemplateNode(page, 'Assessment', 'tool', timeoutMs);
    if (existing.length === 0) createdNodes.push(nodePlan.title);
    await editor.associateNodeWithTeamSetup(node, teamSetupName);
    nodeRefs.push(node);
  }

  const gateRefs = new Map<string, GraphNode>();
  for (const gatePlan of plan.gates) {
    const graph = await inspectAuthoringGraph(page);
    const matches = graph.nodes.filter((node) => node.type === 'gate' && node.name === gatePlan.title);
    if (matches.length > 1) throw new Error(`AE gate title "${gatePlan.title}" is ambiguous; found ${matches.length}.`);
    if (matches.length === 1) {
      gateRefs.set(gatePlan.title, matches[0]!);
      continue;
    }
    const gate = await createTemplateNode(page, 'Gate', 'gate', timeoutMs);
    await configurePermissionGate(page, gate, gatePlan.title, timeoutMs);
    createdGates.push(gatePlan.title);
    gateRefs.set(gatePlan.title, gate);
  }

  // The same order buildDesiredAEFlow describes, resolved to the nodes this run is working with.
  const flow: Array<{ node: GraphNode; title: string }> = [];
  plan.nodes.forEach((nodePlan, index) => {
    flow.push({ node: nodeRefs[index]!, title: nodePlan.title });
    const next = plan.nodes[index + 1];
    if (!next) return;
    const gatePlan = plan.gates.find(
      (candidate) => candidate.afterNodeTitle === nodePlan.title && candidate.beforeNodeTitle === next.title
    );
    if (!gatePlan) throw new Error(`No reviewed AE gate connects "${nodePlan.title}" to "${next.title}".`);
    flow.push({ node: gateRefs.get(gatePlan.title)!, title: gatePlan.title });
  });

  // The reference design is a single column - Team Setup, iRAT, tRAT, then each AE activity, every
  // pair separated by a gate. A new AE chain therefore has to extend that flow rather than sit
  // beside it, and not only for tidiness: LAMS enables the team-based AE settings only when a
  // Leader Selection precedes the activity, which cannot hold while the chain is detached.
  const plannedUiids = new Set([...nodeRefs, ...gateRefs.values()].map((node) => node.uiid));
  const beforeWiring = await inspectAuthoringGraph(page);
  // On a re-run the chain is already attached, so there is no loose end left to attach it to.
  const attached = beforeWiring.transitions.some((transition) => transition.toUiid === nodeRefs[0]!.uiid);
  const tails = attached ? [] : beforeWiring.nodes.filter(
    (node) =>
      !plannedUiids.has(node.uiid) &&
      node.type !== 'grouping' &&
      !beforeWiring.transitions.some((transition) => transition.fromUiid === node.uiid)
  );
  if (!attached) {
    if (tails.length !== 1) {
      const names = tails.map((node) => `"${node.name}"`).join(', ') || 'none';
      throw new Error(
        `The AE chain must extend the existing flow, so exactly one activity may be left without an ` +
          `outgoing transition; found ${tails.length} (${names}). Connect or remove the extras first.`
      );
    }
    const tail = tails[0]!;
    console.log(`Extending the flow from "${tail.name}" into "${flow[0]!.title}".`);
    flow.unshift({ node: tail, title: tail.name });
  }

  await withViewportShowingWholeCanvas(page, async () => {
    for (let index = 0; index + 1 < flow.length; index += 1) {
      const from = flow[index]!;
      const to = flow[index + 1]!;
      const graph = await inspectAuthoringGraph(page);
      if (hasTransition(graph, from.node.uiid, to.node.uiid)) continue;
      try {
        await createTransition(page, from.node, to.node, timeoutMs);
      } catch (error) {
        // LAMS resolves both endpoints with document.elementFromPoint at the click position, so
        // report what that call actually returns for each - that is the only thing it acts on.
        const probe = await page.evaluate(([firstUiid, secondUiid]) => {
          const results = [];
          for (const uiid of [firstUiid, secondUiid]) {
            const activity = document.querySelector(`#canvas > svg > g.svg-activity[uiid="${uiid}"]`);
            const box = activity?.getBoundingClientRect();
            if (!box) {
              results.push(`uiid ${uiid}: not in the DOM`);
              continue;
            }
            const centreX = box.left + box.width / 2;
            const centreY = box.top + box.height / 2;
            const hit = document.elementFromPoint(centreX, centreY);
            const owner = hit?.closest('g[uiid]')?.getAttribute('uiid') ?? 'none';
            results.push(
              `uiid ${uiid}: centre (${Math.round(centreX)},${Math.round(centreY)}) hits <${hit?.tagName ?? 'nothing'} ` +
                `class="${hit?.getAttribute('class') ?? ''}"> owned by uiid ${owner}`
            );
          }
          return `scrollY ${window.scrollY}, innerHeight ${window.innerHeight}; ${results.join('; ')}`;
        }, [from.node.uiid, to.node.uiid]);
        throw new Error(
          `Could not connect "${from.title}" (uiid ${from.node.uiid}) to "${to.title}" (uiid ${to.node.uiid}), ` +
            `transition ${index + 1} of ${flow.length - 1}: ${error instanceof Error ? error.message : String(error)}
` +
            `Hit test: ${probe}`
        );
      }
      console.log(`Connected ${from.title} -> ${to.title}`);
      createdTransitions.push({ from: from.title, to: to.title });
    }
  });

  await arrangeAEActivities(page, timeoutMs);

  // Now each node sits in the flow, so its team-based settings are enabled.
  for (const [index, nodePlan] of plan.nodes.entries()) {
    writtenNodes.push(await editor.writeNode(nodeRefs[index]!, nodePlan));
  }
  // Renaming the gate only changes the canvas model, and saving an activity reloads that model from
  // the server, which drops a rename made before it. It therefore runs last, against the design the
  // save is about to write.
  const renamedGates = await renameLeadingAEGate(page, plan, nodeRefs[0]!.uiid, timeoutMs);
  await editor.saveDesign();
  const finalPlan = planAEGraphReconciliation(await inspectAuthoringGraph(page), plan);
  if (!finalPlan.ready || finalPlan.missingTransitions.length > 0 || finalPlan.missingNodeTitles.length > 0 || finalPlan.missingGateTitles.length > 0) {
    throw new Error('Post-save AE graph verification reports invalid gates, bypasses, or missing nodes, gates, or transitions.');
  }
  return { plan: finalPlan, writtenNodes, createdNodes, createdGates, createdTransitions, replacedGates, renamedGates, removedTransitions };
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

/**
 * LAMS spells the Assessment template's title capitalised but the gate template's in lower case,
 * and CSS attribute matching is case-sensitive, so each has to be used exactly as the DOM has it.
 */
export const TEMPLATE_LIBRARY_TITLES = { Assessment: 'Assessment', Gate: 'gate' } as const;

/**
 * The reference design reads as one column of activities with the gates in a narrow column to
 * their right, each gate level with the gap it bridges. LAMS produces exactly that from its own
 * Arrange button, which recognises a TBL sequence, breaks the row after every gate, redraws each
 * transition and autosaves. Pressing it is what an author does, so the automation presses it too
 * rather than placing each activity by hand and drifting from the layout LAMS would have made.
 */
const ARRANGE_GRID = { columnWidth: 240, rowHeight: 120, activityX: 40, activityY: 40, gateX: 120, gateY: 60 };

export async function arrangeAEActivities(page: Page, timeoutMs: number): Promise<void> {
  await page.locator('#arrangeButton').click();
  // Arrange only asks before discarding annotation positions, which a TBL sequence has none of.
  // It is answered rather than assumed absent, because cancelling leaves the canvas untouched.
  const confirmation = page.locator('#confirmationDialogConfirmButton');
  if (await confirmation.isVisible().catch(() => false)) await confirmation.click();

  // Arrange lays every activity on a fixed grid, so a silently ignored click shows up as soon as
  // one activity is still off it. Gates sit half a row below the activity whose gap they bridge.
  await page.waitForFunction(
    (grid) =>
      Array.from(document.querySelectorAll('#canvas > svg > g.svg-activity')).every((activity) => {
        const x = Number(activity.getAttribute('data-x') ?? NaN);
        const y = Number(activity.getAttribute('data-y') ?? NaN);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        const gate = activity.classList.contains('svg-activity-gate');
        return (
          x % grid.columnWidth === (gate ? grid.gateX : grid.activityX) &&
          y % grid.rowHeight === (gate ? grid.gateY : grid.activityY)
        );
      }),
    ARRANGE_GRID,
    { timeout: timeoutMs }
  );
  console.log('Arranged the design with LAMS Arrange.');
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
  // A properties dialog left open by an earlier step intercepts the drag onto the canvas.
  if (await page.locator('#propertiesDialog').isVisible()) {
    await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  }
  const template = page.locator(`.template[learninglibrarytitle="${TEMPLATE_LIBRARY_TITLES[templateTitle]}"]`);
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
  await answerAutogroupPrompt(page, timeoutMs);
  const created = (await inspectAuthoringGraph(page)).nodes.filter((node) => !beforeIds.has(node.uiid));
  if (created.length !== 1 || created[0]!.type !== expectedType) {
    throw new Error(`Creating ${templateTitle} produced ${created.length} new node(s); expected one ${expectedType}.`);
  }
  return created[0]!;
}

/**
 * The first time each activity type is dropped, LAMS asks whether to autogroup it. The prompt is
 * modal and intercepts pointer events, so every later canvas action fails until it is answered.
 * Decline: the answer is stored as a lasting account preference, and grouping is handled
 * explicitly by associateNodeWithTeamSetup before any settings are written, so the run must not
 * depend on whichever way this prompt was answered before.
 */
async function answerAutogroupPrompt(page: Page, timeoutMs: number): Promise<void> {
  const modal = page.locator('#autogroupPromptModal.show');
  // The prompt renders with the new activity, not before it; a short wait avoids missing the race.
  await modal.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (!(await modal.isVisible().catch(() => false))) return;
  await modal.locator('#autogroupPromptDecline').click();
  await modal.waitFor({ state: 'hidden', timeout: timeoutMs });
  console.log('Declined the LAMS autogrouping prompt; Team Setup is associated explicitly.');
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

/**
 * Every AE gate is named after the node it stands in front of. The gate before the first AE node
 * is supplied by the template, so it arrives under the template's own title and is renamed here
 * once the chain is wired and its predecessor is known. Only that one gate is touched, and only
 * when it really is the permission gate leading into the AE chain.
 */
export async function renameLeadingAEGate(
  page: Page,
  plan: AEPlan,
  firstNodeUiid: number,
  timeoutMs: number
): Promise<Array<{ from: string; to: string }>> {
  const graph = await inspectAuthoringGraph(page);
  const incoming = graph.transitions.filter((transition) => transition.toUiid === firstNodeUiid);
  if (incoming.length !== 1) return [];
  const lead = graph.nodes.find((node) => node.uiid === incoming[0]!.fromUiid);
  // The chain can also extend straight from an activity, which is not a gate and is not renamed.
  if (!lead || lead.type !== 'gate' || lead.name === plan.leadingGateTitle) return [];
  if (lead.gateType !== 'permission') {
    throw new Error(
      `The gate before "${plan.nodes[0]!.title}" is a ${lead.gateType ?? 'unreadable'} gate, not the permission gate ` +
        `the reviewed AE flow expects; inspect "${lead.name}" before renaming it.`
    );
  }
  await configurePermissionGate(page, lead, plan.leadingGateTitle, timeoutMs);
  console.log(`Renamed the leading AE gate "${lead.name}" to "${plan.leadingGateTitle}".`);
  return [{ from: lead.name, to: plan.leadingGateTitle }];
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

/** Connect exact live nodes; verify identities before touching the canvas. */
export async function connectAuthoringNodes(page: Page, from: GraphNode, to: GraphNode, timeoutMs: number): Promise<void> {
  const graph = await inspectAuthoringGraph(page);
  for (const node of [from, to]) {
    if (uniqueByName(graph, node.name).uiid !== node.uiid) throw new Error(`Stale graph node "${node.name}".`);
  }
  if (from.uiid === to.uiid) throw new Error('Cannot connect a node to itself.');
  if (hasTransition(graph, from.uiid, to.uiid)) return;
  await withViewportShowingWholeCanvas(page, () => createTransition(page, from, to, timeoutMs));
}

/**
 * LAMS picks transition endpoints with Snap.getElementByPoint(event.pageX, event.pageY), and Snap
 * forwards those to document.elementFromPoint, which expects viewport coordinates. Page and
 * viewport coordinates agree only at scroll offset 0, so on a scrolled page LAMS hit-tests a point
 * scrollY pixels away and selects nothing. Scrolling an activity into view therefore cannot work:
 * the viewport has to be tall enough to show the whole canvas at once instead.
 */
async function withViewportShowingWholeCanvas<T>(page: Page, run: () => Promise<T>): Promise<T> {
  // The persistent context runs with viewport:null (it follows the window), so page.viewportSize()
  // is null and cannot be used either to preserve the width or to restore afterwards.
  const original = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  await growCanvasToFitActivities(page);
  // Size against the whole document, not the canvas: the canvas sits below the header and toolbar,
  // so its own height understates how far down the lowest activity actually is.
  const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const height = Math.min(4000, Math.max(original.height, documentHeight + 200));
  await page.setViewportSize({ width: original.width, height });
  // Everything LAMS draws on the canvas competes with the activities for the hit-test: the
  // rubber-band preview line, and every transition already drawn - which run down x=380, exactly
  // the column the gates sit in, so each new transition hides the next gate. They are decoration
  // during this phase, so take them out of hit-testing until it is done.
  const overlayStyle = await page.addStyleTag({
    content: '.svg-transition, .svg-transition-element, .svg-transition-draw { pointer-events: none !important; }'
  });
  const applied = await page.evaluate(() => ({ inner: window.innerHeight, scroll: document.documentElement.scrollHeight }));
  console.log(
    `Transition viewport: ${original.width}x${height} (document ${documentHeight} -> ${applied.scroll}, innerHeight ${applied.inner})`
  );
  try {
    if (applied.scroll > applied.inner) {
      throw new Error(
        `Canvas needs ${applied.scroll}px but the viewport only reaches ${applied.inner}px. LAMS hit-tests ` +
          'transition clicks with page coordinates, so the design cannot be scrolled to connect it.'
      );
    }
    return await run();
  } finally {
    await page.setViewportSize(original);
    await overlayStyle.evaluate((element: Element) => element.remove()).catch(() => undefined);
  }
}

/**
 * Both the canvas div and the <svg> inside it have fixed heights, and each has to cover every
 * activity. The div governs how far the document scrolls; the SVG clips its own contents, so an
 * activity below its height is neither drawn nor hit-testable - LAMS's elementFromPoint lands on
 * bare canvas and the click does nothing. createTemplateNode grows the div for the node it adds,
 * but nothing grows the SVG, so gates dropped past it become unreachable.
 */
async function growCanvasToFitActivities(page: Page): Promise<void> {
  await page.locator('#canvas').evaluate((element) => {
    let lowest = 0;
    for (const activity of document.querySelectorAll('#canvas > svg > g.svg-activity')) {
      const y = Number(activity.getAttribute('data-y') ?? 0);
      const height = Number(activity.getAttribute('data-height') ?? 0);
      if (y + height > lowest) lowest = y + height;
    }
    const needed = lowest + 160;
    if (needed > (Number.parseFloat(getComputedStyle(element).height) || 0)) {
      (element as HTMLElement).style.height = `${needed}px`;
    }
    const svg = element.querySelector('svg');
    if (svg && needed > Number(svg.getAttribute('height') ?? 0)) {
      svg.setAttribute('height', String(needed));
    }
  });
}



/**
 * Clicks an activity where LAMS thinks it is, not at the centre of its bounding box. An activity's
 * <g> also encloses its label, so for a 40x40 gate the box centre lands in blank canvas beside the
 * glyph and LAMS's elementFromPoint finds nothing. Tool activities are 200x80 rectangles with the
 * label inside, which is why only gates were affected. data-x/data-y are the model coordinates the
 * transition paths are drawn from, so they are the reliable target.
 */
async function clickActivityGlyph(page: Page, uiid: number): Promise<void> {
  const point = await page.evaluate((id) => {
    const svg = document.querySelector('#canvas > svg');
    const activity = document.querySelector(`#canvas > svg > g.svg-activity[uiid="${id}"]`);
    if (!svg || !activity) return null;
    const origin = svg.getBoundingClientRect();
    const x = Number(activity.getAttribute('data-x') ?? 0);
    const y = Number(activity.getAttribute('data-y') ?? 0);
    const width = Number(activity.getAttribute('data-width') ?? 0);
    const height = Number(activity.getAttribute('data-height') ?? 0);
    return { x: origin.left + x + width / 2, y: origin.top + y + height / 2 };
  }, uiid);
  if (!point) throw new Error(`Activity ${uiid} is not on the authoring canvas.`);
  await page.mouse.click(point.x, point.y);
}

/** Chromium treats two clicks within ~500ms at the same spot as a double-click. */
const DOUBLE_CLICK_WINDOW_MS = 600;

async function createTransition(page: Page, from: GraphNode, to: GraphNode, timeoutMs: number): Promise<void> {
  if (await page.locator('#propertiesDialog').isVisible()) {
    await page.locator('#canvas').click({ position: { x: 5, y: 5 } });
  }
  await growCanvasToFitActivities(page);
  // Consecutive transitions share an endpoint - the target of one is the source of the next - so
  // the same activity is clicked twice in a row, at the same position. Inside the browser's
  // double-click window that opens the activity's editor, whose iframe then covers the canvas and
  // wins every later hit-test. Wait the window out before starting the next pair.
  await page.waitForTimeout(DOUBLE_CLICK_WINDOW_MS);
  await page.locator('#transitionButton').click();
  // Transition mode responds only to real mouse events, and only at scroll offset 0 - see
  // withViewportShowingWholeCanvas. Keep the page pinned at the top and never scroll between the
  // two clicks; the caller has already sized the viewport so both endpoints are on screen.
  await page.evaluate(() => window.scrollTo(0, 0));
  await clickActivityGlyph(page, from.uiid);
  await clickActivityGlyph(page, to.uiid);
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
