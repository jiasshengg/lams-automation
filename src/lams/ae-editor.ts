import type { Dialog, Frame, Locator, Page } from '@playwright/test';
import { inlineHtmlToText, sanitizeInlineHtml } from '../ae/inline-html.js';
import type { AENodePlan, AEPlan, AEQuestionPlan } from '../ae/plan.js';
import type { QuestionImageAsset } from '../docx/question-images.js';
import { applyAEActivitySettings } from './ae-settings.js';
import { inspectAuthoringGraph, openActivityProperties, type GraphNode } from './authoring.js';
import { imageHtml, uploadCkEditorImages, type UploadedImage } from './ckeditor-media.js';
import {
  ACTIVITY_DIALOG,
  MAX_MARK_INPUT,
  QUESTION_TITLE,
  REQUIRED_TOGGLE
} from './irat-editor.js';

const QUESTION_MODAL = '#qb-question-authoring-modal';
// Observed in the Assessment activity frame: the description is a CKEditor-backed
// textarea, so it must be set through the editor instance rather than filled.
const ACTIVITY_DESCRIPTION_EDITOR = 'assessment.instructions';
// Observed in the question authoring modal's advanced settings for MCQ questions.
const PREFIX_ANSWERS_TOGGLE = '#prefixAnswersWithLetters';

export interface AEWriteResult {
  nodeTitle: string;
  updatedQuestions: string[];
  createdQuestions: string[];
  importedImages: number;
}

/** Writes one complete reviewed AE node using the observed LAMS Assessment authoring UI. */
export class LamsAEEditor {
  constructor(
    private readonly page: Page,
    private readonly plan: AEPlan,
    private readonly timeoutMs: number,
    private readonly questionImages: Map<number, QuestionImageAsset[]> = new Map()
  ) {}

  async writeExistingNode(nodePlan: AENodePlan): Promise<AEWriteResult> {
    const graph = await inspectAuthoringGraph(this.page);
    const matches = graph.nodes.filter((node) => node.type === 'tool' && node.name === nodePlan.title);
    if (matches.length !== 1) throw new Error(`Expected one AE Assessment node named "${nodePlan.title}"; found ${matches.length}.`);
    return this.writeNode(matches[0]!, nodePlan);
  }

  async writeNode(node: GraphNode, nodePlan: AENodePlan): Promise<AEWriteResult> {
    const activityFrame = await this.openActivityFrame(node.uiid, node.name);
    await expandAuthoringSections(activityFrame, this.timeoutMs);
    const title = activityFrame.locator('#assessment\\.title');
    await title.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await title.fill(nodePlan.title);
    // AE activities are identified by their title alone; a description is written only
    // when the reviewed plan supplies one, and is otherwise cleared to stay deterministic.
    await setCkEditor(
      activityFrame,
      ACTIVITY_DESCRIPTION_EDITOR,
      nodePlan.description === '' ? '' : `<div>${sanitizeInlineHtml(nodePlan.description)}</div>`
    );

    const rows = activityFrame.locator('#referencesTable tbody tr');
    const existingCount = await rows.count();
    if (existingCount > nodePlan.questions.length) {
      throw new Error(
        `AE node "${nodePlan.title}" contains ${existingCount} questions but the reviewed plan contains ${nodePlan.questions.length}; automatic question deletion is not supported.`
      );
    }

    const updatedQuestions: string[] = [];
    const createdQuestions: string[] = [];
    const uploadedImages: UploadedImage[] = [];
    let importedImages = 0;
    for (let index = 0; index < nodePlan.questions.length; index += 1) {
      const question = nodePlan.questions[index]!;
      const assets = this.questionImages.get(question.number) ?? [];
      if (index < existingCount) {
        uploadedImages.push(...await this.editQuestion(activityFrame, index, question, assets));
        updatedQuestions.push(question.title);
      } else {
        uploadedImages.push(...await this.createQuestion(activityFrame, question, assets));
        createdQuestions.push(question.title);
      }
      importedImages += assets.length;
    }

    await applyAEActivitySettings(this.page, { commit: true, actionTimeoutMs: this.timeoutMs });
    await this.applyAttemptSettings(activityFrame);
    await this.verifyPrintView(activityFrame, nodePlan, uploadedImages);
    await activityFrame.locator('#saveButton').click();
    await this.page.locator(ACTIVITY_DIALOG).waitFor({ state: 'hidden', timeout: this.timeoutMs });

    const saved = (await inspectAuthoringGraph(this.page)).nodes.filter(
      (candidate) => candidate.type === 'tool' && candidate.name === nodePlan.title
    );
    if (saved.length !== 1) throw new Error(`Saved AE node title "${nodePlan.title}" was not found exactly once on the graph.`);
    return { nodeTitle: nodePlan.title, updatedQuestions, createdQuestions, importedImages };
  }

