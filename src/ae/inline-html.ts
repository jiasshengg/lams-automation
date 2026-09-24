/**
 * Inline formatting shared by Source-of-Truth extraction and reviewed AE input.
 *
 * LAMS CKEditor fields accept HTML, so emphasis observed in the SoT DOCX must
 * survive extraction, the reviewed JSON, and the browser write unchanged. Only
 * this allowlist crosses that boundary; every other tag is escaped so reviewed
 * JSON can never inject markup into the authoring surface.
 */
export type InlineTag = 'strong' | 'em' | 'u' | 'sup' | 'sub';

/** Nesting order used when rendering, so equal formatting always renders identically. */
const TAG_ORDER: readonly InlineTag[] = ['strong', 'em', 'u', 'sup', 'sub'];

const TAG_ALIASES: Readonly<Record<string, InlineTag>> = {
  b: 'strong',
  strong: 'strong',
  i: 'em',
  em: 'em',
  u: 'u',
  ins: 'u',
  sup: 'sup',
  sub: 'sub'
};

export interface InlineSegment {
  text: string;
  tags: readonly InlineTag[];
}

const TAG_PATTERN = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\s*\/?\s*>/g;

/** Keeps only the allowlisted tags, escapes everything else, and balances the result. */
export function sanitizeInlineHtml(value: string): string {
  return renderInlineSegments(parseInlineHtml(value));
}

/** The visible text of inline HTML, with entities decoded exactly once. */
export function inlineHtmlToText(value: string): string {
  return parseInlineHtml(value)
    .map((segment) => segment.text)
    .join('');
}

/** Re-renders the `[start, end)` slice of the visible text with its formatting intact. */
export function sliceInlineHtml(value: string, start: number, end: number): string {
  const sliced: InlineSegment[] = [];
  let offset = 0;
  for (const segment of parseInlineHtml(value)) {
    const from = Math.max(start, offset);
    const to = Math.min(end, offset + segment.text.length);
    if (to > from) sliced.push({ text: segment.text.slice(from - offset, to - offset), tags: segment.tags });
    offset += segment.text.length;
  }
  return renderInlineSegments(sliced);
}

/**
 * Drops an "A." style answer label from formatted option text without losing emphasis.
 * Whitespace after the separator is required so option text that opens with its own
 * identifier, such as a pedigree option "I:1 and I:2", keeps every character.
 */
export function stripOptionPrefixHtml(value: string): string {
  const text = inlineHtmlToText(value);
  const prefix = /^\s*[A-Za-z]\s*[).:-]\s+/.exec(text)?.[0].length ?? 0;
  return sliceInlineHtml(value, prefix + leadingSpace(text, prefix), text.trimEnd().length);
}

/**
 * Makes every http(s) address in already-sanitized HTML a clickable link, so a Source-of-Truth
 * reference reaches learners as a link rather than dead text. Trailing sentence punctuation stays
 * outside the link. Only the http and https schemes are ever linked.
 */
export function linkifyUrls(sanitizedHtml: string): string {
  return sanitizedHtml.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
    const url = match.replace(/[.,;:!?)\]]+$/, '');
    return `<a href="${url}">${url}</a>${match.slice(url.length)}`;
  });
}

/**
 * Drops a "1." style question number from a formatted stem without losing emphasis, or
 * returns null when the stem does not open with exactly that number.
 */
/**
 * Removes the question number a stem is printed with, so LAMS's own numbering is the only one a
 * learner sees. A punctuated number is the document's numbering whatever its value ("6.", "Q16."),
 * because Source-of-Truth documents renumber and repeat themselves. A number with no punctuation
 * is only a question number when it is one this question is known by: "2 weeks later…" is prose.
 */
