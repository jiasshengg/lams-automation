import type { Dialog, Frame, Locator, Page } from '@playwright/test';
import type { IratQuestionRequest, IratRequest } from '../config.js';
import { inspectAuthoringGraph, openActivityProperties, type AuthoringGraph, type GraphNode } from './authoring.js';
import { matchingTratRequest, type IratEditor, type IratObservedQuestion, type IratObservedState } from './irat.js';
import type { QuestionImageAsset } from '../docx/question-images.js';
import { imageHtml, uploadCkEditorImages } from './ckeditor-media.js';
import { applyTratAdvancedSettings, DEFAULT_TRAT_ADVANCED_SETTINGS } from './trat-settings.js';

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
 *
 * Two class families carry that state, and both must be read. The server renders the
 * stored value as btn-outline-danger (required) or btn-outline-secondary (optional)
 * every time the reference list is drawn. toggleQuestionRequired's AJAX callback never
 * touches those; it stamps text-danger/text-muted on top of them, and only when the
 * server's reply matches the state it expected — a mismatched reply leaves no class at
 * all. The stamped class is therefore newer than the rendered one and wins.
 */
export const QUESTION_TITLE = 'td .fw-semibold';
export const QUESTION_TYPE_BADGE = 'td .badge.bg-primary-subtle';
export const REQUIRED_TOGGLE = 'button[onclick*="toggleQuestionRequired"]';
export const MAX_MARK_INPUT = 'input.max-mark-input';

/**
 * Reads one "Answer required" button's state from whichever class family is present.
 * Returns null only when the button carries neither, which happens when a toggle's AJAX
 * reply disagreed with the state the handler predicted.
 */
export function readRequiredState(element: Element): boolean | null {
  if (element.classList.contains('text-danger')) return true;
  if (element.classList.contains('text-muted')) return false;
  if (element.classList.contains('btn-outline-danger')) return true;
  if (element.classList.contains('btn-outline-secondary')) return false;
  return null;
}

/** Clicks needed to converge when LAMS leaves a toggle's state unconfirmed. */
const REQUIRED_TOGGLE_ATTEMPTS = 3;
/**
 * The question editor opens as an unnamed iframe inside the activity frame. This LAMS
 * build no longer uses ThickBox, so "#TB_iframeContent" never appears; the iframe is
 * addressed by its stable editReference.do source instead.
 */
export const QUESTION_EDITOR_IFRAME = 'iframe[src*="editReference.do"]';
/** Observed via Create question → Multiple choice on 2026-09-11 (test iRAT).
 * Creation uses initNewReference.do and plain Save inside the question-bank modal.
 */
export const NEW_QUESTION_IFRAME = '#qb-question-authoring-modal.show iframe[src*="initNewReference.do"]';
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
/**
 * Feedback & Results checkbox. No captured iRAT markup records its id, so it is located by
 * the label text the AE adapter already resolves live in the same Assessment tool.
 */
export const DISPLAY_ALL_AFTER_COMPLETION_LABEL = 'Display all questions and answers once the student finishes';

export class LamsIratEditor implements IratEditor {
  private activityFrame: Frame | undefined;
  private readonly uploadedImageUrls = new Set<string>();
  /** Messages of the browser prompts confirmed while saving, e.g. the tRAT update question. */
  readonly confirmedDialogs: string[] = [];

  constructor(
    private readonly page: Page,
    private readonly request: IratRequest,
    private readonly timeoutMs: number,
    private readonly questionImages: Map<string, QuestionImageAsset[]> = new Map()
  ) {}

  async inspect(): Promise<IratObservedState> {
    const graph = await inspectAuthoringGraph(this.page);
    const gate = uniqueGraphNode(graph, this.request.gate.name, 'gate');
    const activity = uniqueGraphNode(graph, this.request.activityName, 'tool');
    const teamSetup = uniqueGraphNode(graph, this.request.teamSetupName, 'grouping');
    const trat = uniqueGraphNode(graph, matchingTratRequest(this.request).activityName, 'tool');
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
      tratActivityName: trat.name,
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
    await this.writeQuestion(question, true);
  }

  async createQuestion(question: IratQuestionRequest): Promise<void> {
    await this.writeQuestion(question, false);
  }

