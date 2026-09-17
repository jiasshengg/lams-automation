import type { Page } from '@playwright/test';
import { inspectAuthoringGraph, type AuthoringGraph, type GraphNode } from './authoring.js';
import { connectAuthoringNodes, removeAuthoringNode, removeAuthoringTransition } from './ae-graph.js';

export interface PlaceholderRemoval {
  title: string;
  predecessor: string;
  /** null means an exact terminal placeholder, before the new AE chain is added. */
  successor: string | null;
}
export interface PlaceholderRepairPlan { lessonTitle: string; removals: PlaceholderRemoval[] }

export function parsePlaceholderRepair(value: unknown): PlaceholderRepairPlan {
  if (!value || typeof value !== 'object') throw new Error('Repair input must be an object.');
  const input = value as Record<string, unknown>;
  if (typeof input.lessonTitle !== 'string' || !input.lessonTitle.trim() || !Array.isArray(input.removals) || !input.removals.length) throw new Error('Repair needs lessonTitle and exact removals.');
  const removals = input.removals.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid removal.');
    const r = item as Record<string, unknown>;
    if (typeof r.title !== 'string' || !/^AE\b/.test(r.title) || typeof r.predecessor !== 'string' || !r.predecessor.trim() || !(r.successor === null || typeof r.successor === 'string' && r.successor.trim())) throw new Error('Each removal needs an exact AE title, predecessor and successor (or null).');
    const result = r as unknown as PlaceholderRemoval;
    if (new Set([result.title, result.predecessor, ...(result.successor ? [result.successor] : [])]).size !== (result.successor ? 3 : 2)) throw new Error('Repair endpoints must be distinct.');
    return result;
  });
  const titles = removals.map(r => r.title);
  if (new Set(titles).size !== titles.length || removals.some(r => titles.includes(r.predecessor) || r.successor !== null && titles.includes(r.successor))) throw new Error('Overlapping placeholder removals are unsupported.');
  return { lessonTitle: input.lessonTitle, removals };
}

function one(graph: AuthoringGraph, name: string): GraphNode {
  const matches = graph.nodes.filter(n => n.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one node "${name}"; found ${matches.length}.`);
  return matches[0]!;
}

/** Validates all targets before mutation and produces the exact expected resulting topology. */
export function projectPlaceholderRepairs(graph: AuthoringGraph, plan: PlaceholderRepairPlan): AuthoringGraph {
  if (!graph.modelAvailable || graph.transitions.some(t => t.fromUiid === null || t.toUiid === null)) throw new Error('Repair requires verified graph endpoints.');
  let projected = { ...graph, nodes: [...graph.nodes], transitions: [...graph.transitions] };
  for (const r of plan.removals) {
    const before = one(projected, r.predecessor);
    const after = r.successor === null ? undefined : one(projected, r.successor);
    const matches = projected.nodes.filter(n => n.name === r.title);
    if (!matches.length) {
      const edges = projected.transitions.filter(t => t.fromUiid === before.uiid);
      if (after ? edges.length !== 1 || edges[0]!.toUiid !== after.uiid : edges.length !== 0) throw new Error(`Absent placeholder "${r.title}" has an unexpected remaining connection; inspect partial state.`);
      continue;
    }
    const target = one(projected, r.title);
    if (target.type !== 'tool') throw new Error(`"${r.title}" is not a tool placeholder.`);
    const incoming = projected.transitions.filter(t => t.toUiid === target.uiid);
    const outgoing = projected.transitions.filter(t => t.fromUiid === target.uiid);
    if (incoming.length !== 1 || incoming[0]!.fromUiid !== before.uiid || outgoing.length !== (after ? 1 : 0) || after && outgoing[0]!.toUiid !== after.uiid) throw new Error(`"${r.title}" does not have the exact approved predecessor/successor.`);
    if (projected.transitions.filter(t => t.fromUiid === before.uiid).length !== 1 || after && projected.transitions.filter(t => t.toUiid === after.uiid).length !== 1) throw new Error(`Repair endpoints for "${r.title}" have extra connections.`);
    projected = { ...projected, nodes: projected.nodes.filter(n => n.uiid !== target.uiid), transitions: projected.transitions.filter(t => t.fromUiid !== target.uiid && t.toUiid !== target.uiid) };
    if (after) projected.transitions.push({ uiid: -1, fromUiid: before.uiid, toUiid: after.uiid });
  }
  return projected;
}

export function verifyRepairResult(actual: AuthoringGraph, expected: AuthoringGraph): void {
  const signature = (g: AuthoringGraph) => JSON.stringify({
    nodes: g.nodes.map(n => `${n.uiid}:${n.type}:${n.name}`).sort(),
    edges: g.transitions.map(t => `${t.fromUiid}->${t.toUiid}`).sort()
  });
  if (!actual.modelAvailable || signature(actual) !== signature(expected)) throw new Error('Placeholder repair changed unexpected nodes/connections or did not persist.');
}

export async function repairAEPlaceholders(page: Page, plan: PlaceholderRepairPlan, timeoutMs: number): Promise<AuthoringGraph> {
  const graph = await inspectAuthoringGraph(page);
  const expected = projectPlaceholderRepairs(graph, plan);
  const present = plan.removals.filter(r => graph.nodes.some(n => n.name === r.title));
  if (present.length && !await page.evaluate(() => {
    const api = (window as unknown as { ActivityLib?: { removeActivity?: unknown; removeTransition?: unknown } }).ActivityLib;
    return typeof api?.removeActivity === 'function' && typeof api?.removeTransition === 'function';
  })) throw new Error('Verified LAMS removal functions are unavailable; no changes made.');
  for (const r of present) {
    await removeAuthoringTransition(page, r.predecessor, r.title, timeoutMs);
    if (r.successor) await removeAuthoringTransition(page, r.title, r.successor, timeoutMs);
    await removeAuthoringNode(page, one(graph, r.title), timeoutMs);
    if (r.successor) await connectAuthoringNodes(page, one(graph, r.predecessor), one(graph, r.successor), timeoutMs);
  }
  verifyRepairResult(await inspectAuthoringGraph(page), expected);
  return expected;
}