  async associateWithTeamSetup(nodeTitle: string, teamSetupName: string): Promise<void> {
    const graph = await inspectAuthoringGraph(this.page);
    await this.associateNodeWithTeamSetup(uniqueNode(graph.nodes, nodeTitle, 'tool'), teamSetupName);
  }

  /**
   * Grouping by uiid rather than title, so a freshly dropped shell can be grouped while it is still
   * named "Assessment". LAMS disables the team-based Assessment settings (disclose answers in
   * monitor, leaders from Select Leader) until the activity is grouped, so this has to run before
   * the settings are written, not after the node is titled.
   */
  async associateNodeWithTeamSetup(node: GraphNode, teamSetupName: string): Promise<void> {
    const graph = await inspectAuthoringGraph(this.page);
    const teamSetup = uniqueNode(graph.nodes, teamSetupName, 'grouping');
    const current = graph.nodes.find((candidate) => candidate.uiid === node.uiid);
    if (current?.grouped && current.groupingUiid === teamSetup.uiid) return;
    await openActivityProperties(this.page, node.uiid, node.name, this.timeoutMs);
    const field = this.page.locator('#propertiesDialog .propertiesContentFieldGrouping:visible');
    await field.selectOption({ label: teamSetupName });
    await field.blur();
    // Clicking empty canvas dismisses the properties dialog. Left open it intercepts the
    // double-click that opens the activity editor (same idiom as createTransition).
    await this.page.locator('#canvas').click({ position: { x: 5, y: 5 } });
    const saved = (await inspectAuthoringGraph(this.page)).nodes.find((candidate) => candidate.uiid === node.uiid);
    if (!saved?.grouped || saved.groupingUiid !== teamSetup.uiid) {
      throw new Error(`AE node "${node.name}" (uiid ${node.uiid}) was not associated with Team Setup "${teamSetupName}".`);
    }
  }

  async saveDesign(): Promise<void> {
    await this.page.locator('#saveButton').click();
    await this.page.waitForTimeout(500);
  }

  /** Leaves Authoring the way the toolbar's Close does, once the design is saved and verified. */
  async closeAuthoring(): Promise<void> {
    const close = this.page.locator('#closeButton');
    if (!(await close.isVisible().catch(() => false))) return;
    await close.click();
    // Closing navigates away from the design, so the canvas it was editing goes with it.
    await this.page
      .locator('#canvas')
      .waitFor({ state: 'detached', timeout: this.timeoutMs })
      .catch(() => undefined);
    console.log('Closed the Authoring page.');
  }

  private async editQuestion(
    activityFrame: Frame,
    rowIndex: number,
    question: AEQuestionPlan,
    images: QuestionImageAsset[]
  ): Promise<UploadedImage[]> {
    const row = activityFrame.locator('#referencesTable tbody tr').nth(rowIndex);
    await row.locator('.edit-reference-link').click();
    const questionFrame = await childFrame(activityFrame.locator('iframe[src*="editReference.do"]'), this.timeoutMs);
    const uploaded = await this.populateQuestion(questionFrame, question, images, true);
    await activityFrame.locator('iframe[src*="editReference.do"]').waitFor({ state: 'detached', timeout: this.timeoutMs });
    await this.applyReferenceFields(activityFrame, question);
    return uploaded;
  }

  private async createQuestion(
    activityFrame: Frame,
    question: AEQuestionPlan,
    images: QuestionImageAsset[]
  ): Promise<UploadedImage[]> {
    await activityFrame.locator('#createQuestionDropdown').click();
    await activityFrame.getByRole('button', { name: question.type === 'mcq' ? 'Multiple choice' : 'Essay', exact: true }).click();
    const modal = activityFrame.locator(`${QUESTION_MODAL}.show`);
    await modal.waitFor({ state: 'visible', timeout: this.timeoutMs });
    const questionFrame = await childFrame(modal.locator('iframe'), this.timeoutMs);
    const uploaded = await this.populateQuestion(questionFrame, question, images, false);
    await modal.waitFor({ state: 'hidden', timeout: this.timeoutMs });
    await this.applyReferenceFields(activityFrame, question);
    return uploaded;
  }

