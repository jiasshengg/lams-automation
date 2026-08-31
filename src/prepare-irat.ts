import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { prepareIratAutomation } from './lams/irat.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  if (process.argv.includes('--commit')) {
    throw new Error('prepare:irat is read-only and does not accept --commit.');
  }
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
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
    const report = await prepareIratAutomation(activePage, config);

    console.log('\niRAT Automation Preflight');
    console.log(`Lesson: ${config.lessonTitle}`);
    console.log(`Folder: ${config.destinationFolderPath.join(' > ')}`);
    report.checks.forEach((check) => console.log(`${check.passed ? '✓' : '✗'} ${check.label}: ${check.detail}`));
    console.log('\nPlanned changes (not applied):');
    report.plan.forEach((step, index) => {
      console.log(`${index + 1}. [${step.phase}] ${step.action}${step.questionTitle ? ` — ${step.questionTitle}` : ''}`);
    });
    console.log(`\nPreflight: ${report.passed ? 'PASS' : 'FAIL'}; no LAMS content was changed.`);
    if (!report.passed) process.exitCode = 2;
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'irat-preflight-failure').catch(() => undefined);
    if (directory) console.error(`iRAT preflight diagnostics: ${directory}`);
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
