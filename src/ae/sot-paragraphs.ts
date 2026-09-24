import { readZipEntries, requireZipEntry } from '../docx/archive.js';
import { renderInlineSegments, type InlineSegment, type InlineTag } from './inline-html.js';
import { SOTLayoutReader, spacingBlankLines, type ParagraphLayout, type SOTLayoutParts } from './sot-layout.js';
import {
  paragraphBlocks,
  topLevelBlocks,
  withoutCompatibilityFallback,
  withoutTextBoxes
} from '../docx/blocks.js';

/** The gap a tab leaves: four non-breaking spaces, because HTML collapses ordinary ones. */
const TAB_GAP = '    ';

/**
 * The figures in a paragraph: one per embedded picture, so a grouped drawing holding several
 * pictures counts each, and a shape with no picture (a text box, an arrow) counts none. This is
 * the same set the image extractor uploads, so every image slot has its picture.
 */
function pictureCount(xml: string): number {
  const drawings = [...xml.matchAll(/<w:drawing\b[\s\S]*?<\/w:drawing>/g)].reduce((sum, drawing) => {
    const wrapped = [...drawing[0].matchAll(/<pic:pic\b/g)].length;
    return sum + (wrapped > 0 ? wrapped : [...drawing[0].matchAll(/<a:blip\b[^>]*\br:embed=/g)].length);
  }, 0);
  // A legacy VML picture with no DrawingML version; the fallback copy was already removed.
  const legacy = [...xml.matchAll(/<w:pict\b[\s\S]*?<\/w:pict>/g)].reduce(
    (sum, pict) => sum + [...pict[0].matchAll(/<v:imagedata\b[^>]*\br:id=/g)].length,
    0
  );
  return drawings + legacy;
}

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
  /** For a table block, its cell text row by row. Absent for an ordinary paragraph. */
  cells?: string[][];
  /** How far the document indents the line from the left margin, in twips. */
  indentTwips?: number;
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
 * Every paragraph in reading order (body paragraphs, then each table cell's paragraphs where the
 * table sits) with the list label Word prints ahead of it. Question numbering reads these, so an
 * option list Word numbers automatically ("A.") is recognised just as a typed one is. Lists are
 * counted across body paragraphs only, exactly as `extractSOTParagraphs` counts them.
 */
export function readParagraphsWithListLabels(
  documentXml: string,
  parts: SOTLayoutParts = {}
): { xml: string; content: SOTParagraph; structureText: string }[] {
  const reader = new SOTLayoutReader(parts);
  return topLevelBlocks(documentXml).flatMap((block) => {
    if (block.kind === 'p') {
      const content = paragraphContent(block.inner, reader.read(block.inner).listLabel);
      return [{ xml: block.inner, content, structureText: content.text }];
    }
    // A table reads as one block of structure, as `extractSOTParagraphs` reads it: an option list
    // laid out in cells ("A | Complete heart block") is only recognisable from the whole table.
    const tableText = tableContent(block.inner).text;
    return paragraphBlocks(block.inner).map((xml, index) => ({
      xml,
      content: paragraphContent(xml),
      structureText: index === 0 ? tableText : ''
    }));
  });
}

/**
 * Reads the document as an ordered run of blocks. Tables are matched before paragraphs so a table
 * is read whole: its cells are `<w:p>` too, and matching those individually is what flattened a
 * table into a column of stray lines. Empty paragraphs are not blocks; they become the
 * `blankLinesBefore` of the next block that carries content.
 */
export function extractSOTParagraphs(documentXml: string, parts: SOTLayoutParts = {}): SOTParagraph[] {
  const reader = new SOTLayoutReader(parts);
  const result: SOTParagraph[] = [];
  let previous: ParagraphLayout | null = null;
  let emptyParagraphs = 0;
  let pageBreak = false;

  for (const block of topLevelBlocks(documentXml)) {
    const layout = block.kind === 'p' ? reader.read(block.inner) : TABLE_LAYOUT;
    const content = block.kind === 'p' ? paragraphContent(block.inner, layout.listLabel) : tableContent(block.inner);
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
      pageBreakBefore: pageBreak,
      indentTwips: layout.indentTwips
    });
    previous = layout;
    emptyParagraphs = 0;
    pageBreak = layout.pageBreakAfter;
  }
  return asTabTables(result);
}

/** A line the document pushes this far across the page stands over a column, not at the margin. */
const HEADER_INDENT_TWIPS = 2880;
/** One or more tabs in a row separate two columns; the gap they leave is four spaces each. */
const TAB_COLUMN_BREAK = new RegExp(TAB_GAP + '+', 'g');

/**
 * Word lays a block of results out with tab stops, not a table: each line holds a label, a value
 * and a reference range, separated by however many tabs reach the next stop. Written as text those
 * columns drift apart, because the number of tabs differs line to line. Read as a table they line
 * up as the document prints them, and the line the document indents over the last column - the
 * "Reference Range" heading - joins it there.
 */
