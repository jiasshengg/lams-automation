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
}

export interface LessonIndexSettings {
  courseGrouping?: string;
  endDate: string;
  endTime?: string;
  displayScoresOnCompletion?: boolean;
  enableScheduling?: boolean;
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
  lessonIndex?: LessonIndexSettings;
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
  'lessonIndex'
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
