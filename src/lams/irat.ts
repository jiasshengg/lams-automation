import type { Page } from '@playwright/test';
import type { IratQuestionRequest, IratRequest, LamsConfig } from '../config.js';
import { applySotFormattingFromDocx } from '../docx/sot-formatting.js';
import { inspectAuthoringGraph, type AuthoringGraph, type GraphNode } from './authoring.js';

export interface IratPlanStep {
  phase: 'gate' | 'activity' | 'question' | 'advanced' | 'trat' | 'verification';
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
  marks?: number;
  baseUid?: string;
  currentUid?: string;
  currentLabel?: string;
}

export interface IratSavedQuestionReference {
  title: string;
  baseUid: string;
  currentUid: string;
  currentLabel: string;
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
  tratActivityName: string;
  teamSetupAssociated: boolean;
  questions: IratObservedQuestion[];
}

export interface IratEditor {
  inspect(): Promise<IratObservedState>;
  updateGate(gate: IratRequest['gate']): Promise<void>;
  associateWithTeamSetup(teamSetupName: string): Promise<void>;
  deleteQuestion(title: string): Promise<void>;
  updateQuestion(question: IratQuestionRequest): Promise<IratSavedQuestionReference | void>;
  createQuestion(question: IratQuestionRequest): Promise<IratSavedQuestionReference | void>;
  applyAnswerRequired(questions: IratQuestionRequest[]): Promise<string[]>;
  updateAdvancedSettings(settings: IratRequest['advanced']): Promise<void>;
  verifyPrintView(request: IratRequest): Promise<void>;
  save(): Promise<void>;
}

export interface IratAutomationResult {
  committed: boolean;
  readiness: IratReadinessReport;
  deletedQuestions: string[];
  updatedQuestions: string[];
  createdQuestions: string[];
  resumedQuestions: string[];
}

export interface IratResumeQuestion {
  currentUid: string;
  currentLabel: string;
  requestHash: string;
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
  uniqueNode(graph, matchingTratRequest(request).activityName, 'tool', checks);

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
  for (const title of request.deleteQuestionTitles ?? []) {
    steps.push({
      phase: 'question',
      questionTitle: title,
      action: `Delete the exact existing iRAT question reference "${title}" after confirming the LAMS deletion dialog`
    });
  }
  request.questions.forEach((question) => {
    steps.push({
      phase: 'question',
      questionTitle: question.title,
      action: `Update existing ${question.type} question as a new version, or create it when missing; mandatory=${question.mandatory}; marks=${question.marks}; default font and size; SoT inline formatting only; correct weights total 100`
    });
  });
  steps.push(
    {
      phase: 'advanced',
      action: `Set shuffle questions=${request.advanced.shuffleQuestions}, shuffle answers=${request.advanced.shuffleAnswers}, questions' numbering=${request.advanced.questionsNumbering}, display all questions=${request.advanced.displayAllQuestions}, display all questions and answers once finished=${request.advanced.displayAllAfterCompletion}, answer justification=${request.advanced.answerJustification}, confidence levels=${request.advanced.confidenceLevels}`
    },
    {
      phase: 'trat',
      action: `Confirm every RAT-sync prompt, restore ${matchingTratRequest(request).activityName} advanced defaults, enable Show confidence levels from ${matchingTratRequest(request).confidenceSourceActivityName}, save, reopen, and verify`
    },
    { phase: 'verification', action: 'Open Print View and compare every question and correct answer with the supplied request' },
    { phase: 'verification', action: 'Save iRAT and re-inspect the resulting state' }
  );
  return steps;
}

