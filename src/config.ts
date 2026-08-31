import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
}

export interface IratAnswerRequest {
  text: string;
  correct: boolean;
  weight: number;
}

export interface IratQuestionRequest {
  title: string;
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
    shuffleAnswers: boolean;
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
  expectedAENodes: number;
  expectedAEGates: number;
  expectedFlow: string[];
  expectedGateProperties?: ExpectedGateProperties[];
  irat?: IratRequest;
  browser: {
    headless: boolean;
    userDataDir: string;
    manualLoginTimeoutMs: number;
    actionTimeoutMs: number;
  };
  selectors: {
    previousCohort?: LocatorSpec;
    tbl?: LocatorSpec;
    openLesson?: LocatorSpec;
    openAuthoring?: LocatorSpec;
    authoringRoot?: LocatorSpec;
    authoringNode?: AuthoringNodeSelector;
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
  'expectedAENodes',
  'expectedAEGates',
  'expectedFlow',
  'expectedGateProperties',
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
  validateIratRequest(merged.irat);

  const config = merged as unknown as LamsConfig;
  config.browser = {
    headless: config.browser?.headless ?? false,
    userDataDir: config.browser?.userDataDir ?? '.playwright/lams-profile',
    manualLoginTimeoutMs: config.browser?.manualLoginTimeoutMs ?? 120_000,
    actionTimeoutMs: config.browser?.actionTimeoutMs ?? 15_000
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
  for (const key of ['shuffleAnswers', 'displayAllQuestions', 'answerJustification', 'confidenceLevels'] as const) {
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
  });
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
    selectors.authoringRoot,
    selectors.authoringNode?.locator
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
