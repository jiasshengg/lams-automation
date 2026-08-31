import type { Page } from '@playwright/test';
import type { IratQuestionRequest, IratRequest, LamsConfig } from '../config.js';
import { inspectAuthoringGraph, type AuthoringGraph, type GraphNode } from './authoring.js';

export interface IratPlanStep {
  phase: 'gate' | 'activity' | 'question' | 'advanced' | 'verification';
  action: string;
  questionTitle?: string;
}

export interface IratReadinessCheck {
  label: string;
  passed: boolean;
  detail: string;
}

export interface IratReadinessReport {
  passed: boolean;
  checks: IratReadinessCheck[];
  plan: IratPlanStep[];
}

export interface IratObservedQuestion {
  title: string;
  type: string;
  mandatory: boolean;
}

export interface IratObservedState {
  gate: {
    name: string;
    description: string | null;
    type: string | null;
    dynamicPassword: boolean | null;
    rotationSeconds: number | null;
  };
  activityName: string;
  teamSetupAssociated: boolean;
  questions: IratObservedQuestion[];
}

export interface IratEditor {
  inspect(): Promise<IratObservedState>;
  updateGate(gate: IratRequest['gate']): Promise<void>;
  associateWithTeamSetup(teamSetupName: string): Promise<void>;
  updateQuestion(question: IratQuestionRequest): Promise<void>;
  updateAdvancedSettings(settings: IratRequest['advanced']): Promise<void>;
  verifyPrintView(request: IratRequest): Promise<void>;
  save(): Promise<void>;
}

export interface IratAutomationResult {
  committed: boolean;
  readiness: IratReadinessReport;
  updatedQuestions: string[];
}

export async function prepareIratAutomation(page: Page, config: LamsConfig): Promise<IratReadinessReport> {
  const request = requireIratRequest(config);
  const graph = await inspectAuthoringGraph(page);
  return validateIratReadiness(graph, request);
}

export function validateIratReadiness(graph: AuthoringGraph, request: IratRequest): IratReadinessReport {
  const checks: IratReadinessCheck[] = [];
  const teamSetup = uniqueNode(graph, request.teamSetupName, 'grouping', checks);
  const gate = uniqueNode(graph, request.gate.name, 'gate', checks);
  const activity = uniqueNode(graph, request.activityName, 'tool', checks);

  const gateConnected = Boolean(
    gate &&
      activity &&
      graph.transitions.some((transition) => transition.fromUiid === gate.uiid && transition.toUiid === activity.uiid)
  );
  checks.push({
    label: 'iRAT Gate connection',
    passed: graph.modelAvailable && gateConnected,
    detail: !graph.modelAvailable
      ? 'Runtime model unavailable; transition endpoints cannot be verified'
      : gateConnected
        ? `${request.gate.name} connects directly to ${request.activityName}`
        : `${request.gate.name} does not connect directly to ${request.activityName}`
  });

  const associated = Boolean(activity && teamSetup && activity.grouped && activity.groupingUiid === teamSetup.uiid);
  checks.push({
    label: 'Team Setup association',
    passed: associated,
    detail: associated
      ? `${request.activityName} is grouped with ${request.teamSetupName}`
      : `${request.activityName} is not grouped with ${request.teamSetupName}`
  });

  return {
    passed: checks.every((check) => check.passed),
    checks,
    plan: createIratPlan(request)
  };
}

export function createIratPlan(request: IratRequest): IratPlanStep[] {
  const steps: IratPlanStep[] = [
    {
      phase: 'gate',
      action: `Set ${request.gate.name} to ${request.gate.type}, description "${request.gate.description}", dynamic password ${request.gate.dynamicPassword ? 'on' : 'off'}, rotation ${request.gate.rotationSeconds}s`
    },
    {
      phase: 'activity',
      action: `Associate ${request.activityName} with ${request.teamSetupName}`
    }
  ];
  request.questions.forEach((question) => {
    steps.push({
      phase: 'question',
      questionTitle: question.title,
      action: `Update ${question.type} question; mandatory=${question.mandatory}; font=${question.fontFamily} ${question.fontSize}; correct weights total 100; save as a new version`
    });
  });
  steps.push(
    {
      phase: 'advanced',
      action: `Set shuffle answers=${request.advanced.shuffleAnswers}, display all questions=${request.advanced.displayAllQuestions}, answer justification=${request.advanced.answerJustification}, confidence levels=${request.advanced.confidenceLevels}`
    },
    { phase: 'verification', action: 'Open Print View and compare every question and correct answer with the supplied request' },
    { phase: 'verification', action: 'Save iRAT and re-inspect the resulting state' }
  );
  return steps;
}

export async function executeIratAutomation(
  editor: IratEditor,
  request: IratRequest,
  options: { commit: boolean }
): Promise<IratAutomationResult> {
  const observed = await editor.inspect();
  const readiness = validateObservedState(observed, request);
  if (!readiness.passed) {
    throw new Error(`iRAT preflight failed: ${readiness.checks.filter((check) => !check.passed).map((check) => check.detail).join('; ')}`);
  }
  if (!options.commit) return { committed: false, readiness, updatedQuestions: [] };

  await editor.updateGate(request.gate);
  await editor.associateWithTeamSetup(request.teamSetupName);
  const updatedQuestions: string[] = [];
  for (const question of request.questions) {
    await editor.updateQuestion(question);
    updatedQuestions.push(question.title);
  }
  await editor.updateAdvancedSettings(request.advanced);
  await editor.verifyPrintView(request);
  await editor.save();
  return { committed: true, readiness, updatedQuestions };
}

export function requireIratRequest(config: LamsConfig): IratRequest {
  if (!config.irat) {
    throw new Error('The per-run request must include an exact "irat" object before iRAT automation can run.');
  }
  return config.irat;
}

function validateObservedState(observed: IratObservedState, request: IratRequest): IratReadinessReport {
  const checks: IratReadinessCheck[] = [
    exactCheck('iRAT Gate', request.gate.name, observed.gate.name),
    exactCheck('iRAT activity', request.activityName, observed.activityName),
    {
      label: 'Team Setup association',
      passed: observed.teamSetupAssociated,
      detail: observed.teamSetupAssociated ? 'iRAT is associated with Team Setup' : 'iRAT is not associated with Team Setup'
    },
    {
      label: 'Question count',
      passed: observed.questions.length === request.questions.length,
      detail: `Expected ${request.questions.length}; found ${observed.questions.length}`
    }
  ];
  const observedTitles = new Set(observed.questions.map((question) => question.title));
  for (const question of request.questions) {
    checks.push({
      label: `Question — ${question.title}`,
      passed: observedTitles.has(question.title),
      detail: observedTitles.has(question.title) ? 'Found exactly by title' : 'Question title not found'
    });
  }
  return { passed: checks.every((check) => check.passed), checks, plan: createIratPlan(request) };
}

function exactCheck(label: string, expected: string, found: string): IratReadinessCheck {
  return { label, passed: expected === found, detail: expected === found ? `Found "${found}"` : `Expected "${expected}"; found "${found}"` };
}

function uniqueNode(
  graph: AuthoringGraph,
  name: string,
  type: GraphNode['type'],
  checks: IratReadinessCheck[]
): GraphNode | undefined {
  const matches = graph.nodes.filter((node) => node.name === name && node.type === type);
  checks.push({
    label: name,
    passed: matches.length === 1,
    detail: matches.length === 1 ? `Found exactly one ${type}` : `Expected one ${type}; found ${matches.length}`
  });
  return matches.length === 1 ? matches[0] : undefined;
}
