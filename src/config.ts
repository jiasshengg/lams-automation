import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const APPROVED_WORKSPACE_COURSE = 'DL Playground 2026/2027 [internal]';

export type RoleName =
  | 'button'
  | 'link'
  | 'menuitem'
  | 'tab'
  | 'treeitem'
  | 'option'
  | 'heading';

export type LocatorSpec =
  | { by: 'role'; role: RoleName; name: string; exact?: boolean }
  | { by: 'label'; label: string; exact?: boolean }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'testId'; testId: string }
  | { by: 'css'; css: string };

export interface AuthoringNodeSelector {
  locator: LocatorSpec;
  nameAttribute?: string;
  typeAttribute?: string;
}

export interface ExpectedGateProperties {
  name: string;
  type?: 'condition' | 'sync' | 'schedule' | 'permission' | 'password' | 'system';
  description?: string;
  dynamicPassword?: boolean;
  rotationSeconds?: number;
  stopAtPrecedingActivity?: boolean;
}

export interface LessonIndexSettings {
  courseGrouping?: string;
  endDate: string;
  endTime?: string;
  displayScoresOnCompletion?: boolean;
  enableScheduling?: boolean;
}

export interface IratAnswerRequest {
  text: string;
  correct: boolean;
  weight: number;
}

export interface IratQuestionRequest {
  title: string;
  /** Deployment guide: iRAT questions carry 1 mark each unless stated otherwise. */
  marks: number;
  type: string;
  content: string;
  mandatory: boolean;
  fontFamily: string;
  fontSize: number;
  answers: IratAnswerRequest[];
}

export interface IratRequest {
  gate: {
    name: string;
    description: string;
    type: 'password';
    dynamicPassword: boolean;
    rotationSeconds: number;
  };
  activityName: string;
  teamSetupName: string;
  questions: IratQuestionRequest[];
  advanced: {
    shuffleQuestions: boolean;
    shuffleAnswers: boolean;
    questionsNumbering: boolean;
    displayAllQuestions: boolean;
    answerJustification: boolean;
    confidenceLevels: boolean;
  };
}

export interface LamsConfig {
  baseUrl: string;
  workspaceCourse: string;
  previousCohort: string;
  currentCohort: string;
  module: string;
  tbl: string;
  lessonTitle: string;
  sourceLessonTitle: string;
  sourceFolderPath: string[];
  destinationFolder: string;
  destinationFolderPath: string[];
  createDestinationFolder?: boolean;
  openSourceAsCopy?: boolean;
  renameDestinationFolderFrom?: string;
  expectedAENodes: number;
  expectedAEGates: number;
  expectedFlow: string[];
  expectedGateProperties?: ExpectedGateProperties[];
  /** Deployment guide: every tool activity reports "Last total score" to the gradebook. */
  expectedGradebookOutput?: string;
  lessonIndex?: LessonIndexSettings;
  irat?: IratRequest;
  browser: {
    headless: boolean;
    userDataDir: string;
    manualLoginTimeoutMs: number;
    actionTimeoutMs: number;
    readyTimeoutMs: number;
  };
  selectors: {
    previousCohort?: LocatorSpec;
    tbl?: LocatorSpec;
    openLesson?: LocatorSpec;
    openAuthoring?: LocatorSpec;
    aeOpenActivity?: LocatorSpec;
    authoringRoot?: LocatorSpec;
    authoringNode?: AuthoringNodeSelector;
    openAddLesson?: LocatorSpec;
    openMonitoring?: LocatorSpec;
  };
}

const requiredStrings = [
  'baseUrl',
  'workspaceCourse',
  'previousCohort',
  'currentCohort',
  'module',
  'tbl',
  'lessonTitle',
  'sourceLessonTitle',
  'destinationFolder'
] as const;

const requestOverrideKeys = [
  'previousCohort',
  'currentCohort',
  'module',
  'tbl',
  'lessonTitle',
  'sourceLessonTitle',
  'sourceFolderPath',
  'destinationFolder',
  'destinationFolderPath',
  'createDestinationFolder',
  'openSourceAsCopy',
  'renameDestinationFolderFrom',
  'expectedAENodes',
  'expectedAEGates',
  'expectedFlow',
  'expectedGateProperties',
  'expectedGradebookOutput',
  'lessonIndex',
  'irat'
] as const;

