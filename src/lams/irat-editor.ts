import type { Frame, Locator, Page } from '@playwright/test';
import type { IratQuestionRequest, IratRequest } from '../config.js';
import { inspectAuthoringGraph, type AuthoringGraph, type GraphNode } from './authoring.js';
import type { IratEditor, IratObservedQuestion, IratObservedState } from './irat.js';
import { findUniqueCheckbox } from './ae-settings.js';

/**
 * Live adapter for the LAMS Assessment authoring UI.
 *
 * Authoring-canvas selectors were captured from the playground instance. The
 * Assessment selectors come from the LAMS v4.8 authoring JSPs and are scoped
 * to the visible activity/question frames before use.
 */
export class LamsIratEditor implements IratEditor {
  private activityFrame: Frame | undefined;

  constructor(
    private readonly page: Page,
    private readonly request: IratRequest,
    private readonly timeoutMs: number
  ) {}

  async inspect(): Promise<IratObservedState> {
    const graph = await inspectAuthoringGraph(this.page);
    const gate = uniqueGraphNode(graph, this.request.gate.name, 'gate');
    const activity = uniqueGraphNode(graph, this.request.activityName, 'tool');
    const teamSetup = uniqueGraphNode(graph, this.request.teamSetupName, 'grouping');
    const questions = await this.inspectQuestionsAndClose(activity);
    return {
      gate: {
        name: gate.name,
        description: gate.description,
        type: gate.gateType,
        dynamicPassword: gate.dynamicPassword,
        rotationSeconds: gate.rotationSeconds
      },
      activityName: activity.name,
      teamSetupAssociated: activity.grouped && activity.groupingUiid === teamSetup.uiid,
      questions
    };
  }

  async updateGate(gate: IratRequest['gate']): Promise<void> {
    const graph = await inspectAuthoringGraph(this.page);
    const node = uniqueGraphNode(graph, gate.name, 'gate');
    await this.canvasNode(node).click();
    const dialog = this.page.locator('#propertiesDialog:visible');
    await dialog.waitFor({ state: 'visible', timeout: this.timeoutMs });

    await dialog.locator('.propertiesContentFieldTitle').fill(gate.name);
    await dialog.locator('.propertiesContentFieldDescription').fill(gate.description);
    await dialog.locator('.propertiesContentFieldGateType').selectOption(gate.type);
    await setCheckbox(dialog.locator('.propertiesContentFieldPasswordDynamic'), gate.dynamicPassword);
    if (gate.dynamicPassword) {
      await dialog.locator('.propertiesContentFieldPasswordDynamicSeconds').selectOption(String(gate.rotationSeconds));
    }
    await dialog.locator('.propertiesContentFieldPasswordDynamicSeconds').blur();

    const updated = uniqueGraphNode(await inspectAuthoringGraph(this.page), gate.name, 'gate');
    if (
      updated.description !== gate.description ||
      updated.gateType !== gate.type ||
      updated.dynamicPassword !== gate.dynamicPassword ||
      (gate.dynamicPassword && updated.rotationSeconds !== gate.rotationSeconds)
    ) {
      throw new Error(`iRAT Gate controls did not retain the configured values for "${gate.name}".`);
    }
  }

  async associateWithTeamSetup(teamSetupName: string): Promise<void> {
    const graph = await inspectAuthoringGraph(this.page);
    const activity = uniqueGraphNode(graph, this.request.activityName, 'tool');
    const teamSetup = uniqueGraphNode(graph, teamSetupName, 'grouping');
    await this.canvasNode(activity).click();
    const dialog = this.page.locator('#propertiesDialog:visible');
    await dialog.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await dialog.locator('.propertiesContentFieldGrouping').selectOption({ label: teamSetupName });
    await dialog.locator('.propertiesContentFieldGrouping').blur();

    const updated = uniqueGraphNode(await inspectAuthoringGraph(this.page), this.request.activityName, 'tool');
    if (!updated.grouped || updated.groupingUiid !== teamSetup.uiid) {
      throw new Error(`iRAT was not associated with "${teamSetupName}" after selecting it.`);
    }
  }