  private async writeQuestion(question: IratQuestionRequest, existing: boolean): Promise<void> {
    if (question.type !== 'multiple-choice') {
      throw new Error(`Live iRAT editing supports only multiple-choice questions; found "${question.type}".`);
    }
    const frame = await this.ensureActivityFrame();
    const previousTitles = await questionTitles(frame);
    const matches = previousTitles.filter((title) => title === normalizeText(question.title)).length;
    if (matches !== (existing ? 1 : 0)) {
      throw new Error(`Expected ${existing ? 'one existing' : 'no existing'} question named "${question.title}"; found ${matches}.`);
    }
    if (existing) {
      const row = await exactQuestionRow(frame, question.title);
      await row.locator('.edit-reference-link').click();
    } else {
      await frame.getByRole('button', { name: 'Create question', exact: true }).click();
      await frame.getByRole('button', { name: 'Multiple choice', exact: true }).click();
    }
    const editorSelector = existing ? QUESTION_EDITOR_IFRAME : NEW_QUESTION_IFRAME;
    const questionFrame = await waitForChildFrame(frame, editorSelector, this.timeoutMs);
    await questionFrame.locator('#assessmentQuestionForm').waitFor({ state: 'visible', timeout: this.timeoutMs });

    // "Default question grade" and "One or multiple answers?" both live inside the
    // collapsed "Advanced settings" accordion, so it is expanded before either is set.
    const advanced = questionFrame.locator('#advancedSettingsCollapse');
    if (!(await advanced.isVisible())) {
      await questionFrame.locator('[data-bs-target="#advancedSettingsCollapse"]').click();
      await advanced.waitFor({ state: 'visible', timeout: this.timeoutMs });
    }

    await questionFrame.locator('#title').fill(question.title);
    await waitForCkEditor(questionFrame, 'description');
    const uploaded = await uploadCkEditorImages(
      questionFrame,
      'description',
      this.questionImages.get(question.title) ?? []
    );
    uploaded.forEach((image) => this.uploadedImageUrls.add(image.url));
    await setCkEditor(questionFrame, 'description', `${inlineHtml(question.content)}${imageHtml(uploaded)}`);
    await verifyDefaultFormatting(questionFrame, 'description', question.content, `"${question.title}" content`);
    if (question.feedback !== undefined) {
      await questionFrame.getByRole('button', { name: 'Feedback for students (optional)', exact: true }).click();
      await setCkEditor(questionFrame, 'feedback', inlineHtml(question.feedback));
      await verifyDefaultFormatting(questionFrame, 'feedback', question.feedback, `"${question.title}" feedback`);
    }
    if (question.prefixAnswersWithLetters !== undefined) {
      await questionFrame.locator('#prefixAnswersWithLetters').setChecked(question.prefixAnswersWithLetters);
    }
    await resizeOptions(questionFrame, question.answers.length, this.timeoutMs);
    await questionFrame.locator('#multipleAnswersAllowed').selectOption(
      question.answers.filter((answer) => answer.correct).length > 1 ? 'true' : 'false'
    );

    for (let index = 0; index < question.answers.length; index += 1) {
      const answer = question.answers[index]!;
      await setCkEditor(questionFrame, `optionName${index}`, inlineHtml(answer.text));
      await verifyDefaultFormatting(questionFrame, `optionName${index}`, answer.text, `"${question.title}" answer ${index + 1}`);
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
    const saveQuestion = questionFrame.locator(existing ? '#saveAsButton' : '#saveButton');
    try {
      await saveQuestion.waitFor({ state: 'visible', timeout: this.timeoutMs });
    } catch {
      throw new Error(existing
        ? `"Save as new version" never appeared for "${question.title}"; refusing to save the shared question in place.`
        : `New-question Save did not appear for "${question.title}".`);
    }
    // Some LAMS deployments raise the RAT-sync confirmation as soon as a question's new
    // version is saved, while others defer it until the activity Save below. Keep the
    // affirmative handler around every question save so neither variant silently chooses
    // the browser's default "No" response.
    await this.acceptSaveDialogs(async () => {
      await saveQuestion.click();
      if (existing) {
        await frame.locator(editorSelector).waitFor({ state: 'detached', timeout: this.timeoutMs });
      } else {
        await frame.locator('#qb-question-authoring-modal').waitFor({ state: 'hidden', timeout: this.timeoutMs });
      }
    });
    const expectedTitles = existing ? previousTitles : [...previousTitles, normalizeText(question.title)];
    await frame.waitForFunction(({ titles, selector }) => {
      const actual = Array.from(document.querySelectorAll(selector)).map((element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim());
      return JSON.stringify(actual) === JSON.stringify(titles);
    }, { titles: expectedTitles, selector: `#referencesTable tbody tr ${QUESTION_TITLE}` }, { timeout: this.timeoutMs });
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

  }

  /**
   * Sets "answer required" for every question in one pass, after the last question editor
   * has closed. Toggling inside writeQuestion loses most of the flags: saving a question
   * rebuilds the reference list, and a rebuild that lands after the toggle restores the
   * flag it had before. Nothing rewrites the list during this pass, so the toggles stick.
   */
  async applyAnswerRequired(questions: IratQuestionRequest[], options: { commit: boolean } = { commit: true }): Promise<string[]> {
    const frame = await this.ensureActivityFrame();
    const titles = questions.map(question => normalizeText(question.title));
    const existing = await questionTitles(frame);
    if (new Set(titles).size !== titles.length ||
        JSON.stringify([...titles].sort()) !== JSON.stringify([...existing].sort())) {
      throw new Error('Answer-required preflight failed: request must match the complete unique question inventory.');
    }
    // Read every target before the first mutation, including in preview mode.
    const planned: Array<{ question: IratQuestionRequest; toggle: Locator; stored: boolean }> = [];
    for (const question of questions) {
      const row = await exactQuestionRow(frame, question.title);
      const toggle = row.locator(REQUIRED_TOGGLE);
      const stored = await toggle.evaluate(readRequiredState);
      if (stored === null) throw new Error(`Cannot read answer-required state for "${question.title}".`);
      planned.push({ question, toggle, stored });
    }
    if (!options.commit) return planned.filter(item => item.stored !== item.question.mandatory).map(item => item.question.title);
    const changed: string[] = [];
    for (const item of planned) {
      const { question, toggle: requiredToggle } = item;
      // The rendered btn-outline-* class already states the stored value, so a question
      // that is already correct is never clicked.
      let stored = item.stored;
      for (let attempt = 0; attempt < REQUIRED_TOGGLE_ATTEMPTS && stored !== question.mandatory; attempt += 1) {
        if (attempt === 0) changed.push(question.title);
        stored = await this.toggleAnswerRequired(requiredToggle);
      }
      if (stored !== question.mandatory) {
        throw new Error(`LAMS kept "answer required" at ${String(stored)} for "${question.title}"; expected ${question.mandatory}.`);
      }
    }
    return changed;
  }

  /**
   * Clicks one "Answer required" toggle and returns the value LAMS stored, taken from the
   * toggle's own AJAX reply rather than from the class it may or may not stamp afterwards.
   * The handler only stamps a class when the reply matches the state it predicted, so a
   * reply that arrives late reads as "nothing happened" and a second click silently flips
   * the flag back. The reply itself is the only authoritative answer.
   */
  private async toggleAnswerRequired(toggle: Locator): Promise<boolean> {
    const reply = this.page.waitForResponse(
      (response) => response.url().includes('toggleQuestionRequired.do'),
      { timeout: this.timeoutMs }
    );
    // Dispatched rather than clicked: hovering one toggle leaves a Bootstrap
    // "Answer required" tooltip floating over the next row's button, and a real click
    // then lands on the tooltip. The inline onclick handler runs either way.
    await toggle.dispatchEvent('click');
    const body = (await (await reply).text()).trim();
    if (body !== 'true' && body !== 'false') {
      throw new Error(`toggleQuestionRequired returned an unreadable state: ${JSON.stringify(body.slice(0, 100))}`);
    }
    return body === 'true';
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

    const displayAll = frame.getByLabel(DISPLAY_ALL_AFTER_COMPLETION_LABEL, { exact: false });
    const matches = await displayAll.count();
    if (matches !== 1) {
      throw new Error(`Expected one "${DISPLAY_ALL_AFTER_COMPLETION_LABEL}" checkbox in the iRAT activity; found ${matches}.`);
    }
    await setCheckbox(displayAll, settings.displayAllAfterCompletion);
    if ((await displayAll.isChecked()) !== settings.displayAllAfterCompletion) {
      throw new Error(`Feedback & Results setting "displayAllAfterCompletion" did not remain ${settings.displayAllAfterCompletion ? 'enabled' : 'disabled'}.`);
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
      if (this.uploadedImageUrls.size > 0) {
        const printableImages = new Set(
          await printPage.locator('img').evaluateAll((elements) => elements.map((element) => (element as HTMLImageElement).src))
        );
        for (const url of this.uploadedImageUrls) {
          if (!printableImages.has(url)) throw new Error(`Print View did not contain uploaded iRAT image: ${url}`);
        }
      }
    } finally {
      await printPage.close();
    }
  }

  async save(): Promise<void> {
    const frame = await this.ensureActivityFrame();
    // Saving the iRAT asks whether the matching tRAT should receive the same changes.
    // The deployment guide always confirms that prompt: the tRAT must mirror the iRAT,
    // so this handler accepts every browser dialog raised by the save and never cancels.
    await this.acceptSaveDialogs(async () => {
      await frame.locator('#saveButton').click();
      await this.page.locator(ACTIVITY_DIALOG).waitFor({ state: 'hidden', timeout: this.timeoutMs });
    });
    this.activityFrame = undefined;

    const trat = matchingTratRequest(this.request);
    const tratNode = uniqueGraphNode(await inspectAuthoringGraph(this.page), trat.activityName, 'tool');
    const tratFrame = await this.openActivityFrame(tratNode);
    await this.verifyTratQuestionSync(tratFrame);
    await applyTratAdvancedSettings(
      tratFrame,
      trat.confidenceSourceActivityName,
      { ...DEFAULT_TRAT_ADVANCED_SETTINGS },
      { commit: true, timeoutMs: this.timeoutMs }
    );
    await this.acceptSaveDialogs(async () => {
      await tratFrame.locator('#saveButton').click();
      await this.page.locator(ACTIVITY_DIALOG).waitFor({ state: 'hidden', timeout: this.timeoutMs });
    });
    this.activityFrame = undefined;

    await this.page.locator('#saveButton').click();
    await this.page.locator('#ldDescriptionFieldModified').waitFor({ state: 'hidden', timeout: this.timeoutMs });
    const graph = await inspectAuthoringGraph(this.page);
    const gate = uniqueGraphNode(graph, this.request.gate.name, 'gate');
    const savedQuestions = await this.inspectQuestionsAndClose(uniqueGraphNode(graph, this.request.activityName, 'tool'));
    const expectedTitles = this.request.questions.map((question) => normalizeText(question.title)).sort();
    const savedTitles = savedQuestions.map((question) => question.title).sort();
    if (JSON.stringify(savedTitles) !== JSON.stringify(expectedTitles) || savedQuestions.some((question) => question.type !== 'multiple-choice')) {
      throw new Error('Post-save iRAT question inventory did not match the request.');
    }
    verifySavedRequiredFlags(savedQuestions, this.request.questions);
    const savedTratFrame = await this.openActivityFrame(
      uniqueGraphNode(await inspectAuthoringGraph(this.page), trat.activityName, 'tool')
    );
    await this.verifyTratQuestionSync(savedTratFrame);
    const tratSettings = await applyTratAdvancedSettings(
      savedTratFrame,
      trat.confidenceSourceActivityName,
      { ...DEFAULT_TRAT_ADVANCED_SETTINGS },
      { commit: false, timeoutMs: this.timeoutMs }
    );
    if (!tratSettings.passed) throw new Error('Post-save tRAT advanced settings did not match the required defaults.');
    await this.closeActivityWithoutSaving(savedTratFrame);
    if (
      gate.gateType !== this.request.gate.type ||
      gate.description !== this.request.gate.description ||
      gate.dynamicPassword !== this.request.gate.dynamicPassword ||
      gate.rotationSeconds !== this.request.gate.rotationSeconds
    ) {
      throw new Error('Post-save graph verification failed for the iRAT Gate.');
    }
  }

  /** Accepts and records every confirmation raised by one explicit save action. */
  private async acceptSaveDialogs(action: () => Promise<void>): Promise<void> {
    const pending: Promise<void>[] = [];
    const handler = (dialog: Dialog) => {
      this.confirmedDialogs.push(dialog.message());
      pending.push(dialog.accept());
    };
    this.page.on('dialog', handler);
    try {
      await action();
      await Promise.all(pending);
    } finally {
      this.page.off('dialog', handler);
    }
  }

  /**
   * Confirms the matching Scratchie activity selected the newest shared-question versions
   * and renders the same text, answers, inline formatting, and imported images as iRAT.
   */
  private async verifyTratQuestionSync(frame: Frame): Promise<void> {
    const rows = frame.locator('#itemTable tbody tr');
    await frame.locator('#itemTable').waitFor({ state: 'visible', timeout: this.timeoutMs });
    const titles: string[] = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const legacyTitle = row.locator('td:has(> .item-sequence-id)');
      const modernTitle = row.locator(QUESTION_TITLE);
      const titleCell = (await legacyTitle.count()) === 1 ? legacyTitle : modernTitle;
      if ((await titleCell.count()) !== 1) {
        throw new Error(`Could not read one title from tRAT question row ${index + 1}.`);
      }
      titles.push(normalizeText(await titleCell.innerText()));
    }
    const expectedTitles = this.request.questions.map((question) => normalizeText(question.title));
    if (JSON.stringify(titles) !== JSON.stringify(expectedTitles)) {
      throw new Error(`tRAT question inventory/order did not match iRAT: ${JSON.stringify(titles)}.`);
    }
    const staleVersions = await frame.locator('.newer-version-prompt:visible').count();
    if (staleVersions > 0) {
      throw new Error(`tRAT still shows ${staleVersions} question version(s) with a newer shared version available.`);
    }

    const popupPromise = this.page.waitForEvent('popup', { timeout: this.timeoutMs });
    await frame.locator('button[onclick*="showQuestionsPrintPage"]').click();
    const printPage = await popupPromise;
    try {
      await printPage.waitForLoadState('domcontentloaded');
      const body = printPage.locator('body');
      const printableText = normalizeText(await body.innerText());
      const printableHtml = canonicalInlineHtml(await body.innerHTML());
      for (const question of this.request.questions) {
        for (const expected of [question.title, stripHtml(question.content), ...question.answers.map((answer) => stripHtml(answer.text))]) {
          if (!printableText.includes(normalizeText(expected))) {
            throw new Error(`tRAT Print View did not contain synced text: "${normalizeText(expected)}".`);
          }
        }
        for (const formatted of [question.content, ...question.answers.map((answer) => answer.text)]) {
          const missing = missingInlineFormatting(printableHtml, formatted);
          if (missing.length > 0) {
            throw new Error(`tRAT Print View lost synced inline formatting: ${missing.join(', ')}.`);
          }
        }
      }
      if (this.uploadedImageUrls.size > 0) {
        const printableImages = new Set(
          await printPage.locator('img').evaluateAll((elements) => elements.map((element) => (element as HTMLImageElement).src))
        );
        for (const url of this.uploadedImageUrls) {
          if (!printableImages.has(url)) throw new Error(`tRAT Print View did not contain synced image: ${url}`);
        }
      }
    } finally {
      await printPage.close();
    }
  }

  private async inspectQuestionsAndClose(activity: GraphNode): Promise<IratObservedQuestion[]> {
    const frame = await this.openActivityFrame(activity);
    const rows = frame.locator('#referencesTable tbody tr');
    // A ready empty activity has Create question but no reference rows.
    await frame.getByRole('button', { name: 'Create question', exact: true }).waitFor({ state: 'visible', timeout: this.timeoutMs });
    const questions: IratObservedQuestion[] = [];
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const mandatory = await row.locator(REQUIRED_TOGGLE).evaluate(readRequiredState);
      if (mandatory === null) throw new Error('Cannot verify an unreadable answer-required flag.');
      questions.push({
        title: normalizeText(await row.locator(QUESTION_TITLE).innerText()),
        type: normalizeQuestionType(await row.locator(QUESTION_TYPE_BADGE).innerText()),
        mandatory
      });
    }

    // The activity authoring frame exposes only a Save control. Its dialog is a Bootstrap
    // modal owned by the parent authoring page, so it is dismissed from the modal header.
    // That routes into the frame's doCancel(), which raises an in-frame "Confirm Cancel"
    // modal; discarding the unchanged inspection requires confirming it.
    await this.closeActivityWithoutSaving(frame);
    return questions;
  }