export async function loadConfig(configPath: string, overrides: Partial<LamsConfig> = {}): Promise<LamsConfig> {
  const absolutePath = path.resolve(configPath);
  const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));

  if (!isRecord(parsed)) throw new Error('Configuration must be a JSON object.');
  const merged: Record<string, unknown> = { ...parsed, ...overrides };
  for (const key of requiredStrings) {
    if (typeof merged[key] !== 'string' || merged[key].trim() === '') {
      throw new Error(`Configuration field "${key}" must be a non-empty string.`);
    }
  }
  if (merged.workspaceCourse !== APPROVED_WORKSPACE_COURSE) {
    throw new Error(`Configuration field "workspaceCourse" must be exactly "${APPROVED_WORKSPACE_COURSE}".`);
  }
  for (const key of ['expectedAENodes', 'expectedAEGates'] as const) {
    if (!Number.isInteger(merged[key]) || Number(merged[key]) < 0) {
      throw new Error(`Configuration field "${key}" must be a non-negative integer.`);
    }
  }
  for (const key of ['sourceFolderPath', 'destinationFolderPath'] as const) {
    if (!Array.isArray(merged[key]) || merged[key].length === 0 || merged[key].some((part) => typeof part !== 'string' || part.trim() === '')) {
      throw new Error(`Configuration field "${key}" must be a non-empty array of folder names.`);
    }
  }
  if (!Array.isArray(merged.expectedFlow) || merged.expectedFlow.length === 0 || merged.expectedFlow.some((name) => typeof name !== 'string' || name.trim() === '')) {
    throw new Error('Configuration field "expectedFlow" must be a non-empty array of exact node names.');
  }
  validateExpectedGateProperties(merged.expectedGateProperties);
  validateLessonIndex(merged.lessonIndex);
  if (merged.createDestinationFolder !== undefined && typeof merged.createDestinationFolder !== 'boolean') {
    throw new Error('Configuration field "createDestinationFolder" must be a boolean.');
  }
  if (merged.openSourceAsCopy !== undefined && typeof merged.openSourceAsCopy !== 'boolean') {
    throw new Error('Configuration field "openSourceAsCopy" must be a boolean.');
  }
  if (
    merged.renameDestinationFolderFrom !== undefined &&
    (typeof merged.renameDestinationFolderFrom !== 'string' || merged.renameDestinationFolderFrom.trim() === '')
  ) {
    throw new Error('Configuration field "renameDestinationFolderFrom" must be a non-empty string.');
  }
  if (merged.createDestinationFolder === true && (merged.destinationFolderPath as unknown[]).length < 2) {
    throw new Error('createDestinationFolder requires a destinationFolderPath with a parent and final folder name.');
  }
  if (merged.renameDestinationFolderFrom !== undefined) {
    if (merged.createDestinationFolder === true) {
      throw new Error('renameDestinationFolderFrom cannot be combined with createDestinationFolder.');
    }
    const destinationPath = merged.destinationFolderPath as string[];
    if (destinationPath.length < 2 || destinationPath.at(-1) === merged.renameDestinationFolderFrom) {
      throw new Error('renameDestinationFolderFrom requires a different final destination folder name.');
    }
  }
  validateIratRequest(merged.irat);

  const config = merged as unknown as LamsConfig;
  config.browser = {
    headless: config.browser?.headless ?? false,
    userDataDir: config.browser?.userDataDir ?? '.playwright/lams-profile',
    manualLoginTimeoutMs: config.browser?.manualLoginTimeoutMs ?? 120_000,
    actionTimeoutMs: config.browser?.actionTimeoutMs ?? 15_000,
    // LAMS initialises the authoring canvas well after the toolbar paints, so surface
    // readiness needs a longer budget than an ordinary action.
    readyTimeoutMs: config.browser?.readyTimeoutMs ?? 60_000
  };
  config.selectors ??= {};
  validateLocatorSpecs(config.selectors);
  return config;
}

