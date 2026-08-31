import type { Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';
import { clickConfigured } from './navigation.js';

export interface MonitoringResult {
  lessonId: string;
  monitoringUrl: string;
}

/**
 * LAMS identifies a lesson by a numeric lessonID that appears in the monitoring URL,
 * either as a query parameter or as a trailing path segment. The downstream Kanban and
 * Elentra steps consume this value, so it is extracted rather than read off the screen.
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
 * Opens Monitor for the lesson currently in view and returns its lesson ID.
 * Monitoring may open in a popup, so both the popup and the current page are considered.
 */
export async function openMonitoring(page: Page, config: LamsConfig): Promise<MonitoringResult> {
  const popupPromise = page
    .waitForEvent('popup', { timeout: config.browser.actionTimeoutMs })
    .catch(() => undefined);
  await clickConfigured(page, config, 'openMonitoring', config.selectors.openMonitoring, false);

  const monitoringPage = (await popupPromise) ?? page;
  await monitoringPage.waitForLoadState('domcontentloaded').catch(() => undefined);
  // A popup reports about:blank until it commits its first navigation, so wait for a real
  // URL rather than reading the placeholder and failing to find a lesson ID in it.
  await monitoringPage
    .waitForURL((url) => url.protocol === 'http:' || url.protocol === 'https:', {
      timeout: config.browser.actionTimeoutMs
    })
    .catch(() => {
      throw new Error(`Monitoring never navigated away from ${monitoringPage.url()}.`);
    });

  const monitoringUrl = monitoringPage.url();
  const lessonId = extractLessonId(monitoringUrl);
  console.log(`Monitoring URL: ${monitoringUrl}`);
  console.log(`Lesson ID: ${lessonId}`);
  return { lessonId, monitoringUrl };
}
