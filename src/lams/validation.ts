import type { LamsConfig } from '../config.js';
import type { AEPlan } from '../ae/plan.js';
import type { AuthoringGraph, GraphNode } from './authoring.js';

export interface ValidationCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface ValidationReport {
  passed: boolean;
  checks: ValidationCheck[];
}

export function validateAuthoringGraph(graph: AuthoringGraph, config: LamsConfig): ValidationReport {
  const checks: ValidationCheck[] = [];
  const nodesByName = new Map<string, GraphNode[]>();
  graph.nodes.forEach((node) => {
    const matches = nodesByName.get(node.name) ?? [];
    matches.push(node);
    nodesByName.set(node.name, matches);
  });

  config.expectedFlow.forEach((name) => {
    const found = nodesByName.get(name)?.length ?? 0;
    checks.push({
      label: name,
      passed: found === 1,
      detail: found === 1 ? 'Found exactly once' : `Expected once; found ${found}`
    });
  });

  const aeNodes = graph.nodes.filter((node) => node.type === 'tool' && /^AE\b/i.test(node.name));
  const aeGates = graph.nodes.filter((node) => node.type === 'gate' && /^AE Gate\b/i.test(node.name));
  checks.push(countCheck('AE Nodes', config.expectedAENodes, aeNodes.length));
  checks.push(countCheck('AE Gates', config.expectedAEGates, aeGates.length));

  const expectedNodeSet = new Set(config.expectedFlow);
  const unexpectedNodes = graph.nodes.filter((node) => !expectedNodeSet.has(node.name));
  checks.push({
    label: 'Relevant node set',
    passed: graph.nodes.length === config.expectedFlow.length && unexpectedNodes.length === 0,
    detail:
      graph.nodes.length === config.expectedFlow.length && unexpectedNodes.length === 0
        ? `Found the expected ${graph.nodes.length} nodes`
        : `Expected ${config.expectedFlow.length}; found ${graph.nodes.length}. Unexpected: ${unexpectedNodes.map((node) => node.name || `UIID ${node.uiid}`).join(', ') || 'none'}`
  });

  const expectedNodes = config.expectedFlow.map((name) => nodesByName.get(name)?.[0]);
  const transitionKeys = new Set(
    graph.transitions
      .filter((transition) => transition.fromUiid !== null && transition.toUiid !== null)
      .map((transition) => `${transition.fromUiid}->${transition.toUiid}`)
  );
  const missingConnections: string[] = [];
  for (let index = 0; index < expectedNodes.length - 1; index += 1) {
    const from = expectedNodes[index];
    const to = expectedNodes[index + 1];
    if (!from || !to || !transitionKeys.has(`${from.uiid}->${to.uiid}`)) {
      missingConnections.push(`${config.expectedFlow[index]} -> ${config.expectedFlow[index + 1]}`);
    }
  }
  checks.push({
    label: 'Connectivity',
    passed: graph.modelAvailable && missingConnections.length === 0 && graph.transitions.length === graph.nodes.length - 1,
    detail:
      !graph.modelAvailable
        ? 'Runtime model unavailable; transition endpoints could not be verified'
        : missingConnections.length > 0
          ? `Missing: ${missingConnections.join(', ')}`
          : graph.transitions.length !== graph.nodes.length - 1
            ? `Expected ${graph.nodes.length - 1} transitions; found ${graph.transitions.length}`
            : 'All expected adjacent nodes are connected in one chain'
  });

  const teamSetup = nodesByName.get('Team Setup')?.[0];
  const associationFailures = graph.nodes.filter(
    (node) => node.type === 'tool' && (!teamSetup || !node.grouped || node.groupingUiid !== teamSetup.uiid)
  );
  checks.push({
    label: 'Team Setup associations',
    passed: Boolean(teamSetup) && associationFailures.length === 0,
    detail:
      teamSetup && associationFailures.length === 0
        ? 'All tool activities are grouped with Team Setup; gates are exempt per the reference lesson'
        : `Not associated: ${associationFailures.map((node) => node.name).join(', ') || 'Team Setup missing'}`
  });

  const gateNameFailures: string[] = [];
  for (let index = 0; index < expectedNodes.length - 1; index += 1) {
    const gate = expectedNodes[index];
    const following = expectedNodes[index + 1];
    if (!gate || gate.type !== 'gate' || !following) continue;
    if (!gateCorrespondsToFollowingNode(gate.name, following.name)) {
      gateNameFailures.push(`${gate.name} -> ${following.name}`);
    }
  }
  checks.push({
    label: 'Gate names',
    passed: gateNameFailures.length === 0,
    detail: gateNameFailures.length === 0 ? 'Every gate corresponds to the following activity category' : `Mismatch: ${gateNameFailures.join(', ')}`
  });

  for (const expected of config.expectedGateProperties ?? []) {
    const matches = nodesByName.get(expected.name) ?? [];
    const gate = matches.length === 1 && matches[0]?.type === 'gate' ? matches[0] : undefined;
    const mismatches: string[] = [];
    if (!gate) {
      mismatches.push(`expected one gate; found ${matches.filter((node) => node.type === 'gate').length}`);
    } else {
      if (expected.type !== undefined && gate.gateType !== expected.type) {
        mismatches.push(`type expected ${expected.type}; found ${gate.gateType ?? 'unavailable'}`);
      }
      if (expected.description !== undefined && gate.description !== expected.description) {
        mismatches.push(`description expected "${expected.description}"; found "${gate.description ?? 'unavailable'}"`);
      }
      if (expected.dynamicPassword !== undefined && gate.dynamicPassword !== expected.dynamicPassword) {
        mismatches.push(`dynamic password expected ${expected.dynamicPassword}; found ${gate.dynamicPassword ?? 'unavailable'}`);
      }
      if (expected.rotationSeconds !== undefined && gate.rotationSeconds !== expected.rotationSeconds) {
        mismatches.push(`rotation expected ${expected.rotationSeconds}s; found ${gate.rotationSeconds === null ? 'unavailable' : `${gate.rotationSeconds}s`}`);
      }
    }
    checks.push({
      label: `Gate properties — ${expected.name}`,
      passed: mismatches.length === 0,
      detail: mismatches.length === 0 ? 'Configured properties match' : mismatches.join('; ')
    });
  }

  return { passed: checks.every((check) => check.passed), checks };
}

