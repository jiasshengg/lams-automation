import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { IratRequest, LamsConfig } from '../src/config.js';
import { hashIratQuestion, IratCheckpointStore } from '../src/lams/irat-checkpoint.js';

const question = {
  title: 'Question 1',
  marks: 1,
  type: 'multiple-choice',
  content: 'Question content',
  mandatory: true,
  answers: [
    { text: 'Correct', correct: true, weight: 100 },
    { text: 'Incorrect', correct: false, weight: 0 }
  ]
};

const request: IratRequest = {
  gate: { name: 'iRAT Gate', description: 'iRAT Gate', type: 'password', dynamicPassword: true, rotationSeconds: 10 },
  activityName: 'iRAT',
  teamSetupName: 'Team Setup',
  questions: [question],
  advanced: {
    shuffleQuestions: true,
    shuffleAnswers: true,
    questionsNumbering: true,
    displayAllQuestions: true,
    displayAllAfterCompletion: true,
    answerJustification: true,
    confidenceLevels: true
  }
};

const config = {
  workspaceCourse: 'Course',
  destinationFolderPath: ['Courses', 'Folder'],
  lessonTitle: 'Lesson'
} as LamsConfig;

test('persists exact question version checkpoints and archives them on completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'irat-checkpoint-'));
  try {
    const store = await IratCheckpointStore.open(config, request, directory);
    await store.recordQuestion(question, '103', 'Version 3');
    const reopened = await IratCheckpointStore.open(config, request, directory);
    expect(reopened.snapshot.questions['Question 1']).toEqual({
      currentUid: '103',
      currentLabel: 'Version 3',
      requestHash: hashIratQuestion(question)
    });
    await reopened.markIratSaved();
    expect(reopened.snapshot.iratSaved).toBe(true);
    await reopened.complete();
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('-complete-');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('question hashes change when any requested question content changes', () => {
  expect(hashIratQuestion(question)).not.toBe(hashIratQuestion({ ...question, content: 'Changed' }));
});