export async function executeIratAutomation(
  editor: IratEditor,
  request: IratRequest,
  options: {
    commit: boolean;
    resumeQuestions?: Record<string, IratResumeQuestion>;
    questionHash?: (question: IratQuestionRequest) => string;
    onQuestionSaved?: (question: IratQuestionRequest, reference: IratSavedQuestionReference) => Promise<void>;
  }
): Promise<IratAutomationResult> {
  const observed = await editor.inspect();
  const readiness = validateObservedState(observed, request);
  if (!readiness.passed) {
    throw new Error(`iRAT preflight failed: ${readiness.checks.filter((check) => !check.passed).map((check) => check.detail).join('; ')}`);
  }
  if (!options.commit) return { committed: false, readiness, deletedQuestions: [], updatedQuestions: [], createdQuestions: [], resumedQuestions: [] };

  const resumable = new Set<string>();
  for (const question of request.questions) {
    const title = normalizeQuestionTitle(question.title);
    const checkpoint = options.resumeQuestions?.[title];
    if (!checkpoint) continue;
    const live = observed.questions.find(candidate => normalizeQuestionTitle(candidate.title) === title);
    const expectedRequestHash = options.questionHash?.(question);
    if (
      !live?.currentUid ||
      live.currentUid !== checkpoint.currentUid ||
      (expectedRequestHash !== undefined && expectedRequestHash !== checkpoint.requestHash)
    ) {
      throw new Error(
        `iRAT checkpoint conflict for "${question.title}": the live selected version or resolved request changed; refusing to guess or create another version.`
      );
    }
    resumable.add(title);
  }

  await editor.updateGate(request.gate);
  await editor.associateWithTeamSetup(request.teamSetupName);
  const deletionTitles = new Set((request.deleteQuestionTitles ?? []).map(normalizeQuestionTitle));
  const deletedQuestions: string[] = [];
  for (const title of request.deleteQuestionTitles ?? []) {
    const matches = observed.questions.filter((question) => normalizeQuestionTitle(question.title) === normalizeQuestionTitle(title));
    if (matches.length === 1) {
      await editor.deleteQuestion(title);
      deletedQuestions.push(title);
    }
  }
  const updatedQuestions: string[] = [];
  const createdQuestions: string[] = [];
  const resumedQuestions: string[] = [];
  const existingTitles = new Set(
    observed.questions
      .map((question) => normalizeQuestionTitle(question.title))
      .filter((title) => !deletionTitles.has(title))
  );
  for (const question of request.questions) {
    if (resumable.has(normalizeQuestionTitle(question.title))) {
      resumedQuestions.push(question.title);
      continue;
    }
    let reference: IratSavedQuestionReference | void;
    if (existingTitles.has(normalizeQuestionTitle(question.title))) {
      reference = await editor.updateQuestion(question);
      updatedQuestions.push(question.title);
    } else {
      reference = await editor.createQuestion(question);
      createdQuestions.push(question.title);
    }
    if (options.onQuestionSaved) {
      if (!reference) throw new Error(`Saved question "${question.title}" did not expose a version UID for recovery checkpointing.`);
      await options.onQuestionSaved(question, reference);
    }
  }
  await editor.applyAnswerRequired(request.questions);
  await editor.updateAdvancedSettings(request.advanced);
  await editor.verifyPrintView(request);
  await editor.save();
  return { committed: true, readiness, deletedQuestions, updatedQuestions, createdQuestions, resumedQuestions };
}

export function requireIratRequest(config: LamsConfig): IratRequest {
  if (!config.irat) {
    throw new Error('The per-run request must include an exact "irat" object before iRAT automation can run.');
  }
  return config.irat;
}

/**
 * Resolves the iRAT request and, when a SoT DOCX is supplied, replaces the request's inline
 * formatting with the document's own before any browser work. Unmatched text is reported
 * rather than failed: the reviewed words stay authoritative, the SoT only styles them.
 */
export async function resolveIratRequest(config: LamsConfig): Promise<IratRequest> {
  const request = requireIratRequest(config);
  const formatting = await applySotFormattingFromDocx(request);
  if (formatting.applied.length > 0) {
    console.log(`SoT inline formatting applied from ${request.sourceDocx} to ${formatting.applied.length} question fields.`);
  }
  for (const warning of formatting.warnings) console.warn(`SoT formatting warning: ${warning}`);
  return request;
}

