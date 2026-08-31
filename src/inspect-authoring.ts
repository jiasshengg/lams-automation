import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from './config.js';
import { inspectAuthoringGraph, openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';
import { formatValidationReport, validateAuthoringGraph } from './lams/validation.js';

async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath);
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
    const graph = await inspectAuthoringGraph(activePage);

    console.log('\nLAMS Authoring Inspection');
    console.log(`Rendering: ${graph.rendering.toUpperCase()}`);
    console.log(`Runtime model: ${graph.modelAvailable ? 'AVAILABLE' : 'DOM FALLBACK'}`);
    console.log(`Nodes: ${graph.nodes.length}`);
    graph.nodes.forEach((node) => {
      console.log(
        `- UIID ${node.uiid}: ${node.name || '(unnamed)'} [${node.type}]` +
          ` grouped=${node.grouped}` +
          `${node.groupingUiid === null ? '' : ` groupingUIID=${node.groupingUiid}`}` +
          `${node.gateType === null ? '' : ` gateType=${node.gateType}`}` +
          `${node.description === null ? '' : ` description=${JSON.stringify(node.description)}`}` +
          `${node.dynamicPassword === null ? '' : ` dynamicPassword=${node.dynamicPassword}`}` +
          `${node.rotationSeconds === null ? '' : ` rotationSeconds=${node.rotationSeconds}`}`
      );
    });
    console.log(`Transitions: ${graph.transitions.length}`);
    graph.transitions.forEach((transition) => {
      console.log(`- UIID ${transition.uiid}: ${transition.fromUiid ?? '?'} -> ${transition.toUiid ?? '?'}`);
    });
    if (process.argv.includes('--validate')) {
      const report = validateAuthoringGraph(graph, config);
      console.log(`\n${formatValidationReport(report)}`);
      if (!report.passed) process.exitCode = 2;
    }
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'authoring-inspection-failure').catch(() => undefined);
    if (directory) console.error(`Inspection diagnostics: ${directory}`);
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
