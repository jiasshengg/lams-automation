import type { Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';

/** Lesson rows on the course page, verified against the live LAMS index markup. */
const LESSON_ROW = 'div.j-single-lesson[data-name]';

export interface MonitoringResult {
  lessonId: string;
  lessonTitle: string;
  monitoringUrl: string;
}

/**
 * On the course page each lesson row carries its Monitor control as
 * `href="javascript:openMonitorLesson(40589)"`, and that argument is the lesson ID.
 * Reading it from the href is deterministic; the buttons themselves only render on
 * row hover, so clicking is both slower and flakier.
 */
export function extractLessonIdFromMonitorHref(href: string): string {
  const match = /openMonitorLesson\(\s*(\d+)\s*[,)]/.exec(href);
  if (!match) throw new Error(`Not a Monitor link: ${href}`);
  return match[1]!;
}

/**
 * LAMS also exposes the ID in the monitoring URL itself, as a lessonID query parameter
 * or a trailing path segment, which is what the browser shows once monitoring is open.
 */
export function extractLessonId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Cannot extract a lesson ID from a malformed URL: ${url}`);
  }

  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() !== 'lessonid') continue;
    if (/^\d+$/.test(value)) return value;
    throw new Error(`Monitoring URL carries a non-numeric lessonID "${value}": ${url}`);
  }

  const fromHash = /[?&]lessonID=(\d+)/i.exec(parsed.hash);
  if (fromHash) return fromHash[1]!;

  const trailingSegment = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
  if (/^\d+$/.test(trailingSegment)) return trailingSegment;

  throw new Error(`No lessonID found in monitoring URL: ${url}`);
}

/**
 * Finds the lesson ID for an exact lesson title on the current course page.
 *
 * Each lesson row is `div.j-single-lesson` carrying the exact title in `data-name` and
 * the lesson ID as its element `id`. Matching on the attribute rather than rendered text
 * means rows below the fold or outside the current page size still resolve.
 */
export async function findLessonId(page: Page, lessonTitle: string, config: LamsConfig): Promise<string> {
  const rows = page.locator(LESSON_ROW);
  await rows.first().waitFor({ state: 'attached', timeout: config.browser.actionTimeoutMs }).catch(() => undefined);

  const matches: string[] = [];
  const titles: string[] = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    const row = rows.nth(index);
    const name = normalise((await row.getAttribute('data-name')) ?? '');
    titles.push(name);
    if (name !== lessonTitle) continue;

    const id = (await row.getAttribute('id')) ?? '';
    if (/^\d+$/.test(id)) {
      matches.push(id);
      continue;
    }
    // Fall back to the Monitor control, which carries the same id in its href.
    const href = await row.locator('a[aria-label="Monitor"]').first().getAttribute('href');
    if (href) matches.push(extractLessonIdFromMonitorHref(href));
  }

  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    throw new Error(
      `No lesson titled "${lessonTitle}" on this page. Found ${titles.length} lessons` +
        (titles.length > 0 ? `, for example: ${titles.slice(0, 5).join(', ')}.` : '.')
    );
  }
  if (unique.length > 1) {
    throw new Error(`Found ${unique.length} lessons titled "${lessonTitle}" (IDs ${unique.join(', ')}); refusing to guess.`);
  }
  return unique[0]!;
}

/**
 * Opens Monitor for a lesson and returns its ID. The Monitor control navigates the
 * current tab to /lams/home/monitorLesson.do?lessonID=..., so the ID is confirmed
 * against the resulting URL rather than trusted from the link alone.
 */
export async function openMonitoring(page: Page, lessonTitle: string, config: LamsConfig): Promise<MonitoringResult> {
  const lessonId = await findLessonId(page, lessonTitle, config);

  await page.goto(new URL(`/lams/home/monitorLesson.do?lessonID=${lessonId}`, config.baseUrl).toString(), {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle').catch(() => undefined);

  const monitoringUrl = page.url();
  const confirmed = extractLessonId(monitoringUrl);
  if (confirmed !== lessonId) {
    throw new Error(`Monitoring opened lesson ${confirmed} but "${lessonTitle}" is lesson ${lessonId}.`);
  }

  console.log(`Monitoring URL: ${monitoringUrl}`);
  console.log(`Lesson ID: ${lessonId}`);
  return { lessonId, lessonTitle, monitoringUrl };
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
