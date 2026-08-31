import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { extractLessonId, openMonitoring } from '../src/lams/monitoring.js';

test('extracts the lesson ID from a lessonID query parameter', () => {
  expect(
    extractLessonId('https://ilams.lamsinternational.com/lams/monitoring/monitoring.do?method=getLessonDetails&lessonID=41276')
  ).toBe('41276');
});

test('extracts the lesson ID from a hash fragment', () => {
  expect(extractLessonId('https://ilams.lamsinternational.com/lams/monitoring.do#/?lessonID=41276')).toBe('41276');
});

test('extracts the lesson ID from a trailing path segment', () => {
  expect(extractLessonId('https://ilams.lamsinternational.com/lams/monitoring/41276')).toBe('41276');
});

test('rejects a URL with no lesson ID', () => {
  expect(() => extractLessonId('https://ilams.lamsinternational.com/lams/index.do')).toThrow(/No lessonID found/);
});

test('rejects a non-numeric lessonID rather than returning it', () => {
  expect(() => extractLessonId('https://example.test/monitoring.do?lessonID=abc')).toThrow(/non-numeric lessonID/);
});

test('opens monitoring in a popup and reports the lesson ID', async ({ page, context }) => {
  await context.route('**/monitoring.do*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Monitor</h1>' })
  );
  await page.setContent(`
    <a id="monitor" target="_blank" href="https://lams.test/lams/monitoring/monitoring.do?method=getLessonDetails&lessonID=41276">Monitor</a>
  `);

  const config = {
    browser: { actionTimeoutMs: 5_000 },
    selectors: { openMonitoring: { by: 'css', css: '#monitor' } }
  } as unknown as LamsConfig;

  const result = await openMonitoring(page, config);

  expect(result.lessonId).toBe('41276');
  expect(result.monitoringUrl).toContain('lessonID=41276');
});
