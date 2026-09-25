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

test('an explicit caption on an automatically-detected image is not lost to deduplication', async () => {
  await withDocx(
    paragraph('19. In the image below, which letter indicates a sulcus?') +
    paragraph('A. C') +
    paragraph('', drawing) +
    // Not "Figure/Table/…", no Caption style, no link: isCaption() cannot see this as a
    // caption, so automatic detection attaches the image to Question 19 with caption ''.
    paragraph('Medical gallery of Blausen Medical 2014') +
    paragraph('20. In the brain above, which letter indicates the diencephalon?'),
    async (sourceDocx) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-irat-images-explicit-'));
      try {
        const explicitPath = path.join(directory, 'same-figure.png');
        // Byte-for-byte the same PNG the drawing() helper embeds, so this collides with the
        // automatically-detected image under deduplicate()'s same-bytes key.
        await writeFile(
          explicitPath,
          Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
        );
        const request = baseRequest(sourceDocx, ['Question 19', 'Question 20']);
        request.questions[0]!.images = [
          { path: explicitPath, placement: 'after', caption: 'Medical gallery of Blausen Medical 2014' }
        ];
        const images = await resolveIratQuestionImages(request);
        // One image, not two: the explicit entry merges into the automatic one instead of
        // appearing alongside it.
        expect(images.get('Question 19')).toHaveLength(1);
        expect(images.get('Question 19')?.[0]).toMatchObject({
          placement: 'after',
          caption: 'Medical gallery of Blausen Medical 2014'
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );
});

test('an explicit empty images array suppresses automatic duplication onto that question', async () => {
  await withDocx(
    paragraph('19. In the image below, which letter indicates a sulcus?') +
    paragraph('A. C') +
    paragraph('', drawing) +
    paragraph('20. In the brain above, which letter indicates the diencephalon?'),
    async (sourceDocx) => {
      const request = baseRequest(sourceDocx, ['Question 19', 'Question 20']);
      // Reviewed and rejected: this is the bare "below"/"above" pointer pair with no case
      // narrative, so the image belongs once to Question 19 only.
      request.questions[1]!.images = [];
      const images = await resolveIratQuestionImages(request);
      expect(images.get('Question 19')).toHaveLength(1);
      expect(images.get('Question 20')).toHaveLength(0);
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
