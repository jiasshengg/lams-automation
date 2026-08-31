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

export async function loadConfig(configPath: string): Promise<LamsConfig> {
  const absolutePath = path.resolve(configPath);
  const parsed: unknown = JSON.parse(await readFile(absolutePath, 'utf8'));

  if (!isRecord(parsed)) throw new Error('Configuration must be a JSON object.');
  for (const key of requiredStrings) {
    if (typeof parsed[key] !== 'string' || parsed[key].trim() === '') {
      throw new Error(`Configuration field "${key}" must be a non-empty string.`);
    }
  }
  for (const key of ['expectedAENodes', 'expectedAEGates'] as const) {
    if (!Number.isInteger(parsed[key]) || Number(parsed[key]) < 0) {
      throw new Error(`Configuration field "${key}" must be a non-negative integer.`);
    }
  }
  for (const key of ['sourceFolderPath', 'destinationFolderPath'] as const) {
    if (!Array.isArray(parsed[key]) || parsed[key].length === 0 || parsed[key].some((part) => typeof part !== 'string' || part.trim() === '')) {
      throw new Error(`Configuration field "${key}" must be a non-empty array of folder names.`);
    }
  }
  if (!Array.isArray(parsed.expectedFlow) || parsed.expectedFlow.length === 0 || parsed.expectedFlow.some((name) => typeof name !== 'string' || name.trim() === '')) {
    throw new Error('Configuration field "expectedFlow" must be a non-empty array of exact node names.');
  }

  const config = parsed as unknown as LamsConfig;
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
