import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { interpolate, loadConfig, parseRequestOverrides } from '../src/config.js';

test('interpolates lesson-specific selector values from configuration', () => {
  const config = {
    previousCohort: 'Cohort_2025Y1',
    tbl: 'TBL06'
  } as LamsConfig;
  expect(interpolate('{{previousCohort}} / {{tbl}}', config)).toBe('Cohort_2025Y1 / TBL06');
});

test('applies per-run lesson values without editing the environment config', async () => {
  const overrides = parseRequestOverrides(
    JSON.stringify({
      sourceFolderPath: ['Courses', 'Previous cohort', 'FOM'],
      sourceLessonTitle: 'FOM TBL06 Previous',
      destinationFolderPath: ['Courses', 'Current cohort', 'FOM'],
      lessonTitle: 'FOM TBL06 Current'
    })
  );

  const config = await loadConfig('configs/example.json', overrides);
  expect(config.sourceLessonTitle).toBe('FOM TBL06 Previous');
  expect(config.lessonTitle).toBe('FOM TBL06 Current');
  expect(config.destinationFolder).toBe('Courses/Current cohort/FOM');
  expect(config.workspaceCourse).toBe('DL Playground 2026/2027 [internal]');
});

test('rejects attempts to override stable environment fields per run', () => {
  expect(() =>
    parseRequestOverrides(JSON.stringify({ workspaceCourse: 'Another course', baseUrl: 'https://example.invalid' }))
  ).toThrow('cannot override stable environment fields');
});
