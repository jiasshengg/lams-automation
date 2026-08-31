/**
 * Shared page-snapshot helper for selector discovery.
 *
 * The body is passed to page.evaluate as a string on purpose: tsx compiles inline
 * functions with a `__name` helper that does not exist in the page realm, so an inline
 * arrow function throws ReferenceError as soon as it is evaluated.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';

export const SNAPSHOT_SCRIPT = `(() => {
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
    .call(document.querySelectorAll('h1, h2, h3, h4, legend, label'))
    .filter(visible)
    .map(text);
  return {
    url: location.href,
    title: document.title,
    headings: headings.slice(0, 120),
    controls: controls.slice(0, 400)
  };
})()`;

export interface Snapshot {
  url: string;
  title: string;
  headings: string[];
  controls: string[];
}

export async function writeSnapshot(page: Page, outDir: string, label: string): Promise<Snapshot> {
  await mkdir(outDir, { recursive: true });
  const summary = (await page.evaluate(SNAPSHOT_SCRIPT)) as Snapshot;
  const lines = [
    `# ${label}  ${new Date().toISOString()}`,
    `URL: ${summary.url}`,
    `TITLE: ${summary.title}`,
    '',
    '## headings / labels',
    ...summary.headings,
    '',
    '## visible controls',
    ...summary.controls
  ];
  await writeFile(path.join(outDir, `${label}.txt`), lines.join('\n'), 'utf8');
  await writeFile(path.join(outDir, `${label}.html`), await page.content(), 'utf8');
  await page.screenshot({ path: path.join(outDir, `${label}.png`) }).catch(() => undefined);
  return summary;
}
