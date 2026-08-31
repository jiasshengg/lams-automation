import type { Frame, Locator, Page } from '@playwright/test';
import type { IratQuestionRequest, IratRequest } from '../config.js';
import { inspectAuthoringGraph, openActivityProperties, type AuthoringGraph, type GraphNode } from './authoring.js';
import type { IratEditor, IratObservedQuestion, IratObservedState } from './irat.js';

/**
 * Live adapter for the LAMS Assessment authoring UI.
 *
 * Authoring-canvas selectors were captured from the playground instance. The
 * Assessment selectors come from the LAMS v4.8 authoring JSPs and are scoped
 * to the visible activity/question frames before use.
 */
/**
 * Live LAMS Assessment reference-row selectors, captured from the authenticated
 * authoring iframe of a real TBL lesson (artifacts/*-irat-question-inspection-failure).
 *
 * The row's second cell holds the display order ("1)"), so the question title lives in
 * the question cell's bold span rather than in a fixed `td` index. The type is a
 * Bootstrap badge, not a ".question-type-alert" — that class does not exist in this
 * markup. "Answer required" is toggled by, and read from, the BUTTON that calls
 * toggleQuestionRequired(this): its own inline handler does hasClass('text-danger') on
 * that button, and toggles text-danger/text-muted there, not on the inner <i> icon.
 */
export const QUESTION_TITLE = 'td .fw-semibold';
export const QUESTION_TYPE_BADGE = 'td .badge.bg-primary-subtle';
export const REQUIRED_TOGGLE = 'button[onclick*="toggleQuestionRequired"]';
export const MAX_MARK_INPUT = 'input.max-mark-input';
/**
 * The question editor opens as an unnamed iframe inside the activity frame. This LAMS
 * build no longer uses ThickBox, so "#TB_iframeContent" never appears; the iframe is
 * addressed by its stable editReference.do source instead.
 */
export const QUESTION_EDITOR_IFRAME = 'iframe[src*="editReference.do"]';
/**
 * The tool activity opens in a Bootstrap modal on the parent authoring page, whose only
 * dismissal control is the header close button. The frame itself exposes no cancel.
 */
export const ACTIVITY_DIALOG_CLOSE = '.modal.dialogContainer.show[id^="dialogActivity"] .modal-header .btn-close';
/**
 * Dismissing that modal only removes its "show" class and hides it; LAMS leaves the
 * activity iframe attached, so completion is confirmed by the dialog no longer showing.
 */
// Other LAMS modals (notably #propertiesDialog) keep a stale "show" class while hidden,
// so the activity dialog is addressed by its dialogActivity id prefix as well.
export const ACTIVITY_DIALOG = '.modal.dialogContainer.show[id^="dialogActivity"]';
/** "Continue" in the frame's own "Confirm Cancel" modal, raised when closing unsaved work. */
export const CANCEL_CONFIRM = '#authoringCancelModalConfirm';

/**
 * Every iRAT advanced setting has a stable id in the activity frame's markup. The labels
 * wrap a description block, which makes label-based matching brittle, so ids are used.
 */
