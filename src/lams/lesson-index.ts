import type { Locator, Page } from '@playwright/test';
import type { LamsConfig, LessonIndexSettings } from '../config.js';

export interface LessonIndexOptions {
  commit: boolean;
}

export interface LessonIndexResult {
  designTitle: string;
  lessonTitle: string;
  endDateTime: string;
  courseGrouping: string;
  committed: boolean;
}

const NO_PRESET = 'None';

/**
 * Verified against the live Add Lesson page (LAMS :: Add Lesson,
 * /lams/home/addLesson.do?organisationID=...). These IDs are stable in that markup;
 * the visible labels are plain text next to the inputs rather than accessible names,
 * so roles alone cannot address them.
 */
const SELECTORS = {
  addLessonButton: 'button.btn-primary:has-text("Add Lesson")',
  recentToggle: '#recentToggleBtn',
  recentEntries: '#recentList button.access-item',
  lessonName: '#lessonNameInput',
  scoresToggle: '#gradebookOnCompleteField',
  schedulingToggle: '#schedulingEnableField',
  endDatetime: '#schedulingEndDatetimeField',
  next: '#btnNext',
  addNow: '#addButton',
  groupingRadio: 'input[name="orgGroupingId"]'
} as const;

export type ResolvedLessonIndexSettings = Required<
  Pick<LessonIndexSettings, 'endDate' | 'endTime' | 'displayScoresOnCompletion' | 'enableScheduling'>
> & { courseGrouping?: string };

export function resolveLessonIndexSettings(config: LamsConfig): ResolvedLessonIndexSettings {
  const settings = config.lessonIndex;
  if (!settings) throw new Error('Configuration field "lessonIndex" is required for the index workflow.');
  return {
    ...(settings.courseGrouping ? { courseGrouping: settings.courseGrouping } : {}),
    endDate: settings.endDate,
    endTime: settings.endTime ?? '23:59',
    // TBL convention: hide per-activity scores, and time-box the lesson.
    displayScoresOnCompletion: settings.displayScoresOnCompletion ?? false,
    enableScheduling: settings.enableScheduling ?? true
  };
}

/** Opens the Add Lesson wizard from the course page. */
export async function openAddLesson(page: Page, config: LamsConfig): Promise<void> {
  const button = page.locator(SELECTORS.addLessonButton).first();
  await button.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await button.click();
  await page.waitForURL(/addLesson\.do/, { timeout: config.browser.actionTimeoutMs });
  await page.locator(SELECTORS.recentToggle).waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  console.log(`Opened Add Lesson: ${page.url()}`);
}

/**
 * Picks the top entry of "Recently used designs", which is the design the authoring
 * workflow saved most recently. The panel can start collapsed, so it is expanded first.
 */
export async function selectMostRecentDesign(page: Page, config: LamsConfig): Promise<string> {
  const toggle = page.locator(SELECTORS.recentToggle);
  await toggle.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await toggle.click();
    await page.locator(SELECTORS.recentEntries).first().waitFor({
      state: 'visible',
      timeout: config.browser.actionTimeoutMs
    });
  }

  const entries = page.locator(SELECTORS.recentEntries);
  if ((await entries.count()) === 0) {
    throw new Error('The "Recently used designs" panel is empty; nothing to index.');
  }

  const mostRecent = entries.first();
  const designTitle = normalise(await mostRecent.innerText());
  if (designTitle === '') throw new Error('The most recent design entry has no readable title.');

  await mostRecent.click();

  // Selecting a design populates the lesson name and swaps the footer from Add now to Next.
  const lessonName = page.locator(SELECTORS.lessonName);
  await lessonName.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await expectValue(lessonName, designTitle, config, 'lesson name');
  console.log(`Selected most recent design: ${designTitle}`);
  return designTitle;
}

export async function configureAdvancedOptions(page: Page, config: LamsConfig): Promise<string> {
  const settings = resolveLessonIndexSettings(config);
  await openTab(page, config, 'Advanced');

  await setToggle(page, config, SELECTORS.scoresToggle, 'Display activity scores on completion', settings.displayScoresOnCompletion);
  await setToggle(page, config, SELECTORS.schedulingToggle, 'Enable scheduling', settings.enableScheduling);

  const endDateTime = `${settings.endDate} ${settings.endTime}`;
  if (settings.enableScheduling) await setEndDateTime(page, config, endDateTime);
  return endDateTime;
}

/**
 * Applies the course grouping for a lesson.
 *
 * Y1 and Y2 run as a whole class, so a design that uses groupings offers exactly one
 * preset besides "None" and it is simply selected. A design without grouping activities
 * gets no Course groupings step at all — LAMS keeps Next hidden and commits straight
 * from Add now — so that case publishes as-is.
 *
 * lessonIndex.courseGrouping overrides the automatic choice by exact preset name, for
 * the rare course that offers more than one.
 */
