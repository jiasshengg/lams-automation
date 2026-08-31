/**
 * Second discovery pass over Add Lesson: expands the recently-used-designs panel,
 * selects the most recent design, enables scheduling, and snapshots the fields that
 * only render once those are active.
 *
 * Stops before "Add now": no lesson is created.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';
import { writeSnapshot } from './snapshot.mts';

const BASE_URL = 'https://ilams.lamsinternational.com/lams/home/addLesson.do?organisationID=509';
const OUT_DIR = path.resolve('artifacts', 'explore2');

async function main(): Promise<void> {
  const context = await chromium.launchPersistentContext(path.resolve('.playwright/lams-profile'), {
    headless: false,
    viewport: null
  });
  context.setDefaultTimeout(20_000);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // The recently-used-designs panel starts collapsed behind a Show toggle.
    const toggle = page.locator('#recentToggleBtn');
    if ((await toggle.count()) > 0) {
      await toggle.click().catch(() => undefined);
      await page.waitForTimeout(1_500);
    }
    await writeSnapshot(page, OUT_DIR, '04-recent-expanded');

    // Dump the raw markup of the recent panel so its row structure is unambiguous.
    const recentHtml = await page.evaluate(`(() => {
      var panel = document.querySelector('#recentContainer, #recentDesigns, #recentList, [id*="recent" i]');
      return panel ? panel.outerHTML.slice(0, 6000) : 'NOT FOUND';
    })()`);
    console.log('--- RECENT PANEL HTML ---');
    console.log(recentHtml);

    await page.locator('#schedulingEnableField').check().catch(() => undefined);
    await page.waitForTimeout(1_500);
    await writeSnapshot(page, OUT_DIR, '05-scheduling-on');

    const schedulingHtml = await page.evaluate(`(() => {
      var inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
      return inputs
        .filter(function (i) { return /date|time|start|end|sched/i.test(i.id + ' ' + (i.name || '')); })
        .map(function (i) {
          return [i.id, i.name, i.type, i.readOnly ? 'readonly' : '', i.value, i.className].join(' | ');
        })
        .join('\\n');
    })()`);
    console.log('--- SCHEDULING INPUTS ---');
    console.log(schedulingHtml);

    const footerHtml = await page.evaluate(`(() => {
      return Array.prototype.slice.call(document.querySelectorAll('button'))
        .filter(function (b) { return b.offsetParent !== null; })
        .map(function (b) { return (b.id || '(no id)') + ' | ' + (b.textContent || '').trim(); })
        .join('\\n');
    })()`);
    console.log('--- VISIBLE BUTTONS ---');
    console.log(footerHtml);

    console.log(`Snapshots written to ${OUT_DIR}.`);
    await page.waitForTimeout(600_000);
  } finally {
    await context.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
