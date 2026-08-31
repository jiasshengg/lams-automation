import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { copyLesson, openSourceLesson } from '../src/lams/lesson-copy.js';

test('opens an exact lesson through a configurable folder path', async ({ page }) => {
  await page.setContent(`
    <button id="openButton" onclick="document.querySelector('[role=dialog]').hidden = false">Open</button>
    <div role="dialog" aria-label="Open design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">! My Courses</div>
        <div role="treeitem">! Sample &amp; Orientation Lessons</div>
        <div role="treeitem">[Jss] TEST LESSON A 280826</div>
      </div>
      <button id="ldStoreDialogOpenButton" onclick="this.closest('[role=dialog]').hidden = true; document.querySelector('h1').hidden = false">Open</button>
    </div>
    <h1 hidden>[Jss] TEST LESSON A 280826</h1>
  `);

  const config = {
    sourceLessonTitle: '[Jss] TEST LESSON A 280826',
    sourceFolderPath: ['Courses', '! My Courses', '! Sample & Orientation Lessons'],
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;

  await openSourceLesson(page, config);
  await expect(page.getByRole('heading', { name: config.sourceLessonTitle })).toBeVisible();
});

test('dry run verifies the destination without saving a copy', async ({ page }) => {
  await page.setContent(`
    <button id="saveDropButton">Save menu</button>
    <a href="#" onclick="document.querySelector('[role=dialog]').hidden = false">Save as</a>
    <div role="dialog" aria-label="Save design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
      </div>
      <input aria-label="Type the learning design name to save" value="[Jss] TEST LESSON A 280826">
      <button id="ldStoreDialogSaveButton" onclick="document.body.dataset.saved = 'true'">Save</button>
    </div>
  `);

  const config = {
    sourceLessonTitle: '[Jss] TEST LESSON A 280826',
    lessonTitle: '[Jss] TEST LESSON A COPY',
    destinationFolderPath: ['Courses', 'DL Playground 2026/2027 [internal]'],
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;

  const result = await copyLesson(page, config, { commit: false });
  expect(result.committed).toBe(false);
  await expect(page.getByRole('dialog', { name: 'Save design' })).toBeVisible();
  await expect(page.locator('body')).not.toHaveAttribute('data-saved');
});

test('commit saves and verifies the copy in the destination library', async ({ page }) => {
  await page.setContent(`
    <button id="saveDropButton">Save menu</button>
    <a href="#" onclick="document.querySelector('#save-dialog').hidden = false">Save as</a>
    <div id="save-dialog" role="dialog" aria-label="Save design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">! My Courses</div>
        <div role="treeitem">! Sample &amp; Orientation Lessons</div>
      </div>
      <input aria-label="Type the learning design name to save" value="[Jss] TEST LESSON A 280826">
      <button id="ldStoreDialogSaveButton" onclick="
        const title = this.parentElement.querySelector('input').value;
        this.parentElement.hidden = true;
        document.querySelector('h1').textContent = title;
        document.querySelector('h1').hidden = false;
        document.querySelector('#copied-design').textContent = title;
      ">Save</button>
    </div>
    <h1 hidden></h1>
    <button id="openButton" onclick="document.querySelector('#open-dialog').hidden = false">Open</button>
    <div id="open-dialog" role="dialog" aria-label="Open design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">! My Courses</div>
        <div role="treeitem">! Sample &amp; Orientation Lessons</div>
        <div id="copied-design" role="treeitem"></div>
      </div>
      <button id="ldStoreDialogCancelButton" onclick="this.parentElement.hidden = true">Cancel</button>
    </div>
  `);

  const config = {
    sourceLessonTitle: '[Jss] TEST LESSON A 280826',
    lessonTitle: '[Jss-Playwright] TEST LESSON A 280826',
    destinationFolderPath: ['Courses', '! My Courses', '! Sample & Orientation Lessons'],
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;

  const result = await copyLesson(page, config, { commit: true });
  expect(result.committed).toBe(true);
  await expect(page.getByRole('heading', { name: config.lessonTitle })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Open design' })).toBeHidden();
});
