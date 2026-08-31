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
  destinationFolderCreated: boolean;
  destinationFolderRenamed: boolean;
}

export async function openSourceLesson(page: Page, config: LamsConfig): Promise<void> {
  await openLessonFromLibrary(page, config.sourceFolderPath, config.sourceLessonTitle, config);
}

export async function openLessonFromLibrary(
  page: Page,
  folderPath: string[],
  lessonTitle: string,
  config: LamsConfig
): Promise<void> {
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  await traverseFolderPath(dialog, folderPath, page, config);
  const lesson = await exactLessonTreeItem(dialog, lessonTitle);
  await waitForUniqueVisible(lesson, page, config, `lesson: ${lessonTitle}`, false);
  await lesson.click();

  // Read-only library designs expose a distinct stable control that opens an
  // unsaved writable clone. No library copy exists until Save As completes.
  const openButton = dialog.locator(
    config.openSourceAsCopy ? '#ldStoreDialogCopyOpenButton' : '#ldStoreDialogOpenButton'
  );
  await openButton.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  if (!(await openButton.isEnabled())) {
    throw new Error(`${config.openSourceAsCopy ? 'Open a copy' : 'Open'} remained disabled for "${lessonTitle}".`);
  }
  await openButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
  await page.getByText(lessonTitle, { exact: true }).filter({ visible: true }).first().waitFor({
    state: 'visible',
    timeout: config.browser.actionTimeoutMs
  });
  console.log(`Verified opened ${config.openSourceAsCopy ? 'a writable source copy' : 'lesson'}: ${lessonTitle}`);
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
  if (options.commit) assertCommitValues(config);
  const destination = await prepareDestinationFolder(dialog, page, config, options.commit);

  if (!options.commit) {
    const destinationCheck = config.renameDestinationFolderFrom
      ? 'folder rename controls'
      : config.createDestinationFolder
        ? 'folder creation controls'
        : 'folder';
    console.log(
      `Dry run complete: Save As dialog and destination ${destinationCheck} were verified; no folder or copy was created.`
    );
    return {
      sourceTitle: config.sourceLessonTitle,
      newTitle: config.lessonTitle,
      destinationFolderPath: config.destinationFolderPath,
      committed: false,
      destinationFolderCreated: false,
      destinationFolderRenamed: false
    };
  }

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
    committed: true,
    destinationFolderCreated: destination.created,
    destinationFolderRenamed: destination.renamed
  };
}

interface DestinationPreparation {
  created: boolean;
  renamed: boolean;
}