  async updateQuestion(question: IratQuestionRequest): Promise<void> {
    if (question.type !== 'multiple-choice') {
      throw new Error(`Live iRAT editing supports only multiple-choice questions; found "${question.type}".`);
    }
    const frame = await this.ensureActivityFrame();
    const row = await exactQuestionRow(frame, question.title);
    await row.locator('.edit-reference-link').click();
    const questionFrame = await waitForChildFrame(frame, '#TB_iframeContent', this.timeoutMs);
    await questionFrame.locator('#assessmentQuestionForm').waitFor({ state: 'visible', timeout: this.timeoutMs });

    await questionFrame.locator('#title').fill(question.title);
    await setCkEditor(questionFrame, 'description', formattedHtml(question.content, question.fontFamily, question.fontSize));
    await resizeOptions(questionFrame, question.answers.length, this.timeoutMs);
    await questionFrame.locator('#multipleAnswersAllowed').selectOption(
      question.answers.filter((answer) => answer.correct).length > 1 ? 'true' : 'false'
    );

    for (let index = 0; index < question.answers.length; index += 1) {
      const answer = question.answers[index]!;
      await setCkEditor(questionFrame, `optionName${index}`, formattedHtml(answer.text, question.fontFamily, question.fontSize));
      await setHiddenValue(questionFrame.locator(`#optionMaxMark${index}`), answer.weight / 100);
    }

    // The guide checks "Default question grade" per question (1 for iRAT). No stable id
    // was observed, so it is matched by its visible label and read back.
    const gradeField = questionFrame.getByLabel('Default question grade', { exact: false }).first();
    await gradeField.fill(String(question.marks));
    if ((await gradeField.inputValue()).trim() !== String(question.marks)) {
      throw new Error(`Default question grade for "${question.title}" did not accept ${question.marks}.`);
    }
    await questionFrame.locator('#saveAsButton').click();
    await frame.locator('#TB_iframeContent').waitFor({ state: 'detached', timeout: this.timeoutMs });
    const updatedRow = await exactQuestionRow(frame, question.title);
    const requiredIcon = updatedRow.locator('.fa-asterisk');
    const isMandatory = await requiredIcon.evaluate((element) => element.classList.contains('text-danger'));
    if (isMandatory !== question.mandatory) await requiredIcon.click();
    await waitForMandatoryState(frame, question.title, question.mandatory, this.timeoutMs);
  }

  async updateAdvancedSettings(settings: IratRequest['advanced']): Promise<void> {
    const frame = await this.ensureActivityFrame();
    await frame.locator('[role="tab"], a').filter({ hasText: /^Advanced$/i }).first().click();
    await frame.locator('#shuffledAnswers').waitFor({ state: 'visible', timeout: this.timeoutMs });
    await setCheckbox(frame.locator('#shuffledAnswers'), settings.shuffleAnswers);
    if (settings.displayAllQuestions) {
      await frame.locator('#questionDistributionTypeAll').check();
    } else {
      throw new Error('The live adapter currently requires displayAllQuestions=true; no alternative distribution was supplied.');
    }
    await setCheckbox(frame.locator('#allowAnswerJustification'), settings.answerJustification);
    await setCheckbox(frame.locator('#enable-confidence-levels'), settings.confidenceLevels);
    // The deployment guide turns these two on for iRAT (the inverse of AE). No stable id
    // was observed for them, so they are matched by their visible label, like the AE
    // activity settings, and read back rather than assumed.
    await this.setLabelledToggle('Shuffle questions', settings.shuffleQuestions);
    await this.setLabelledToggle("Enable questions' numbering", settings.questionsNumbering);
  }

  private async setLabelledToggle(label: string, expected: boolean): Promise<void> {
    const { locator } = await findUniqueCheckbox(this.page, label, this.timeoutMs);
    await setCheckbox(locator, expected);
    if ((await locator.isChecked()) !== expected) {
      throw new Error(`Checkbox "${label}" did not remain ${expected ? 'enabled' : 'disabled'}.`);
    }
  }

