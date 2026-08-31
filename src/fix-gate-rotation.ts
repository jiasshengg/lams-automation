import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig, parseRequestOverrides } from './config.js';
import { inspectAuthoringGraph, openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { setGateRotationSeconds } from './lams/gate-properties.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const gateName = readArgument('--gate');
  const rotation = Number(readArgument('--rotation-seconds'));
  const commit = process.argv.includes('--commit');
  if (!gateName || !Number.isInteger(rotation) || rotation <= 0) {
    throw new Error('Usage: fix:gate -- --config <path> --gate <exact gate name> --rotation-seconds <n> --request-json <json> [--commit]');
  }

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
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);

    const before = gate(await inspectAuthoringGraph(activePage), gateName);
    console.log(`\nLesson: ${config.lessonTitle}`);
    console.log(`Folder: ${config.destinationFolderPath.join(' > ')}`);
    console.log(`${gateName}: type=${before.gateType} dynamic=${before.dynamicPassword} rotation=${before.rotationSeconds ?? 'unavailable'}s`);

    if (before.rotationSeconds === rotation) {
      console.log(`\nNothing to do: rotation is already ${rotation}s.`);
      return;
    }
    if (!commit) {
      console.log(`\nDry run: would change rotation ${before.rotationSeconds ?? 'unavailable'}s -> ${rotation}s. Nothing was changed or saved.`);
      return;
    }

    const change = await setGateRotationSeconds(activePage, config, gateName, rotation);
    const saveButton = activePage.locator('#saveButton');
    await saveButton.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
    if (!(await saveButton.isEnabled())) throw new Error('Authoring Save remained disabled after changing the rotation.');
    await saveButton.click();

    // Reopen the lesson so the verification reads persisted state, not the live canvas.
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);
    const persisted = gate(await inspectAuthoringGraph(activePage), gateName);
    if (persisted.rotationSeconds !== rotation) {
      throw new Error(`Saved design still reports ${persisted.rotationSeconds ?? 'unavailable'}s for "${gateName}".`);
    }
    console.log(`\nGate rotation updated and verified: ${change.previousSeconds ?? 'unavailable'}s -> ${persisted.rotationSeconds}s`);
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'gate-rotation-failure').catch(() => undefined);
    if (directory) console.error(`Diagnostics: ${directory}`);
    throw error;
  } finally {
    await context.close();
  }
}

function gate(graph: Awaited<ReturnType<typeof inspectAuthoringGraph>>, gateName: string) {
  const matches = graph.nodes.filter((node) => node.name === gateName && node.type === 'gate');
  if (matches.length !== 1) throw new Error(`Expected exactly one gate named "${gateName}"; found ${matches.length}.`);
  return matches[0]!;
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
