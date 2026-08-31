import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { inspectPageSurface, saveDiagnostics } from './lams/diagnostics.js';
import { copyLesson, openSourceLesson } from './lams/lesson-copy.js';
import { openLams, SelectorRequiredError, verifyWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/example.json';
  const commit = process.argv.includes('--commit');
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  if (config.baseUrl.includes('replace-with-your-lams-host.example')) {
    throw new Error(`Edit ${path.resolve(configPath)} and set the real LAMS baseUrl before running Milestone 1.`);
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
    const authoringPage = await openAuthoring(page, config);
    activePage = authoringPage;
    await openSourceLesson(authoringPage, config);
    const result = await copyLesson(authoringPage, config, { commit });
    console.log(`\nFirst-box workflow: ${result.committed ? 'COPIED' : 'DRY RUN PASS'}`);
    console.log(`Source: ${result.sourceTitle}`);
    console.log(`New title: ${result.newTitle}`);
    console.log(`Destination: ${result.destinationFolderPath.join(' > ')}`);
  } catch (error) {
    if (error instanceof SelectorRequiredError) {
      console.error(`\nMilestone 1 paused: ${error.message}`);
      console.error('Inspect page.png, page.html, and dom-summary.json, then add the selector to your config.');
      console.error(JSON.stringify(await inspectPageSurface(page), null, 2));
      process.exitCode = 2;
    } else {
      const directory = await saveDiagnostics(activePage, 'workflow-failure').catch(() => undefined);
      if (directory) console.error(`Live failure diagnostics: ${directory}`);
      throw error;
    }
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
