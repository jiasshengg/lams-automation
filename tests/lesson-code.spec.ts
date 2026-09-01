import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { collectLessonCodeCandidates, readLessonCode, selectLessonCode } from '../src/lams/lesson-code.js';

const config = { browser: { actionTimeoutMs: 2_000 } } as LamsConfig;

/** Mirrors the shape of monitoring: the lesson ID 41276 is five digits too. */
const MONITORING_PAGE = `
  <div class="lesson-header">
    <a href="javascript:openMonitorLesson(41276)">Monitor</a>
    <input type="hidden" name="lessonID" value="41276">
    <span class="lesson-id">41276</span>
  </div>
  <div class="join-panel">
    <label>Join code</label>
    <span id="lessonJoinCode">83914</span>
  </div>
`;

test('prefers a labelled code over an unlabelled lesson id', () => {
  const chosen = selectLessonCode([
    { code: '41276', context: 'Monitor lessonID=41276', source: 'input', labelled: false },
    { code: '83914', context: 'Join code 83914', source: 'span#lessonJoinCode', labelled: true }
  ]);
  expect(chosen.code).toBe('83914');
});

test('never promotes an unlabelled value, so a lesson id is not mistaken for a code', () => {
  expect(() =>
    selectLessonCode([{ code: '41276', context: 'lessonID=41276', source: 'input', labelled: false }])
  ).toThrow(/No labelled 5-digit lesson code/);
});

test('refuses to guess between two different labelled codes', () => {
  expect(() =>
    selectLessonCode([
      { code: '83914', context: 'Join code 83914', source: 'span', labelled: true },
      { code: '55501', context: 'Access code 55501', source: 'span', labelled: true }
    ])
  ).toThrow(/refusing to guess/);
});

test('excludes the known lesson id even when it is labelled', () => {
  expect(() =>
    selectLessonCode(
      [{ code: '41276', context: 'Lesson code 41276', source: 'span', labelled: true }],
      ['41276']
    )
  ).toThrow(/No labelled 5-digit lesson code/);
});

test('harvests candidates from live DOM text and attributes', async ({ page }) => {
  await page.setContent(MONITORING_PAGE);
  const candidates = await collectLessonCodeCandidates(page.mainFrame());

  const codes = candidates.filter((candidate) => candidate.labelled).map((candidate) => candidate.code);
  expect([...new Set(codes)]).toEqual(['83914']);
  expect(candidates.some((candidate) => candidate.code === '41276')).toBe(true);
});

test('reads the code from a monitoring page while ignoring the lesson id', async ({ page }) => {
  await page.setContent(MONITORING_PAGE);
  const result = await readLessonCode(page, config, ['41276']);
  expect(result.code).toBe('83914');
  expect(result.candidate.source).toContain('lessonJoinCode');
});
