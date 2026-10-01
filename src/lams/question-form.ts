import type { Frame } from '@playwright/test';

/**
 * Waits until a LAMS question editor is ready to save.
 *
 * While a question is edited, LAMS's qb-question.js repeatedly submits the form to its "check new
 * version" URL, pointing the form's action there until the reply arrives. saveQuestion(true)
 * appends "?newVersion=true" to whatever the action is at that moment, so a Save clicked mid-check
 * posts to the check URL instead: the check's bare true/false reply replaces the activity's
 * question list and the dialog closes without saving anything. A filled field that still has focus
 * starts that check on the very click that saves, so the field is committed first and the save
 * waits until the form is back on its save action with no request in flight.
 */
export async function waitForQuestionFormIdle(frame: Frame, timeoutMs: number): Promise<void> {
  // The check runs on the form's change event, which a changed field fires only when it loses
  // focus - left to itself, that is the moment the Save button is pressed. Committing the field
  // here starts any pending check now, so the wait below can see it finish.
  await frame.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
  });
  await frame.waitForFunction(
    () => {
      const page = window as typeof window & {
        isVersionCheck?: () => boolean;
        jQuery?: { active?: number };
      };
      const checking = typeof page.isVersionCheck === 'function' && page.isVersionCheck();
      return !checking && (page.jQuery?.active ?? 0) === 0;
    },
    undefined,
    { timeout: timeoutMs }
  );
}

/**
 * Asks LAMS to decide now whether the edited question needs a new version. The editor only offers
 * "Save as new version" once that check has answered, and it throttles checks triggered by typing,
 * skipping any in the first moments after the editor opens - a question filled that quickly would
 * never be offered the button. The quick form of LAMS's own check bypasses the throttle.
 */
export async function requestNewVersionCheck(frame: Frame, timeoutMs: number): Promise<void> {
  await waitForQuestionFormIdle(frame, timeoutMs);
  await frame.evaluate(() => {
    const page = window as typeof window & { checkQuestionNewVersion?: (quick: boolean) => void };
    if (typeof page.checkQuestionNewVersion === 'function') page.checkQuestionNewVersion(true);
  });
  await waitForQuestionFormIdle(frame, timeoutMs);
}
