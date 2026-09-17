import path from 'node:path';
import { chromium } from '@playwright/test';
import { browserLaunchOptions, loadConfig, parseRequestOverrides } from './config.js';
import { openAuthoring } from './lams/authoring.js';
import { saveDiagnostics } from './lams/diagnostics.js';
import { executeIratAutomation, resolveIratRequest } from './lams/irat.js';
import { LamsIratEditor, verifySavedRequiredFlags } from './lams/irat-editor.js';
import { openLessonFromLibrary } from './lams/lesson-copy.js';
import { openLams, selectWorkspaceCourse } from './lams/navigation.js';
import { resolveIratQuestionImages } from './docx/question-images.js';
import { hashIratQuestion, IratCheckpointStore } from './lams/irat-checkpoint.js';

/**
 * Applies the structured iRAT request to a lesson that already exists in the approved
 * playground. The continuous workflow copies and then configures in one pass; this entry
 * point covers the case where the copy is already saved, so re-copying would be rejected.
 * It never copies, renames, publishes, starts, or restructures a lesson.
 */
async function main(): Promise<void> {
  const commit = !process.argv.includes('--dry-run');
  const resumeTratSync = process.argv.includes('--resume-trat-sync');
  const repairQuestionTitle = readArgument('--repair-question');
  if (resumeTratSync && !commit) throw new Error('--resume-trat-sync cannot be combined with --dry-run.');
  if (repairQuestionTitle && !commit) throw new Error('--repair-question cannot be combined with --dry-run.');
  if (resumeTratSync && repairQuestionTitle) throw new Error('--resume-trat-sync and --repair-question are mutually exclusive.');
  const keepOpen = process.argv.includes('--keep-open');
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath, parseRequestOverrides(readArgument('--request-json')));
  const irat = await resolveIratRequest(config);
  const questionImages = await resolveIratQuestionImages(irat);
  const checkpoint = commit && !resumeTratSync && !repairQuestionTitle
    ? await IratCheckpointStore.open(config, irat, undefined, questionImages)
    : undefined;

  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), browserLaunchOptions(config));
  context.setDefaultTimeout(config.browser.actionTimeoutMs);
  const page = context.pages()[0] ?? (await context.newPage());
  let activePage = page;

  try {
    await openLams(page, config);
    await selectWorkspaceCourse(page, config);
    activePage = await openAuthoring(page, config);
    await openLessonFromLibrary(activePage, config.destinationFolderPath, config.lessonTitle, config);

    const editor = new LamsIratEditor(
      activePage,
      irat,
      config.browser.actionTimeoutMs,
      questionImages,
      checkpoint
        ? { onIratSaved: () => checkpoint.markIratSaved(), onTratSynced: () => checkpoint.complete() }
        : {}
    );
    const recoverAfterIratSave = resumeTratSync || checkpoint?.snapshot.iratSaved === true;
    if (recoverAfterIratSave || repairQuestionTitle) {
      const observed = await editor.inspect();
      const expectedTitles = irat.questions.map(question => question.title);
      const observedTitles = observed.questions.map(question => question.title);
      if (
        JSON.stringify(observedTitles) !== JSON.stringify(expectedTitles) ||
        observed.questions.some(question => question.type !== 'multiple-choice')
      ) {
        throw new Error(`Cannot run targeted iRAT recovery: saved iRAT inventory is ${JSON.stringify(observedTitles)}.`);
      }
      verifySavedRequiredFlags(observed.questions, irat.questions);
      if (!observed.teamSetupAssociated) throw new Error('Cannot resume tRAT sync: iRAT is not associated with Team Setup.');
      if (
        observed.gate.type !== irat.gate.type ||
        observed.gate.description !== irat.gate.description ||
        observed.gate.dynamicPassword !== irat.gate.dynamicPassword ||
        observed.gate.rotationSeconds !== irat.gate.rotationSeconds
      ) {
        throw new Error('Cannot run targeted iRAT recovery: the saved iRAT Gate does not match the request.');
      }
      if (repairQuestionTitle) {
        const targets = irat.questions.filter(question => question.title === repairQuestionTitle);
        if (targets.length !== 1) {
          throw new Error(`--repair-question must name one requested question; found ${targets.length} matches for "${repairQuestionTitle}".`);
        }
        const reusedVersion = await editor.selectImmediateNewerQuestionVersion(repairQuestionTitle);
        if (!reusedVersion) await editor.updateQuestion(targets[0]!);
        await editor.applyAnswerRequired(irat.questions);
        await editor.verifyPrintView(irat);
        await editor.save();
        console.log('\niRAT targeted recovery: COMPLETE');
        console.log(`Lesson: ${config.lessonTitle}`);
        console.log(`Question recovery version: ${repairQuestionTitle} — ${reusedVersion ?? 'new version created'}`);
        console.log(`Save prompts confirmed (${editor.confirmedDialogs.length}): ${editor.confirmedDialogs.join(' | ') || 'none raised'}`);
        console.log('Verified: complete iRAT Print View, synced tRAT questions/versions, tRAT confidence/default settings, and post-save state.');
        return;
      }
      await editor.verifyPrintView(irat);
      await editor.resumeTratSyncAndVerify();
      console.log('\niRAT recovery: COMPLETE');
      console.log(`Lesson: ${config.lessonTitle}`);
      console.log(`Folder: ${config.destinationFolderPath.join(' > ')}`);
      console.log('Questions updated during recovery: none (saved iRAT inventory was reused).');
      console.log('Verified: saved iRAT inventory/required flags/gate/Print View, synced tRAT questions and versions, tRAT confidence/default settings, and post-save state.');
      return;
    }
    const result = await executeIratAutomation(editor, irat, {
      commit,
      questionHash: hashIratQuestion,
      ...(checkpoint
        ? {
            resumeQuestions: checkpoint.snapshot.questions,
            onQuestionSaved: async (question: typeof irat.questions[number], reference: { currentUid: string; currentLabel: string }) =>
              checkpoint.recordQuestion(question, reference.currentUid, reference.currentLabel)
          }
        : {})
    });

    if (!commit) {
      console.log('iRAT preflight passed; no changes applied.');
      return;
    }
    console.log('\niRAT application: COMPLETE');
    console.log(`Lesson: ${config.lessonTitle}`);
    console.log(`Folder: ${config.destinationFolderPath.join(' > ')}`);
    console.log(`Questions deleted (${result.deletedQuestions.length}): ${result.deletedQuestions.join(', ')}`);
    console.log(`Questions updated (${result.updatedQuestions.length}): ${result.updatedQuestions.join(', ')}`);
    console.log(`Questions created (${result.createdQuestions.length}): ${result.createdQuestions.join(', ')}`);
    console.log(`Questions reused from checkpoint (${result.resumedQuestions.length}): ${result.resumedQuestions.join(', ')}`);
    console.log(`Question images imported: ${[...questionImages.values()].reduce((sum, images) => sum + images.length, 0)}`);
    console.log(`Save prompts confirmed (${editor.confirmedDialogs.length}): ${editor.confirmedDialogs.join(' | ') || 'none raised'}`);
    console.log('Verified: configured course, exact lesson, iRAT/tRAT graph readiness, Print View, synced tRAT questions, tRAT confidence/default settings, and post-save gate state.');
  } catch (error) {
    const directory = await saveDiagnostics(activePage, 'apply-irat-failure').catch(() => undefined);
    if (directory) console.error(`iRAT diagnostics: ${directory}`);
    // With --keep-open the rethrow is not printed until the window closes; surface it now.
    if (keepOpen) console.error(error instanceof Error ? error.stack ?? error.message : error);
    throw error;
  } finally {
    if (keepOpen) {
      console.log('\nBrowser left open for manual verification. Close the window to end the run.');
      await new Promise<void>((resolve) => context.on('close', () => resolve()));
    } else {
      await context.close();
    }
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
