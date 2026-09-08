import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import { buildAEPlan } from '../src/ae/plan.js';
import { LamsAEEditor } from '../src/lams/ae-editor.js';

// Mirrors the observed question authoring modal: the answer-letter prefix is a plain
// visible checkbox in the advanced settings, unchecked by default on a new question.
const MODAL = '<input type="checkbox" id="prefixAnswersWithLetters">';

const plan = buildAEPlan({
  sourceLabel: 'Prefix regression', breakMarkerCount: 0, gates: [],
  nodes: [{ title: 'AE 1', questions: [
    { number: 1, type: 'mcq', prompt: 'Pick one.', options: [
      { text: 'A) wrong', correct: false }, { text: 'B) right', correct: true }
    ] },
    { number: 2, type: 'essay', prompt: 'Explain.' }
  ] }]
});
const [mcq, essay] = plan.nodes[0]!.questions;

// applyPrefixToggle is private; the tests drive it directly against a real DOM, and a
// Page stands in for the question modal's Frame since only locator() is exercised.
function editorFor(page: Page) {
  return new LamsAEEditor(page, plan, 5000) as unknown as {
    applyPrefixToggle(frame: Frame, question: NonNullable<typeof mcq>): Promise<void>;
  };
}

test('enables the answer-letter prefix for an MCQ question', async ({ page }) => {
  await page.setContent(MODAL);
  await editorFor(page).applyPrefixToggle(page as unknown as Frame, mcq!);
  expect(await page.locator('#prefixAnswersWithLetters').isChecked()).toBe(true);
});

test('leaves the prefix enabled when it is already on', async ({ page }) => {
  await page.setContent('<input type="checkbox" id="prefixAnswersWithLetters" checked>');
  await editorFor(page).applyPrefixToggle(page as unknown as Frame, mcq!);
  expect(await page.locator('#prefixAnswersWithLetters').isChecked()).toBe(true);
});

test('turns the prefix off for a question that should not carry letters', async ({ page }) => {
  await page.setContent('<input type="checkbox" id="prefixAnswersWithLetters" checked>');
  await editorFor(page).applyPrefixToggle(page as unknown as Frame, essay!);
  expect(await page.locator('#prefixAnswersWithLetters').isChecked()).toBe(false);
});

test('fails loudly when the prefix control is absent', async ({ page }) => {
  await page.setContent('<p>no toggle here</p>');
  await expect(editorFor(page).applyPrefixToggle(page as unknown as Frame, mcq!)).rejects.toThrow();
});