async function prepareDestinationFolder(
  dialog: Locator,
  page: Page,
  config: LamsConfig,
  commit: boolean
): Promise<DestinationPreparation> {
  if (config.renameDestinationFolderFrom) {
    return prepareRenamedDestinationFolder(dialog, page, config, commit);
  }
  if (!config.createDestinationFolder) {
    await traverseFolderPath(dialog, config.destinationFolderPath, page, config);
    return { created: false, renamed: false };
  }

  const parentPath = config.destinationFolderPath.slice(0, -1);
  const folderName = config.destinationFolderPath.at(-1)!;
  await traverseFolderPath(dialog, parentPath, page, config);
  const existing = exactTreeItem(dialog, folderName);
  const existingVisible = await visibleCount(existing);
  if (existingVisible > 0) {
    throw new Error(`Refusing to create destination folder: "${folderName}" already exists.`);
  }

  const newFolderButton = dialog.locator('#ldStoreDialogNewFolderButton');
  await newFolderButton.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  if (!(await newFolderButton.isEnabled())) {
    throw new Error(`Cannot create "${folderName}": the selected parent folder is read-only.`);
  }
  if (!commit) {
    console.log(`Verified missing destination folder and enabled New control: ${folderName}`);
    return { created: false, renamed: false };
  }

  const promptHandled = new Promise<void>((resolve, reject) => {
    page.once('dialog', async (prompt) => {
      try {
        if (prompt.type() !== 'prompt' || prompt.message() !== 'Please enter the name for a new folder') {
          await prompt.dismiss();
          throw new Error(`Unexpected folder creation dialog: ${prompt.type()} ${JSON.stringify(prompt.message())}`);
        }
        await prompt.accept(folderName);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
  await Promise.all([newFolderButton.click(), promptHandled]);
  const created = await waitForUniqueVisible(exactTreeItem(dialog, folderName), page, config, `created folder: ${folderName}`, false);
  if ((await created.getAttribute('aria-expanded')) !== 'true') await created.click();
  console.log(`Verified created destination folder: ${folderName}`);
  return { created: true, renamed: false };
}

async function prepareRenamedDestinationFolder(
  dialog: Locator,
  page: Page,
  config: LamsConfig,
  commit: boolean
): Promise<DestinationPreparation> {
  const parentPath = config.destinationFolderPath.slice(0, -1);
  const newName = config.destinationFolderPath.at(-1)!;
  const oldName = config.renameDestinationFolderFrom!;
  await traverseFolderPath(dialog, parentPath, page, config);

  if ((await visibleCount(await exactFolderTreeItem(dialog, newName))) > 0) {
    throw new Error(`Refusing to rename destination folder: "${newName}" already exists.`);
  }
  const oldFolder = await waitForUniqueVisible(
    await exactFolderTreeItem(dialog, oldName),
    page,
    config,
    `folder to rename: ${oldName}`,
    false
  );
  await oldFolder.click();
  const renameButton = dialog.locator('#ldStoreDialogRenameButton');
  await renameButton.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  if (!(await renameButton.isEnabled())) throw new Error(`Rename remained disabled for folder "${oldName}".`);

  if (!commit) {
    console.log(`Verified destination folder can be renamed exactly: ${oldName} -> ${newName}`);
    return { created: false, renamed: false };
  }

  await renameButton.click();
  const renameDialog = page.getByRole('dialog', { name: 'Rename', exact: true });
  await renameDialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  const input = renameDialog.locator('#ldStoreDialogRenameModalInput');
  await input.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await input.fill(newName);
  const confirm = renameDialog.locator('#ldStoreDialogRenameModalConfirm');
  if (!(await confirm.isEnabled())) throw new Error(`Rename confirmation remained disabled for "${newName}".`);
  await confirm.click();
  await renameDialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });

  const renamed = await waitForUniqueVisible(
    await exactFolderTreeItem(dialog, newName),
    page,
    config,
    `renamed folder: ${newName}`,
    false
  );
  if ((await visibleCount(await exactFolderTreeItem(dialog, oldName))) > 0) {
    throw new Error(`Folder rename did not remove the old visible name "${oldName}".`);
  }
  if ((await renamed.getAttribute('aria-expanded')) !== 'true') await renamed.click();
  console.log(`Verified renamed destination folder: ${oldName} -> ${newName}`);
  return { created: false, renamed: true };
}

async function verifyCopiedLessonInDestination(page: Page, config: LamsConfig): Promise<void> {
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await traverseFolderPath(dialog, config.destinationFolderPath, page, config);
  await waitForUniqueVisible(
    await exactLessonTreeItem(dialog, config.lessonTitle),
    page,
    config,
    `copied lesson: ${config.lessonTitle}`,
    false
  );
  const cancelButton = dialog.locator('#ldStoreDialogCancelButton');
  await cancelButton.click();
  await dialog.waitFor({ state: 'hidden', timeout: config.browser.actionTimeoutMs });
}

async function assertTitleAbsent(dialog: Locator, title: string): Promise<void> {
  const matches = await exactLessonTreeItem(dialog, title);
  for (let index = 0; index < (await matches.count()); index += 1) {
    if (await matches.nth(index).isVisible()) {
      throw new Error(`Refusing to commit: destination already contains "${title}".`);
    }
  }
}

async function visibleCount(locator: Locator): Promise<number> {
  let visible = 0;
  for (let index = 0; index < (await locator.count()); index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return visible;
}

export async function traverseFolderPath(
  dialog: Locator,
  folderPath: string[],
  page: Page,
  config: LamsConfig
): Promise<void> {
  for (const folderName of folderPath) {
    const folder = await exactFolderTreeItem(dialog, folderName);
    const target = await waitForUniqueVisible(folder, page, config, `folder: ${folderName}`, false);
    const expanded = await target.getAttribute('aria-expanded');
    if (expanded !== 'true') await target.click();
    await target.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
    console.log(`Verified folder: ${folderName}`);
  }
}

async function exactFolderTreeItem(dialog: Locator, name: string): Promise<Locator> {
  const typed = dialog
    .locator('[role="treeitem"].tree-parent')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) });
  return (await visibleCount(typed)) > 0 ? typed : exactTreeItem(dialog, name);
}

async function exactLessonTreeItem(dialog: Locator, name: string): Promise<Locator> {
  const typed = dialog
    .locator('[role="treeitem"]:not(.tree-parent)')
    .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) });
  const treeDistinguishesFolders = (await dialog.locator('[role="treeitem"].tree-parent').count()) > 0;
  return treeDistinguishesFolders ? typed : exactTreeItem(dialog, name);
}

function exactTreeItem(dialog: Locator, name: string): Locator {
  return dialog.getByRole('treeitem').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertCommitValues(config: LamsConfig): void {
  if (config.lessonTitle === config.sourceLessonTitle) {
    throw new Error('Refusing to commit: lessonTitle must differ from sourceLessonTitle.');
  }
  if (/replace|example/i.test(config.lessonTitle)) {
    throw new Error('Refusing to commit with a placeholder lessonTitle.');
  }
}
