import type { Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';
import { sendCodeToSheet } from '../sheets/code-sink.js';
import { createLessonFromMostRecentDesign, openAddLesson, resolveLessonIndexSettings, type LessonIndexResult } from './lesson-index.js';
import { openMonitoring } from './monitoring.js';
import { openCoursePage } from './navigation.js';

export interface PublishOptions {
  commit: boolean;
  /** Refuse to publish unless the top "Recently used designs" entry is this title. */
  expectedDesignTitle?: string;
  /** Record the 5-digit code in the Kanban sheet once it is known. */
  publishCode: boolean;
  /** Demand that the sheet be configured instead of reporting the code for manual entry. */
  forceCode: boolean;
}

export interface PublishResult {
  lesson: LessonIndexResult;
  lessonId?: string;
}

/**
 * The publishing stage: creates the learner-facing lesson from the most recent design and
 * records its 5-digit code. It needs the user's lessonIndex.endDate, so it can only run when the
 * user has supplied one for this lesson. Shared by `lesson:index` and `run:tbl --publish`, which
 * runs it in the authoring browser instead of launching another.
 */
export async function publishLesson(page: Page, config: LamsConfig, options: PublishOptions): Promise<PublishResult> {
  await openCoursePage(page, config);
  await openAddLesson(page, config);
  const lesson = await createLessonFromMostRecentDesign(page, config, {
    commit: options.commit,
    ...(options.expectedDesignTitle !== undefined ? { expectedDesignTitle: options.expectedDesignTitle } : {})
  });
  console.log(`\nIndex workflow: ${lesson.committed ? 'LESSON CREATED' : 'DRY RUN PASS'}`);
  console.log(`Design: ${lesson.designTitle}`);
  console.log(`Lesson title: ${lesson.lessonTitle}`);
  console.log(`Ends: ${lesson.endDateTime}`);
  console.log(`Course grouping: ${lesson.courseGrouping}`);
  if (!lesson.committed) {
    console.log('\nSkipping monitoring: no lesson was created in this dry run. Re-run with --commit.');
    return { lesson };
  }

  // The Add Lesson wizard navigated away from the course page, so the course has to be
  // reselected before the lesson rows can be read; the base URL alone lands on whatever
  // course LAMS treats as current.
  await openCoursePage(page, config);
  const monitoring = await openMonitoring(page, lesson.lessonTitle, config);
  console.log('\nMonitoring workflow: OK');
  console.log(`Lesson ID (the 5-digit code): ${monitoring.lessonId}`);
  await reportLessonCode(lesson.lessonTitle, monitoring.lessonId, options, config);
  return { lesson, lessonId: monitoring.lessonId };
}

/** Fails before any browser work when publishing was requested without the user's end date. */
export function requirePublishSettings(config: LamsConfig): void {
  const settings = resolveLessonIndexSettings(config);
  if (!settings.endDate) {
    throw new Error('Publishing needs lessonIndex.endDate (YYYY-MM-DD) from the user in --request-json.');
  }
}

/**
 * The 5-digit code the Kanban sheet wants is the lesson ID from the monitoring URL
 * (monitorLesson.do?lessonID=41192), which openMonitoring has already read and confirmed
 * against the URL the browser actually landed on.
 *
 * Recording it completes the publishing stage, so it is sent by default. A machine with no
 * sheet credentials simply reports the code for manual entry rather than failing a run whose
 * LAMS-side work already succeeded, unless --publish-code asked for the send explicitly.
 */
export async function reportLessonCode(
  identifier: string,
  code: string,
  options: Pick<PublishOptions, 'publishCode' | 'forceCode'>,
  config: LamsConfig
): Promise<void> {
  if (!options.publishCode) {
    console.log('Kanban sheet not updated: --no-publish-code was passed. Record this code manually.');
    return;
  }
  if (!options.forceCode && !sheetConfigured(config)) {
    console.log('Kanban sheet not configured (add a "sheet" block to configs/local.json); record this code manually.');
    return;
  }

  // The lesson exists by this point, so a sheet that is unreachable or rejects the
  // identifier is reported rather than allowed to fail the whole run.
  try {
    await sendCodeToSheet(code, identifier, sinkOptions(config));
    console.log(`Sent code ${code} for "${identifier}" to the Kanban sheet.`);
  } catch (error) {
    console.error(`Kanban sheet not updated: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

/**
 * The endpoint may come from the ignored `configs/local.json` or from the environment. The
 * environment wins, so an exported variable or a CI secret can override the file without
 * editing it, and an existing .env keeps working exactly as before.
 */
function sinkOptions(config: LamsConfig): { url?: string; secret?: string } {
  const url = process.env.LAMS_SHEET_WEBHOOK_URL || config.sheet?.webhookUrl;
  const secret = process.env.LAMS_SHEET_SECRET || config.sheet?.secret;
  return { ...(url ? { url } : {}), ...(secret ? { secret } : {}) };
}

function sheetConfigured(config: LamsConfig): boolean {
  const { url, secret } = sinkOptions(config);
  return Boolean(url && secret);
}