function validateIratRequest(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Configuration field "irat" must be an object.');
  if (!isRecord(value.gate)) throw new Error('irat.gate must be an object.');
  for (const key of ['name', 'description'] as const) {
    if (typeof value.gate[key] !== 'string' || value.gate[key].trim() === '') {
      throw new Error(`irat.gate.${key} must be a non-empty string.`);
    }
  }
  if (value.gate.type !== 'password') throw new Error('irat.gate.type must be "password".');
  if (typeof value.gate.dynamicPassword !== 'boolean') {
    throw new Error('irat.gate.dynamicPassword must be a boolean.');
  }
  if (!Number.isInteger(value.gate.rotationSeconds) || Number(value.gate.rotationSeconds) <= 0) {
    throw new Error('irat.gate.rotationSeconds must be a positive integer.');
  }
  for (const key of ['activityName', 'teamSetupName'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      throw new Error(`irat.${key} must be a non-empty string.`);
    }
  }
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw new Error('irat.questions must be a non-empty array.');
  }
  const titles = new Set<string>();
  value.questions.forEach((question, questionIndex) => {
    if (!isRecord(question)) throw new Error(`irat.questions[${questionIndex}] must be an object.`);
    for (const key of ['title', 'type', 'content', 'fontFamily'] as const) {
      if (typeof question[key] !== 'string' || question[key].trim() === '') {
        throw new Error(`irat.questions[${questionIndex}].${key} must be a non-empty string.`);
      }
    }
    if (titles.has(question.title)) throw new Error(`Duplicate iRAT question title: "${question.title}".`);
    titles.add(question.title);
    if (question.marks === undefined) {
      // The deployment guide sets iRAT questions to 1 mark each unless stated otherwise.
      question.marks = 1;
    } else if (!Number.isInteger(question.marks) || Number(question.marks) <= 0) {
      throw new Error(`irat.questions[${questionIndex}].marks must be a positive integer.`);
    }
    if (typeof question.mandatory !== 'boolean') {
      throw new Error(`irat.questions[${questionIndex}].mandatory must be a boolean.`);
    }
    if (!Number.isFinite(question.fontSize) || Number(question.fontSize) <= 0) {
      throw new Error(`irat.questions[${questionIndex}].fontSize must be positive.`);
    }
    if (!Array.isArray(question.answers) || question.answers.length < 2) {
      throw new Error(`irat.questions[${questionIndex}].answers must contain at least two answers.`);
    }
    let correctWeight = 0;
    question.answers.forEach((answer, answerIndex) => {
      if (!isRecord(answer) || typeof answer.text !== 'string' || answer.text.trim() === '') {
        throw new Error(`irat.questions[${questionIndex}].answers[${answerIndex}].text must be non-empty.`);
      }
      if (typeof answer.correct !== 'boolean') {
        throw new Error(`irat.questions[${questionIndex}].answers[${answerIndex}].correct must be a boolean.`);
      }
      if (!Number.isFinite(answer.weight) || Number(answer.weight) < 0 || Number(answer.weight) > 100) {
        throw new Error(`irat.questions[${questionIndex}].answers[${answerIndex}].weight must be between 0 and 100.`);
      }
      if (answer.correct) correctWeight += Number(answer.weight);
      else if (Number(answer.weight) !== 0) {
        throw new Error(`Incorrect answer weight must be 0 in iRAT question "${question.title}".`);
      }
    });
    if (correctWeight !== 100) {
      throw new Error(`Correct answer weights must total 100 in iRAT question "${question.title}"; found ${correctWeight}.`);
    }
  });
  if (!isRecord(value.advanced)) throw new Error('irat.advanced must be an object.');
  for (const key of [
    'shuffleQuestions',
    'shuffleAnswers',
    'questionsNumbering',
    'displayAllQuestions',
    'answerJustification',
    'confidenceLevels'
  ] as const) {
    if (typeof value.advanced[key] !== 'boolean') throw new Error(`irat.advanced.${key} must be a boolean.`);
  }
}

