/**
 * Paragraph layout read from a Source-of-Truth DOCX: the vertical gaps Word leaves between
 * paragraphs, page breaks, and the letters Word generates for list paragraphs.
 *
 * Only layout that changes what a learner reads is carried into LAMS. Fonts, sizes, colours,
 * indents, and alignment stay at the LAMS defaults, so nothing here returns styling.
 */
export interface SOTLayoutParts {
  stylesXml?: string;
  numberingXml?: string;
}

export interface ParagraphLayout {
  styleId: string | null;
  /** Twips. */
  spacingBefore: number;
  /** Twips. */
  spacingAfter: number;
  contextualSpacing: boolean;
  /** The label Word prints ahead of a list paragraph, such as "A.", or null. */
  listLabel: string | null;
  /**
   * The number Word prints ahead of a decimal list item, such as "1.". It is shown to the reader
   * and kept out of `text`, so a numbered statement list cannot open a question by its text.
   */
  displayLabel?: string | null;
  /**
   * Which decimal list the paragraph belongs to and the number Word prints for it. A generated
   * number is still a question number when the questions around it say so; see
   * `numberQuestionStems`, which is the only place that decides.
   */
  listItem?: DecimalListItem | null;
  /** A page break precedes the paragraph's first visible character. */
  pageBreakBefore: boolean;
  /** A page break follows the paragraph's last visible character. */
  pageBreakAfter: boolean;
  /**
   * How far the paragraph is indented from the left margin, in twips. A line the document pushes
   * across the page this way is standing over a column of the block below it.
   */
  indentTwips: number;
}

/** One item of a decimal list: the list and level it counts in, and the number Word prints. */
export interface DecimalListItem {
  key: string;
  number: number;
}

/** 6pt. Smaller gaps (such as 2pt between answer options) read as ordinary line spacing. */
export const BLANK_LINE_TWIPS = 120;

interface SpacingProperties {
  before?: number;
  after?: number;
  contextualSpacing?: boolean;
}

interface ListLevel {
  format: string;
  text: string;
  start: number;
}

/**
 * Lettered and Roman lists are labelled. A decimal list's number is only displayed: a generated
 * "1." read as text would make every numbered statement a question stem. Whether it opens a
 * question is decided from `listItem` by `numberQuestionStems` instead.
 */
const LABELLED_FORMATS = new Set(['upperLetter', 'lowerLetter', 'upperRoman', 'lowerRoman']);

export class SOTLayoutReader {
  private readonly defaults: SpacingProperties;
  private readonly styles: Map<string, { basedOn: string | null; spacing: SpacingProperties }>;
  private readonly defaultStyleId: string | null;
  private readonly lists: Map<string, Map<number, ListLevel>>;
  private readonly counters = new Map<string, number[]>();

  constructor(parts: SOTLayoutParts = {}) {
    const stylesXml = parts.stylesXml ?? '';
    this.defaults = spacingProperties(/<w:pPrDefault>([\s\S]*?)<\/w:pPrDefault>/.exec(stylesXml)?.[1] ?? '');
    this.styles = new Map(
      [...stylesXml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)]
        .filter((style) => /w:type="paragraph"/.test(style[1] ?? ''))
        .map((style) => [
          attribute(style[1] ?? '', 'w:styleId') ?? '',
          {
            basedOn: /<w:basedOn w:val="([^"]+)"/.exec(style[2] ?? '')?.[1] ?? null,
            spacing: spacingProperties(/<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(style[2] ?? '')?.[1] ?? '')
          }
        ])
    );
    this.defaultStyleId =
      [...stylesXml.matchAll(/<w:style\b([^>]*)>/g)]
        .map((style) => style[1] ?? '')
        .filter((attributes) => /w:type="paragraph"/.test(attributes) && /w:default="1"/.test(attributes))
        .map((attributes) => attribute(attributes, 'w:styleId'))[0] ?? null;
    this.lists = readLists(parts.numberingXml ?? '');
  }

  /** Reads one `<w:p>` body. Stateful: list counters advance in document order. */
  read(paragraphXml: string): ParagraphLayout {
    const properties = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paragraphXml)?.[1] ?? '';
    const styleId = /<w:pStyle w:val="([^"]+)"/.exec(properties)?.[1] ?? this.defaultStyleId;
    const spacing = { ...this.defaults, ...this.styleSpacing(styleId), ...spacingProperties(properties) };
    const body = paragraphXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/, '');
    const firstText = body.search(/<w:t[\s>]/);
    const breaks = [...body.matchAll(/<w:br\b[^>]*w:type="page"[^>]*\/>/g)].map((match) => match.index!);
    return {
      styleId,
      spacingBefore: spacing.before ?? 0,
      spacingAfter: spacing.after ?? 0,
      contextualSpacing: spacing.contextualSpacing ?? false,
      ...this.labels(properties),
      pageBreakBefore: /<w:pageBreakBefore(?:\s[^>]*)?\/>/.test(properties) || (firstText >= 0 && breaks.some((at) => at < firstText)),
      pageBreakAfter: breaks.some((at) => firstText < 0 || at > firstText),
      indentTwips: Number(/<w:ind\b[^>]*\bw:left="(\d+)"/.exec(properties)?.[1] ?? 0)
    };
  }

  private styleSpacing(styleId: string | null): SpacingProperties {
    const chain: SpacingProperties[] = [];
    const seen = new Set<string>();
    for (let id = styleId; id !== null && !seen.has(id); id = this.styles.get(id)?.basedOn ?? null) {
      seen.add(id);
      const style = this.styles.get(id);
      if (style) chain.unshift(style.spacing);
    }
    return Object.assign({}, ...chain);
  }

  private labels(properties: string): { listLabel: string | null; displayLabel: string | null; listItem: DecimalListItem | null } {
    const label = this.listLabel(properties);
    if (label === null) return { listLabel: null, displayLabel: null, listItem: null };
    return label.structural
      ? { listLabel: label.text, displayLabel: null, listItem: null }
      : { listLabel: null, displayLabel: label.text, listItem: label.item };
  }

  private listLabel(properties: string): { text: string; structural: boolean; item: DecimalListItem | null } | null {
    const numId = /<w:numId w:val="(\d+)"/.exec(properties)?.[1];
    if (numId === undefined || numId === '0') return null;
    const levelIndex = Number(/<w:ilvl w:val="(\d+)"/.exec(properties)?.[1] ?? 0);
    const levels = this.lists.get(numId);
    if (!levels?.has(levelIndex)) return null;
    const counts = this.counters.get(numId) ?? [];
    counts[levelIndex] = (counts[levelIndex] ?? levels.get(levelIndex)!.start - 1) + 1;
    // Starting a shallower item restarts every deeper level beneath it.
    counts.length = levelIndex + 1;
    this.counters.set(numId, counts);
    const level = levels.get(levelIndex)!;
    const structural = LABELLED_FORMATS.has(level.format);
    if (!structural && level.format !== 'decimal') return null;
    const text = level.text.replace(/%(\d)/g, (_match, depth: string) => {
      const index = Number(depth) - 1;
      return formatCounter(counts[index] ?? levels.get(index)?.start ?? 1, levels.get(index)?.format ?? level.format);
    });
    const item = structural ? null : { key: `${numId}:${levelIndex}`, number: counts[levelIndex]! };
    return text.trim() === '' ? null : { text, structural, item };
  }
}