export function validateAEPlanGraph(graph: AuthoringGraph, plan: AEPlan): ValidationReport {
  const checks: ValidationCheck[] = [];
  const nodesByName = new Map<string, GraphNode[]>();
  graph.nodes.forEach((node) => {
    const matches = nodesByName.get(node.name) ?? [];
    matches.push(node);
    nodesByName.set(node.name, matches);
  });

  for (const node of plan.nodes) {
    const matches = (nodesByName.get(node.title) ?? []).filter((candidate) => candidate.type === 'tool');
    checks.push({
      label: `AE node — ${node.title}`,
      passed: matches.length === 1,
      detail: matches.length === 1 ? 'Found exactly once as a tool activity' : `Expected once as a tool activity; found ${matches.length}`
    });
  }
  for (const gate of plan.gates) {
    const matches = (nodesByName.get(gate.title) ?? []).filter((candidate) => candidate.type === 'gate');
    checks.push({
      label: `AE gate — ${gate.title}`,
      passed: matches.length === 1,
      detail: matches.length === 1 ? 'Found exactly once as a gate' : `Expected once as a gate; found ${matches.length}`
    });
  }

  const aeNodes = graph.nodes.filter((node) => node.type === 'tool' && /^AE\b/i.test(node.name));
  const aeGates = graph.nodes.filter((node) => node.type === 'gate' && /^AE Gate\b/i.test(node.name));
  checks.push(countCheck('AE plan node count', plan.requiredAENodes, aeNodes.length));
  checks.push(countCheck('AE plan gate count', plan.requiredAEGates, aeGates.length));

  const expectedChain: string[] = [];
  plan.nodes.forEach((node, index) => {
    expectedChain.push(node.title);
    const gate = plan.gates[index];
    if (gate) expectedChain.push(gate.title);
  });
  const transitionKeys = new Set(
    graph.transitions
      .filter((transition) => transition.fromUiid !== null && transition.toUiid !== null)
      .map((transition) => `${transition.fromUiid}->${transition.toUiid}`)
  );
  const missingConnections: string[] = [];
  for (let index = 0; index < expectedChain.length - 1; index += 1) {
    const fromName = expectedChain[index]!;
    const toName = expectedChain[index + 1]!;
    const fromMatches = nodesByName.get(fromName) ?? [];
    const toMatches = nodesByName.get(toName) ?? [];
    if (
      fromMatches.length !== 1 ||
      toMatches.length !== 1 ||
      !transitionKeys.has(`${fromMatches[0]!.uiid}->${toMatches[0]!.uiid}`)
    ) {
      missingConnections.push(`${fromName} -> ${toName}`);
    }
  }
  checks.push({
    label: 'AE plan connectivity',
    passed: graph.modelAvailable && missingConnections.length === 0,
    detail: !graph.modelAvailable
      ? 'Runtime model unavailable; AE transition endpoints could not be verified'
      : missingConnections.length === 0
        ? 'Every planned AE node and gate is connected in the required order'
        : `Missing: ${missingConnections.join(', ')}`
  });

  return { passed: checks.every((check) => check.passed), checks };
}

export function formatValidationReport(report: ValidationReport): string {
  const lines = ['LAMS Authoring Validation', ''];
  report.checks.forEach((check) => {
    lines.push(`${check.passed ? '✓' : '✗'} ${check.label}: ${check.detail}`);
  });
  lines.push('', `Overall: ${report.passed ? 'PASS' : 'FAIL'}`);
  return lines.join('\n');
}

function countCheck(label: string, expected: number, found: number): ValidationCheck {
  return {
    label,
    passed: expected === found,
    detail: `Expected: ${expected}; Found: ${found}`
  };
}

function gateCorrespondsToFollowingNode(gateName: string, followingName: string): boolean {
  if (/^iRAT Gate$/i.test(gateName)) return /^iRAT\b/i.test(followingName);
  if (/^tRAT Gate$/i.test(gateName)) return /^tRAT\b/i.test(followingName);
  if (/^AE Gate\b/i.test(gateName)) return /^AE\b/i.test(followingName);
  return false;
}