  private async populateQuestion(
    frame: Frame,
    question: AEQuestionPlan,
    images: QuestionImageAsset[],
    existing: boolean
  ): Promise<UploadedImage[]> {
    await frame.locator('#assessmentQuestionForm').waitFor({ state: 'visible', timeout: this.timeoutMs });
    await frame.locator('#title').fill(question.title);
    await waitForCkEditor(frame, 'description');
    const uploaded = await uploadCkEditorImages(frame, 'description', images);
    await setCkEditor(frame, 'description', questionDescriptionHtml(question.promptHtml, uploaded));

    const advanced = frame.locator('#advancedSettingsCollapse');
    if (!(await advanced.isVisible())) {
      await frame.locator('[data-bs-target="#advancedSettingsCollapse"]').click();
      await advanced.waitFor({ state: 'visible', timeout: this.timeoutMs });
    }
    const mark = frame.locator('#maxMark');
    await mark.fill(String(question.marks));
    if (question.type === 'mcq') {
      await resizeOptions(frame, question.options.length, this.timeoutMs);
      await this.applyPrefixToggle(frame, question);
      for (let index = 0; index < question.options.length; index += 1) {
        const option = question.options[index]!;
        await setCkEditor(frame, `optionName${index}`, `<div>${option.html}</div>`);
      }
      await applyAEAnswerScoring(frame, question);
    }

    const save = existing ? frame.locator('#saveAsButton') : frame.locator('#saveButton');
    await save.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await save.click();
    return uploaded;
  }

  /** LAMS only exposes the answer-prefix toggle for multiple choice questions. */
  private async applyPrefixToggle(frame: Frame, question: AEQuestionPlan): Promise<void> {
    const toggle = frame.locator(PREFIX_ANSWERS_TOGGLE);
    await toggle.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await toggle.setChecked(question.prefixSequentialLetters);
    if (await toggle.isChecked() !== question.prefixSequentialLetters) {
      throw new Error(
        `Question "${question.title}" answer-letter prefix did not remain ${question.prefixSequentialLetters ? 'enabled' : 'disabled'}.`
      );
    }
  }

  private async applyReferenceFields(activityFrame: Frame, question: AEQuestionPlan): Promise<void> {
    const row = await exactQuestionRow(activityFrame, question.title);
    const mark = row.locator(MAX_MARK_INPUT);
    if (Number(await mark.inputValue()) !== question.marks) {
      await mark.fill(String(question.marks));
      await mark.blur();
    }
    const toggle = row.locator(REQUIRED_TOGGLE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const actual = await toggle.evaluate((element) =>
        element.classList.contains('text-danger') ? true : element.classList.contains('text-muted') ? false : null
      );
      if (actual === question.answerRequired) break;
      await toggle.click();
      await toggle.evaluate((element) => new Promise<void>((resolve) => {
        const poll = () => element.classList.contains('text-danger') || element.classList.contains('text-muted')
          ? resolve()
          : setTimeout(poll, 50);
        poll();
      }), undefined, { timeout: this.timeoutMs }).catch(() => undefined);
    }
  }

  private async applyAttemptSettings(frame: Frame): Promise<void> {
    if (this.plan.activitySettings.passingMark === null) {
      await frame.locator('#attemptsAllowedRadio').check();
      await frame.locator('#attemptsAllowed').selectOption(String(this.plan.activitySettings.attempts));
    } else {
      await frame.locator('#passingMarkRadio').check();
      await frame.locator('#passingMark').selectOption(String(this.plan.activitySettings.passingMark));
    }
  }

  private async verifyPrintView(frame: Frame, nodePlan: AENodePlan, uploadedImages: UploadedImage[]): Promise<void> {
    const popupPromise = this.page.waitForEvent('popup', { timeout: this.timeoutMs });
    await frame.locator('button[onclick*="showQuestionsPrintPage"]').click();
    const printPage = await popupPromise;
    try {
      await printPage.waitForLoadState('load');
      // The Print View fills itself in after load, so reading it immediately can see an empty body.
      // Best effort only: if the text never arrives, verifyAEPrintContent reports exactly what is
      // missing, which is more useful than a timeout here.
      await printPage
        .locator('body')
        .filter({ hasText: nodePlan.questions[0]!.title })
        .waitFor({ state: 'visible', timeout: this.timeoutMs })
        .catch(() => undefined);
      await verifyAEPrintContent(printPage, nodePlan, uploadedImages);
    } finally {
      await printPage.close();
    }
  }

