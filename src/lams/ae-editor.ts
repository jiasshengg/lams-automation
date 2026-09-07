import type { Frame, Locator, Page } from '@playwright/test';
import type { AENodePlan, AEPlan, AEQuestionPlan } from '../ae/plan.js';
import type { QuestionImageAsset } from '../docx/question-images.js';
import { applyAEActivitySettings } from './ae-settings.js';
import { inspectAuthoringGraph, openActivityProperties, type GraphNode } from './authoring.js';
import { imageHtml, uploadCkEditorImages } from './ckeditor-media.js';
import {
  ACTIVITY_DIALOG,
  MAX_MARK_INPUT,
  QUESTION_TITLE,
  REQUIRED_TOGGLE
} from './irat-editor.js';

const QUESTION_MODAL = '#qb-question-authoring-modal';

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
    const title = activityFrame.locator('#assessment\\.title');
    await title.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await title.fill(nodePlan.title);

    const rows = activityFrame.locator('#referencesTable tbody tr');
    const existingCount = await rows.count();
    if (existingCount > nodePlan.questions.length) {
      throw new Error(
        `AE node "${nodePlan.title}" contains ${existingCount} questions but the reviewed plan contains ${nodePlan.questions.length}; automatic question deletion is not supported.`
      );
    }

    const updatedQuestions: string[] = [];
    const createdQuestions: string[] = [];
    const uploadedImageUrls: string[] = [];
    let importedImages = 0;
    for (let index = 0; index < nodePlan.questions.length; index += 1) {
      const question = nodePlan.questions[index]!;
      const assets = this.questionImages.get(question.number) ?? [];
      if (index < existingCount) {
        uploadedImageUrls.push(...await this.editQuestion(activityFrame, index, question, assets));
        updatedQuestions.push(question.title);
      } else {
        uploadedImageUrls.push(...await this.createQuestion(activityFrame, question, assets));
        createdQuestions.push(question.title);
      }
      importedImages += assets.length;
    }

    await applyAEActivitySettings(this.page, { commit: true, actionTimeoutMs: this.timeoutMs });
    await this.applyAttemptSettings(activityFrame);
    await this.verifyPrintView(activityFrame, nodePlan, uploadedImageUrls);
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
    const activity = uniqueNode(graph.nodes, nodeTitle, 'tool');
    const teamSetup = uniqueNode(graph.nodes, teamSetupName, 'grouping');
    await openActivityProperties(this.page, activity.uiid, nodeTitle, this.timeoutMs);
    const field = this.page.locator('#propertiesDialog .propertiesContentFieldGrouping:visible');
    await field.selectOption({ label: teamSetupName });
    await field.blur();
    const saved = uniqueNode((await inspectAuthoringGraph(this.page)).nodes, nodeTitle, 'tool');
    if (!saved.grouped || saved.groupingUiid !== teamSetup.uiid) {
      throw new Error(`AE node "${nodeTitle}" was not associated with Team Setup "${teamSetupName}".`);
    }
  }

  async saveDesign(): Promise<void> {
    await this.page.locator('#saveButton').click();
    await this.page.waitForTimeout(500);
  }

  private async editQuestion(
    activityFrame: Frame,
    rowIndex: number,
    question: AEQuestionPlan,
    images: QuestionImageAsset[]
  ): Promise<string[]> {
    const row = activityFrame.locator('#referencesTable tbody tr').nth(rowIndex);
    await row.locator('.edit-reference-link').click();
    const questionFrame = await childFrame(activityFrame.locator('iframe[src*="editReference.do"]'), this.timeoutMs);
    const uploadedUrls = await this.populateQuestion(questionFrame, question, images, true);
    await activityFrame.locator('iframe[src*="editReference.do"]').waitFor({ state: 'detached', timeout: this.timeoutMs });
    await this.applyReferenceFields(activityFrame, question);
    return uploadedUrls;
  }

  private async createQuestion(
    activityFrame: Frame,
    question: AEQuestionPlan,
    images: QuestionImageAsset[]
  ): Promise<string[]> {
    await activityFrame.locator('#createQuestionDropdown').click();
    await activityFrame.getByRole('button', { name: question.type === 'mcq' ? 'Multiple choice' : 'Essay', exact: true }).click();
    const modal = activityFrame.locator(`${QUESTION_MODAL}.show`);
    await modal.waitFor({ state: 'visible', timeout: this.timeoutMs });
    const questionFrame = await childFrame(modal.locator('iframe'), this.timeoutMs);
    const uploadedUrls = await this.populateQuestion(questionFrame, question, images, false);
    await modal.waitFor({ state: 'hidden', timeout: this.timeoutMs });
    await this.applyReferenceFields(activityFrame, question);
    return uploadedUrls;
  }

  private async populateQuestion(
    frame: Frame,
    question: AEQuestionPlan,
    images: QuestionImageAsset[],
    existing: boolean
  ): Promise<string[]> {
    await frame.locator('#assessmentQuestionForm').waitFor({ state: 'visible', timeout: this.timeoutMs });
    await frame.locator('#title').fill(question.title);
    await waitForCkEditor(frame, 'description');
    const uploaded = await uploadCkEditorImages(this.page, frame, 'description', images);
    await setCkEditor(frame, 'description', `${question.promptHtml}${imageHtml(uploaded)}`);

    const advanced = frame.locator('#advancedSettingsCollapse');
    if (!(await advanced.isVisible())) {
      await frame.locator('[data-bs-target="#advancedSettingsCollapse"]').click();
      await advanced.waitFor({ state: 'visible', timeout: this.timeoutMs });
    }
    const mark = frame.locator('#maxMark');
    await mark.fill(String(question.marks));
    if (question.type === 'mcq') {
      await resizeOptions(frame, question.options.length, this.timeoutMs);
      await frame.locator('#multipleAnswersAllowed').selectOption('false');
      for (let index = 0; index < question.options.length; index += 1) {
        const option = question.options[index]!;
        await setCkEditor(frame, `optionName${index}`, `<p>${escapeHtml(option.text)}</p>`);
        await setHiddenValue(frame.locator(`#optionMaxMark${index}`), option.creditPercent / 100);
      }
    }

    const save = existing ? frame.locator('#saveAsButton') : frame.locator('#saveButton');
    await save.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await save.click();
    return uploaded.map((image) => image.url);
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

  private async verifyPrintView(frame: Frame, nodePlan: AENodePlan, uploadedImageUrls: string[]): Promise<void> {
    const popupPromise = this.page.waitForEvent('popup', { timeout: this.timeoutMs });
    await frame.locator('button[onclick*="showQuestionsPrintPage"]').click();
    const printPage = await popupPromise;
    try {
      await printPage.waitForLoadState('domcontentloaded');
      await verifyAEPrintContent(printPage, nodePlan, uploadedImageUrls);
    } finally {
      await printPage.close();
    }
  }

  private async openActivityFrame(uiid: number, title: string): Promise<Frame> {
    const node = this.page.locator(`#canvas > svg > g.svg-activity-tool[uiid="${uiid}"]`);
    const iframe = this.page.locator('iframe[id^="dialogActivity"]:visible');
    if (await iframe.count() === 0) await node.dblclick({ delay: 80 });
    await iframe.waitFor({ state: 'visible', timeout: this.timeoutMs });
    const frame = await childFrame(iframe, this.timeoutMs);
    await frame.locator('#authoringForm').waitFor({ state: 'visible', timeout: this.timeoutMs });
    console.log(`Opened AE Assessment activity: ${title}`);
    return frame;
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

async function resizeOptions(frame: Frame, expectedCount: number, timeoutMs: number): Promise<void> {
  let count = await frame.locator('.single-option-table').count();
  while (count < expectedCount) {
    await frame.locator('a[onclick*="addOption"]').click();
    count += 1;
    await frame.locator('.single-option-table').nth(count - 1).waitFor({ state: 'visible', timeout: timeoutMs });
  }
  while (count > expectedCount) {
    await frame.locator('.single-option-table').nth(count - 1).locator('.delete-button').evaluate((element: HTMLElement) => element.click());
    count -= 1;
    await frame.waitForFunction((value) => document.querySelectorAll('.single-option-table').length === value, count, { timeout: timeoutMs });
  }
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
}

/** Compare against browser-decoded text so escaped punctuation matches Print View. */
export async function verifyAEPrintContent(printPage: Page, nodePlan: AENodePlan, uploadedImageUrls: string[]): Promise<void> {
  const text = normalize(await printPage.locator('body').innerText());
  for (const question of nodePlan.questions) {
    const promptText = await printPage.evaluate(
      (html) => new DOMParser().parseFromString(html.replace(/<[^>]*>/g, ' '), 'text/html').body.textContent ?? '',
      question.promptHtml
    );
    const expected = [question.title, promptText, ...question.options.map((option) => option.text)];
    for (const value of expected) {
      if (!text.includes(normalize(value))) throw new Error(`AE Print View for "${nodePlan.title}" omitted expected text: "${normalize(value)}".`);
    }
  }
  const imageUrls = new Set(
    await printPage.locator('img').evaluateAll((elements) => elements.map((element) => (element as HTMLImageElement).src))
  );
  for (const url of uploadedImageUrls) {
    if (!imageUrls.has(url)) throw new Error(`AE Print View for "${nodePlan.title}" omitted uploaded image: ${url}`);
  }
}