export async function selectCourseGrouping(page: Page, config: LamsConfig): Promise<string> {
  const settings = resolveLessonIndexSettings(config);

  const next = page.locator(SELECTORS.next);
  if (!(await next.isVisible())) {
    console.log('No Course groupings step for this design; publishing without a preset.');
    return NO_PRESET;
  }
  await next.click();

  const radios = page.locator(SELECTORS.groupingRadio);
  await radios.first().waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  const presets: Array<{ label: string; radio: Locator }> = [];
  for (let index = 0; index < (await radios.count()); index += 1) {
    const radio = radios.nth(index);
    presets.push({ label: normalise(await radioLabel(radio)), radio });
  }
  const labels = presets.map((preset) => preset.label);

  let chosen: { label: string; radio: Locator } | undefined;
  if (settings.courseGrouping) {
    chosen = presets.find((preset) => preset.label === settings.courseGrouping);
    if (!chosen) {
      throw new Error(
        `Course grouping "${settings.courseGrouping}" is not offered. Available presets: ${labels.join(', ') || '(none)'}.`
      );
    }
  } else {
    const selectable = presets.filter((preset) => preset.label !== NO_PRESET);
    if (selectable.length === 0) {
      console.log('Only "None" is offered; publishing without a preset.');
      return NO_PRESET;
    }
    if (selectable.length > 1) {
      throw new Error(
        `Expected one course grouping besides "None" but found ${selectable.length} (${selectable
          .map((preset) => preset.label)
          .join(', ')}). Set lessonIndex.courseGrouping to choose.`
      );
    }
    chosen = selectable[0]!;
  }

  await chosen.radio.check();
  if (!(await chosen.radio.isChecked())) {
    throw new Error(`Course grouping "${chosen.label}" did not stay selected.`);
  }
  console.log(`Selected course grouping: ${chosen.label}`);
  return chosen.label;
}

export async function addLessonNow(page: Page, config: LamsConfig, options: LessonIndexOptions): Promise<void> {
  const addNow = page.locator(SELECTORS.addNow);
  await addNow.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  if (!(await addNow.isEnabled())) throw new Error('"Add now" is disabled; the lesson form is incomplete.');
  if (!options.commit) {
    console.log('Dry run complete: the lesson form was filled and verified; "Add now" was not clicked.');
    return;
  }
  await addNow.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log('Lesson created.');
}

export async function createLessonFromMostRecentDesign(
  page: Page,
  config: LamsConfig,
  options: LessonIndexOptions
): Promise<LessonIndexResult> {
  const designTitle = await selectMostRecentDesign(page, config);
  const lessonTitle = normalise(await page.locator(SELECTORS.lessonName).inputValue());
  const endDateTime = await configureAdvancedOptions(page, config);
  const courseGrouping = await selectCourseGrouping(page, config);
  await addLessonNow(page, config, options);
  return { designTitle, lessonTitle, endDateTime, courseGrouping, committed: options.commit };
}

async function setEndDateTime(page: Page, config: LamsConfig, endDateTime: string): Promise<void> {
  const input = page.locator(SELECTORS.endDatetime);
  await input.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await input.fill(endDateTime);
  // The jQuery datepicker overlay stays open after typing and would swallow later clicks.
  await input.press('Escape').catch(() => undefined);
  await expectValue(input, endDateTime, config, 'lesson end date/time');
  console.log(`Set lesson end date/time: ${endDateTime}`);
}

async function setToggle(
  page: Page,
  config: LamsConfig,
  selector: string,
  label: string,
  desired: boolean
): Promise<void> {
  const toggle = page.locator(selector);
  await toggle.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await toggle.setChecked(desired);
  if ((await toggle.isChecked()) !== desired) {
    throw new Error(`Toggle "${label}" could not be set to ${desired ? 'on' : 'off'}.`);
  }
  console.log(`Toggle "${label}" is ${desired ? 'on' : 'off'}.`);
}

async function openTab(page: Page, config: LamsConfig, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true }).first();
  await tab.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await tab.click();
  console.log(`Opened tab: ${name}`);
}

/** The grouping radios are wrapped in their label rather than carrying an accessible name. */
async function radioLabel(radio: Locator): Promise<string> {
  return radio.evaluate((element) => {
    const wrapper = element.closest('label') ?? element.parentElement;
    return wrapper?.textContent ?? '';
  });
}

async function expectValue(input: Locator, expected: string, config: LamsConfig, what: string): Promise<void> {
  await input
    .page()
    .waitForFunction(
      ([element, value]) => (element as HTMLInputElement).value.trim() === value,
      [await input.elementHandle(), expected] as const,
      { timeout: config.browser.actionTimeoutMs }
    )
    .catch(() => undefined);
  const actual = normalise(await input.inputValue());
  if (actual !== expected) {
    throw new Error(`The ${what} did not apply: expected "${expected}" but the field reads "${actual}".`);
  }
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
