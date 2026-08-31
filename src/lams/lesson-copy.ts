import type { Locator, Page } from '@playwright/test';
import type { LamsConfig } from '../config.js';
import { waitForUniqueVisible } from './navigation.js';

export interface CopyLessonOptions {
  commit: boolean;
}

export interface CopyLessonResult {
  sourceTitle: string;
  newTitle: string;
  destinationFolderPath: string[];
  committed: boolean;
}

export interface OpenLessonOptions {
  absentTitle?: string;
}

export interface RenameLessonOptions {
  commit: boolean;
}

export interface RenameLessonResult {
  sourceTitle: string;
  newTitle: string;
  folderPath: string[];
  committed: boolean;
}

export async function openSourceLesson(page: Page, config: LamsConfig): Promise<void> {
  await openLessonFromLibrary(page, config.sourceFolderPath, config.sourceLessonTitle, config);
}

export async function openLessonFromLibrary(
  page: Page,
  folderPath: string[],
  lessonTitle: string,
  config: LamsConfig,
  options: OpenLessonOptions = {}
): Promise<void> {
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  await traverseFolderPath(dialog, folderPath, page, config);
  if (options.absentTitle) await assertTitleAbsent(dialog, options.absentTitle);
  const lesson = exactTreeItem(dialog, lessonTitle);
  await waitForUniqueVisible(lesson, page, config, `lesson: ${lessonTitle}`, false);
  await lesson.click();

  // LAMS includes an icon glyph in this button's accessible name in some browser builds.
  // The ID is stable in the observed Authoring design-library markup.
  const openButton = dialog.locator('#ldStoreDialogOpenButton');
  await openButton.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  if (!(await openButton.isEnabled())) throw new Error(`Open remained disabled for "${lessonTitle}".`);
  await openButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
  await page.getByText(lessonTitle, { exact: true }).filter({ visible: true }).first().waitFor({
    state: 'visible',
    timeout: config.browser.actionTimeoutMs
  });
  console.log(`Verified opened lesson: ${lessonTitle}`);
}

export async function renameLesson(
  page: Page,
  config: LamsConfig,
  options: RenameLessonOptions
): Promise<RenameLessonResult> {
  assertNewTitleValues(config);

  // These stable IDs/classes were observed in the real LAMS Authoring title editor.
  const titleField = page.locator('#ldDescriptionFieldTitle');
  const visibleTitle = await waitForUniqueVisible(titleField, page, config, 'authoring title', false);
  const currentTitle = (await visibleTitle.innerText()).trim();
  if (currentTitle !== config.sourceLessonTitle) {
    throw new Error(
      `Refusing to rename: opened title is "${currentTitle}", expected "${config.sourceLessonTitle}".`
    );
  }

  await visibleTitle.click();
  const titleContainer = page.locator('#ldDescriptionTitleContainer');
  const titleInput = titleContainer.getByRole('textbox');
  const submitButton = titleContainer.locator('button.editable-submit');
  const cancelButton = titleContainer.locator('button.editable-cancel');
  await waitForUniqueVisible(titleInput, page, config, 'inline title textbox', false);
  await waitForUniqueVisible(submitButton, page, config, 'inline title confirmation', false);

  if (!options.commit) {
    await (await waitForUniqueVisible(cancelButton, page, config, 'inline title cancel', false)).click();
    await waitForExactTitle(titleField, config.sourceLessonTitle, config);
    console.log('Rename dry run complete: inline title controls were verified and cancelled; no title was changed.');
    return {
      sourceTitle: config.sourceLessonTitle,
      newTitle: config.lessonTitle,
      folderPath: config.sourceFolderPath,
      committed: false
    };
  }

  await titleInput.fill(config.lessonTitle);
  await submitButton.click();
  await waitForExactTitle(titleField, config.lessonTitle, config);

  const modifiedIndicator = page.locator('#ldDescriptionFieldModified');
  await waitForUniqueVisible(modifiedIndicator, page, config, 'unsaved title indicator', false);

  const saveButton = page.locator('#saveButton');
  const uniqueSaveButton = await waitForUniqueVisible(saveButton, page, config, 'authoring save', false);
  if (!(await uniqueSaveButton.isEnabled())) throw new Error('Authoring Save remained disabled after changing the title.');
  await uniqueSaveButton.click();
  await modifiedIndicator.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });

  await verifyRenamedLessonInFolder(page, config);
  console.log(`Verified renamed lesson in source folder: ${config.lessonTitle}`);
  return {
    sourceTitle: config.sourceLessonTitle,
    newTitle: config.lessonTitle,
    folderPath: config.sourceFolderPath,
    committed: true
  };
}

