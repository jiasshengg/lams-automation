import type { AEPlan } from '../ae/plan.js';
import type { AuthoringGraph, GraphNode } from './authoring.js';

/**
 * An existing AE activity or gate the user has authorised renaming to its reviewed title, so a
 * copy's earlier AE chain is rewritten in place instead of a second chain being built beside it.
 */
export interface AERename {
  type: 'tool' | 'gate';
  from: string;
  to: string;
}

export interface AERenamePlan {
  lessonTitle: string;
  renames: AERename[];
}

export function parseAERenamePlan(value: unknown): AERenamePlan {
  if (!value || typeof value !== 'object') throw new Error('Rename input must be an object.');
  const input = value as Record<string, unknown>;
  if (typeof input.lessonTitle !== 'string' || !input.lessonTitle.trim() || !Array.isArray(input.renames) || input.renames.length === 0) {
    throw new Error('Rename input needs lessonTitle and exact renames.');
  }
  const renames = input.renames.map((item: unknown, index): AERename => {
    if (!item || typeof item !== 'object') throw new Error(`renames[${index}] must be an object.`);
    const entry = item as Record<string, unknown>;
    if (entry.type !== 'tool' && entry.type !== 'gate') throw new Error(`renames[${index}].type must be "tool" or "gate".`);
    // Earlier lessons also title AE gates "AEGate …" with no space, and some title their AE
    // activities by case alone ("Case 1 Q2 to Q4"); both are still earlier AE titles.
    const earlierAETitle = entry.type === 'tool' ? /^(?:AE|Case)\b/ : /^AE(?:Gate)?\b/;
    if (typeof entry.from !== 'string' || !earlierAETitle.test(entry.from.trim())) throw new Error(`renames[${index}].from must be an exact AE title.`);
    if (typeof entry.to !== 'string' || !/^AE\b/.test(entry.to.trim())) throw new Error(`renames[${index}].to must be an exact AE title.`);
    if (entry.from.trim() === entry.to.trim()) throw new Error(`renames[${index}] renames "${entry.from}" to itself.`);
    return { type: entry.type, from: entry.from.trim(), to: entry.to.trim() };
  });
  for (const type of ['tool', 'gate'] as const) {
    const ofType = renames.filter((rename) => rename.type === type);
    if (new Set(ofType.map((rename) => rename.from)).size !== ofType.length) throw new Error(`Each ${type} may be renamed only once.`);
    if (new Set(ofType.map((rename) => rename.to)).size !== ofType.length) throw new Error(`Two ${type}s cannot take the same title.`);
  }
  return { lessonTitle: input.lessonTitle, renames };
}

/** Every rename must land on a title the reviewed plan names, so nothing is renamed on a guess. */
export function assertRenamesFollowPlan(renames: AERenamePlan, plan: AEPlan): void {
  const nodeTitles = new Set(plan.nodes.map((node) => node.title));
  // The template's gate in front of the AE chain is renamed by the reconciler itself; naming it here
  // only lets the expectations follow it.
  const gateTitles = new Set([...plan.gates.map((gate) => gate.title), plan.leadingGateTitle]);
  for (const rename of renames.renames) {
    const allowed = rename.type === 'tool' ? nodeTitles : gateTitles;
    if (!allowed.has(rename.to)) {
      throw new Error(`Rename target "${rename.to}" is not a reviewed AE ${rename.type === 'tool' ? 'node' : 'gate'} title.`);
    }
  }
}

/** The one existing node a rename applies to, or null when its reviewed title is already present. */
export function renameSource(graph: AuthoringGraph, renames: AERenamePlan | undefined, type: AERename['type'], to: string): GraphNode | null {
  const rename = renames?.renames.find((candidate) => candidate.type === type && candidate.to === to);
  if (!rename) return null;
  const matches = graph.nodes.filter((node) => node.type === type && node.name === rename.from);
  if (matches.length !== 1) throw new Error(`Rename source ${type} "${rename.from}" must identify exactly one ${type}; found ${matches.length}.`);
  return matches[0]!;
}

/** The graph as it reads once the authorised renames are applied, for deriving expectations. */
export function projectAERenames(graph: AuthoringGraph, renames: AERenamePlan): AuthoringGraph {
  const nodes = graph.nodes.map((node) => {
    const rename = renames.renames.find((candidate) => candidate.type === node.type && candidate.from === node.name);
    return rename ? { ...node, name: rename.to } : node;
  });
  for (const rename of renames.renames) {
    const sources = graph.nodes.filter((node) => node.type === rename.type && node.name === rename.from);
    if (sources.length !== 1) throw new Error(`Rename source ${rename.type} "${rename.from}" must identify exactly one ${rename.type}; found ${sources.length}.`);
    if (graph.nodes.some((node) => node.type === rename.type && node.name === rename.to)) {
      throw new Error(`Rename target "${rename.to}" already exists as a ${rename.type}.`);
    }
  }
  return { ...graph, nodes };
}
