import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { buildAEPlan } from './ae/plan.js';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openExactAEActivity } from './lams/ae.js';
import { applyAEActivitySettings } from './lams/ae-settings.js';
import { inspectAuthoringGraph, openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';
import { formatValidationReport, validateAEPlanGraph } from './lams/validation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const aePath = readArgument('--ae-json');
  const nodeTitle = readArgument('--node');
  if (!aePath || !nodeTitle) {
    throw new Error('Usage: npm run inspect:ae -- --config <path> --ae-json <path> --node <exact-title> --request-json <json>');
  }
  if (process.argv.includes('--commit')) throw new Error('inspect:ae is read-only and does not accept --commit');

  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  const plan = buildAEPlan(JSON.parse(await readFile(path.resolve(aePath), 'utf8')) as unknown);
  if (!plan.nodes.some((node) => node.title === nodeTitle)) {
    throw new Error(`--node must exactly match one planned AE node; received "${nodeTitle}"`);
  }

  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;
  try {
    await openLams(page, config);
    await verifyWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);

    const graphReport = validateAEPlanGraph(await inspectAuthoringGraph(activePage), plan);
    console.log(`\n${formatValidationReport(graphReport)}`);
    if (!graphReport.passed) {
      process.exitCode = 2;
      return;
    }

    activePage = await openExactAEActivity(activePage, nodeTitle, config);
    const settings = await applyAEActivitySettings(activePage, {
      commit: false,
      actionTimeoutMs: config.browser.actionTimeoutMs
    });
    console.log(`\nAE activity settings — ${nodeTitle}`);
    settings.checks.forEach((check) => {
      console.log(`${check.actual === check.expected ? '✓' : '✗'} ${check.label}: expected ${check.expected}, found ${check.actual}`);
    });
    console.log(`Overall: ${settings.passed ? 'PASS' : 'FAIL'} (read-only; ${settings.changesRequired} changes required)`);
    if (!settings.passed) process.exitCode = 2;
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'ae-inspection-failure').catch(() => undefined);
    if (directory) console.error(`AE inspection diagnostics: ${directory}`);
    throw error;
  } finally {
    await context.close();
  }
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
