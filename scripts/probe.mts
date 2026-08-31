/**
 * Selector discovery probe.
 *
 * Launches the dedicated Playwright profile at the LAMS login page and then writes a
 * snapshot of whatever page is in focus to artifacts/probe/ every few seconds, so real
 * selectors can be read off the live DOM while a human drives the browser by hand.
 *
 * Read-only: it never clicks, types, or submits anything.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';

const BASE_URL = process.argv[2] ?? 'https://ilams.lamsinternational.com/lams/index.do';
const OUT_DIR = path.resolve('artifacts', 'probe');
const INTERVAL_MS = 4_000;

// Passed to page.evaluate as a string: tsx compiles inline functions with a `__name`
// helper that does not exist in the page realm, which makes them throw on evaluation.
const SNAPSHOT_SCRIPT = `(() => {
  function text(element) {
    return (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
  }
  function visible(element) {
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function describe(element) {
    var tag = element.tagName.toLowerCase();
    var id = element.id ? '#' + element.id : '';
    var cls = (element.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 4).join('.');
    var name = element.getAttribute('name');
    var type = element.getAttribute('type');
    var role = element.getAttribute('role');
    var aria = element.getAttribute('aria-label');
    return [
      tag + id + (cls ? '.' + cls : ''),
      name ? 'name=' + name : '',
      type ? 'type=' + type : '',
      role ? 'role=' + role : '',
      aria ? 'aria-label=' + aria : '',
      type === 'checkbox' || type === 'radio' ? 'checked=' + element.checked : '',
      element.value ? 'value=' + String(element.value).slice(0, 60) : '',
      'text="' + text(element) + '"'
    ].filter(Boolean).join(' | ');
  }
  var controls = Array.prototype.slice
    .call(document.querySelectorAll('a, button, input, select, textarea, [role="tab"], [role="radio"], [role="checkbox"], li'))
    .filter(visible)
    .map(describe);
  var headings = Array.prototype.slice
    .call(document.querySelectorAll('h1, h2, h3, legend, label'))
    .filter(visible)
    .map(text);
  return {
    url: location.href,
    title: document.title,
    headings: headings.slice(0, 80),
    controls: controls.slice(0, 250)
  };
})()`;

interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  controls: string[];
}

async function snapshot(page: Page, index: number): Promise<void> {
  const summary = (await page.evaluate(SNAPSHOT_SCRIPT)) as Snapshot;

  const lines = [
    `# snapshot ${index}  ${new Date().toISOString()}`,
    `URL: ${summary.url}`,
    `TITLE: ${summary.title}`,
    '',
    '## headings / labels',
    ...summary.headings,
    '',
    '## visible controls',
    ...summary.controls
  ];
  await writeFile(path.join(OUT_DIR, 'latest.txt'), lines.join('\n'), 'utf8');
  await writeFile(path.join(OUT_DIR, 'latest.html'), await page.content(), 'utf8');
  await page.screenshot({ path: path.join(OUT_DIR, 'latest.png'), fullPage: false }).catch(() => undefined);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(path.resolve('.playwright/lams-profile'), {
    headless: false,
    viewport: null
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  console.log('Probe running. Log in and navigate by hand; snapshots go to artifacts/probe/.');
  for (let index = 1; ; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    if (pages.length === 0) break;
    const active = pages[pages.length - 1]!;
    await snapshot(active, index).catch((error: unknown) => {
      console.error(`snapshot ${index} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    console.log(`snapshot ${index}: ${active.url()}`);
  }
  await context.close();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
