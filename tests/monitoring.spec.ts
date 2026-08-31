import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { extractLessonId, extractLessonIdFromMonitorHref, findLessonId } from '../src/lams/monitoring.js';

/** Mirrors the live course-page rows: the Monitor control carries the lesson id in its href. */
const COURSE_PAGE = `
  <div class="list-group">
    <div id="40589" role="listitem" class="j-single-lesson list-group-item" data-name="DHPM TBL1.4 030425 2024Y1">
      <a class="sequence-name-link" href="javascript:openLearner(40589)">DHPM TBL1.4 030425 2024Y1</a>
      <a aria-label="Monitor" href="javascript:openMonitorLesson(40589)">Monitor</a>
    </div>
    <div id="41276" role="listitem" class="j-single-lesson list-group-item" data-name="FOM TBL06 030926 2026Y1">
      <a class="sequence-name-link" href="javascript:openLearner(41276)">FOM TBL06 030926 2026Y1</a>
      <a aria-label="Monitor" href="javascript:openMonitorLesson(41276)">Monitor</a>
    </div>
  </div>
`;

const config = { browser: { actionTimeoutMs: 3_000 } } as LamsConfig;

test('extracts the lesson id from a Monitor link href', () => {
  expect(extractLessonIdFromMonitorHref('javascript:openMonitorLesson(40589)')).toBe('40589');
  expect(extractLessonIdFromMonitorHref('javascript:openMonitorLesson( 41276 , url)')).toBe('41276');
  expect(() => extractLessonIdFromMonitorHref('javascript:somethingElse(1)')).toThrow(/Not a Monitor link/);
});

test('extracts the lesson id from a lessonID query parameter', () => {
  expect(
    extractLessonId('https://ilams.lamsinternational.com/lams/monitoring/monitoring/monitorLesson.do?lessonID=40589')
  ).toBe('40589');
});

test('extracts the lesson id from a hash fragment', () => {
  expect(extractLessonId('https://ilams.lamsinternational.com/lams/monitoring.do#/?lessonID=41276')).toBe('41276');
});

test('extracts the lesson id from a trailing path segment', () => {
  expect(extractLessonId('https://ilams.lamsinternational.com/lams/monitoring/41276')).toBe('41276');
});

test('rejects a URL with no lesson id', () => {
  expect(() => extractLessonId('https://ilams.lamsinternational.com/lams/index.do')).toThrow(/No lessonID found/);
});

test('rejects a non-numeric lessonID rather than returning it', () => {
  expect(() => extractLessonId('https://example.test/monitoring.do?lessonID=abc')).toThrow(/non-numeric lessonID/);
});

test('finds the lesson id for an exact lesson title', async ({ page }) => {
  await page.setContent(COURSE_PAGE);

  expect(await findLessonId(page, 'FOM TBL06 030926 2026Y1', config)).toBe('41276');
  expect(await findLessonId(page, 'DHPM TBL1.4 030425 2024Y1', config)).toBe('40589');
});

test('refuses a title that matches no lesson on the page', async ({ page }) => {
  await page.setContent(COURSE_PAGE);

  await expect(findLessonId(page, 'NOT A REAL LESSON', config)).rejects.toThrow(/No lesson titled/);
});

test('falls back to the Monitor href when the row id is not numeric', async ({ page }) => {
  await page.setContent(`
    <div class="j-single-lesson" id="lesson-row-a" data-name="ODD ROW ID">
      <a aria-label="Monitor" href="javascript:openMonitorLesson(33333)">Monitor</a>
    </div>
  `);

  expect(await findLessonId(page, 'ODD ROW ID', config)).toBe('33333');
});

test('refuses to guess when two lessons share a title', async ({ page }) => {
  await page.setContent(`
    <div class="list-group">
      <div id="11111" class="j-single-lesson" data-name="DUPLICATE TITLE">
        <a aria-label="Monitor" href="javascript:openMonitorLesson(11111)">Monitor</a>
      </div>
      <div id="22222" class="j-single-lesson" data-name="DUPLICATE TITLE">
        <a aria-label="Monitor" href="javascript:openMonitorLesson(22222)">Monitor</a>
      </div>
    </div>
  `);

  await expect(findLessonId(page, 'DUPLICATE TITLE', config)).rejects.toThrow(/refusing to guess/);
});
