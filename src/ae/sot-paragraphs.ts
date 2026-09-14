import { readZipEntries, requireZipEntry } from '../docx/archive.js';
import { renderInlineSegments, type InlineSegment, type InlineTag } from './inline-html.js';
import { SOTLayoutReader, spacingBlankLines, type ParagraphLayout, type SOTLayoutParts } from './sot-layout.js';

export type { SOTLayoutParts };

export interface SOTParagraph {
  /** Visible text, whitespace-normalised. Every structural rule matches against this. */
  text: string;
  /** The same text with the emphasis observed in the DOCX preserved as inline HTML. */
  html: string;
  bold: boolean;
  imageCount: number;
  /**
   * Blank lines a reader sees above this paragraph: the empty paragraphs typed before it, or one
   * line when Word's paragraph spacing leaves a visible gap instead.
   */
  blankLinesBefore: number;
  /** The paragraph starts a new page. */
  pageBreakBefore: boolean;
}

export function readDocumentXmlFromDocx(buffer: Buffer): string {
  return requireZipEntry(readZipEntries(buffer), 'word/document.xml').toString('utf8');
}

/** The DOCX parts paragraph extraction reads: the body plus the styles and lists that lay it out. */
export function readSOTDocxParts(buffer: Buffer): SOTLayoutParts & { documentXml: string } {
  const entries = readZipEntries(buffer);
  const styles = entries.get('word/styles.xml');
  const numbering = entries.get('word/numbering.xml');
  return {
    documentXml: requireZipEntry(entries, 'word/document.xml').toString('utf8'),
    ...(styles ? { stylesXml: styles.toString('utf8') } : {}),
    ...(numbering ? { numberingXml: numbering.toString('utf8') } : {})
  };
}

/**
 * Reads the document as an ordered run of blocks. Tables are matched before paragraphs so a table
 * is read whole: its cells are `<w:p>` too, and matching those individually is what flattened a
 * table into a column of stray lines. Empty paragraphs are not blocks; they become the
 * `blankLinesBefore` of the next block that carries content.
 */
export function extractSOTParagraphs(documentXml: string, parts: SOTLayoutParts = {}): SOTParagraph[] {
  const blocks = /<w:tbl(?:\s[^>]*)?>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  const reader = new SOTLayoutReader(parts);
  const result: SOTParagraph[] = [];
  let previous: ParagraphLayout | null = null;
  let emptyParagraphs = 0;
  let pageBreak = false;

  for (const match of documentXml.matchAll(blocks)) {
    const layout = match[1] === undefined ? reader.read(match[2] ?? '') : TABLE_LAYOUT;
    const content = match[1] === undefined ? paragraphContent(match[2] ?? '', layout.listLabel) : tableContent(match[1]);
    pageBreak ||= layout.pageBreakBefore;
    if (content.text === '' && content.imageCount === 0) {
      // A paragraph holding only a page break moves to a new page; it is not a typed blank line.
      if (!layout.pageBreakAfter && !layout.pageBreakBefore) emptyParagraphs += 1;
      pageBreak ||= layout.pageBreakAfter;
      continue;
    }
    const spacing = spacingBlankLines(previous, layout);
    result.push({
      ...content,
      blankLinesBefore: result.length === 0 ? 0 : emptyParagraphs > 0 ? emptyParagraphs : spacing,
      pageBreakBefore: pageBreak
    });
    previous = layout;
    emptyParagraphs = 0;
    pageBreak = layout.pageBreakAfter;
  }
  return result;
}

/** Tables carry no paragraph spacing of their own; the paragraphs around them supply the gap. */
const TABLE_LAYOUT: ParagraphLayout = {
  styleId: null,
  spacingBefore: 0,
  spacingAfter: 0,
  contextualSpacing: false,
  listLabel: null,
  pageBreakBefore: false,
  pageBreakAfter: false
};

