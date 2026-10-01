import { tryExpectedTBLGraph } from './lams/tbl-expectations.js';
import { parsePlaceholderRepair, persistPlaceholderRepairs, repairAEPlaceholders } from './lams/ae-placeholder.js';
import { inspectAuthoringGraph } from './lams/authoring.js';
import { validateAuthoringGraph, formatValidationReport } from './lams/validation.js';
import { launchLamsBrowser } from '../scripts/setup/browser-profile.mjs';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { loadEnvFile } from './load-env.js';
import { closeAuthoring, openAuthoringLibrary } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { executeIratAutomation, resolveIratRequest } from './lams/irat.js';
import { LamsIratEditor } from './lams/irat-editor.js';
import { copyLesson, openLessonFromLibrary, openSourceLesson } from './lams/lesson-copy.js';
import { resolveIratQuestionImages } from './docx/question-images.js';
import { resolveAEQuestionImages } from './docx/question-images.js';
import { readFile } from 'node:fs/promises';
import { resolveInputFile } from './input-file.js';
import { buildAEPlan } from './ae/plan.js';
import { assertAEPlanMatchesSOT } from './ae/sot-check.js';
import { LamsAEEditor } from './lams/ae-editor.js';
import { reconcileAndWriteAEGraph } from './lams/ae-graph.js';
import { assertRenamesFollowPlan, parseAERenamePlan, projectAERenames } from './lams/ae-rename.js';
import { publishLesson, requirePublishSettings } from './lams/publish.js';

loadEnvFile();