  private async closeActivityWithoutSaving(frame: Frame): Promise<void> {
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
    // The panel can survive every dismissal this build offers. It is only ever in the way
    // of the double-click, so it is made click-through for exactly that action and
    // restored immediately: nothing about the activity or its properties is changed.
    const panel = this.page.locator('#propertiesDialog');
    const covering = await panel.isVisible();
    if (covering) await setPointerEvents(panel, 'none');
    try {
      await this.canvasNode(activity).dblclick({ delay: 80 });
    } finally {
      if (covering) await setPointerEvents(panel, '');
    }
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
   *
   * LAMS leaves the panel on the canvas at reduced opacity rather than removing it, and a
   * fixed click position can land on the panel itself, so Escape is tried first and then a
   * canvas point nothing is covering. Both are best-effort: this build can keep the panel
   * open regardless, which openActivityFrame handles by making it click-through.
   */
  private async dismissPropertiesDialog(): Promise<void> {
    const dialog = this.page.locator('#propertiesDialog');
    if (!(await dialog.isVisible())) return;
    await this.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined);
    if (!(await dialog.isVisible())) return;
    const point = await findClearCanvasPoint(this.page);
    if (!point) return;
    await this.page.mouse.click(point.x, point.y);
    await dialog.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined);
  }

  private canvasNode(node: GraphNode): Locator {
    return this.page.locator(`#canvas > svg > g.svg-activity[uiid="${node.uiid}"]`);
  }
}

