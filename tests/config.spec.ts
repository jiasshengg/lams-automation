import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LamsConfig } from '../src/config.js';
import { browserLaunchOptions, DEFAULT_LAMS_BASE_URL, interpolate, loadConfig, parseRequestOverrides } from '../src/config.js';

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

test('uses the shared iLAMS URL when baseUrl is omitted', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-config-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const example = JSON.parse(await readFile('configs/example.json', 'utf8')) as Record<string, unknown>;
    delete example.baseUrl;
    await writeFile(configPath, JSON.stringify(example), 'utf8');

    await expect(loadConfig(configPath)).resolves.toMatchObject({ baseUrl: DEFAULT_LAMS_BASE_URL });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects attempts to override stable environment fields per run', () => {
  expect(() => parseRequestOverrides(JSON.stringify({ baseUrl: 'https://example.invalid' }))).toThrow(
    'cannot override stable environment fields'
  );
});

test('accepts a different workspace course for each run', async () => {
  await expect(
    loadConfig('configs/example.json', parseRequestOverrides(JSON.stringify({ workspaceCourse: 'Another course' })))
  ).resolves.toMatchObject({ workspaceCourse: 'Another course' });
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

test('applies the deployment-guide iRAT advanced toggles and rejects non-boolean values', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  expect(base.irat.advanced.shuffleQuestions).toBe(true);
  expect(base.irat.advanced.questionsNumbering).toBe(true);

  const missing = { ...base.irat, advanced: { ...base.irat.advanced } };
  delete missing.advanced.shuffleQuestions;
  const defaulted = await loadConfig('configs/example.json', { irat: missing });
  expect(defaulted.irat?.advanced.shuffleQuestions).toBe(true);

  const invalid = { ...base.irat, advanced: { ...base.irat.advanced, shuffleQuestions: 'yes' } };
  await expect(loadConfig('configs/example.json', { irat: invalid })).rejects.toThrow(
    'irat.advanced.shuffleQuestions must be a boolean.'
  );
});

test('defaults iRAT question marks to 1 and rejects a non-positive mark', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  const config = await loadConfig('configs/example.json', { irat: base.irat });
  expect(config.irat?.questions[0]?.marks).toBe(1);

  const bad = { ...base.irat, questions: [{ ...base.irat.questions[0], marks: 0 }] };
  await expect(loadConfig('configs/example.json', { irat: bad })).rejects.toThrow(
    'irat.questions[0].marks must be a positive integer.'
  );
});

test('copy defaults to the source folder rather than the local destination', async () => {
  const config = await loadConfig('configs/example.json', {
    sourceFolderPath: ['Courses', 'Current source'], lessonTitle: 'New copy'
  }, { defaultDestinationToSource: true });
  expect(config.destinationFolderPath).toEqual(['Courses', 'Current source']);
  expect(config.destinationFolder).toBe('Courses/Current source');
  expect(config.destinationFolderPath).not.toBe(config.sourceFolderPath);
});

test('copy honors an explicit destination and keeps its report consistent', async () => {
  const config = await loadConfig('configs/example.json', {
    destinationFolderPath: ['Courses', 'Requested destination']
  }, { defaultDestinationToSource: true });
  expect(config.destinationFolderPath).toEqual(['Courses', 'Requested destination']);
  expect(config.destinationFolder).toBe('Courses/Requested destination');
});

test('same-folder default works with the configured source and preserves existing edit targets', async () => {
  const existing = await loadConfig('configs/example.json');
  const copy = await loadConfig('configs/example.json', {}, { defaultDestinationToSource: true });
  expect(copy.destinationFolderPath).toEqual(existing.sourceFolderPath);
  const edit = await loadConfig('configs/example.json', { sourceFolderPath: ['Different source'] });
  expect(edit.destinationFolderPath).toEqual(existing.destinationFolderPath);
});

test('copy does not interpret a missing folder-operation target as the source', async () => {
  await expect(loadConfig('configs/example.json', { createDestinationFolder: true }, { defaultDestinationToSource: true }))
    .rejects.toThrow('requires an explicit destinationFolderPath');
  await expect(loadConfig('configs/example.json', { destinationFolderPath: [] }, { defaultDestinationToSource: true }))
    .rejects.toThrow(/destinationFolder/);
});

test('drives an installed system browser only when browser.channel is configured', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-config-channel-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const example = JSON.parse(await readFile('configs/example.json', 'utf8')) as { browser: Record<string, unknown> };
    const bundled = await loadConfig('configs/example.json');
    expect(bundled.browser.channel).toBeUndefined();
    expect(browserLaunchOptions(bundled)).toEqual({ headless: false, viewport: null });

    example.browser.channel = 'chrome';
    await writeFile(configPath, JSON.stringify(example), 'utf8');
    const system = await loadConfig(configPath);
    expect(system.browser.channel).toBe('chrome');
    expect(browserLaunchOptions(system)).toEqual({ headless: false, viewport: null, channel: 'chrome' });
    expect(browserLaunchOptions(system, { headless: true }).headless).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('derives "Question N" iRAT titles from the source question number when omitted', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  const { title: _ignored, ...question } = base.irat.questions[0];
  const irat = {
    ...base.irat,
    questions: [
      { ...question, sourceQuestionNumber: undefined, content: 'First' },
      { ...question, sourceQuestionNumber: 7, content: 'Seventh' },
      { ...question, sourceQuestionNumber: undefined, title: 'Custom title', content: 'Custom' }
    ]
  };
  const config = await loadConfig('configs/example.json', parseRequestOverrides(JSON.stringify({ irat })));
  expect(config.irat?.questions.map((entry) => entry.title)).toEqual(['Question 1', 'Question 7', 'Custom title']);
});

test('ignores legacy iRAT font fields so older requests still load with default formatting', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  const irat = { ...base.irat, questions: [{ ...base.irat.questions[0], fontFamily: 'Arial', fontSize: 12 }] };
  const config = await loadConfig('configs/example.json', parseRequestOverrides(JSON.stringify({ irat })));
  expect(config.irat?.questions[0]?.title).toBe('Question 1');
});

test('iRAT advanced toggles default to the deployment guide values when omitted', async () => {
  const base = JSON.parse(await (await import('node:fs/promises')).readFile('configs/example.json', 'utf8'));
  const irat = { ...base.irat, advanced: { shuffleAnswers: false } };
  const config = await loadConfig('configs/example.json', parseRequestOverrides(JSON.stringify({ irat })));
  expect(config.irat?.advanced).toEqual({
    shuffleQuestions: true, shuffleAnswers: false, questionsNumbering: true, displayAllQuestions: true,
    displayAllAfterCompletion: true, answerJustification: true, confidenceLevels: true
  });
  const missing = { ...base.irat };
  delete missing.advanced;
  const defaults = await loadConfig('configs/example.json', parseRequestOverrides(JSON.stringify({ irat: missing })));
  expect(defaults.irat?.advanced.displayAllAfterCompletion).toBe(true);
});