async function main(): Promise<void> {
  const commit = !process.argv.includes('--dry-run');
  // --publish continues into the publishing stage in this same browser once AE is saved and
  // validated. It is only ever passed on an explicit request for the full flow or to publish.
  const publish = process.argv.includes('--publish');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')), { defaultDestinationToSource: true });
  if (publish) {
    if (!readArgument('--ae-json')) throw new Error('--publish runs after AE, so it needs --ae-json.');
    // The end date can only come from the user; without it nothing is copied or published.
    requirePublishSettings(config);
  }
  const irat = await resolveIratRequest(config);
  const repairJson = readArgument('--repair-json');
  const repair = repairJson ? parsePlaceholderRepair(JSON.parse(await readFile(await resolveInputFile(repairJson, '.json'), 'utf8'))) : undefined;
  const aeJson = readArgument('--ae-json');
  const aePlan = aeJson
    ? buildAEPlan(JSON.parse(await readFile(await resolveInputFile(aeJson, '.json'), 'utf8')) as unknown)
    : undefined;
  // Checked before the browser opens: nothing reaches LAMS unless it follows the document.
  if (aePlan) await assertAEPlanMatchesSOT(aePlan);
  // Authorised in-place renames of the copy's earlier AE chain, exactly as apply:ae takes them.
  const renameJson = readArgument('--rename-json');
  const renames = renameJson ? parseAERenamePlan(JSON.parse(await readFile(await resolveInputFile(renameJson, '.json'), 'utf8'))) : undefined;
  if (renames && !aePlan) throw new Error('--rename-json renames AE titles, so it needs --ae-json.');
  if (renames && aePlan) assertRenamesFollowPlan(renames, aePlan);
  if (renames && renames.lessonTitle !== config.lessonTitle) throw new Error('Rename plan lessonTitle does not match the requested destination lesson.');
  // --slow-mo pauses before every action so a live run can be watched step by step.
  const slowMoArgument = readArgument('--slow-mo');
  const slowMoMs = slowMoArgument === undefined ? undefined : Number(slowMoArgument);
  if (slowMoMs !== undefined && (!Number.isFinite(slowMoMs) || slowMoMs < 0)) {
    throw new Error(`--slow-mo must be a non-negative number of milliseconds; received "${slowMoArgument}".`);
  }
  if (slowMoMs) console.log(`Slow motion: pausing ${slowMoMs}ms before each action.`);
  const context = await launchLamsBrowser(
    config.browser.userDataDir,
    // Slow motion is only ever useful on a visible browser, so it forces headed mode.
    browserLaunchOptions(config, slowMoMs !== undefined ? { headless: false, slowMoMs } : {})
  );
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    activePage = await openAuthoringLibrary(page, config);
    await openSourceLesson(activePage, config);
    if (repair && repair.lessonTitle !== config.lessonTitle) throw new Error('Repair plan lessonTitle does not match the requested destination lesson.');
    const copy = await copyLesson(activePage, config, { commit });
    if (!commit) {
      console.log('Copy dry run complete; iRAT changes were not applied.');
      return;
    }
    // iRAT and AE each verify their own targets as they write. The full-lesson expectations for the closing validation come from an in-page read of the
    // copy, which opens no activity and costs no navigation.
    const copied = aePlan ? await inspectAuthoringGraph(activePage) : undefined;
    const expectations = aePlan && copied
      ? tryExpectedTBLGraph(renames ? projectAERenames(copied, renames) : copied, config, aePlan, repair)
      : undefined;
    if (renames) console.log(`Authorised AE renames: ${renames.renames.map((rename) => `${rename.type} "${rename.from}" -> "${rename.to}"`).join(', ')}`);
    if (repair) {
      const repaired = await repairAEPlaceholders(activePage, repair, config.browser.actionTimeoutMs);
      await persistPlaceholderRepairs(activePage, repaired, () =>
        openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config));
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
          config.browser.actionTimeoutMs,
          renames
        )
      : undefined;
    if (expectations) {
      const report = validateAuthoringGraph(await inspectAuthoringGraph(activePage), { ...config, ...expectations });
      console.log(formatValidationReport(report));
      if (!report.passed) throw new Error('Completed authoring does not match the reviewed full-lesson expectations. Inspect saved state before publishing.');
    }
    // Step 81 closes the Author screen once the design is saved. Publishing (steps 82-92)
    // follows in this same browser only with --publish, which the skill passes solely when the
    // user asked for the full flow or for publishing and supplied this lesson's end date.
    await closeAuthoring(activePage, page, config);
    activePage = page;

    const published = publish
      ? await publishLesson(page, config, {
          commit: true,
          // Only the design this run just saved may be published.
          expectedDesignTitle: copy.newTitle,
          forceCode: process.argv.includes('--publish-code'),
          publishCode: !process.argv.includes('--no-publish-code')
        })
      : undefined;

    console.log('\nContinuous TBL workflow: COMPLETE');
    console.log(`Copied: ${copy.sourceTitle} → ${copy.newTitle}`);
    console.log(`Destination: ${copy.destinationFolderPath.join(' > ')}`);
    console.log(`iRAT questions deleted: ${result.deletedQuestions.join(', ') || 'none'}`);
    console.log(`iRAT questions updated: ${result.updatedQuestions.join(', ')}`);
    console.log(`Questions created (${result.createdQuestions.length}): ${result.createdQuestions.join(', ')}`);
    console.log(`iRAT images imported: ${[...questionImages.values()].reduce((sum, images) => sum + images.length, 0)}`);
    console.log(`iRAT save prompts confirmed (${editor.confirmedDialogs.length}): ${editor.confirmedDialogs.join(' | ') || 'none raised'}`);
    if (aeResult) {
      console.log(`AE nodes written: ${aeResult.writtenNodes.map((node) => node.nodeTitle).join(', ')}`);
      console.log(`AE nodes/gates created: ${aeResult.createdNodes.length}/${aeResult.createdGates.length}`);
      console.log(`AE gates replaced: ${aeResult.replacedGates.join(', ') || 'none'}`);
      console.log(`AE nodes renamed: ${aeResult.renamedNodes.map((rename) => `${rename.from} -> ${rename.to}`).join(', ') || 'none'}`);
      console.log(`AE gates renamed: ${aeResult.renamedGates.map((rename) => `${rename.from} -> ${rename.to}`).join(', ') || 'none'}`);
      console.log(`AE transitions removed: ${aeResult.removedTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
      console.log(`AE images imported: ${aeResult.writtenNodes.reduce((sum, node) => sum + node.importedImages, 0)}`);
    }
    if (published) {
      console.log(`Published: ${published.lesson.lessonTitle}, ends ${published.lesson.endDateTime}, code ${published.lessonId ?? 'unknown'}`);
    } else {
      console.log('Authoring complete. To publish this lesson to a cohort, rerun with --publish or run lesson:index with --commit.');
    }
    console.log(
      aeResult
        ? 'Verified: configured course, copy destination, iRAT content/Print View, AE content/Print View, and post-save AE graph.'
        : 'Verified: configured course, copy destination, iRAT/tRAT graph readiness, Print View, synced tRAT questions, tRAT confidence/default settings, and post-save gate state.'
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
