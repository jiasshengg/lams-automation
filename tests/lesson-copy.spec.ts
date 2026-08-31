import { expect, test } from '@playwright/test';
import type { LamsConfig } from '../src/config.js';
import { copyLesson, openLessonFromLibrary, openSourceLesson, renameLesson } from '../src/lams/lesson-copy.js';

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

test('refuses rename setup when the folder already contains the new title', async ({ page }) => {
  await page.setContent(`
    <button id="openButton" onclick="document.querySelector('[role=dialog]').hidden = false">Open</button>
    <div role="dialog" aria-label="Open design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">Existing lesson</div>
        <div role="treeitem">Renamed lesson</div>
      </div>
      <button id="ldStoreDialogOpenButton">Open</button>
    </div>
  `);
  const config = { browser: { actionTimeoutMs: 2_000 } } as LamsConfig;

  await expect(
    openLessonFromLibrary(page, ['Courses'], 'Existing lesson', config, { absentTitle: 'Renamed lesson' })
  ).rejects.toThrow('contains "Renamed lesson"');
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

test('opens a read-only source through the explicit Open a copy control', async ({ page }) => {
  await page.setContent(`
    <button id="openButton" onclick="document.querySelector('[role=dialog]').hidden = false">Open</button>
    <div role="dialog" aria-label="Open design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
        <div role="treeitem">Run sequences</div>
        <div role="treeitem">FOM TBL01 110825 2025Y1</div>
      </div>
      <button id="ldStoreDialogOpenButton" hidden>Open</button>
      <button id="ldStoreDialogCopyOpenButton" onclick="this.closest('[role=dialog]').hidden = true; document.querySelector('h1').hidden = false">Open a copy</button>
    </div>
    <h1 hidden>FOM TBL01 110825 2025Y1</h1>
  `);
  const config = {
    sourceLessonTitle: 'FOM TBL01 110825 2025Y1',
    sourceFolderPath: ['Courses', 'DL Playground 2026/2027 [internal]', 'Run sequences'],
    openSourceAsCopy: true,
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;

  await openSourceLesson(page, config);

  await expect(page.getByRole('heading', { name: config.sourceLessonTitle })).toBeVisible();
});

test('dry run verifies a missing final destination folder can be created without creating it', async ({ page }) => {
  await page.setContent(`
    <button id="saveDropButton">Save menu</button>
    <a href="#" onclick="document.querySelector('[role=dialog]').hidden = false">Save as</a>
    <div role="dialog" aria-label="Save design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
      </div>
      <input aria-label="Type the learning design name to save" value="source">
      <button id="ldStoreDialogNewFolderButton" onclick="prompt('Please enter the name for a new folder')">New</button>
      <button id="ldStoreDialogSaveButton">Save</button>
    </div>
  `);
  const config = {
    sourceLessonTitle: '[for interns] TEST LESSON A 280826',
    lessonTitle: '[Nathanael]',
    destinationFolderPath: ['Courses', 'DL Playground 2026/2027 [internal]', '![Nathanael]'],
    createDestinationFolder: true,
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;
  let promptCount = 0;
  page.on('dialog', async (dialog) => {
    promptCount += 1;
    await dialog.dismiss();
  });

  const result = await copyLesson(page, config, { commit: false });

  expect(result.committed).toBe(false);
  expect(result.destinationFolderCreated).toBe(false);
  expect(promptCount).toBe(0);
  await expect(page.getByRole('treeitem', { name: '![Nathanael]', exact: true })).toHaveCount(0);
});

test('commit creates only the missing final folder, saves the copy, and verifies both', async ({ page }) => {
  await page.setContent(`
    <button id="saveDropButton">Save menu</button>
    <a href="#" onclick="document.querySelector('#save-dialog').hidden = false">Save as</a>
    <div id="save-dialog" role="dialog" aria-label="Save design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
        <div id="save-folder-slot"></div>
      </div>
      <input aria-label="Type the learning design name to save" value="source">
      <button id="ldStoreDialogNewFolderButton" onclick="
        const name = prompt('Please enter the name for a new folder');
        if (name) document.querySelector('#save-folder-slot').outerHTML = '&lt;div role=treeitem&gt;' + name + '&lt;/div&gt;';
      ">New</button>
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
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
        <div role="treeitem">![Nathanael]</div>
        <div id="copied-design" role="treeitem"></div>
      </div>
      <button id="ldStoreDialogCancelButton" onclick="this.parentElement.hidden = true">Cancel</button>
    </div>
  `);
  const config = {
    sourceLessonTitle: '[for interns] TEST LESSON A 280826',
    lessonTitle: '[Nathanael]',
    destinationFolderPath: ['Courses', 'DL Playground 2026/2027 [internal]', '![Nathanael]'],
    createDestinationFolder: true,
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;
  const result = await copyLesson(page, config, { commit: true });

  expect(result.committed).toBe(true);
  expect(result.destinationFolderCreated).toBe(true);
  await expect(page.getByRole('heading', { name: '[Nathanael]' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Open design' })).toBeHidden();
});

test('dry run verifies an exact destination folder rename without renaming or saving', async ({ page }) => {
  await page.setContent(`
    <button id="saveDropButton">Save menu</button>
    <a href="#" onclick="document.querySelector('[role=dialog]').hidden = false">Save as</a>
    <div role="dialog" aria-label="Save design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
        <div role="treeitem">![Nathanael]</div>
      </div>
      <input aria-label="Type the learning design name to save" value="source">
      <button id="ldStoreDialogRenameButton">Rename</button>
      <button id="ldStoreDialogSaveButton">Save</button>
    </div>
  `);
  const config = {
    sourceLessonTitle: 'FOM TBL01 110825 2025Y1',
    lessonTitle: '[Nathanael] MOCK FOM TBL01 AE TEST',
    destinationFolderPath: [
      'Courses',
      'DL Playground 2026/2027 [internal]',
      '[Nathanael] MOCK FOM TBL01 AE TEST'
    ],
    renameDestinationFolderFrom: '![Nathanael]',
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;

  const result = await copyLesson(page, config, { commit: false });

  expect(result.committed).toBe(false);
  expect(result.destinationFolderRenamed).toBe(false);
  await expect(page.getByRole('treeitem', { name: '![Nathanael]', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: config.destinationFolderPath.at(-1)!, exact: true })).toHaveCount(0);
});

test('commit renames the exact folder, preserves its lesson, and saves the new copy', async ({ page }) => {
  await page.setContent(`
    <button id="saveDropButton">Save menu</button>
    <a href="#" onclick="document.querySelector('#save-dialog').hidden = false">Save as</a>
    <div id="save-dialog" role="dialog" aria-label="Save design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
        <div id="destination-folder" class="tree-parent" role="treeitem">![Nathanael]</div>
        <div role="treeitem">[Nathanael]</div>
        <div id="new-copy" role="treeitem"></div>
      </div>
      <input aria-label="Type the learning design name to save" value="source">
      <button id="ldStoreDialogRenameButton" onclick="document.querySelector('#rename-modal').hidden = false">Rename</button>
      <button id="ldStoreDialogSaveButton" onclick="
        const title = this.parentElement.querySelector('input').value;
        document.querySelector('#new-copy').textContent = title;
        this.parentElement.hidden = true;
        document.querySelector('h1').textContent = title;
        document.querySelector('h1').hidden = false;
      ">Save</button>
    </div>
    <div id="rename-modal" role="dialog" aria-label="Rename" hidden>
      <label for="ldStoreDialogRenameModalInput">Please enter the new name for</label>
      <input id="ldStoreDialogRenameModalInput">
      <button id="ldStoreDialogRenameModalConfirm" onclick="
        document.querySelector('#destination-folder').textContent = document.querySelector('#ldStoreDialogRenameModalInput').value;
        this.closest('[role=dialog]').hidden = true;
      ">Rename</button>
    </div>
    <h1 hidden></h1>
    <button id="openButton" onclick="document.querySelector('#open-dialog').hidden = false">Open</button>
    <div id="open-dialog" role="dialog" aria-label="Open design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">DL Playground 2026/2027 [internal]</div>
        <div class="tree-parent" role="treeitem">[Nathanael] MOCK FOM TBL01 AE TEST</div>
        <div role="treeitem">[Nathanael]</div>
        <div role="treeitem">[Nathanael] MOCK FOM TBL01 AE TEST</div>
      </div>
      <button id="ldStoreDialogCancelButton" onclick="this.parentElement.hidden = true">Cancel</button>
    </div>
  `);
  const config = {
    sourceLessonTitle: 'FOM TBL01 110825 2025Y1',
    lessonTitle: '[Nathanael] MOCK FOM TBL01 AE TEST',
    destinationFolderPath: [
      'Courses',
      'DL Playground 2026/2027 [internal]',
      '[Nathanael] MOCK FOM TBL01 AE TEST'
    ],
    renameDestinationFolderFrom: '![Nathanael]',
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;

  const result = await copyLesson(page, config, { commit: true });

  expect(result.committed).toBe(true);
  expect(result.destinationFolderRenamed).toBe(true);
  await expect(page.getByRole('heading', { name: config.lessonTitle })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Open design' })).toBeHidden();
});
test('rename dry run verifies and cancels the inline title editor', async ({ page }) => {
  await page.setContent(inlineRenameMarkup());
  const config = renameConfig();

  const result = await renameLesson(page, config, { commit: false });

  expect(result.committed).toBe(false);
  await expect(page.locator('#ldDescriptionFieldTitle')).toHaveText(config.sourceLessonTitle);
  await expect(page.locator('#title-editor')).toBeHidden();
  await expect(page.locator('body')).not.toHaveAttribute('data-saved');
});

test('rename commit updates, saves, and verifies the exact library title', async ({ page }) => {
  await page.setContent(inlineRenameMarkup());
  const config = renameConfig();

  const result = await renameLesson(page, config, { commit: true });

  expect(result.committed).toBe(true);
  await expect(page.locator('#ldDescriptionFieldTitle')).toHaveText(config.lessonTitle);
  await expect(page.locator('body')).toHaveAttribute('data-saved', 'true');
  await expect(page.getByRole('dialog', { name: 'Open design' })).toBeHidden();
});

function inlineRenameMarkup(): string {
  return `
    <div id="ldDescriptionTitleContainer">
      <span id="ldDescriptionFieldTitle" onclick="
        this.hidden = true;
        document.querySelector('#title-editor').hidden = false;
      ">Existing lesson</span>
      <span id="title-editor" hidden>
        <input type="text">
        <button type="submit" class="editable-submit" onclick="
          const title = document.querySelector('#ldDescriptionFieldTitle');
          title.textContent = this.parentElement.querySelector('input').value;
          document.querySelector('#library-title').textContent = title.textContent;
          document.querySelector('#ldDescriptionFieldModified').hidden = false;
          title.hidden = false;
          this.parentElement.hidden = true;
        ">Confirm</button>
        <button type="button" class="editable-cancel" onclick="
          document.querySelector('#ldDescriptionFieldTitle').hidden = false;
          this.parentElement.hidden = true;
        ">Cancel</button>
      </span>
      <span id="ldDescriptionFieldModified" hidden>*</span>
    </div>
    <button id="saveButton" onclick="
      document.body.dataset.saved = 'true';
      document.querySelector('#ldDescriptionFieldModified').hidden = true;
    ">Save</button>
    <button id="openButton" onclick="document.querySelector('[role=dialog]').hidden = false">Open</button>
    <div role="dialog" aria-label="Open design" hidden>
      <div role="tree">
        <div role="treeitem">Courses</div>
        <div role="treeitem">Playground</div>
        <div id="library-title" role="treeitem">Existing lesson</div>
      </div>
      <button id="ldStoreDialogCancelButton" onclick="this.closest('[role=dialog]').hidden = true">Cancel</button>
    </div>
  `;
}

function renameConfig(): LamsConfig {
  return {
    sourceLessonTitle: 'Existing lesson',
    lessonTitle: 'Renamed lesson',
    sourceFolderPath: ['Courses', 'Playground'],
    browser: { actionTimeoutMs: 2_000 }
  } as LamsConfig;
}
