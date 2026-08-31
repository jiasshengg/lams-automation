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
  Pick<LessonIndexSettings, 'courseGrouping' | 'endDate' | 'endTime' | 'displayScoresOnCompletion' | 'enableScheduling'>
> & { expectedDesignTitle?: string };

export function resolveLessonIndexSettings(config: LamsConfig): ResolvedLessonIndexSettings {
  const settings = config.lessonIndex;
  if (!settings) throw new Error('Configuration field "lessonIndex" is required for the index workflow.');
  return {
    courseGrouping: settings.courseGrouping,
    endDate: settings.endDate,
    endTime: settings.endTime ?? '23:59',
    // TBL convention: hide per-activity scores, and time-box the lesson.
    displayScoresOnCompletion: settings.displayScoresOnCompletion ?? false,
    enableScheduling: settings.enableScheduling ?? true,
    ...(settings.expectedDesignTitle ? { expectedDesignTitle: settings.expectedDesignTitle } : {})
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
  const settings = resolveLessonIndexSettings(config);

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

  if (settings.expectedDesignTitle && designTitle !== settings.expectedDesignTitle) {
    throw new Error(
      `Refusing to continue: most recent design is "${designTitle}" but lessonIndex.expectedDesignTitle is "${settings.expectedDesignTitle}".`
    );
  }

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
 * Lesson titles carry the cohort year as a trailing token such as "2026Y1", and the
 * course grouping to apply is the one for that year. Callers write the grouping as a
 * template — "Y{{cohortYear}} ALL" — which is resolved from the selected design title.
 */
export function resolveCourseGrouping(template: string, designTitle: string): string {
  if (!template.includes('{{cohortYear}}')) return template;
  const match = /\b\d{2,4}Y(\d)\b/.exec(designTitle);
  if (!match) {
    throw new Error(
      `Cannot resolve {{cohortYear}}: design title "${designTitle}" has no cohort-year token such as "2026Y1".`
    );
  }
  return template.replaceAll('{{cohortYear}}', match[1]!);
}

export async function selectCourseGrouping(page: Page, config: LamsConfig, designTitle: string): Promise<string> {
  const settings = resolveLessonIndexSettings(config);
  const wanted = resolveCourseGrouping(settings.courseGrouping, designTitle);

  // LAMS only offers the Course groupings step for designs that contain grouping
  // activities; otherwise Next stays hidden and the footer commits straight from Add now.
  const next = page.locator(SELECTORS.next);
  if (!(await next.isVisible())) {
    if (wanted !== NO_PRESET) {
      throw new Error(
        `Design "${designTitle}" has no grouping activities, so the Course groupings step is not offered, but "${wanted}" was requested.`
      );
    }
    console.log('No Course groupings step for this design; no preset applied.');
    return NO_PRESET;
  }

  await next.click();

  const radios = page.locator(SELECTORS.groupingRadio);
  await radios.first().waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  const available: string[] = [];
  let target: Locator | undefined;
  for (let index = 0; index < (await radios.count()); index += 1) {
    const radio = radios.nth(index);
    const label = normalise(await radioLabel(radio));
    available.push(label);
    if (label === wanted) target = radio;
  }
  if (!target) {
    throw new Error(
      `Course grouping "${wanted}" is not offered for "${designTitle}". Available presets: ${available.join(', ') || '(none)'}.`
    );
  }

  await target.check();
  if (!(await target.isChecked())) {
    throw new Error(`Course grouping "${wanted}" did not stay selected.`);
  }
  const suffix = wanted === NO_PRESET ? ' (no preset applied)' : '';
  console.log(`Selected course grouping: ${wanted}${suffix}`);
  return wanted;
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
  const courseGrouping = await selectCourseGrouping(page, config, designTitle);
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
