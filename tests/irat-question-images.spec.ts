import { expect, test } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IratRequest } from '../src/config.js';
import { resolveIratQuestionImages } from '../src/docx/question-images.js';
import { drawing, mediaDocx, paragraph } from './helpers/docx-media.js';

const advanced = {
  shuffleQuestions: true, shuffleAnswers: true, questionsNumbering: true,
  displayAllQuestions: true, displayAllAfterCompletion: true, answerJustification: true, confidenceLevels: true
};

function baseRequest(sourceDocx: string, titles: string[]): IratRequest {
  return {
    sourceDocx,
    activityName: 'iRAT',
    teamSetupName: 'Team Setup',
    gate: { name: 'iRAT Gate', description: 'iRAT Gate', type: 'password', dynamicPassword: true, rotationSeconds: 10 },
    advanced,
    questions: titles.map((title, index) => ({
      title, type: 'multiple-choice', marks: 1, mandatory: true,
      content: title, sourceQuestionNumber: 19 + index,
      answers: [{ text: 'A', correct: true, weight: 100 }]
    }))
  };
}

async function withDocx(paragraphs: string, run: (sourceDocx: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-irat-images-'));
  try {
    const sourceDocx = path.join(directory, 'source.docx');
    await writeFile(sourceDocx, mediaDocx(paragraphs));
    await run(sourceDocx);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('a figure shared between adjacent questions is automatically duplicated onto both', async () => {
  await withDocx(
    paragraph('19. In the image below, which letter indicates a sulcus?') +
    paragraph('A. C') +
    paragraph('', drawing) +
    paragraph('20. In the brain above, which letter indicates the diencephalon?'),
    async (sourceDocx) => {
      const request = baseRequest(sourceDocx, ['Question 19', 'Question 20']);
      const images = await resolveIratQuestionImages(request);
      expect(images.get('Question 19')).toHaveLength(1);
      expect(images.get('Question 19')?.[0]).toMatchObject({ placement: 'after' });
      // Automatically reproduced on the next question too, ahead of its own content,
      // without the request needing to list the image a second time.
      expect(images.get('Question 20')).toHaveLength(1);
      expect(images.get('Question 20')?.[0]).toMatchObject({ placement: 'before' });
      expect(images.get('Question 19')?.[0]?.data.equals(images.get('Question 20')?.[0]?.data as Buffer)).toBe(true);
    }
  );
});

test('an unshared figure is not duplicated onto the following question', async () => {
  await withDocx(
    paragraph('19. Stem with its own figure.') +
    paragraph('', drawing) +
    paragraph('A. Option') +
    paragraph('20. A later, unrelated question.'),
    async (sourceDocx) => {
      const request = baseRequest(sourceDocx, ['Question 19', 'Question 20']);
      const images = await resolveIratQuestionImages(request);
      expect(images.get('Question 19')).toHaveLength(1);
      expect(images.get('Question 20')).toHaveLength(0);
    }
  );
});