export async function copyLesson(
  page: Page,
  config: LamsConfig,
  options: CopyLessonOptions
): Promise<CopyLessonResult> {
  await page.locator('#saveDropButton').click();
  await page.getByRole('link', { name: 'Save as', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Save design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  const titleInput = dialog.getByRole('textbox', {
    name: 'Type the learning design name to save',
    exact: true
  });
  await titleInput.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await traverseFolderPath(dialog, config.destinationFolderPath, page, config);

  if (!options.commit) {
    console.log('Dry run complete: Save As dialog and destination folder were verified; no copy was created.');
    return {
      sourceTitle: config.sourceLessonTitle,
      newTitle: config.lessonTitle,
      destinationFolderPath: config.destinationFolderPath,
      committed: false
    };
  }

  assertNewTitleValues(config);
  await assertTitleAbsent(dialog, config.lessonTitle);
  await titleInput.fill(config.lessonTitle);

  const saveButton = dialog.locator('#ldStoreDialogSaveButton');
  if (!(await saveButton.isEnabled())) throw new Error('Save remained disabled after selecting the destination and title.');
  await saveButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
  await page.getByText(config.lessonTitle, { exact: true }).filter({ visible: true }).first().waitFor({
    state: 'visible',
    timeout: config.browser.actionTimeoutMs
  });
  await verifyCopiedLessonInDestination(page, config);
  console.log(`Verified copied lesson in destination: ${config.lessonTitle}`);
  return {
    sourceTitle: config.sourceLessonTitle,
    newTitle: config.lessonTitle,
    destinationFolderPath: config.destinationFolderPath,
    committed: true
  };
}

async function verifyCopiedLessonInDestination(page: Page, config: LamsConfig): Promise<void> {
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await traverseFolderPath(dialog, config.destinationFolderPath, page, config);
  await waitForUniqueVisible(
    exactTreeItem(dialog, config.lessonTitle),
    page,
    config,
    `copied lesson: ${config.lessonTitle}`,
    false
  );
  const cancelButton = dialog.locator('#ldStoreDialogCancelButton');
  await cancelButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
}

async function verifyRenamedLessonInFolder(page: Page, config: LamsConfig): Promise<void> {
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await traverseFolderPath(dialog, config.sourceFolderPath, page, config);
  await waitForUniqueVisible(
    exactTreeItem(dialog, config.lessonTitle),
    page,
    config,
    `renamed lesson: ${config.lessonTitle}`,
    false
  );
  await assertTitleAbsent(dialog, config.sourceLessonTitle);
  const cancelButton = dialog.locator('#ldStoreDialogCancelButton');
  await cancelButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
}

async function assertTitleAbsent(dialog: Locator, title: string): Promise<void> {
  const matches = exactTreeItem(dialog, title);
  for (let index = 0; index < (await matches.count()); index += 1) {
    if (await matches.nth(index).isVisible()) {
      throw new Error(`Refusing to commit: selected folder already contains "${title}".`);
    }
  }
}

export async function traverseFolderPath(
  dialog: Locator,
  folderPath: string[],
  page: Page,
  config: LamsConfig
): Promise<void> {
  for (const folderName of folderPath) {
    const folder = exactTreeItem(dialog, folderName);
    const target = await waitForUniqueVisible(folder, page, config, `folder: ${folderName}`, false);
    const expanded = await target.getAttribute('aria-expanded');
    if (expanded !== 'true') await target.click();
    await target.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
    console.log(`Verified folder: ${folderName}`);
  }
}

function exactTreeItem(dialog: Locator, name: string): Locator {
  return dialog.getByRole('treeitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertNewTitleValues(config: LamsConfig): void {
  if (config.lessonTitle === config.sourceLessonTitle) {
    throw new Error('Refusing to commit: lessonTitle must differ from sourceLessonTitle.');
  }
  if (/replace|example/i.test(config.lessonTitle)) {
    throw new Error('Refusing to commit with a placeholder lessonTitle.');
  }
}

async function waitForExactTitle(titleField: Locator, title: string, config: LamsConfig): Promise<void> {
  await titleField.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(title)}\\s*$`) }).waitFor({
    state: 'visible',
    timeout: config.browser.actionTimeoutMs
  });
}
