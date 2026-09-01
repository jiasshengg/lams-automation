import path from 'node:path';
import { chromium } from '@playwright/test';
import { loadConfig } from './config.js';
import { findLessonId } from './lams/monitoring.js';
import { openLams, verifyWorkspaceCourse } from './lams/navigation.js';

/**
 * Opens LAMS in the persistent profile and prints every URL the browser visits, in any
 * tab, highlighting 5-digit runs. Interactive and read-only: it drives nothing, it only
 * watches, so the exact shape of the code-bearing URL can be observed once.
 */
async function main(): Promise<void> {
  const configPath = readArgument('--config') ?? 'configs/local.json';
  const config = await loadConfig(configPath);
  const context = await chromium.launchPersistentContext(path.resolve(config.browser.userDataDir), {
    headless: false,
    viewport: null
  });

  const seen = new Set<string>();
  const report = (url: string, label: string) => {
    if (!url || url === 'about:blank' || seen.has(url)) return;
    seen.add(url);
    const digits = [...url.matchAll(/\d{5}/g)].map((match) => match[0]);
    console.log(`[${label}] ${url}${digits.length > 0 ? `   <-- 5-digit runs: ${digits.join(', ')}` : ''}`);
  };

  const watch = (page: import('@playwright/test').Page, index: number) => {
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) report(frame.url(), `tab ${index}`);
    });
    report(page.url(), `tab ${index}`);
  };

  context.pages().forEach((page, index) => watch(page, index));
  context.on('page', (page) => watch(page, context.pages().length - 1));

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  // --monitor drives to the monitoring page for the configured lesson. If that exact
  // title is not on the course page the lessons that are there get listed instead, and
  // the browser is left open to click through manually rather than opening a guess.
  if (process.argv.includes('--monitor')) {
    try {
      await verifyWorkspaceCourse(page, config);
      // --lesson opens a lesson other than the configured one, for observing a page
      // shape on whatever lessons the course actually has today.
      const title = readArgument('--lesson') ?? config.lessonTitle;
      const lessonId = await findLessonId(page, title, config);
      const url = new URL(`/lams/home/monitorLesson.do?lessonID=${lessonId}`, config.baseUrl).toString();
      console.log(`Opening monitoring for "${title}" (lesson ${lessonId}).`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      console.warn(`Could not open monitoring automatically: ${error instanceof Error ? error.message : String(error)}`);
      const names = await page
        .locator('div.j-single-lesson[data-name]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-name') ?? ''))
        .catch(() => [] as string[]);
      if (names.length > 0) console.warn(`Lessons on this page:${names.map((name) => `\n  - ${name}`).join('')}`);
      console.warn('Navigate to monitoring by hand; URLs are still being watched.');
    }
  }

  console.log('\nBrowser is open. Sign in if needed, then navigate to wherever the 5-digit code appears.');
  console.log('Every URL is printed here. Close the browser window when done.\n');

  await new Promise<void>((resolve) => context.on('close', () => resolve()));
}

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