export function parseRequestOverrides(raw: string | undefined): Partial<LamsConfig> {
  if (raw === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`--request-json must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('--request-json must contain a JSON object.');

  const allowed = new Set<string>(requestOverrideKeys);
  const unknownKeys = Object.keys(parsed).filter((key) => !allowed.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`--request-json cannot override stable environment fields: ${unknownKeys.join(', ')}`);
  }

  const overrideRecord: Record<string, unknown> = {};
  requestOverrideKeys.forEach((key) => {
    if (Object.hasOwn(parsed, key)) overrideRecord[key] = parsed[key];
  });
  if (!Object.hasOwn(overrideRecord, 'destinationFolder') && Array.isArray(overrideRecord.destinationFolderPath)) {
    overrideRecord.destinationFolder = overrideRecord.destinationFolderPath.join('/');
  }
  return overrideRecord as Partial<LamsConfig>;
}

function validateExpectedGateProperties(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error('Configuration field "expectedGateProperties" must be an array.');
  }
  const validTypes = new Set(['condition', 'sync', 'schedule', 'permission', 'password', 'system']);
  value.forEach((rule, index) => {
    if (!isRecord(rule) || typeof rule.name !== 'string' || rule.name.trim() === '') {
      throw new Error(`expectedGateProperties[${index}].name must be a non-empty string.`);
    }
    if (rule.type !== undefined && !validTypes.has(String(rule.type))) {
      throw new Error(`expectedGateProperties[${index}].type is invalid.`);
    }
    if (rule.description !== undefined && typeof rule.description !== 'string') {
      throw new Error(`expectedGateProperties[${index}].description must be a string.`);
    }
    if (rule.dynamicPassword !== undefined && typeof rule.dynamicPassword !== 'boolean') {
      throw new Error(`expectedGateProperties[${index}].dynamicPassword must be a boolean.`);
    }
    if (rule.rotationSeconds !== undefined && (!Number.isInteger(rule.rotationSeconds) || Number(rule.rotationSeconds) <= 0)) {
      throw new Error(`expectedGateProperties[${index}].rotationSeconds must be a positive integer.`);
    }
    if (rule.stopAtPrecedingActivity !== undefined && typeof rule.stopAtPrecedingActivity !== 'boolean') {
      throw new Error(`expectedGateProperties[${index}].stopAtPrecedingActivity must be a boolean.`);
    }
  });
}

function validateLessonIndex(value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error('Configuration field "lessonIndex" must be an object.');
  if (value.courseGrouping !== undefined && (typeof value.courseGrouping !== 'string' || value.courseGrouping.trim() === '')) {
    throw new Error('lessonIndex.courseGrouping must be a non-empty string when provided.');
  }
  if (typeof value.endDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.endDate)) {
    throw new Error('lessonIndex.endDate must be a date formatted as YYYY-MM-DD.');
  }
  if (value.endTime !== undefined && (typeof value.endTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.endTime))) {
    throw new Error('lessonIndex.endTime must be a 24-hour time formatted as HH:MM.');
  }
  for (const key of ['displayScoresOnCompletion', 'enableScheduling'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new Error(`lessonIndex.${key} must be a boolean.`);
    }
  }
}

export function interpolate(value: string, config: LamsConfig): string {
  return value.replace(/\{\{(\w+)\}\}/g, (match, key: keyof LamsConfig) => {
    const replacement = config[key];
    return typeof replacement === 'string' ? replacement : match;
  });
}

function validateLocatorSpecs(selectors: LamsConfig['selectors']): void {
  const specs: unknown[] = [
    selectors.previousCohort,
    selectors.tbl,
    selectors.openLesson,
    selectors.openAuthoring,
    selectors.aeOpenActivity,
    selectors.authoringRoot,
    selectors.authoringNode?.locator,
    selectors.openAddLesson,
    selectors.openMonitoring
  ];
  for (const spec of specs) {
    if (spec === undefined) continue;
    if (!isRecord(spec) || !['role', 'label', 'text', 'testId', 'css'].includes(String(spec.by))) {
      throw new Error(`Invalid locator specification: ${JSON.stringify(spec)}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
