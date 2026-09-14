import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { loadEnvFile } from './load-env.js';
import type { LamsConfig } from './config.js';
import { closeAuthoring, openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { executeIratAutomation, resolveIratRequest } from './lams/irat.js';
import { LamsIratEditor } from './lams/irat-editor.js';
import { copyLesson, openSourceLesson } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';
import { createLessonFromMostRecentDesign, openAddLesson } from './lams/lesson-index.js';
import type { LessonIndexResult } from './lams/lesson-index.js';
import { openMonitoring } from './lams/monitoring.js';
import { sendCodeToSheet } from './sheets/code-sink.js';
import { resolveIratQuestionImages } from './docx/question-images.js';
import { resolveAEQuestionImages } from './docx/question-images.js';
import { readFile } from 'node:fs/promises';
import { resolveInputFile } from './input-file.js';
import { buildAEPlan } from './ae/plan.js';
import { LamsAEEditor } from './lams/ae-editor.js';
import { reconcileAndWriteAEGraph } from './lams/ae-graph.js';

loadEnvFile();

async function main(): Promise<void> {
  const commit = !process.argv.includes('--dry-run');
  const publishCode = process.argv.includes('--publish-code');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')), { defaultDestinationToSource: true });
  // Steps 81-92 are part of the one continuous run: a config carrying lessonIndex is
  // published automatically once authoring succeeds. They publish a lesson learners can
  // see, so --skip-index stops before that and --dry-run previews the form instead.
  const index = !process.argv.includes('--skip-index') && config.lessonIndex !== undefined;
  const irat = await resolveIratRequest(config);
  const aeJson = readArgument('--ae-json');
  const aePlan = aeJson
    ? buildAEPlan(JSON.parse(await readFile(await resolveInputFile(aeJson, '.json'), 'utf8')) as unknown)
    : undefined;
  // --slow-mo pauses before every action so a live run can be watched step by step.
  const slowMoArgument = readArgument('--slow-mo');
  const slowMoMs = slowMoArgument === undefined ? undefined : Number(slowMoArgument);
  if (slowMoMs !== undefined && (!Number.isFinite(slowMoMs) || slowMoMs < 0)) {
    throw new Error(`--slow-mo must be a non-negative number of milliseconds; received "${slowMoArgument}".`);
  }
  if (slowMoMs) console.log(`Slow motion: pausing ${slowMoMs}ms before each action.`);
  const context = await chromium.launchPersistentContext(
    path.resolve(config.browser.userDataDir),
    // Slow motion is only ever useful on a visible browser, so it forces headed mode.
    browserLaunchOptions(config, slowMoMs !== undefined ? { headless: false, slowMoMs } : {})
  );
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
      if (index) {
        // Nothing was copied, so there is no design this run authored to match against;
        // the preview fills and verifies the Add Lesson form and stops before "Add now".
        await closeAuthoring(activePage, page, config);
        activePage = page;
        await publishLesson(page, config, undefined, false, false);
      }
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
    // Step 81: leave the Author screen before the course page drives Add Lesson.
    await closeAuthoring(activePage, page, config);
    activePage = page;

    // Steps 82-92, on the same page and the same authenticated session as the authoring.
    const published = index ? await publishLesson(page, config, copy.newTitle, commit, publishCode) : undefined;
    if (!index) {
      console.log(
        config.lessonIndex
          ? 'Stopped after authoring: --skip-index was passed (steps 81-92 skipped).'
          : 'Stopped after authoring: no "lessonIndex" block, so there is no end date to publish with.'
      );
    }

    console.log('\nContinuous TBL workflow: COMPLETE');
    console.log(`Copied: ${copy.sourceTitle} → ${copy.newTitle}`);
    console.log(`Destination: ${copy.destinationFolderPath.join(' > ')}`);
    console.log(`iRAT questions updated: ${result.updatedQuestions.join(', ')}`);
    console.log(`Questions created (${result.createdQuestions.length}): ${result.createdQuestions.join(', ')}`);
    console.log(`iRAT images imported: ${[...questionImages.values()].reduce((sum, images) => sum + images.length, 0)}`);
    console.log(`iRAT save prompts confirmed (${editor.confirmedDialogs.length}): ${editor.confirmedDialogs.join(' | ') || 'none raised'}`);
    if (aeResult) {
      console.log(`AE nodes written: ${aeResult.writtenNodes.map((node) => node.nodeTitle).join(', ')}`);
      console.log(`AE nodes/gates created: ${aeResult.createdNodes.length}/${aeResult.createdGates.length}`);
      console.log(`AE gates replaced: ${aeResult.replacedGates.join(', ') || 'none'}`);
      console.log(`AE transitions removed: ${aeResult.removedTransitions.map((edge) => `${edge.from} -> ${edge.to}`).join(', ') || 'none'}`);
      console.log(`AE images imported: ${aeResult.writtenNodes.reduce((sum, node) => sum + node.importedImages, 0)}`);
    }
    if (published) {
      console.log(`Lesson published from design: ${published.designTitle}`);
      console.log(`Lesson ends: ${published.endDateTime}`);
      console.log(`Course grouping: ${published.courseGrouping}`);
      console.log(`Lesson ID (the 5-digit code): ${published.lessonId ?? 'not read; no lesson was created'}`);
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

/**
 * Steps 82-92 reuse the course page the authoring run already navigated and authenticated,
 * so there is no second browser, login, or course selection. The lesson code is read from
 * Monitoring only once a committed lesson actually exists.
 */
async function publishLesson(
  page: Page,
  config: LamsConfig,
  designTitle: string | undefined,
  commit: boolean,
  publishCode: boolean
): Promise<LessonIndexResult & { lessonId?: string }> {
  // Closing the Author screen leaves this page on the cohort it was opened from, so Add
  // Lesson is clicked where we already are. selectWorkspaceCourse only confirms that
  // heading and returns; it re-navigates only if LAMS moved us somewhere else.
  await selectWorkspaceCourse(page, config);
  if (!config.lessonIndex) {
    throw new Error('--index needs a "lessonIndex" block (at least endDate) in the config or --request-json.');
  }
  await openAddLesson(page, config);
  const result = await createLessonFromMostRecentDesign(page, config, {
    commit,
    ...(designTitle !== undefined ? { expectedDesignTitle: designTitle } : {})
  });
  if (!result.committed) return result;

  await openLams(page, config);
  const monitoring = await openMonitoring(page, result.lessonTitle, config);
  if (publishCode) {
    // The lesson already exists by now, so a sheet that rejects the code is reported
    // rather than allowed to fail a run whose LAMS-side work is complete.
    try {
      await sendCodeToSheet(monitoring.lessonId, result.lessonTitle);
      console.log(`Sent code ${monitoring.lessonId} for "${result.lessonTitle}" to the Kanban sheet.`);
    } catch (error) {
      console.error(`Kanban sheet not updated: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  return { ...result, lessonId: monitoring.lessonId };
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