  private async openActivityFrame(uiid: number, title: string): Promise<Frame> {
    const node = this.page.locator(`#canvas > svg > g.svg-activity-tool[uiid="${uiid}"]`);
    const iframe = this.page.locator('iframe[id^="dialogActivity"]:visible');
    // The dialog's src carries hasLeaderSelection and the grouping flags, so when the surrounding
    // design has just changed LAMS discards the dialog rather than reloading it - the frame
    // detaches and the iframe leaves the DOM. Reopening it from the canvas is the only recovery,
    // so the whole open sequence retries, not just the frame lookup.
    for (let attempt = 1; ; attempt += 1) {
      try {
        // Clicking an activity selects it, so the wiring pass leaves the properties dialog open
        // over the canvas, where it swallows the double-click that opens the editor.
        if (await this.page.locator('#propertiesDialog').isVisible()) {
          await this.page.locator('#canvas').click({ position: { x: 5, y: 5 } });
        }
        if (await iframe.count() === 0) await node.dblclick({ delay: 80 });
        await iframe.waitFor({ state: 'visible', timeout: this.timeoutMs });
        const frame = await childFrame(iframe, this.timeoutMs);
        await frame.locator('#authoringForm').waitFor({ state: 'visible', timeout: this.timeoutMs });
        console.log(`Opened AE Assessment activity: ${title}`);
        return frame;
      } catch (error) {
        const recoverable = error instanceof Error && /detached|Timeout/i.test(error.message);
        if (!recoverable || attempt >= 3) throw error;
        console.log(`Activity dialog for "${title}" went away while opening; reopening (attempt ${attempt + 1}).`);
      }
    }
  }
}

/** Keeps each figure on the side of the question stem the Source-of-Truth printed it. */
export function questionDescriptionHtml(promptHtml: string, images: UploadedImage[]): string {
  const before = imageHtml(images, 'before');
  const after = imageHtml(images, 'after');
  if (before === '') return `${promptHtml}${after}`;
  // A figure printed above the stem still belongs below the case narrative that introduces it
  // ("...the karyotype below:"), so it goes immediately before the numbered stem rather than above
  // the case heading. With no numbered stem to find, it leads the prompt as it reads in the source.
  const stem = /<div>(?=(?:<[^>]+>)*\s*\d+\s*[.)])/i.exec(promptHtml);
  const at = stem?.index ?? 0;
  return `${promptHtml.slice(0, at)}${before}${promptHtml.slice(at)}${after}`;
}

export async function applyAEAnswerScoring(
  frame: Frame,
  question: Pick<AEQuestionPlan, 'title' | 'multipleAnswersAllowed' | 'options'>
): Promise<void> {
  const expectedMode = question.multipleAnswersAllowed ? 'true' : 'false';
  const mode = frame.locator('#multipleAnswersAllowed');
  await mode.selectOption(expectedMode);
  if (await mode.inputValue() !== expectedMode) {
    throw new Error(`Question "${question.title}" did not retain its one-or-multiple-answers setting.`);
  }

  for (let index = 0; index < question.options.length; index += 1) {
    const expected = question.options[index]!.creditPercent / 100;
    const field = frame.locator(`#optionMaxMark${index}`);
    await setHiddenValue(field, expected);
    const actual = Number(await field.inputValue());
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
      throw new Error(`Question "${question.title}" option ${index + 1} did not retain its configured weight.`);
    }
  }
}

async function childFrame(iframe: Locator, timeoutMs: number): Promise<Frame> {
  await iframe.waitFor({ state: 'visible', timeout: timeoutMs });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (!frame) throw new Error('A visible LAMS authoring iframe did not expose its content frame.');
  return frame;
}

async function exactQuestionRow(frame: Frame, title: string): Promise<Locator> {
  const rows = frame.locator('#referencesTable tbody tr');
  const matches: number[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    if (normalize(await rows.nth(index).locator(QUESTION_TITLE).innerText()) === normalize(title)) matches.push(index);
  }
  if (matches.length !== 1) throw new Error(`Expected one AE question row titled "${title}"; found ${matches.length}.`);
  return rows.nth(matches[0]!);
}

async function waitForCkEditor(frame: Frame, id: string): Promise<void> {
  await frame.waitForFunction((editorId) => Boolean((window as typeof window & {
    CKEDITOR?: { instances?: Record<string, unknown> };
  }).CKEDITOR?.instances?.[editorId]), id);
}