export function stripQuestionNumberHtml(value: string, numbers: number | readonly number[]): string | null {
  const known = typeof numbers === 'number' ? [numbers] : numbers;
  const text = inlineHtmlToText(value);
  const punctuated = /^\s*(?:Q\s?)?(\d+)\s*[.):]\s+/i.exec(text);
  const bare = /^\s*(\d+)\s+/.exec(text);
  const match = punctuated ?? (bare && known.includes(Number(bare[1])) ? bare : null);
  if (!match) return null;
  const prefix = match[0].length;
  return sliceInlineHtml(value, prefix + leadingSpace(text, prefix), text.trimEnd().length);
}

/**
 * Removes a tag that covers the whole value, leaving partial emphasis untouched.
 *
 * Word marks an answer key by emboldening an entire option, so copying that bold
 * into LAMS would show learners which option is correct. Emphasis inside an option
 * is never uniform, so it survives.
 */
export function withoutUniformInlineTag(value: string, tag: InlineTag): string {
  const segments = parseInlineHtml(value);
  const visible = segments.filter((segment) => segment.text.trim() !== '');
  if (visible.length === 0 || !visible.every((segment) => segment.tags.includes(tag))) {
    return renderInlineSegments(segments);
  }
  return renderInlineSegments(
    segments.map((segment) => ({ text: segment.text, tags: segment.tags.filter((existing) => existing !== tag) }))
  );
}

/** Builds inline HTML from observed formatting runs, merging runs that carry equal tags. */
export function renderInlineSegments(segments: readonly InlineSegment[]): string {
  const parts: string[] = [];
  let open: readonly InlineTag[] = [];
  for (const segment of merge(segments)) {
    const next = canonical(segment.tags);
    let shared = 0;
    while (shared < open.length && shared < next.length && open[shared] === next[shared]) shared += 1;
    for (let index = open.length - 1; index >= shared; index -= 1) parts.push(`</${open[index]!}>`);
    for (let index = shared; index < next.length; index += 1) parts.push(`<${next[index]!}>`);
    parts.push(escapeHtmlText(segment.text));
    open = next;
  }
  for (let index = open.length - 1; index >= 0; index -= 1) parts.push(`</${open[index]!}>`);
  return parts.join('');
}

export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character]!;
  });
}

/**
 * Reads inline HTML as formatting segments. A `<br>` becomes a space because AE
 * prompts already express line structure as separate newline-delimited lines.
 */
function parseInlineHtml(value: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const stack: InlineTag[] = [];
  let cursor = 0;
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  const pushText = (text: string) => {
    if (text !== '') segments.push({ text: decodeEntities(text), tags: [...stack] });
  };

  while ((match = TAG_PATTERN.exec(value)) !== null) {
    const name = match[2]!.toLowerCase();
    const tag = TAG_ALIASES[name];
    const closing = match[1] === '/';
    if (tag === undefined && name !== 'br') continue;
    pushText(value.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (name === 'br') {
      if (!closing) segments.push({ text: ' ', tags: [...stack] });
      continue;
    }
    if (!closing) {
      stack.push(tag!);
      continue;
    }
    const depth = stack.lastIndexOf(tag!);
    if (depth >= 0) stack.splice(depth, 1);
  }
  pushText(value.slice(cursor));
  return segments;
}

function merge(segments: readonly InlineSegment[]): InlineSegment[] {
  const merged: InlineSegment[] = [];
  for (const segment of segments) {
    if (segment.text === '') continue;
    const previous = merged[merged.length - 1];
    if (previous && sameTags(previous.tags, segment.tags)) merged[merged.length - 1] = { text: previous.text + segment.text, tags: previous.tags };
    else merged.push({ text: segment.text, tags: canonical(segment.tags) });
  }
  return merged;
}

function canonical(tags: readonly InlineTag[]): InlineTag[] {
  return TAG_ORDER.filter((tag) => tags.includes(tag));
}

function sameTags(left: readonly InlineTag[], right: readonly InlineTag[]): boolean {
  const a = canonical(left);
  const b = canonical(right);
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

function leadingSpace(text: string, from: number): number {
  return text.slice(from).length - text.slice(from).trimStart().length;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_match, name: string) =>
      ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[name]!);
}