export function verifySavedRequiredFlags(saved: IratObservedQuestion[], requested: IratQuestionRequest[]): void {
  for (const question of requested) {
    const matches = saved.filter(candidate => normalizeText(candidate.title) === normalizeText(question.title));
    if (matches.length !== 1 || matches[0]!.mandatory !== question.mandatory) {
      throw new Error(`Post-save answer-required verification failed for "${question.title}"; expected ${question.mandatory}.`);
    }
  }
}

/**
 * Toggles a leftover overlay's pointer interception without changing what it shows.
 * Bootstrap gives .modal no pointer events and .modal-dialog its own, so the inner dialog
 * has to be set as well or it keeps swallowing the click.
 */
async function setPointerEvents(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((element, next) => {
    for (const target of [element, ...element.querySelectorAll('.modal-dialog')]) {
      (target as HTMLElement).style.pointerEvents = next;
    }
  }, value);
}

/**
 * Finds a viewport point where a click lands on the authoring canvas background: inside
 * the canvas, and not on a floating panel, an activity, or a transition. The canvas is
 * filled by its own <svg>, so the topmost element there is that drawing surface rather
 * than #canvas itself — anything the canvas contains counts, as long as it is not part of
 * an activity or transition.
 */
export async function findClearCanvasPoint(page: Page): Promise<{ x: number; y: number } | null> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#canvas');
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    for (let y = box.top + 8; y < box.bottom - 8; y += 24) {
      for (let x = box.left + 8; x < box.right - 8; x += 24) {
        const topmost = document.elementFromPoint(x, y);
        if (!topmost || !canvas.contains(topmost)) continue;
        if (topmost.closest('.svg-activity, .svg-transition')) continue;
        return { x, y };
      }
    }
    return null;
  });
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
    // New MCQs start with four options; removing surplus answers triggers LAMS's
    // confirmation, also observed/tested by the AE adapter. Scope the handler to removal.
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

