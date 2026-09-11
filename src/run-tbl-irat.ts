import path from 'node:path';
import { chromium } from '@playwright/test';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { executeIratAutomation, requireIratRequest } from './lams/irat.js';
import { LamsIratEditor } from './lams/irat-editor.js';
import { copyLesson, openSourceLesson } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';
import { resolveIratQuestionImages } from './docx/question-images.js';
import { resolveAEQuestionImages } from './docx/question-images.js';
import { readFile } from 'node:fs/promises';
import { resolveInputFile } from './input-file.js';
import { buildAEPlan } from './ae/plan.js';
import { LamsAEEditor } from './lams/ae-editor.js';
import { reconcileAndWriteAEGraph } from './lams/ae-graph.js';

async function main(): Promise<void> {
  const commit = !process.argv.includes('--dry-run');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')), { defaultDestinationToSource: true });
  const irat = requireIratRequest(config);
  const aeJson = readArgument('--ae-json');
  const aePlan = aeJson
    ? buildAEPlan(JSON.parse(await readFile(await resolveInputFile(aeJson, '.json'), 'utf8')) as unknown)
    : undefined;
  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), browserLaunchOptions(config));
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openSourceLesson(activePage, config);
    const copy = await copyLesson(activePage, config, { commit });
    if (!commit) {
      console.log('Copy dry run complete; iRAT changes were not applied.');
      return;
    }
    const questionImages = await resolveIratQuestionImages(irat);
    const editor = new LamsIratEditor(activePage, irat, config.browser.actionTimeoutMs, questionImages);
    const result = await executeIratAutomation(editor, irat, { commit });
    const aeImages = aePlan ? await resolveAEQuestionImages(aePlan) : undefined;
    const aeResult = aePlan
      ? await reconcileAndWriteAEGraph(
          activePage,
          aePlan,
          new LamsAEEditor(activePage, aePlan, config.browser.actionTimeoutMs, aeImages),
          readArgument('--team-setup') ?? irat.teamSetupName,
          config.browser.actionTimeoutMs
        )
      : undefined;
    console.log('\nContinuous TBL workflow: COMPLETE');
    console.log(`Copied: ${copy.sourceTitle} → ${copy.newTitle}`);
    console.log(`Destination: ${copy.destinationFolderPath.join(' > ')}`);
    console.log(`iRAT questions updated: ${result.updatedQuestions.join(', ')}`);
    console.log(`Questions created (${result.createdQuestions.length}): ${result.createdQuestions.join(', ')}`);
    console.log(`iRAT images imported: ${[...questionImages.values()].reduce((sum, images) => sum + images.length, 0)}`);
    if (aeResult) {
      console.log(`AE nodes written: ${aeResult.writtenNodes.map((node) => node.nodeTitle).join(', ')}`);
      console.log(`AE nodes/gates created: ${aeResult.createdNodes.length}/${aeResult.createdGates.length}`);
      console.log(`AE gates replaced: ${aeResult.replacedGates.join(', ') || 'none'}`);
      console.log(`AE transitions removed: ${aeResult.removedTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
      console.log(`AE images imported: ${aeResult.writtenNodes.reduce((sum, node) => sum + node.importedImages, 0)}`);
    }
    console.log(
      aeResult
        ? 'Verified: configured course, copy destination, iRAT content/Print View, AE content/Print View, and post-save AE graph.'
        : 'Verified: configured course, copy destination, iRAT graph readiness, Print View, and post-save gate state.'
    );
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'continuous-tbl-irat-failure').catch(() => undefined);
    if (directory) console.error(`Workflow diagnostics: ${directory}`);
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