/** Reads one `<w:tbl>` as a single block whose html is the table itself. */
export function tableContent(xml: string): SOTParagraph {
  const rows = [...xml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((row) =>
    [...(row[1] ?? '').matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((cell) => {
      const paragraphs = [...(cell[1] ?? '').matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
        .map((paragraph) => ({ ...paragraphContent(paragraph[1] ?? ''), align: cellAlignment(paragraph[1] ?? '') }))
        .filter((paragraph) => paragraph.text !== '');
      const [first] = paragraphs;
      return {
        text: paragraphs.map((paragraph) => paragraph.text).join(' '),
        html: paragraphs.map((paragraph) => paragraph.html).join('<br>'),
        // A cell is aligned only when every line in it is; mixed alignment stays at the default.
        align: first && paragraphs.every((paragraph) => paragraph.align === first.align) ? first.align : null
      };
    })
  );
  const cells = rows.flat();
  return {
    text: cells.map((cell) => cell.text).filter((text) => text !== '').join(' '),
    html: rows.length === 0 ? '' : renderTable(rows, columnWidths(xml), tableWidthPx(xml)),
    bold: false,
    imageCount: 0,
    blankLinesBefore: 0,
    pageBreakBefore: false
  };
}

/** `w:gridCol` widths are twips; the document's proportions are what carry over, not the absolute size. */
function columnWidths(xml: string): number[] {
  const columns = [...xml.matchAll(/<w:gridCol\b[^>]*\bw:w="(\d+)"/g)].map((column) => Number(column[1]));
  const total = columns.reduce((sum, width) => sum + width, 0);
  return total === 0 ? [] : columns.map((width) => Math.round((width / total) * 100));
}

/** The printed width of the table: its grid columns in twips, at 15 twips per CSS pixel. */
function tableWidthPx(xml: string): number | null {
  const total = [...xml.matchAll(/<w:gridCol\b[^>]*\bw:w="(\d+)"/g)].reduce((sum, column) => sum + Number(column[1]), 0);
  return total === 0 ? null : Math.round(total / 15);
}

function cellAlignment(paragraphXml: string): 'center' | 'right' | null {
  const value = /<w:pPr>[\s\S]*?<w:jc w:val="([^"]+)"/.exec(paragraphXml)?.[1];
  if (value === 'center') return 'center';
  return value === 'right' || value === 'end' ? 'right' : null;
}

/**
 * Every cell is a `td`: Word's header row is styled with bold runs, which the cell html already
 * carries, whereas `th` would add centring the document does not have.
 */
function renderTable(
  rows: { text: string; html: string; align: 'center' | 'right' | null }[][],
  widths: number[],
  widthPx: number | null
): string {
  const body = rows
    .map((cells, rowIndex) =>
      `<tr>${cells
        .map((cell, columnIndex) => {
          // Widths are declared once, on the first row, the way Word's grid declares them.
          const width = rowIndex === 0 && widths[columnIndex] !== undefined ? ` width="${widths[columnIndex]}%"` : '';
          const align = cell.align === null ? '' : ` align="${cell.align}"`;
          return `<td${width}${align}>${cell.html}</td>`;
        })
        .join('')}</tr>`
    )
    .join('');
  return `<table${widthPx === null ? '' : ` width="${widthPx}"`}>${body}</table>`;
}

/** Reads one `<w:p>` body. Shared so image captions resolve exactly as prompts do. */
export function paragraphContent(xml: string, listLabel: string | null = null): SOTParagraph {
  const segments = paragraphSegments(xml);
  const contentText = segments.map((segment) => segment.text).join('');
  // Word prints a list paragraph's label without storing it as text, so it is added here and
  // "A." reads exactly as the page shows it. An empty list item stays empty.
  const shown = listLabel !== null && contentText !== '' ? [{ text: `${listLabel} `, tags: [] }, ...segments] : segments;
  return {
    text: shown.map((segment) => segment.text).join(''),
    html: renderInlineSegments(shown),
    // Word marks an answer key by emboldening the whole option paragraph, so a
    // paragraph only counts as bold when no visible character is left plain.
    bold: contentText !== '' && segments.every((segment) => segment.text.trim() === '' || segment.tags.includes('strong')),
    imageCount: [...xml.matchAll(/<w:drawing\b/g)].length,
    blankLinesBefore: 0,
    pageBreakBefore: false
  };
}

/**
 * Word splits a single sentence across many runs, so formatting is resolved per
 * character and only then regrouped. Collapsing whitespace afterwards keeps `text`
 * identical to a plain-text reading of the paragraph.
 */
function paragraphSegments(xml: string): InlineSegment[] {
  const pattern =
    /<w:r(?:\s[^>]*)?>|<\/w:r>|<w:rPr(?:\s[^>]*)?>([\s\S]*?)<\/w:rPr>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>)/g;
  const characters: { character: string; tags: readonly InlineTag[] }[] = [];
  let tags: readonly InlineTag[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(xml)) !== null) {
    if (match[1] !== undefined) {
      tags = runTags(match[1]);
      continue;
    }
    if (match[2] !== undefined || match[3] !== undefined) {
      // A tab or line break reads as a space, matching a plain-text reading of the run.
      for (const character of match[2] === undefined ? ' ' : decodeXml(match[2])) characters.push({ character, tags });
      continue;
    }
    // A run boundary: formatting never leaks past the run that declared it.
    tags = [];
  }
  return groupSegments(normalizeWhitespace(characters));
}

