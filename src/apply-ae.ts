import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { buildAEPlan } from './ae/plan.js';
import { loadConfig, parseRequestOverrides } from './config.js';
import { resolveAEQuestionImages } from './docx/question-images.js';
import { resolveInputFile } from './input-file.js';
import { LamsAEEditor } from './lams/ae-editor.js';
import { openAuthoring } from './lams/authoring.js';
import { inspectAuthoringGraph } from './lams/authoring.js';
import { planAEGraphReconciliation, reconcileAndWriteAEGraph } from './lams/ae-graph.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';

async function main(): Promise<void> {
  const aeJson = readArgument('--ae-json');
  if (!aeJson) throw new Error('Usage: npm run apply:ae -- --config <path> --ae-json <path> --request-json <json> [--team-setup <title>] [--dry-run]');
  const commit = !process.argv.includes('--dry-run');
  const config = await loadConfig(
    readArgument('--config') ?? 'configs/local.json',
    parseRequestOverrides(readArgument('--request-json'))
  );
  const plan = buildAEPlan(JSON.parse(await readFile(await resolveInputFile(aeJson, '.json'), 'utf8')) as unknown);
  const teamSetup = readArgument('--team-setup') ?? config.irat?.teamSetupName ?? 'Team Setup';
  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: config.browser.headless,
    viewport: null
  });
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? await context.newPage();
  let activePage = page;
  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);
    if (!commit) {
      const graphPlan = planAEGraphReconciliation(await inspectAuthoringGraph(activePage), plan);
      console.log(`AE write preview: ${plan.nodes.length} node(s), ${plan.nodes.flatMap((node) => node.questions).length} question(s); no changes applied.`);
      console.log(`Missing AE nodes: ${graphPlan.missingNodeTitles.join(', ') || 'none'}`);
      console.log(`Missing AE gates: ${graphPlan.missingGateTitles.join(', ') || 'none'}`);
      console.log(`Missing transitions: ${graphPlan.missingTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
      console.log(`Gate-bypass transitions: ${graphPlan.bypassTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
      console.log(`Gates requiring replacement: ${graphPlan.gatesToReplace.join(', ') || 'none'}`);
      if (graphPlan.invalidGates.length > 0) throw new Error(`AE graph has unsupported gate conflicts: ${graphPlan.invalidGates.join('; ')}`);
      return;
    }
    const images = await resolveAEQuestionImages(plan);
    const editor = new LamsAEEditor(activePage, plan, config.browser.actionTimeoutMs, images);
    const result = await reconcileAndWriteAEGraph(activePage, plan, editor, teamSetup, config.browser.actionTimeoutMs);
    console.log('\nAE application: COMPLETE');
    console.log(`Lesson: ${config.lessonTitle}`);
    console.log(`Nodes written: ${result.writtenNodes.map((node) => node.nodeTitle).join(', ')}`);
    console.log(`Nodes created: ${result.createdNodes.join(', ') || 'none'}`);
    console.log(`Gates created: ${result.createdGates.join(', ') || 'none'}`);
    console.log(`Gates replaced: ${result.replacedGates.join(', ') || 'none'}`);
    console.log(`Transitions removed: ${result.removedTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
    console.log(`Transitions created: ${result.createdTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
    console.log(`Questions created/updated: ${result.writtenNodes.reduce((sum, node) => sum + node.createdQuestions.length + node.updatedQuestions.length, 0)}`);
    console.log(`Images imported: ${result.writtenNodes.reduce((sum, node) => sum + node.importedImages, 0)}`);
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'apply-ae-failure').catch(() => undefined);
    if (directory) console.error(`AE diagnostics: ${directory}`);
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
