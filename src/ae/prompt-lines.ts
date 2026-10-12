/**
 * An AE prompt is newline-delimited: each line is one block in LAMS and an empty line is a blank
 * line, both exactly where the Source-of-Truth prints them.
 *
 * A figure printed inside the case text is uploaded separately, so its position is held by this
 * placeholder line until the uploaded image can be written there.
 */
export const IMAGE_SLOT_LINE = '{{image}}';

/** The placeholder as it travels through promptHtml. `questionDescriptionHtml` always removes it. */
export const IMAGE_SLOT_HTML = '<!--sot-image-->';

/**
 * Where a table or drawn figure that Word renders as a picture sits, while the draft is built. The
 * draft turns it into an ordinary `IMAGE_SLOT_LINE` and records which rendered picture fills it.
 */
export function renderSlotLine(id: string): string {
  return `{{render:${id}}}`;
}

/** The render id a prompt line holds, or null for any other line. */
export function renderSlotId(line: string): string | null {
  return /^\{\{render:([^{}]+)\}\}$/.exec(line)?.[1] ?? null;
}
