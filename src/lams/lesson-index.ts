import type { Locator, Page } from '@playwright/test';
import type { LamsConfig, LessonIndexSettings } from '../config.js';
import { waitForUniqueVisible } from './navigation.js';

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

/**
 * Picks the top entry of the "Recently used designs" panel on the Add Lesson page,
 * which is the design the authoring workflow saved most recently.
 */
export async function selectMostRecentDesign(page: Page, config: LamsConfig): Promise<string> {
  const settings = resolveLessonIndexSettings(config);
  const entries = recentlyUsedEntries(page);
  await entries.first().waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  const mostRecent = entries.first();
  const designTitle = normalise(await mostRecent.innerText());
  if (designTitle === '') throw new Error('The most recent design entry has no readable title.');

  if (settings.expectedDesignTitle && designTitle !== settings.expectedDesignTitle) {
    throw new Error(
      `Refusing to continue: most recent design is "${designTitle}" but lessonIndex.expectedDesignTitle is "${settings.expectedDesignTitle}".`
    );
  }

  await mostRecent.click();
  const lessonName = lessonNameInput(page);
  await lessonName.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await waitForLessonName(page, config, designTitle);
  console.log(`Selected most recent design: ${designTitle}`);
  return designTitle;
}

export async function configureAdvancedOptions(page: Page, config: LamsConfig): Promise<string> {
  const settings = resolveLessonIndexSettings(config);
  await openTab(page, config, 'Advanced');

  await setToggle(page, config, 'Display activity scores on completion', settings.displayScoresOnCompletion);
  await setToggle(page, config, 'Enable scheduling', settings.enableScheduling);

  const endDateTime = `${settings.endDate} ${settings.endTime}`;
  if (settings.enableScheduling) await setEndDateTime(page, config, endDateTime);
  return endDateTime;
}

export async function selectCourseGrouping(page: Page, config: LamsConfig): Promise<string> {
  const settings = resolveLessonIndexSettings(config);
  await clickFooterButton(page, config, 'Next');

  await page
    .getByText('Course groupings', { exact: true })
    .first()
    .waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  const preset = page.getByRole('radio', { name: settings.courseGrouping, exact: false }).filter({ visible: true });
  const target = await waitForUniqueVisible(preset, page, config, `course grouping: ${settings.courseGrouping}`, false);
  await target.check();
  if (!(await target.isChecked())) {
    throw new Error(`Course grouping "${settings.courseGrouping}" did not stay selected.`);
  }
  const suffix = settings.courseGrouping === NO_PRESET ? ' (no preset applied)' : '';
  console.log(`Selected course grouping: ${settings.courseGrouping}${suffix}`);
  return settings.courseGrouping;
}

export async function addLessonNow(page: Page, config: LamsConfig, options: LessonIndexOptions): Promise<void> {
  const addNow = footerButton(page, 'Add now');
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
  const lessonTitle = normalise(await lessonNameInput(page).inputValue().catch(() => designTitle));
  const endDateTime = await configureAdvancedOptions(page, config);
  const courseGrouping = await selectCourseGrouping(page, config);
  await addLessonNow(page, config, options);
  return { designTitle, lessonTitle, endDateTime, courseGrouping, committed: options.commit };
}

async function setEndDateTime(page: Page, config: LamsConfig, endDateTime: string): Promise<void> {
  const input = endDateInput(page);
  await input.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });

  // The picker input is usually readonly, so write the value through the DOM and fire the
  // events the widget listens for instead of driving the hour/minute sliders.
  await input.evaluate((element, value) => {
    const field = element as HTMLInputElement;
    field.removeAttribute('readonly');
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, endDateTime);
  await input.blur().catch(() => undefined);

  const applied = normalise(await input.inputValue());
  if (applied !== endDateTime) {
    throw new Error(`End date/time did not apply: expected "${endDateTime}" but the field reads "${applied}".`);
  }
  console.log(`Set lesson end date/time: ${endDateTime}`);
}

async function setToggle(page: Page, config: LamsConfig, label: string, desired: boolean): Promise<void> {
  const toggle = page.getByRole('checkbox', { name: label, exact: false }).filter({ visible: true });
  const target = await waitForUniqueVisible(toggle, page, config, `toggle: ${label}`, false);
  if ((await target.isChecked()) !== desired) await target.setChecked(desired);
  if ((await target.isChecked()) !== desired) {
    throw new Error(`Toggle "${label}" could not be set to ${desired ? 'on' : 'off'}.`);
  }
  console.log(`Toggle "${label}" is ${desired ? 'on' : 'off'}.`);
}

async function waitForLessonName(page: Page, config: LamsConfig, expected: string): Promise<void> {
  const applied = await page
    .waitForFunction(
      (title) => {
        const input = document.querySelector<HTMLInputElement>('input#lessonName, input[name="lessonName"]');
        return (input?.value ?? '').trim() === title;
      },
      expected,
      { timeout: config.browser.actionTimeoutMs }
    )
    .catch(() => undefined);
  if (!applied) {
    const actual = normalise(await lessonNameInput(page).inputValue().catch(() => ''));
    throw new Error(`Lesson name did not populate from the design: expected "${expected}" but read "${actual}".`);
  }
}

async function openTab(page: Page, config: LamsConfig, name: string): Promise<void> {
  const tab = page.getByRole('tab', { name, exact: true }).filter({ visible: true });
  const target = await waitForUniqueVisible(tab, page, config, `tab: ${name}`, false);
  await target.click();
  console.log(`Opened tab: ${name}`);
}

async function clickFooterButton(page: Page, config: LamsConfig, name: string): Promise<void> {
  const button = footerButton(page, name);
  await button.waitFor({ state: 'visible', timeout: config.browser.actionTimeoutMs });
  await button.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  console.log(`Clicked ${name}.`);
}

function footerButton(page: Page, name: string): Locator {
  return page.getByRole('button', { name, exact: false }).filter({ visible: true }).first();
}

function recentlyUsedEntries(page: Page): Locator {
  return page
    .locator('[data-recently-used-designs] li, #recentlyUsedDesigns li, .recently-used-designs li')
    .filter({ visible: true });
}

function lessonNameInput(page: Page): Locator {
  return page.locator('input#lessonName, input[name="lessonName"]').filter({ visible: true }).first();
}

function endDateInput(page: Page): Locator {
  return page.locator('input#endDate, input[name="endDate"]').filter({ visible: true }).first();
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