// Each toggle matches only its own element: `<w:bCs/>` and `<w:iCs/>` are the
// complex-script variants and must not switch on Latin bold or italic.
const BOLD = /<w:b(?:\s[^>]*)?\/?>/i;
const ITALIC = /<w:i(?:\s[^>]*)?\/?>/i;
const UNDERLINE = /<w:u(?:\s[^>]*)?\/?>/i;
const VERTICAL_ALIGN = /<w:vertAlign\b[^>]*w:val=["'](superscript|subscript)["']/i;

/** Direct run properties only: DOCX styles are not resolved, matching prior behaviour. */
function runTags(runProperties: string): readonly InlineTag[] {
  const tags: InlineTag[] = [];
  if (enabled(BOLD, runProperties)) tags.push('strong');
  if (enabled(ITALIC, runProperties)) tags.push('em');
  if (enabled(UNDERLINE, runProperties)) tags.push('u');
  const vertical = VERTICAL_ALIGN.exec(runProperties)?.[1];
  if (vertical === 'superscript') tags.push('sup');
  if (vertical === 'subscript') tags.push('sub');
  return tags;
}

/** Word writes a bare `<w:b/>` to switch a toggle on and `w:val="0"`/`"none"` to switch it off. */
function enabled(pattern: RegExp, runProperties: string): boolean {
  const match = pattern.exec(runProperties);
  return match !== null && !/w:val=["'](?:0|false|off|none)["']/i.test(match[0]);
}

/**
 * A collapsed space inherits only the formatting both neighbours share, so a bold
 * word never drags a trailing underline or emphasis across the gap beside it.
 */
function normalizeWhitespace(
  characters: { character: string; tags: readonly InlineTag[] }[]
): { character: string; tags: readonly InlineTag[] }[] {
  const result: { character: string; tags: readonly InlineTag[] }[] = [];
  let pendingSpace = false;
  for (const entry of characters) {
    const character = entry.character === '\u00a0' ? ' ' : entry.character;
    if (/\s/.test(character)) {
      pendingSpace = result.length > 0;
      continue;
    }
    if (pendingSpace) {
      const previous = result[result.length - 1]!.tags;
      result.push({ character: ' ', tags: previous.filter((tag) => entry.tags.includes(tag)) });
      pendingSpace = false;
    }
    result.push({ character, tags: entry.tags });
  }
  return result;
}

function groupSegments(characters: { character: string; tags: readonly InlineTag[] }[]): InlineSegment[] {
  const segments: InlineSegment[] = [];
  for (const entry of characters) {
    const previous = segments[segments.length - 1];
    if (previous && sameTags(previous.tags, entry.tags)) previous.text += entry.character;
    else segments.push({ text: entry.character, tags: entry.tags });
  }
  return segments;
}

function sameTags(left: readonly InlineTag[], right: readonly InlineTag[]): boolean {
  return left.length === right.length && left.every((tag) => right.includes(tag));
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}