/** The number of blank lines Word's paragraph spacing visibly leaves between two paragraphs. */
export function spacingBlankLines(previous: ParagraphLayout | null, next: ParagraphLayout): number {
  if (previous === null) return 0;
  if (previous.styleId === next.styleId && (previous.contextualSpacing || next.contextualSpacing)) return 0;
  return Math.max(previous.spacingAfter, next.spacingBefore) >= BLANK_LINE_TWIPS ? 1 : 0;
}

function spacingProperties(xml: string): SpacingProperties {
  const spacing = /<w:spacing\b([^>]*)\/?>/.exec(xml)?.[1] ?? '';
  const result: SpacingProperties = {};
  const before = attribute(spacing, 'w:before');
  const after = attribute(spacing, 'w:after');
  if (before !== null) result.before = Number(before);
  if (after !== null) result.after = Number(after);
  const contextual = /<w:contextualSpacing(?:\s[^>]*)?\/>/.exec(xml)?.[0];
  if (contextual !== undefined) result.contextualSpacing = !/w:val="(?:0|false|off)"/.test(contextual);
  return result;
}

function readLists(numberingXml: string): Map<string, Map<number, ListLevel>> {
  const abstracts = new Map(
    [...numberingXml.matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)].map((abstract) => [
      abstract[1]!,
      readLevels(abstract[2] ?? '')
    ])
  );
  return new Map(
    [...numberingXml.matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)].map((num) => {
      const levels = new Map(abstracts.get(/<w:abstractNumId w:val="(\d+)"/.exec(num[2] ?? '')?.[1] ?? '') ?? []);
      for (const override of (num[2] ?? '').matchAll(/<w:lvlOverride w:ilvl="(\d+)">([\s\S]*?)<\/w:lvlOverride>/g)) {
        const index = Number(override[1]);
        const base = readLevels(override[2] ?? '').get(index) ?? levels.get(index);
        const start = /<w:startOverride w:val="(\d+)"/.exec(override[2] ?? '')?.[1];
        if (base) levels.set(index, start === undefined ? base : { ...base, start: Number(start) });
      }
      return [num[1]!, levels];
    })
  );
}

function readLevels(xml: string): Map<number, ListLevel> {
  return new Map(
    [...xml.matchAll(/<w:lvl w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)].map((level) => [
      Number(level[1]),
      {
        format: /<w:numFmt w:val="([^"]+)"/.exec(level[2] ?? '')?.[1] ?? 'decimal',
        text: /<w:lvlText w:val="([^"]*)"/.exec(level[2] ?? '')?.[1] ?? '',
        start: Number(/<w:start w:val="(\d+)"/.exec(level[2] ?? '')?.[1] ?? 1)
      }
    ])
  );
}

function formatCounter(value: number, format: string): string {
  switch (format) {
    case 'upperLetter':
      return letters(value);
    case 'lowerLetter':
      return letters(value).toLowerCase();
    case 'upperRoman':
      return roman(value);
    case 'lowerRoman':
      return roman(value).toLowerCase();
    default:
      return String(value);
  }
}

/** Word repeats the letter past Z: 27 is "AA", 28 is "BB". */
function letters(value: number): string {
  const letter = String.fromCharCode(65 + ((value - 1) % 26));
  return letter.repeat(Math.floor((value - 1) / 26) + 1);
}

function roman(value: number): string {
  const numerals: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let remaining = value;
  return numerals.reduce((result, [amount, numeral]) => {
    const count = Math.floor(remaining / amount);
    remaining -= count * amount;
    return result + numeral.repeat(count);
  }, '');
}

function attribute(attributes: string, name: string): string | null {
  return new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}
