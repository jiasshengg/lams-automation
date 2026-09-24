import type { Dialog, Frame, Locator, Page } from '@playwright/test';
import type { IratQuestionRequest, IratRequest } from '../config.js';
import { inspectAuthoringGraph, letClicksThroughDecorations, openActivityProperties, type AuthoringGraph, type GraphNode } from './authoring.js';
import { matchingTratRequest, type IratEditor, type IratObservedQuestion, type IratObservedState, type IratSavedQuestionReference } from './irat.js';
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

interface QuestionBankReference {
  baseUid: string;
  currentUid: string;
  currentLabel: string;
}

export interface LamsIratEditorHooks {
  onIratSaved?: () => Promise<void>;
  onTratSynced?: () => Promise<void>;
}

export class LamsIratEditor implements IratEditor {
  private activityFrame: Frame | undefined;
  private readonly uploadedImageUrls = new Set<string>();
  /** Messages of the browser prompts confirmed while saving, e.g. the tRAT update question. */
  readonly confirmedDialogs: string[] = [];

  constructor(
    private readonly page: Page,
    private readonly request: IratRequest,
    private readonly timeoutMs: number,
    private readonly questionImages: Map<string, QuestionImageAsset[]> = new Map(),
    private readonly hooks: LamsIratEditorHooks = {}
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

  /** Removes only one exact activity reference after LAMS shows its deletion warning. */
  async deleteQuestion(title: string): Promise<void> {
    const frame = await this.ensureActivityFrame();
    const beforeTitles = await questionTitles(frame);
    const normalizedTitle = normalizeText(title);
    if (beforeTitles.filter((candidate) => candidate === normalizedTitle).length !== 1) {
      throw new Error(`Expected one iRAT question named "${title}" before deletion.`);
    }
    const row = await exactQuestionRow(frame, title);
    const deleteButton = row.getByRole('button', { name: 'Delete', exact: true });
    if ((await deleteButton.count()) !== 1) {
      throw new Error(`Expected one Delete action for iRAT question "${title}".`);
    }
    await deleteButton.click();

    const dialog = frame.getByRole('dialog', { name: 'Delete', exact: true });
    await dialog.waitFor({ state: 'visible', timeout: this.timeoutMs });
    const warning = dialog.getByText('Do you really want to delete this question?', { exact: true });
    if ((await warning.count()) !== 1) {
      throw new Error(`The deletion dialog for "${title}" did not contain the verified warning.`);
    }
    const expectedTitles = beforeTitles.filter((candidate) => candidate !== normalizedTitle);
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await frame.waitForFunction(({ titles, selector }) => {
      const actual = Array.from(document.querySelectorAll(selector)).map((element) =>
        (element.textContent ?? '').replace(/\s+/g, ' ').trim()
      );
      return JSON.stringify(actual) === JSON.stringify(titles);
    }, { titles: expectedTitles, selector: `#referencesTable tbody tr ${QUESTION_TITLE}` }, { timeout: this.timeoutMs });
    if ((await questionTitles(frame)).includes(normalizedTitle)) {
      throw new Error(`iRAT question "${title}" was still present after confirming deletion.`);
    }
  }

  async updateQuestion(question: IratQuestionRequest): Promise<IratSavedQuestionReference | void> {
    return this.writeQuestion(question, true);
  }

  /**
   * Selects one immediately newer iRAT version left by a failed post-question-save run.
   * Refuses gaps or several newer versions so recovery cannot guess among shared edits.
   */
  async selectImmediateNewerQuestionVersion(title: string): Promise<string | undefined> {
    const frame = await this.ensureActivityFrame();
    const row = await exactQuestionRow(frame, title);
    const entries = await row.locator('.question-version-dropdown .dropdown-item button[onclick*="changeItemQuestionVersion"]').evaluateAll(buttons =>
      buttons.map(button => ({
        text: (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
        disabled: button.closest('.dropdown-item')?.classList.contains('disabled') ?? false
      }))
    );
    const current = entries.find(entry => entry.disabled);
    const currentNumber = current ? /^Version\s*(\d+)$/i.exec(current.text)?.[1] : undefined;
    if (!currentNumber) return undefined;
    const nextLabel = `Version ${Number(currentNumber) + 1}`;
    const newerIndexes = entries
      .map((entry, index) => entry.text === nextLabel && !entry.disabled ? index : -1)
      .filter(index => index >= 0);
    const later = entries.filter(entry => {
      const number = /^Version\s*(\d+)$/i.exec(entry.text)?.[1];
      return number !== undefined && Number(number) > Number(currentNumber) + 1;
    });
    if (later.length > 0 || newerIndexes.length !== 1) return undefined;
    await row.locator('.question-version-dropdown button.dropdown-toggle').click();
    await row.locator('.question-version-dropdown .dropdown-item button[onclick*="changeItemQuestionVersion"]')
      .nth(newerIndexes[0]!)
      .click();
    await frame.waitForFunction(({ questionTitle, expected }) => {
      const candidates = Array.from(document.querySelectorAll('#referencesTable tbody tr'));
      const match = candidates.find(candidate =>
        (candidate.querySelector('td .fw-semibold')?.textContent ?? '').replace(/\s+/g, ' ').trim() === questionTitle
      );
      const selected = (match?.querySelector('.question-version-dropdown button.dropdown-toggle')?.textContent ?? '').replace(/\s+/g, ' ').trim();
      return selected === expected;
    }, { questionTitle: normalizeText(title), expected: nextLabel }, { timeout: this.timeoutMs });
    return nextLabel;
  }

  async createQuestion(question: IratQuestionRequest): Promise<IratSavedQuestionReference | void> {
    return this.writeQuestion(question, false);
  }

  private async writeQuestion(question: IratQuestionRequest, existing: boolean): Promise<IratSavedQuestionReference | void> {
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
    const [snapshot] = await snapshotIratReferenceRows(updatedRow);
    if (!snapshot?.baseUid || !snapshot.currentUid || !snapshot.currentLabel) return undefined;
    return {
      title: snapshot.title,
      baseUid: snapshot.baseUid,
      currentUid: snapshot.currentUid,
      currentLabel: snapshot.currentLabel
    };
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
    const printPage = await openPrintView(this.page, frame, this.timeoutMs);
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
      const expectedImageCount = [...this.questionImages.values()].reduce((sum, images) => sum + images.length, 0);
      if (this.uploadedImageUrls.size > 0 || expectedImageCount > 0) {
        const printableImages = new Set(
          await printPage.locator('img[src*="/www/secure/"]').evaluateAll((elements) => elements.map((element) => (element as HTMLImageElement).src))
        );
        if (this.uploadedImageUrls.size === 0 && printableImages.size !== expectedImageCount) {
          throw new Error(`Print View contained ${printableImages.size} stored iRAT image(s); expected ${expectedImageCount} from the SoT.`);
        }
        for (const url of this.uploadedImageUrls) {
          if (!printableImages.has(url)) throw new Error(`Print View did not contain uploaded iRAT image: ${url}`);
        }
        printableImages.forEach(url => this.uploadedImageUrls.add(url));
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

    // Scratchie's confidence-source controls are deliberately withheld until the
    // current design has been saved. Persist the completed iRAT first, then reopen the
    // matching tRAT so its Data import panel can enumerate Assessment activities.
    await this.page.locator('#saveButton').click();
    await this.page.locator('#ldDescriptionFieldModified').waitFor({ state: 'hidden', timeout: this.timeoutMs });
    await this.hooks.onIratSaved?.();

    await this.syncTratAndVerify();
  }

  /**
   * Resumes the post-iRAT-save stage after a verified partial run. This deliberately
   * does not reopen or save any iRAT question, so recovery cannot create redundant
   * question versions. Callers must first verify the saved iRAT inventory/Print View.
   */
  async resumeTratSyncAndVerify(): Promise<void> {
    await this.syncTratAndVerify();
  }

  private async syncTratAndVerify(): Promise<void> {

    const trat = matchingTratRequest(this.request);
    const savedIratFrame = await this.ensureActivityFrame();
    const questionBankReferences = await this.readIratQuestionBankReferences(savedIratFrame);
    await this.closeActivityWithoutSaving(savedIratFrame);
    const tratNode = uniqueGraphNode(await inspectAuthoringGraph(this.page), trat.activityName, 'tool');
    const tratFrame = await this.openActivityFrame(tratNode);
    await this.verifyTratQuestionSync(tratFrame, { repairStaleVersions: true }, questionBankReferences);
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

    // Persist the repaired tRAT references and its settings before reopening both
    // activities for final read-only verification.
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
    await this.verifyTratQuestionSync(savedTratFrame, { repairStaleVersions: false }, questionBankReferences);
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
    await this.hooks.onTratSynced?.();
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
  private async verifyTratQuestionSync(
    frame: Frame,
    options: { repairStaleVersions: boolean },
    questionBankReferences?: Map<string, QuestionBankReference>
  ): Promise<void> {
    const { rows, modern } = await this.tratQuestionRows(frame);
    let titles = await readTratTitles(rows, modern);
    const expectedTitles = this.request.questions.map((question) => normalizeText(question.title));
    if (JSON.stringify(titles) !== JSON.stringify(expectedTitles)) {
      if (!options.repairStaleVersions) {
        throw new Error(`tRAT question inventory/order did not match iRAT: ${JSON.stringify(titles)}.`);
      }
      const authorizedDeletions = new Set((this.request.deleteQuestionTitles ?? []).map(normalizeText));
      const exactAuthorizedInventory =
        titles.length > 0 &&
        titles.length === authorizedDeletions.size &&
        titles.every(title => authorizedDeletions.has(title));
      if (exactAuthorizedInventory) {
        await this.deleteAuthorizedTratQuestions(frame, rows, modern, titles);
        titles = await readTratTitles(rows, modern);
      }
      const missing = missingTratQuestionSuffix(titles, this.request.questions);
      if (!questionBankReferences) throw new Error('Question Bank repair requires verified iRAT question references.');
      await this.importMissingTratQuestions(frame, rows, modern, missing, questionBankReferences);
      titles = await readTratTitles(rows, modern);
      if (JSON.stringify(titles) !== JSON.stringify(expectedTitles)) {
        throw new Error(`tRAT question inventory/order did not match iRAT after Question Bank repair: ${JSON.stringify(titles)}.`);
      }
    }
    if (options.repairStaleVersions) {
      if (!questionBankReferences) throw new Error('tRAT version reconciliation requires verified iRAT question references.');
      await this.selectCurrentIratVersionsInTrat(frame, rows, modern, questionBankReferences);
    } else if (questionBankReferences) {
      await this.verifyTratVersionLabels(rows, modern, questionBankReferences);
    }
    const staleVersions = await this.countStaleTratVersions(frame);
    if (staleVersions > 0) {
      throw new Error(`tRAT still shows ${staleVersions} question version(s) with a newer shared version available.`);
    }

    const printPage = await openPrintView(this.page, frame, this.timeoutMs);
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

  /**
   * Imports shared iRAT questions that LAMS omitted from Scratchie after creating them.
   * This is deliberately suffix-only: existing tRAT rows must already be the exact
   * requested prefix, so the repair never deletes, replaces, or reorders unrelated rows.
   */
  private async importMissingTratQuestions(
    frame: Frame,
    rows: Locator,
    modern: boolean,
    missing: IratQuestionRequest[],
    questionBankReferences: Map<string, QuestionBankReference>
  ): Promise<void> {
    if (!modern) {
      throw new Error(`tRAT is missing ${missing.length} question(s), but this legacy layout has no verified Question Bank import path.`);
    }
    const header = frame.locator('#question-bank-card-header');
    const panel = frame.locator('#question-bank-collapse');
    if (!(await panel.isVisible())) await header.click();
    await panel.waitFor({ state: 'visible', timeout: this.timeoutMs });
    await frame.waitForFunction(() => !document.querySelector('#question-bank-collapse')?.classList.contains('contains-nothing'), undefined, {
      timeout: this.timeoutMs
    });

    for (const question of missing) {
      const requestedTitle = normalizeText(question.title);
      const requestedContent = expectedQuestionDescriptionText(question.content, this.questionImages.get(question.title));
      const reference = questionBankReferences.get(requestedTitle);
      if (!reference) throw new Error(`No verified iRAT Question Bank reference was found for "${question.title}".`);
      const before = await rows.count();
      const selectedUid = panel.locator('#selected-question-uid');
      // Question Bank access is deliberately limited to read and import. The exact
      // immutable version UID came from this lesson's iRAT reference, so text search,
      // Question Bank editing, and Question Bank deletion are neither needed nor allowed.
      await this.loadQuestionBankDetailsReadOnly(frame, reference.currentUid);
      if ((await selectedUid.inputValue()) !== reference.currentUid) {
        throw new Error(`Question Bank did not select the verified current iRAT version for "${question.title}".`);
      }
      const detail = panel.locator('#question-detail-area');
      const detailTitle = normalizeText(await detail.locator('.card-title').innerText());
      const detailContent = normalizeText(await detail.locator('.question-description').innerText());
      if (detailTitle !== requestedTitle || detailContent !== requestedContent) {
        throw new Error(`Verified Question Bank UID did not match the requested title/content for "${question.title}".`);
      }
      await this.importQuestionBankReference(panel, question.title);
      await frame.waitForFunction(({ count, title }) => {
        const items = Array.from(document.querySelectorAll('#scratchieItemsList .scratchie-item-list-item'));
        const last = items.at(-1)?.querySelector('.fw-semibold.text-break')?.textContent ?? '';
        return items.length === count + 1 && last.replace(/\s+/g, ' ').trim() === title;
      }, { count: before, title: requestedTitle }, { timeout: this.timeoutMs });
    }
  }

  /** Read-only Question Bank detail lookup by an exact verified immutable version UID. */
  private async loadQuestionBankDetailsReadOnly(frame: Frame, currentUid: string): Promise<void> {
    await frame.evaluate(uid => {
      const loader = (window as typeof window & { loadQuestionDetailsArea?: (questionUid: number) => void }).loadQuestionDetailsArea;
      if (typeof loader !== 'function') throw new Error('Question Bank detail loader is unavailable.');
      loader(Number(uid));
    }, currentUid);
    await frame.waitForFunction(uid =>
      (document.querySelector('#selected-question-uid') as HTMLInputElement | null)?.value === uid,
    currentUid, { timeout: this.timeoutMs });
  }

  /** Imports one verified Question Bank version as an activity reference; never edits it. */
  private async importQuestionBankReference(panel: Locator, title: string): Promise<void> {
    const importResponse = this.page.waitForResponse(
      response => response.url().includes('/authoring/importQbQuestion.do'),
      { timeout: this.timeoutMs }
    );
    await panel.locator('#import-button').click();
    if (!(await importResponse).ok()) throw new Error(`Question Bank import failed for "${title}".`);
  }

  /**
   * Mirrors only the exact placeholder deletions already authorized for iRAT. This path
   * is used when LAMS accepted the sync prompt but left Scratchie on that complete old
   * inventory; any mixed, additional, or differently titled tRAT row is rejected above.
   */
  private async deleteAuthorizedTratQuestions(
    frame: Frame,
    rows: Locator,
    modern: boolean,
    titles: string[]
  ): Promise<void> {
    if (!modern) throw new Error('Authorized tRAT placeholder deletion is unavailable in the legacy layout.');
    for (const title of titles) {
      const currentRows = frame.locator('#scratchieItemsList .scratchie-item-list-item');
      const matchingIndexes: number[] = [];
      for (let index = 0; index < (await currentRows.count()); index += 1) {
        const [candidate] = await readTratTitles(currentRows.nth(index), true);
        if (candidate === title) matchingIndexes.push(index);
      }
      if (matchingIndexes.length !== 1) {
        throw new Error(`Expected one authorized tRAT placeholder named "${title}"; found ${matchingIndexes.length}.`);
      }
      const before = await currentRows.count();
      await currentRows.nth(matchingIndexes[0]!).getByRole('button', { name: 'Remove', exact: true }).click();
      const modal = frame.locator('#scratchieDeleteItemModal');
      await modal.waitFor({ state: 'visible', timeout: this.timeoutMs });
      if ((await modal.getByText('Do you really want to delete this question?', { exact: true }).count()) !== 1) {
        throw new Error(`The tRAT deletion dialog for "${title}" did not contain the verified warning.`);
      }
      await modal.locator('#scratchieDeleteItemConfirmBtn').click();
      await frame.waitForFunction(({ count, removedTitle }) => {
        const items = Array.from(document.querySelectorAll('#scratchieItemsList .scratchie-item-list-item'));
        const remaining = items.map(item => (item.querySelector('.fw-semibold.text-break')?.textContent ?? '').replace(/\s+/g, ' ').trim());
        return items.length === count - 1 && !remaining.includes(removedTitle);
      }, { count: before, removedTitle: title }, { timeout: this.timeoutMs });
      console.log(`Deleted authorized tRAT placeholder: ${title}`);
    }
  }

  private async tratQuestionRows(frame: Frame): Promise<{ rows: Locator; modern: boolean }> {
    // Scratchie changed from a table to Bootstrap list items in the deployed LAMS build.
    // Both renderings expose stable containers; select the one that is actually present
    // instead of assuming the Assessment tool's #itemTable exists in Scratchie.
    const modernList = frame.locator('#scratchieItemsList');
    const legacyTable = frame.locator('#itemTable');
    const modern = await modernList.isVisible().catch(() => false);
    if (modern) await modernList.waitFor({ state: 'visible', timeout: this.timeoutMs });
    else await legacyTable.waitFor({ state: 'visible', timeout: this.timeoutMs });
    return {
      modern,
      rows: modern ? modernList.locator('.scratchie-item-list-item') : legacyTable.locator('tbody tr')
    };
  }

  /** Reads the exact Question Bank family and selected version for every iRAT row. */
  private async readIratQuestionBankReferences(frame: Frame): Promise<Map<string, QuestionBankReference>> {
    const references = new Map<string, QuestionBankReference>();
    await waitForReferenceRows(frame, this.request.questions.map((question) => normalizeText(question.title)), this.timeoutMs);
    const snapshots = await snapshotIratReferenceRows(frame.locator('#referencesTable tbody tr'));
    for (const question of this.request.questions) {
      const matches = snapshots.filter(snapshot => snapshot.title === normalizeText(question.title));
      if (matches.length !== 1 || !matches[0]!.baseUid || !matches[0]!.currentUid || !matches[0]!.currentLabel) {
        throw new Error(`Could not read one Question Bank family/current version for "${question.title}".`);
      }
      const snapshot = matches[0]!;
      references.set(snapshot.title, {
        baseUid: snapshot.baseUid!,
        currentUid: snapshot.currentUid!,
        currentLabel: snapshot.currentLabel!
      });
    }
    return references;
  }

  /**
   * LAMS may acknowledge the iRAT sync confirmation while leaving Scratchie references
   * on their previous shared-question versions. When that verified state is visible,
   * select the exact current iRAT version for each same-titled tRAT row, then verify the complete
   * Print View against the request before the activity is saved.
   */
  private async selectCurrentIratVersionsInTrat(
    frame: Frame,
    rows: Locator,
    modern: boolean,
    questionBankReferences: Map<string, QuestionBankReference>
  ): Promise<void> {
    for (let index = 0; index < (await rows.count()); index += 1) {
      const row = rows.nth(index);
      const [title] = await readTratTitles(row, modern);
      const reference = questionBankReferences.get(title!);
      if (!reference) throw new Error(`No verified iRAT version was found for tRAT question "${title}".`);
      const warning = row.getByRole('button', { name: 'There is a newer version of this question', exact: true });
      const versionMenu = row.locator('button.dropdown-toggle');
      const selectedLabel = await readTratSelectedVersionLabel(row);
      if (!selectedLabel) {
        throw new Error(`Could not find one tRAT version menu for question row ${index + 1}.`);
      }
      if (selectedLabel === reference.currentLabel && (await warning.count()) === 0) continue;
      if ((await versionMenu.count()) !== 1) {
        throw new Error(`tRAT question "${title}" is ${selectedLabel}; iRAT is ${reference.currentLabel}, but no version menu is available.`);
      }
      if (!modern) {
        throw new Error(`tRAT question "${title}" is ${selectedLabel}; iRAT is ${reference.currentLabel}, but this legacy layout has no verified repair path.`);
      }
      await versionMenu.click();
      const candidates = row.locator('button.dropdown-item[onclick*="changeItemQuestionVersion"]');
      const onclickValues = await candidates.evaluateAll(buttons => buttons.map(button => button.getAttribute('onclick') ?? ''));
      const matchingIndexes = onclickValues
        .map((onclick, candidateIndex) => questionVersionUid(onclick) === reference.currentUid ? candidateIndex : -1)
        .filter(candidateIndex => candidateIndex >= 0);
      if (matchingIndexes.length !== 1) {
        throw new Error(`Expected one ${reference.currentLabel} (${reference.currentUid}) choice for tRAT question "${title}"; found ${matchingIndexes.length}.`);
      }
      await candidates.nth(matchingIndexes[0]!).click();

      const deadline = Date.now() + this.timeoutMs;
      let updated = false;
      do {
        // changeItemQuestionVersion replaces the whole #itemArea. Reacquire the row from
        // the new list and verify its selected label instead of polling a pre-AJAX node.
        const freshRow = frame.locator('#scratchieItemsList .scratchie-item-list-item').nth(index);
        const selectedLabel = normalizeText(await freshRow.locator('button.dropdown-toggle').innerText().catch(() => ''));
        const stillWarns = await freshRow
          .getByRole('button', { name: 'There is a newer version of this question', exact: true })
          .count();
        updated = selectedLabel === reference.currentLabel && stillWarns === 0;
        if (updated) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      if (!updated) {
        throw new Error(`Selecting ${reference.currentLabel} did not update tRAT question "${title}".`);
      }
    }
  }

  private async verifyTratVersionLabels(
    rows: Locator,
    modern: boolean,
    questionBankReferences: Map<string, QuestionBankReference>
  ): Promise<void> {
    const snapshots = await snapshotTratRows(rows, modern);
    for (const snapshot of snapshots) {
      const reference = questionBankReferences.get(snapshot.title);
      const title = snapshot.title;
      if (!reference) throw new Error(`No verified iRAT version was found for tRAT question "${title}".`);
      const selectedLabel = snapshot.selectedLabel;
      if (!selectedLabel) {
        throw new Error(`Could not verify one selected tRAT version for question "${title}".`);
      }
      if (selectedLabel !== reference.currentLabel) {
        throw new Error(`Post-save tRAT version mismatch for "${title}": selected ${selectedLabel}, expected ${reference.currentLabel} from iRAT.`);
      }
    }
  }

  private async countStaleTratVersions(frame: Frame): Promise<number> {
    return frame.locator([
      '.newer-version-prompt:visible',
      'button[aria-label="There is a newer version of this question"]:visible'
    ].join(', ')).count();
  }

  private async inspectQuestionsAndClose(activity: GraphNode): Promise<IratObservedQuestion[]> {
    const frame = await this.openActivityFrame(activity);
    const rows = frame.locator('#referencesTable tbody tr');
    // A ready empty activity has Create question but no reference rows.
    await frame.getByRole('button', { name: 'Create question', exact: true }).waitFor({ state: 'visible', timeout: this.timeoutMs });
    const questions = await snapshotIratReferenceRows(rows);

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
    // LAMS binds to the genuine double-click mouse sequence. The persistent properties
    // overlay is made click-through below so that sequence reaches the verified SVG node.
    await this.dismissPropertiesDialog();
    // The panel can survive every dismissal this build offers. It is only ever in the way
    // of the double-click, so it is made click-through for exactly that action and
    // restored immediately: nothing about the activity or its properties is changed.
    // Do this whenever the persistent panel exists, not only when isVisible() happens to
    // report true: Bootstrap can promote it back to .show between that check and the
    // double-click actionability check.
    const panel = this.page.locator('#propertiesDialog');
    const covering = (await panel.count()) === 1;
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
    for (const target of [element, ...element.querySelectorAll('*')]) {
      const htmlTarget = target as HTMLElement;
      if (next) {
        htmlTarget.dataset.codexPointerEvents = htmlTarget.style.getPropertyValue('pointer-events');
        htmlTarget.dataset.codexPointerEventsPriority = htmlTarget.style.getPropertyPriority('pointer-events');
        htmlTarget.style.setProperty('pointer-events', next, 'important');
      } else {
        const previous = htmlTarget.dataset.codexPointerEvents ?? '';
        const priority = htmlTarget.dataset.codexPointerEventsPriority ?? '';
        if (previous) htmlTarget.style.setProperty('pointer-events', previous, priority);
        else htmlTarget.style.removeProperty('pointer-events');
        delete htmlTarget.dataset.codexPointerEvents;
        delete htmlTarget.dataset.codexPointerEventsPriority;
      }
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

/**
 * Opens an activity's Print View and returns its window. LAMS renders every question, answer, and
 * stored image into that page before opening it, so how long it takes grows with the activity: a
 * fifteen-question iRAT with figures outlives the ordinary action timeout. The wait is therefore
 * at least a minute, while the click itself still has to succeed within the action timeout.
 */
export const PRINT_VIEW_TIMEOUT_MS = 60_000;
/** The page LAMS prints an activity's questions from: `.../authoring/printQuestions.do?...`. */
const PRINT_VIEW_URL = /printQuestions\.do/i;

export async function openPrintView(page: Page, frame: Frame | Page, timeoutMs: number): Promise<Page> {
  // The help widget floats exactly where this control sits, so first make sure it cannot take
  // the click; it re-applies its own styles, so that is not always enough.
  await letClicksThroughDecorations(page);
  // The dialog opens windows of its own as well — a question's Question Bank statistics, for one —
  // so the Print View is identified by the page LAMS prints it from, not by being first to appear.
  const popupPromise = page.waitForEvent('popup', {
    timeout: Math.max(timeoutMs, PRINT_VIEW_TIMEOUT_MS),
    predicate: async (candidate) => {
      if (PRINT_VIEW_URL.test(candidate.url())) return true;
      await candidate.waitForLoadState('domcontentloaded').catch(() => undefined);
      return PRINT_VIEW_URL.test(candidate.url());
    }
  });
  // When the click fails, nothing ever awaits this wait. Left alone it rejects later, once the
  // browser has closed, and that crash replaces the click's own error with a useless one.
  popupPromise.catch(() => undefined);
  const control = frame.locator('button[onclick*="showQuestionsPrintPage"]');
  try {
    await control.click({ timeout: timeoutMs });
  } catch (error) {
    if (!(error instanceof Error) || !/intercepts pointer events/.test(error.message)) throw error;
    // Something decorative is covering the control. Its own handler is what opens the Print View,
    // and the page that opens is verified line by line, so the outcome is still proven.
    console.log('A floating widget covered the Print View control; opening it through the control itself.');
    await control.evaluate((element: HTMLElement) => element.click());
  }
  return popupPromise;
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

/**
 * The live "question-description" block renders the stem followed by every image's
 * caption (see `imageHtml` in ckeditor-media.ts), all as one text node. A captioned
 * image therefore never text-matches a comparison built from the stem alone, so the
 * expected text has to include each non-empty caption in upload order, exactly as
 * `imageHtml` appends them.
 */
export function expectedQuestionDescriptionText(content: string, images: readonly { caption: string }[] | undefined): string {
  const stem = normalizeText(stripHtml(content));
  const captions = (images ?? [])
    .map((image) => normalizeText(stripHtml(image.caption)))
    .filter((caption) => caption !== '');
  return [stem, ...captions].join(' ');
}

/**
 * Returns the only safe automatic tRAT inventory repair: missing requested rows after
 * an exact existing prefix. Any extra, reordered, or differently named row is ambiguous.
 */
export function missingTratQuestionSuffix(
  observedTitles: string[],
  requestedQuestions: IratQuestionRequest[]
): IratQuestionRequest[] {
  const observed = observedTitles.map(normalizeText);
  const expected = requestedQuestions.map(question => normalizeText(question.title));
  const exactPrefix = observed.length < expected.length && observed.every((title, index) => title === expected[index]);
  if (!exactPrefix) {
    throw new Error(`tRAT question inventory/order did not match iRAT: ${JSON.stringify(observed)}.`);
  }
  return requestedQuestions.slice(observed.length);
}

/** Choose a distinctive contiguous plain-text fragment for the Question Bank filter. */
export function questionBankSearchTerm(content: string): string {
  const segments = normalizeText(content).match(/[\p{L}][\p{L} '-]{23,}/gu) ?? [];
  const longest = segments.map(segment => normalizeText(segment)).sort((a, b) => b.length - a.length)[0];
  if (!longest) throw new Error('Question content has no stable plain-text fragment for Question Bank search.');
  return longest.slice(0, 100).trim();
}

export function questionVersionUid(onclick: string): string | undefined {
  return /changeItemQuestionVersion\(\s*\d+\s*,\s*\d+\s*,\s*(\d+)\s*\)/.exec(onclick)?.[1];
}

/** Reads the exact Question Bank UID exposed by a single-version row's stats action. */
export function questionStatsUid(onclick: string): string | undefined {
  return /[?&]qbQuestionUid=(\d+)/.exec(onclick)?.[1];
}

/**
 * LAMS appends the Assessment reference rows one at a time after the activity frame opens,
 * and each row's mark input and answer-required toggle land after its title. A snapshot
 * taken as soon as the table is visible can therefore see a partial table or a row with an
 * empty controls cell. Wait until the title list is exactly the expected one and every row
 * carries both controls before reading it.
 */
export async function waitForReferenceRows(target: Frame | Page, expectedTitles: string[], timeoutMs: number): Promise<void> {
  await target.waitForFunction(({ titles, selectors }) => {
    const rows = Array.from(document.querySelectorAll('#referencesTable tbody tr'));
    const actual = rows.map((row) => (row.querySelector(selectors.title)?.textContent ?? '').replace(/\s+/g, ' ').trim());
    if (JSON.stringify(actual) !== JSON.stringify(titles)) return false;
    return rows.every((row) => row.querySelector(selectors.required) && row.querySelector(selectors.mark));
  }, { titles: expectedTitles, selectors: { title: QUESTION_TITLE, required: REQUIRED_TOGGLE, mark: MAX_MARK_INPUT } }, { timeout: timeoutMs });
}

/**
 * Reads the complete iRAT reference table in one browser round trip. This is read-only:
 * it snapshots activity references and immutable Question Bank version identifiers.
 */
export async function snapshotIratReferenceRows(rows: Locator): Promise<IratObservedQuestion[]> {
  const raw = await rows.evaluateAll((elements, selectors) => elements.map((row, index) => {
    const required = row.querySelector(selectors.required);
    const classes = required ? [...required.classList] : [];
    const mandatory = classes.includes('text-danger') || classes.includes('btn-outline-danger')
      ? true
      : classes.includes('text-muted') || classes.includes('btn-outline-secondary')
        ? false
        : null;
    const entries = [...row.querySelectorAll('.question-version-dropdown .dropdown-item button[onclick*="changeItemQuestionVersion"]')]
      .map(button => ({
        text: (button.textContent ?? '').replace(/\s+/g, ' ').trim(),
        onclick: button.getAttribute('onclick') ?? '',
        current: button.closest('.dropdown-item')?.classList.contains('disabled') ?? false
      }));
    return {
      index,
      title: (row.querySelector(selectors.title)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      type: (row.querySelector(selectors.type)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      mandatory,
      marks: (row.querySelector(selectors.mark) as HTMLInputElement | null)?.value ?? '',
      entries,
      singleLabel: (row.querySelector('.badge.bg-secondary-subtle')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      statsOnclick: row.querySelector('button[onclick*="qb/stats/show.do"][onclick*="qbQuestionUid="]')?.getAttribute('onclick') ?? ''
    };
  }), { title: QUESTION_TITLE, type: QUESTION_TYPE_BADGE, required: REQUIRED_TOGGLE, mark: MAX_MARK_INPUT });

  return raw.map(item => {
    if (!item.title) throw new Error(`Could not read one iRAT title from reference row ${item.index + 1}.`);
    if (item.mandatory === null) throw new Error(`Cannot verify the answer-required flag for iRAT row ${item.index + 1}.`);
    const base = item.entries.find(entry => /^Version\s*1$/i.test(entry.text));
    const current = item.entries.find(entry => entry.current);
    let baseUid = base ? questionVersionUid(base.onclick) : undefined;
    let currentUid = current ? questionVersionUid(current.onclick) : undefined;
    let currentLabel = current ? normalizeText(current.text) : undefined;
    if (!baseUid && !currentUid && item.entries.length === 0 && /^Version\s*1$/i.test(item.singleLabel)) {
      const uid = questionStatsUid(item.statsOnclick);
      if (uid) {
        baseUid = uid;
        currentUid = uid;
        currentLabel = item.singleLabel;
      }
    }
    const marks = Number(item.marks);
    return {
      title: normalizeText(item.title),
      type: normalizeQuestionType(item.type),
      mandatory: item.mandatory,
      ...(Number.isFinite(marks) ? { marks } : {}),
      ...(baseUid ? { baseUid } : {}),
      ...(currentUid ? { currentUid } : {}),
      ...(currentLabel ? { currentLabel } : {})
    };
  });
}

export interface TratRowSnapshot {
  title: string;
  selectedLabel?: string;
  stale: boolean;
  versionOnclicks: string[];
}

/** Reads the complete Scratchie reference list in one read-only browser round trip. */
export async function snapshotTratRows(rows: Locator, modern: boolean): Promise<TratRowSnapshot[]> {
  const raw = await rows.evaluateAll((elements, modernLayout) => elements.map((row, index) => {
    const titleCells = modernLayout
      ? row.querySelectorAll('.fw-semibold.text-break')
      : row.querySelectorAll('td:has(> .item-sequence-id)').length === 1
        ? row.querySelectorAll('td:has(> .item-sequence-id)')
        : row.querySelectorAll('td .fw-semibold');
    const menu = row.querySelector('button.dropdown-toggle');
    const badge = row.querySelector('.badge.bg-secondary-subtle');
    return {
      index,
      titleCount: titleCells.length,
      title: (titleCells[0]?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      selectedLabel: (menu?.textContent ?? badge?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      stale: Boolean(row.querySelector('.newer-version-prompt, button[aria-label="There is a newer version of this question"]')),
      versionOnclicks: [...row.querySelectorAll('button.dropdown-item[onclick*="changeItemQuestionVersion"]')]
        .map(button => button.getAttribute('onclick') ?? '')
    };
  }), modern);
  return raw.map(item => {
    if (item.titleCount !== 1 || !item.title) {
      throw new Error(`Could not read one title from tRAT question row ${item.index + 1}.`);
    }
    return {
      title: normalizeText(item.title),
      ...(item.selectedLabel ? { selectedLabel: normalizeText(item.selectedLabel) } : {}),
      stale: item.stale,
      versionOnclicks: item.versionOnclicks
    };
  });
}

async function readTratTitles(rows: Locator, modern: boolean): Promise<string[]> {
  return (await snapshotTratRows(rows, modern)).map(row => row.title);
}

/** Reads either a multi-version dropdown label or LAMS's single-Version-1 badge. */
async function readTratSelectedVersionLabel(row: Locator): Promise<string | undefined> {
  const menu = row.locator('button.dropdown-toggle');
  if ((await menu.count()) === 1) return normalizeText(await menu.innerText());
  const badge = row.locator('.badge.bg-secondary-subtle');
  if ((await badge.count()) === 1) return normalizeText(await badge.innerText());
  return undefined;
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
