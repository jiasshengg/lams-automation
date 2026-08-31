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

test('rejects a local configuration outside the approved playground', async () => {
  await expect(
    loadConfig('configs/example.json', { workspaceCourse: 'Another course' })
  ).rejects.toThrow('must be exactly "DL Playground 2026/2027 [internal]"');
});

test('accepts an explicit request to create only the missing final destination folder', () => {
  const overrides = parseRequestOverrides(
    JSON.stringify({
      destinationFolderPath: ['Courses', 'DL Playground 2026/2027 [internal]', '![Nathanael]'],
      createDestinationFolder: true
    })
  );

  expect(overrides.createDestinationFolder).toBe(true);
});

test('accepts explicit read-only source copy and destination rename controls', () => {
  const overrides = parseRequestOverrides(
    JSON.stringify({
      openSourceAsCopy: true,
      renameDestinationFolderFrom: '![Nathanael]',
      destinationFolderPath: [
        'Courses',
        'DL Playground 2026/2027 [internal]',
        '[Nathanael] MOCK FOM TBL01 AE TEST'
      ]
    })
  );

  expect(overrides.openSourceAsCopy).toBe(true);
  expect(overrides.renameDestinationFolderFrom).toBe('![Nathanael]');
});

test('accepts changing iRAT content as a per-run request', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  const irat = {
    ...base.irat,
    questions: [
      {
        ...base.irat.questions[0],
        title: 'Question 1',
        content: 'Current Source-of-Truth content',
        answers: [
          { text: 'A', correct: true, weight: 60 },
          { text: 'B', correct: true, weight: 40 },
          { text: 'C', correct: false, weight: 0 }
        ]
      }
    ]
  };
  const config = await loadConfig('configs/example.json', parseRequestOverrides(JSON.stringify({ irat })));
  expect(config.irat?.questions[0]?.title).toBe('Question 1');
  expect(config.irat?.questions[0]?.answers.filter((answer) => answer.correct).map((answer) => answer.weight)).toEqual([60, 40]);
});

test('rejects iRAT correct-answer weights that do not total 100', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  base.irat.questions[0].answers[0].weight = 80;
  await expect(loadConfig('configs/example.json', { irat: base.irat })).rejects.toThrow('Correct answer weights must total 100');
});