  async verifyPrintView(request: IratRequest): Promise<void> {
    const frame = await this.ensureActivityFrame();
    await frame.locator('[role="tab"], a').filter({ hasText: /^Basic$/i }).first().click();
    const popupPromise = this.page.waitForEvent('popup', { timeout: this.timeoutMs });
    await frame.locator('button[onclick*="showQuestionsPrintPage"]').click();
    const printPage = await popupPromise;
    try {
      await printPage.waitForLoadState('domcontentloaded');
      const printableText = normalizeText(await printPage.locator('body').innerText());
      for (const question of request.questions) {
        for (const expected of [question.title, stripHtml(question.content), ...question.answers.map((answer) => stripHtml(answer.text))]) {
          if (!printableText.includes(normalizeText(expected))) {
            throw new Error(`Print View did not contain expected iRAT text: "${normalizeText(expected)}".`);
          }
        }
      }
    } finally {
      await printPage.close();
    }
  }

  async save(): Promise<void> {
    const frame = await this.ensureActivityFrame();
    const dialogHandler = async (dialog: { message(): string; accept(): Promise<void>; dismiss(): Promise<void> }) => {
      if (/sync|matching rat/i.test(dialog.message())) await dialog.dismiss();
      else await dialog.accept();
    };
    this.page.on('dialog', dialogHandler);
    try {
      await frame.locator('#saveButton').click();
      await this.page.locator('iframe[id^="dialogActivity"]').waitFor({ state: 'detached', timeout: this.timeoutMs });
    } finally {
      this.page.off('dialog', dialogHandler);
      this.activityFrame = undefined;
    }

    await this.page.locator('#saveButton').click();
    await this.page.waitForTimeout(500);
    const graph = await inspectAuthoringGraph(this.page);
    const gate = uniqueGraphNode(graph, this.request.gate.name, 'gate');
    if (
      gate.gateType !== this.request.gate.type ||
      gate.description !== this.request.gate.description ||
      gate.dynamicPassword !== this.request.gate.dynamicPassword ||
      gate.rotationSeconds !== this.request.gate.rotationSeconds
    ) {
      throw new Error('Post-save graph verification failed for the iRAT Gate.');
    }
  }

  private async inspectQuestionsAndClose(activity: GraphNode): Promise<IratObservedQuestion[]> {
    const frame = await this.openActivityFrame(activity);
    const rows = frame.locator('#referencesTable tbody tr');
    await rows.first().waitFor({ state: 'visible', timeout: this.timeoutMs });
    const questions: IratObservedQuestion[] = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      questions.push({
        title: normalizeText(await row.locator('td').nth(1).innerText()),
        type: normalizeQuestionType(await row.locator('.question-type-alert').innerText()),
        mandatory: await row.locator('.fa-asterisk').evaluate((element) => element.classList.contains('text-danger'))
      });
    }

    this.page.once('dialog', async (dialog) => dialog.accept());
    await frame.locator('#cancelButton').click();
    await this.page.locator('iframe[id^="dialogActivity"]').waitFor({ state: 'detached', timeout: this.timeoutMs });
    this.activityFrame = undefined;
    return questions;
  }

  private async ensureActivityFrame(): Promise<Frame> {
    if (this.activityFrame && !this.activityFrame.isDetached()) return this.activityFrame;
    const graph = await inspectAuthoringGraph(this.page);
    return this.openActivityFrame(uniqueGraphNode(graph, this.request.activityName, 'tool'));
  }

  private async openActivityFrame(activity: GraphNode): Promise<Frame> {
    await this.canvasNode(activity).dblclick({ delay: 80 });
    const iframe = this.page.locator('iframe[id^="dialogActivity"]:visible');
    await iframe.waitFor({ state: 'visible', timeout: this.timeoutMs });
    const frame = await (await iframe.elementHandle())?.contentFrame();
    if (!frame) throw new Error(`The authoring iframe for "${activity.name}" was not available.`);
    await frame.locator('#authoringForm').waitFor({ state: 'visible', timeout: this.timeoutMs });
    this.activityFrame = frame;
    return frame;
  }

  private canvasNode(node: GraphNode): Locator {
    return this.page.locator(`#canvas > svg > g.svg-activity[uiid="${node.uiid}"]`);
  }
}