export const ADVANCED_TOGGLES = {
  shuffleQuestions: '#shuffled',
  shuffleAnswers: '#shuffledAnswers',
  questionsNumbering: '#questions-numbering',
  answerJustification: '#allowAnswerJustification',
  confidenceLevels: '#enable-confidence-levels'
} as const;

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
    // The properties panel is a floating, semi-transparent modal that stays over the
    // canvas after use, so a real click on a node is intercepted. openActivityProperties
    // dispatches the event directly and waits for the panel to switch to this activity.
    await openActivityProperties(this.page, node.uiid, gate.name, this.timeoutMs);
    const dialog = this.page.locator('#propertiesDialog');

    await visibleField(dialog, '.propertiesContentFieldTitle').fill(gate.name);
    await visibleField(dialog, '.propertiesContentFieldDescription').fill(gate.description);
    await visibleField(dialog, '.propertiesContentFieldGateType').selectOption(gate.type);
    await setCheckbox(visibleField(dialog, '.propertiesContentFieldPasswordDynamic'), gate.dynamicPassword);
    if (gate.dynamicPassword) {
      await visibleField(dialog, '.propertiesContentFieldPasswordDynamicSeconds').selectOption(String(gate.rotationSeconds));
    }
    await visibleField(dialog, '.propertiesContentFieldPasswordDynamicSeconds').blur();

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
    await openActivityProperties(this.page, activity.uiid, this.request.activityName, this.timeoutMs);
    const dialog = this.page.locator('#propertiesDialog');
    await visibleField(dialog, '.propertiesContentFieldGrouping').selectOption({ label: teamSetupName });
    await visibleField(dialog, '.propertiesContentFieldGrouping').blur();

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
    const questionFrame = await waitForChildFrame(frame, QUESTION_EDITOR_IFRAME, this.timeoutMs);
    await questionFrame.locator('#assessmentQuestionForm').waitFor({ state: 'visible', timeout: this.timeoutMs });

    // "Default question grade" and "One or multiple answers?" both live inside the
    // collapsed "Advanced settings" accordion, so it is expanded before either is set.
    const advanced = questionFrame.locator('#advancedSettingsCollapse');
    if (!(await advanced.isVisible())) {
      await questionFrame.locator('[data-bs-target="#advancedSettingsCollapse"]').click();
      await advanced.waitFor({ state: 'visible', timeout: this.timeoutMs });
    }

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

    // Both the grade and the answer-count select live in the same accordion, expanded above.
    const gradeField = questionFrame.locator('#maxMark');
    await gradeField.fill(String(question.marks));
    if ((await gradeField.inputValue()).trim() !== String(question.marks)) {
      throw new Error(`Default question grade for "${question.title}" did not accept ${question.marks}.`);
    }

    // LAMS reveals "Save as new version" only once the question is dirty, and only that
    // control forks a new question-bank version. Plain Save rewrites the shared question
    // in place, which would also change the source lesson this copy came from, so the run
    // stops rather than falling back to it.
    const saveAsNewVersion = questionFrame.locator('#saveAsButton');
    try {
      await saveAsNewVersion.waitFor({ state: 'visible', timeout: this.timeoutMs });
    } catch {
      throw new Error(
        `"Save as new version" never appeared for "${question.title}"; refusing to save the shared question in place.`
      );
    }
    await saveAsNewVersion.click();
    await frame.locator(QUESTION_EDITOR_IFRAME).waitFor({ state: 'detached', timeout: this.timeoutMs });
    const updatedRow = await exactQuestionRow(frame, question.title);

    // The visible "Mark" column is the assessment reference's own maxMark input, which is
    // separate from the question bank's default grade set inside the editor dialog. The
    // deployment guide's per-question mark is what learners are scored on, so set both.
    const markInput = updatedRow.locator(MAX_MARK_INPUT);
    if (Number(await markInput.inputValue()) !== question.marks) {
      await markInput.fill(String(question.marks));
      await markInput.blur();
    }
    if (Number(await markInput.inputValue()) !== question.marks) {
      throw new Error(`Mark for "${question.title}" did not accept ${question.marks}.`);
    }

    // LAMS renders no required-state class on load: text-danger/text-muted are written
    // only by toggleQuestionRequired's AJAX callback, so the stored value is unreadable
    // until the toggle is exercised. Clicking is therefore treated as a probe — the class
    // that comes back is authoritative, and a second click converges when the stored value
    // already differed from what the class implied. Without this, re-running the workflow
    // would silently invert every question's "answer required" flag.
    const requiredToggle = updatedRow.locator(REQUIRED_TOGGLE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observed = await requiredToggle.evaluate((element) =>
        element.classList.contains('text-danger') ? true : element.classList.contains('text-muted') ? false : null
      );
      if (observed === question.mandatory) break;
      await requiredToggle.click();
      await waitForToggleResponse(requiredToggle, this.timeoutMs);
    }
    await waitForMandatoryState(frame, question.title, question.mandatory, this.timeoutMs);
  }

  async updateAdvancedSettings(settings: IratRequest['advanced']): Promise<void> {
    const frame = await this.ensureActivityFrame();
    // The activity page is a set of collapsible cards, not tabs, so every setting is
    // revealed with "Expand all" before it is set. Each toggle carries a stable id in
    // this markup, so none of them needs to be matched by its visible label.
    await frame.locator('#expandAllButton').click();
    await frame.locator(ADVANCED_TOGGLES.shuffleAnswers).waitFor({ state: 'visible', timeout: this.timeoutMs });

    if (!settings.displayAllQuestions) {
      throw new Error('The live adapter currently requires displayAllQuestions=true; no alternative distribution was supplied.');
    }
    await frame.locator('#questionDistributionTypeAll').check();

    for (const [key, selector] of Object.entries(ADVANCED_TOGGLES)) {
      const expected = settings[key as keyof IratRequest['advanced']];
      const toggle = frame.locator(selector);
      await setCheckbox(toggle, expected);
      if ((await toggle.isChecked()) !== expected) {
        throw new Error(`Advanced setting "${key}" did not remain ${expected ? 'enabled' : 'disabled'}.`);
      }
    }
  }

  async verifyPrintView(request: IratRequest): Promise<void> {
    const frame = await this.ensureActivityFrame();
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
    await this.page.locator(ACTIVITY_DIALOG).waitFor({ state: 'hidden', timeout: this.timeoutMs });
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
        title: normalizeText(await row.locator(QUESTION_TITLE).innerText()),
        type: normalizeQuestionType(await row.locator(QUESTION_TYPE_BADGE).innerText()),
        mandatory: await row.locator(REQUIRED_TOGGLE).evaluate((element) => element.classList.contains('text-danger'))
      });
    }

    // The activity authoring frame exposes only a Save control. Its dialog is a Bootstrap
    // modal owned by the parent authoring page, so it is dismissed from the modal header.
    // That routes into the frame's doCancel(), which raises an in-frame "Confirm Cancel"
    // modal; discarding the unchanged inspection requires confirming it.
    await this.page.locator(ACTIVITY_DIALOG_CLOSE).click();
    const confirmDiscard = frame.locator(CANCEL_CONFIRM);
    try {
      await confirmDiscard.waitFor({ state: 'visible', timeout: this.timeoutMs });
      await confirmDiscard.click();
    } catch {
      // Some activities close without prompting; the dialog check below is authoritative.
    }
    await this.page.locator(ACTIVITY_DIALOG).waitFor({ state: 'hidden', timeout: this.timeoutMs });
    this.activityFrame = undefined;
    return questions;
  }

  private async ensureActivityFrame(): Promise<Frame> {
    if (this.activityFrame && !this.activityFrame.isDetached()) return this.activityFrame;
    const graph = await inspectAuthoringGraph(this.page);
    return this.openActivityFrame(uniqueGraphNode(graph, this.request.activityName, 'tool'));
  }

  private async openActivityFrame(activity: GraphNode): Promise<Frame> {
    // A real double click is what LAMS binds to; a dispatched dblclick carries detail 0
    // and its handler ignores it. The floating properties panel can cover the node, so it
    // is dismissed first when it is showing.
    await this.dismissPropertiesDialog();
    await this.canvasNode(activity).dblclick({ delay: 80 });
    const iframe = this.page.locator('iframe[id^="dialogActivity"]:visible');
    await iframe.waitFor({ state: 'visible', timeout: this.timeoutMs });
    const frame = await (await iframe.elementHandle())?.contentFrame();
    if (!frame) throw new Error(`The authoring iframe for "${activity.name}" was not available.`);
    await frame.locator('#authoringForm').waitFor({ state: 'visible', timeout: this.timeoutMs });
    this.activityFrame = frame;
    return frame;
  }

  /**
   * The properties panel has no close control: LAMS hides it when the canvas background is
   * clicked. It is only dismissed when actually showing, and the canvas click selects
   * nothing, so no activity is moved, opened, or changed.
   */
  private async dismissPropertiesDialog(): Promise<void> {
    const dialog = this.page.locator('#propertiesDialog');
    if (!(await dialog.isVisible())) return;
    await this.page.locator('#canvas').click({ position: { x: 5, y: 5 } });
    await dialog.waitFor({ state: 'hidden', timeout: this.timeoutMs }).catch(() => undefined);
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
    if (normalizeText(await rows.nth(index).locator(QUESTION_TITLE).innerText()) === normalizeText(title)) matchingIndexes.push(index);
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
        const cell = candidate.querySelector('td .fw-semibold');
        return (cell?.textContent ?? '').replace(/\s+/g, ' ').trim() === expectedTitle.replace(/\s+/g, ' ').trim();
      });
      const toggle = row?.querySelector('button[onclick*="toggleQuestionRequired"]');
      return toggle ? toggle.classList.contains('text-danger') === expectedMandatory : false;
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


/**
 * The properties panel keeps one field set per activity in the DOM and lays out only the
 * active one, so a bare class selector matches stale siblings. Only the visible field
 * belongs to the activity the panel is currently showing.
 */
function visibleField(dialog: Locator, className: string): Locator {
  return dialog.locator(className).filter({ visible: true }).first();
}

/** Waits for toggleQuestionRequired's callback to stamp the resulting state on the button. */
async function waitForToggleResponse(toggle: Locator, timeoutMs: number): Promise<void> {
  await toggle
    .evaluate(
      (element) =>
        new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 10_000;
          const poll = () => {
            if (element.classList.contains('text-danger') || element.classList.contains('text-muted')) resolve();
            else if (Date.now() > deadline) reject(new Error('no toggle response'));
            else setTimeout(poll, 50);
          };
          poll();
        }),
      undefined,
      { timeout: timeoutMs }
    )
    .catch(() => undefined);
}