function validateObservedState(observed: IratObservedState, request: IratRequest): IratReadinessReport {
  const checks: IratReadinessCheck[] = [
    exactCheck('iRAT Gate', request.gate.name, observed.gate.name),
    exactCheck('iRAT activity', request.activityName, observed.activityName),
    exactCheck('matching tRAT activity', matchingTratRequest(request).activityName, observed.tratActivityName),
    {
      label: 'Team Setup association',
      passed: observed.teamSetupAssociated,
      detail: observed.teamSetupAssociated ? 'iRAT is associated with Team Setup' : 'iRAT is not associated with Team Setup'
    }
  ];
  const requestedTitles = request.questions.map((question) => normalizeQuestionTitle(question.title));
  const deletionTitles = (request.deleteQuestionTitles ?? []).map(normalizeQuestionTitle);
  checks.push({
    label: 'Unique requested question titles',
    passed: new Set(requestedTitles).size === requestedTitles.length,
    detail: 'Requested question titles must be unique after whitespace normalization'
  });
  checks.push({
    label: 'Unique deletion question titles',
    passed: new Set(deletionTitles).size === deletionTitles.length,
    detail: 'Explicit deletion titles must be unique after whitespace normalization'
  });
  const unexpectedTitles = observed.questions
    .map((question) => normalizeQuestionTitle(question.title))
    .filter((title) => !requestedTitles.includes(title) && !deletionTitles.includes(title));
  checks.push({
    label: 'Unexpected existing questions',
    passed: unexpectedTitles.length === 0,
    detail: unexpectedTitles.length === 0
      ? 'No unapproved extra question rows were found'
      : `Stopped before writes. Report these exact extra question titles to the user and request an explicit instruction for each one: ${unexpectedTitles.map((title) => `"${title}"`).join(', ')}. Ask whether each question should be kept completely untouched; updated while keeping its current title; updated and renamed with an exact new title; deleted; or handled according to another exact instruction. Do not continue or infer an action until the user answers.`
  });
  for (const title of deletionTitles) {
    const matches = observed.questions.filter((question) => normalizeQuestionTitle(question.title) === title);
    const overlapsRequest = requestedTitles.includes(title);
    checks.push({
      label: `Delete question — ${title}`,
      passed: matches.length <= 1 && !overlapsRequest,
      detail: overlapsRequest
        ? `Question "${title}" cannot be both requested and deleted`
        : matches.length > 1
          ? `Question "${title}" has ${matches.length} matches; deletion target is ambiguous`
          : matches.length === 1
            ? `Found exactly one explicitly authorized question reference to delete`
            : `Question "${title}" is already absent`
    });
  }
  for (const question of observed.questions) {
    const normalizedTitle = normalizeQuestionTitle(question.title);
    const requested = requestedTitles.includes(normalizedTitle);
    const authorizedDeletion = deletionTitles.includes(normalizedTitle);
    checks.push({
      label: `Existing question — ${question.title}`,
      passed: requested || authorizedDeletion,
      detail: requested
        ? `Existing question "${question.title}" is included in the complete request`
        : authorizedDeletion
          ? `Existing question "${question.title}" is explicitly authorized for deletion`
          : `Existing question "${question.title}" must be included in the complete request or explicitly authorized for deletion`
    });
  }
  for (const question of request.questions) {
    const matches = observed.questions.filter((candidate) => normalizeQuestionTitle(candidate.title) === normalizeQuestionTitle(question.title));
    const supported = question.type === 'multiple-choice' && matches.every((candidate) => candidate.type === question.type);
    checks.push({
      label: `Question — ${question.title}`,
      passed: matches.length <= 1 && supported,
      detail: !supported ? 'Only matching multiple-choice types are supported'
        : matches.length > 1 ? 'Duplicate existing question title; target is ambiguous'
        : matches.length === 1 ? 'Found exactly by title; update as new version' : 'Missing question; create Multiple choice'
    });
  }
  checks.push({
    label: 'Question distribution',
    passed: request.advanced.displayAllQuestions,
    detail: 'The live adapter requires displayAllQuestions=true'
  });
  return { passed: checks.every((check) => check.passed), checks, plan: createIratPlan(request) };
}

export function matchingTratRequest(request: IratRequest): NonNullable<IratRequest['trat']> {
  return request.trat ?? {
    activityName: 'tRAT',
    confidenceSourceActivityName: request.activityName
  };
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

export function normalizeQuestionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}
