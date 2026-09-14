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