function asTabTables(paragraphs: SOTParagraph[]): SOTParagraph[] {
  const result: SOTParagraph[] = [];
  for (let index = 0; index < paragraphs.length; index += 1) {
    const rows: string[][] = [];
    const first = index;
    // A heading the document pushes across the page with an indent stands over the last column of
    // the block below it, so it opens that block rather than sitting apart from it.
    const header = paragraphs[index];
    const opensWithHeader =
      header !== undefined &&
      (header.indentTwips ?? 0) >= HEADER_INDENT_TWIPS &&
      tabColumns(paragraphs[index + 1]) !== null;
    if (opensWithHeader) index += 1;
    while (index < paragraphs.length) {
      const columns = tabColumns(paragraphs[index]);
      if (columns === null) break;
      rows.push(columns);
      index += 1;
    }
    if (rows.length === 0 || rows.every((row) => row.filter((cell) => cell !== '').length < 2)) {
      result.push(paragraphs[first]!);
      index = first;
      continue;
    }
    const dataRows = rows.filter((row) => row.filter((cell) => cell !== '').length >= 2);
    const dataWidth = Math.max(...dataRows.map((row) => row.length));
    const padded = rows.map((row) => fitToWidth(row, dataWidth));
    // The columns the data leaves empty are spacing, not columns — dropped before a heading is
    // placed, so the heading stands over a column that carries something.
    dropEmptyColumns(padded.filter((row) => row.filter((cell) => cell !== '').length >= 2));
    const width = padded.find((row) => row.filter((cell) => cell !== '').length >= 2)!.length;
    const fitted = padded.map((row) => fitToWidth(row.filter((cell, at) => at < width || cell !== ''), width));
    if (opensWithHeader) fitted.unshift([...Array.from({ length: width - 1 }, () => ''), header!.html]);
    const source = paragraphs[first]!;
    result.push({
      text: fitted.flat().filter((cell) => cell !== '').join(' '),
      html: '<table data-layout="tabs">' + fitted.map((row) => '<tr>' + row.map((cell) => '<td>' + cell + '</td>').join('') + '</tr>').join('') + '</table>',
      bold: false,
      imageCount: 0,
      blankLinesBefore: source.blankLinesBefore,
      pageBreakBefore: source.pageBreakBefore
    });
    index -= 1;
  }
  return result;
}

/**
 * The columns a tab-laid-out line holds, or null when the line is ordinary prose. A line holding
 * one word after a run of tabs counts too: that is how the document positions a column heading.
 */
function tabColumns(paragraph: SOTParagraph | undefined): string[] | null {
  if (paragraph === undefined || paragraph.imageCount > 0 || !paragraph.html.includes(TAB_GAP)) return null;
  const columns = paragraph.html.split(TAB_COLUMN_BREAK).map((cell) => cell.trim());
  const filled = columns.filter((cell) => cell !== '').length;
  return filled >= 2 || (filled === 1 && columns[0] === '') ? columns : null;
}

/**
 * Fits a row to the block's width. A heading the document positions with tabs — one word after a
 * run of them — belongs over the column it was pushed to, so it fills from the right; a data row
 * starts at the first column and any missing cells are at the end.
 */
function fitToWidth(row: string[], width: number): string[] {
  const text = row.filter((cell) => cell !== '');
  const positionedHeading = text.length === 1 && row[0] === '';
  if (positionedHeading || row.length > width) {
    return [...Array.from({ length: Math.max(width - text.length, 0) }, () => ''), ...text].slice(-width);
  }
  return [...row, ...Array.from({ length: width - row.length }, () => '')];
}

/** A column empty in every row is spacing the document left, not a column of its own. */
function dropEmptyColumns(rows: string[][]): void {
  for (let column = (rows[0]?.length ?? 0) - 1; column >= 0; column -= 1) {
    if (rows.some((row) => row[column] !== '')) continue;
    for (const row of rows) row.splice(column, 1);
  }
}

/** Tables carry no paragraph spacing of their own; the paragraphs around them supply the gap. */
const TABLE_LAYOUT: ParagraphLayout = {
  styleId: null,
  spacingBefore: 0,
  spacingAfter: 0,
  contextualSpacing: false,
  listLabel: null,
  pageBreakBefore: false,
  pageBreakAfter: false,
  indentTwips: 0
};

/** Reads one `<w:tbl>` as a single block whose html is the table itself. */
export function tableContent(xml: string): SOTParagraph {
  const rows = [...xml.matchAll(/<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g)].map((row) =>
    [...(row[1] ?? '').matchAll(/<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g)].map((cell) => {
      const paragraphs = paragraphBlocks(cell[1] ?? '')
        .map((paragraph) => ({ ...paragraphContent(paragraph), align: cellAlignment(paragraph) }))
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
    pageBreakBefore: false,
    cells: rows.map((row) => row.map((cell) => cell.text))
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
export function paragraphContent(paragraphXml: string, listLabel: string | null = null): SOTParagraph {
  // Labels typed in text boxes on a figure belong to the picture, not to the line of prose.
  const drawings = withoutCompatibilityFallback(paragraphXml);
  const xml = withoutTextBoxes(drawings);
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
    imageCount: pictureCount(xml),
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
      // A tab is how the document lays a line out in columns — lab results against their
      // reference ranges. One space would run the two together, so it keeps a gap a reader sees;
      // the spaces are non-breaking because HTML collapses ordinary ones. A line break reads as
      // a space, matching a plain-text reading of the run.
      const text = match[2] !== undefined ? decodeXml(match[2]) : match[3]?.startsWith('<w:tab') ? '\t' : ' ';
      for (const character of text) characters.push({ character, tags });
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
    // A tab is a column gap, not spacing to collapse: it is what holds a lab result apart from
    // its reference range, so it survives as a gap the reader sees.
    if (character === '\t') {
      for (const space of TAB_GAP) result.push({ character: space, tags: entry.tags });
      pendingSpace = false;
      continue;
    }
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