async function setCkEditor(frame: Frame, id: string, html: string): Promise<void> {
  await waitForCkEditor(frame, id);
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

async function waitForCkEditor(frame: Frame, id: string): Promise<void> {
  await frame.waitForFunction(
    (editorId) => Boolean((window as typeof window & { CKEDITOR?: { instances?: Record<string, { status?: string }> } }).CKEDITOR?.instances?.[editorId]),
    id
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


/**
 * Keeps only the SoT inline formatting tags and escapes everything else. No font family,
 * size, or block styling is ever emitted: the LAMS editor treats their absence as
 * "Default", which the deployment guide requires for every iRAT question.
 */
export function inlineHtml(value: string): string {
  return escapeHtml(value.replace(/<(?!\/?(?:sub|sup|strong|b|em|i|u|br)\s*\/?\s*>)[^>]*>/gi, ''))
    .replace(/&lt;(\/?(?:sub|sup|strong|b|em|i|u|br)\s*\/?)&gt;/gi, '<$1>');
}

/**
 * Normalises editor HTML so the request and CKEditor's own serialisation compare equally:
 * bold/italic synonyms collapse, attributes and whitespace inside tags are dropped.
 */
export function canonicalInlineHtml(value: string): string {
  return value
    .replace(/<(\/?)b\b[^>]*>/gi, '<$1strong>')
    .replace(/<(\/?)i\b[^>]*>/gi, '<$1em>')
    .replace(/<br\b[^>]*>/gi, '<br>')
    .replace(/<(\/?)(sub|sup|strong|em|u)\b[^>]*>/gi, '<$1$2>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*<br>\s*/g, '<br>')
    .trim();
}

/**
 * Reports why saved editor HTML does not match the deployment guide's formatting rules:
 * no explicit font, size, or block style, and every SoT inline tag from the request kept.
 */
export function formattingProblems(savedHtml: string, requested: string): string[] {
  const problems: string[] = [];
  const styles = [...savedHtml.matchAll(/style\s*=\s*"([^"]*)"/gi)].map((match) => match[1] ?? '');
  if (styles.some((style) => /font-family|font-size/i.test(style))) problems.push('explicit font family or size is present');
  if (/<(?:font|h[1-6]|pre|blockquote)\b/i.test(savedHtml)) problems.push('a heading, font, or block format is present');
  const canonical = canonicalInlineHtml(savedHtml);
  for (const tag of ['strong', 'em', 'u', 'sub', 'sup']) {
    const segments = [...canonicalInlineHtml(inlineHtml(requested)).matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, 'g'))];
    for (const segment of segments) {
      if (!canonical.includes(`<${tag}>${segment[1]}</${tag}>`)) problems.push(`<${tag}> formatting of "${stripHtml(segment[1] ?? '')}" was lost`);
    }
  }
  return problems;
}

async function verifyDefaultFormatting(frame: Frame, id: string, requested: string, label: string): Promise<void> {
  const saved = await frame.evaluate((editorId) => {
    const editor = (window as typeof window & { CKEDITOR: { instances: Record<string, { getData(): string }> } }).CKEDITOR.instances[editorId];
    return editor?.getData() ?? '';
  }, id);
  const problems = formattingProblems(saved, requested);
  if (problems.length > 0) throw new Error(`Editor formatting for ${label} is not at the LAMS default: ${problems.join('; ')}.`);
}

function stripHtml(value: string): string {
  return value.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ');
}

/** Returns exact inline-tagged segments requested by the SoT but absent from Print View. */
export function missingInlineFormatting(printableCanonicalHtml: string, requested: string): string[] {
  const missing: string[] = [];
  const expected = canonicalInlineHtml(inlineHtml(requested));
  for (const tag of ['strong', 'em', 'u', 'sub', 'sup']) {
    for (const segment of expected.matchAll(new RegExp(`<${tag}>(.*?)</${tag}>`, 'g'))) {
      const formatted = `<${tag}>${segment[1]}</${tag}>`;
      if (!printableCanonicalHtml.includes(formatted)) missing.push(formatted);
    }
  }
  return missing;
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


async function questionTitles(frame: Frame): Promise<string[]> {
  return (await frame.locator(`#referencesTable tbody tr ${QUESTION_TITLE}`).allTextContents()).map(normalizeText);
}