async function setCkEditor(frame: Frame, id: string, html: string): Promise<void> {
  await waitForCkEditor(frame, id);
  await frame.evaluate(({ editorId, value }) => {
    const editor = (window as typeof window & {
      CKEDITOR: { instances: Record<string, { setData(data: string): void; fire(name: string): void }> };
    }).CKEDITOR.instances[editorId];
    if (!editor) throw new Error(`CKEditor instance "${editorId}" is missing.`);
    editor.setData(value);
    editor.fire('change');
  }, { editorId: id, value: html });
}

export async function resizeOptions(frame: Frame, expectedCount: number, timeoutMs: number): Promise<void> {
  let count = await frame.locator('.single-option-table').count();
  while (count < expectedCount) {
    await frame.locator('a[onclick*="addOption"]').click();
    count += 1;
    await frame.locator('.single-option-table').nth(count - 1).waitFor({ state: 'visible', timeout: timeoutMs });
  }
  while (count > expectedCount) {
    // qb-option.js removeOption() gates the deletion behind confirm(). Playwright
    // auto-dismisses unhandled dialogs, which silently answered "no" and left the
    // option in place, so the confirmation is accepted explicitly for each removal.
    const page = frame.page();
    const acceptDeletion = (dialog: Dialog) => { void dialog.accept(); };
    page.on('dialog', acceptDeletion);
    try {
      await frame.locator('.single-option-table').nth(count - 1).locator('.delete-button').evaluate((element: HTMLElement) => element.click());
      count -= 1;
      await frame.waitForFunction((value) => document.querySelectorAll('.single-option-table').length === value, count, { timeout: timeoutMs });
    } finally {
      page.off('dialog', acceptDeletion);
    }
  }
}

/**
 * Attempts, passing mark, and several canonical toggles live inside accordion
 * sections that load collapsed, where Playwright never sees them as visible.
 * "Expand all" opens every section through the page's own Bootstrap instances.
 */
export async function expandAuthoringSections(frame: Frame, timeoutMs: number): Promise<void> {
  const expandAll = frame.locator('#expandAllButton');
  await expandAll.waitFor({ state: 'visible', timeout: timeoutMs });
  await expandAll.click();
  await frame.locator('#advancedCollapse').waitFor({ state: 'visible', timeout: timeoutMs });
}

async function setHiddenValue(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((element: HTMLInputElement, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

function uniqueNode(nodes: GraphNode[], name: string, type: GraphNode['type']): GraphNode {
  const matches = nodes.filter((node) => node.name === name && node.type === type);
  if (matches.length !== 1) throw new Error(`Expected one ${type} node named "${name}"; found ${matches.length}.`);
  return matches[0]!;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Compare against browser-decoded text so escaped punctuation matches Print View. */
export async function verifyAEPrintContent(
  printPage: Page,
  nodePlan: AENodePlan,
  uploadedImages: Pick<UploadedImage, 'url' | 'caption'>[]
): Promise<void> {
  const text = normalize(await printPage.locator('body').innerText());
  for (const question of nodePlan.questions) {
    // Block boundaries read as a space; inline emphasis must not, or a
    // superscript such as 10<sup>9</sup> would be compared as "10 9". Authored blocks are divs
    // (CKEditor's Normal (DIV) format); paragraphs stay listed for content authored elsewhere.
    const promptText = await printPage.evaluate(
      (html) =>
        new DOMParser().parseFromString(
          html.replace(/<\/p>|<\/div>|<\/t[dhr]>|<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''),
          'text/html'
        ).body.textContent ?? '',
      question.promptHtml
    );
    const expected = [question.title, promptText, ...question.options.map((option) => option.text)];
    for (const value of expected) {
      if (!text.includes(normalize(value))) {
        throw new Error(
          `AE Print View for "${nodePlan.title}" omitted expected text: "${normalize(value)}". ` +
            `Print View held ${text.length} characters: "${text.slice(0, 300)}".`
        );
      }
    }
  }
  const imageUrls = new Set(
    await printPage.locator('img').evaluateAll((elements) => elements.map((element) => (element as HTMLImageElement).src))
  );
  for (const image of uploadedImages) {
    if (!imageUrls.has(image.url)) throw new Error(`AE Print View for "${nodePlan.title}" omitted uploaded image: ${image.url}`);
    const caption = normalize(inlineHtmlToText(image.caption));
    if (caption !== '' && !text.includes(caption)) {
      throw new Error(`AE Print View for "${nodePlan.title}" omitted the caption for ${image.url}: "${caption}".`);
    }
  }
}