function uniqueGraphNode(graph: AuthoringGraph, name: string, type: GraphNode['type']): GraphNode {
  const matches = graph.nodes.filter((node) => node.name === name && node.type === type);
  if (matches.length !== 1) throw new Error(`Expected one ${type} node named "${name}"; found ${matches.length}.`);
  return matches[0]!;
}

async function exactQuestionRow(frame: Frame, title: string): Promise<Locator> {
  const rows = frame.locator('#referencesTable tbody tr');
  const matchingIndexes: number[] = [];
  for (let index = 0; index < (await rows.count()); index += 1) {
    if (normalizeText(await rows.nth(index).locator('td').nth(1).innerText()) === normalizeText(title)) matchingIndexes.push(index);
  }
  if (matchingIndexes.length !== 1) throw new Error(`Expected one iRAT question named "${title}"; found ${matchingIndexes.length}.`);
  return rows.nth(matchingIndexes[0]!);
}

async function waitForChildFrame(parent: Frame, selector: string, timeoutMs: number): Promise<Frame> {
  const iframe = parent.locator(selector);
  await iframe.waitFor({ state: 'visible', timeout: timeoutMs });
  const frame = await (await iframe.elementHandle())?.contentFrame();
  if (!frame) throw new Error(`Frame "${selector}" was visible but unavailable.`);
  return frame;
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

async function setCkEditor(frame: Frame, id: string, html: string): Promise<void> {
  await frame.waitForFunction(
    (editorId) => Boolean((window as typeof window & { CKEDITOR?: { instances?: Record<string, { status?: string }> } }).CKEDITOR?.instances?.[editorId]),
    id
  );
  await frame.evaluate(
    ({ editorId, value }) => {
      const editor = (window as typeof window & {
        CKEDITOR: { instances: Record<string, { setData(data: string): void; fire(name: string): void }> };
      }).CKEDITOR.instances[editorId];
      if (!editor) throw new Error(`CKEditor instance "${editorId}" is missing.`);
      editor.setData(value);
      editor.fire('change');
    },
    { editorId: id, value: html }
  );
}

async function setHiddenValue(locator: Locator, value: number): Promise<void> {
  await locator.evaluate((element: HTMLInputElement, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function setCheckbox(locator: Locator, checked: boolean): Promise<void> {
  if ((await locator.isChecked()) !== checked) {
    if (checked) await locator.check();
    else await locator.uncheck();
  }
}

async function waitForMandatoryState(frame: Frame, title: string, mandatory: boolean, timeoutMs: number): Promise<void> {
  await frame.waitForFunction(
    ({ expectedTitle, expectedMandatory }) => {
      const rows = Array.from(document.querySelectorAll('#referencesTable tbody tr'));
      const row = rows.find((candidate) => {
        const cell = candidate.querySelectorAll('td')[1];
        return (cell?.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedTitle.replace(/\s+/g, ' ').trim();
      });
      return row?.querySelector('.fa-asterisk')?.classList.contains('text-danger') === expectedMandatory;
    },
    { expectedTitle: title, expectedMandatory: mandatory },
    { timeout: timeoutMs }
  );
}

function formattedHtml(value: string, fontFamily: string, fontSize: number): string {
  return `<span style="font-family:${escapeHtml(fontFamily)};font-size:${fontSize}px">${escapeHtml(stripHtml(value))}</span>`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeQuestionType(value: string): string {
  return /multiple\s*choice/i.test(value) ? 'multiple-choice' : normalizeText(value).toLowerCase();
}
