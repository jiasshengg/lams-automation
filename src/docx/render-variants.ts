import { topLevelBlocks, withoutCompatibilityFallback, type DocxBlock } from './blocks.js';
import { isEmptyParagraph } from './render-targets.js';

/**
 * Copies of a document that differ from it only in how a range of blocks is painted, never in
 * where anything sits on the page. Rendering a copy beside the original and comparing the two pages
 * shows exactly where Word printed that range, which is how a figure is pictured where Word cannot
 * hand over a picture of a range itself (Word for Mac).
 *
 * Word rejects a part whose elements are out of schema order, so every inserted element is placed
 * before the first sibling the schema puts after it.
 */

const WHITE_COLOUR = '<w:color w:val="FFFFFF"/>';
/** Solid black shading: it fills a cell or paragraph edge to edge and, unlike a border, takes no room. */
const SOLID_SHADING = '<w:shd w:val="clear" w:color="auto" w:fill="000000"/>';

/** Run-property elements the schema places after `w:color`. */
const AFTER_COLOUR = ['spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'];
/** Paragraph-property elements the schema places after `w:rPr`, and after `w:shd`. */
const AFTER_PARAGRAPH_RUN = ['sectPr', 'pPrChange'];
const AFTER_PARAGRAPH_SHADING = [
  'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi',
  'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection',
  'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'
];
/** Cell-property elements the schema places after `w:shd`. */
const AFTER_CELL_SHADING = ['noWrap', 'tcMar', 'textDirection', 'tcFitText', 'vAlign', 'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge', 'tcPrChange'];

/**
 * What a range holds that cannot be painted out without moving anything: a chart, a diagram, an
 * embedded object, an equation, ink, or a legacy VML drawing. A figure holding one is not pictured
 * this way; null when there is none.
 */
export function unpaintableContent(xml: string): string | null {
  const modern = withoutCompatibilityFallback(xml);
  const found: [RegExp, string][] = [
    [/<c:chart\b/, 'a chart'],
    [/<dgm:relIds\b/, 'a SmartArt diagram'],
    [/<o:OLEObject\b|<w:object\b/, 'an embedded object'],
    [/<m:oMath/, 'an equation'],
    [/<w14:contentPart\b|<w15:contentPart\b/, 'ink'],
    [/<w:pict\b/, 'a legacy (VML) drawing']
  ];
  return found.find(([pattern]) => pattern.test(modern))?.[1] ?? null;
}

/** The document XML with the blocks `[firstBlock, lastBlock]` passed through `paint`. */
export function withPaintedBlocks(
  documentXml: string,
  ranges: readonly { firstBlock: number; lastBlock: number }[],
  paint: (xml: string) => string
): string {
  const blocks = topLevelBlocks(documentXml);
  const spans = ranges
    .map(({ firstBlock, lastBlock }) => span(blocks, firstBlock, lastBlock))
    .sort((left, right) => left.start - right.start);
  let xml = '';
  let cursor = 0;
  for (const { start, end } of spans) {
    if (start < cursor) throw new Error('Painted ranges must not overlap.');
    xml += documentXml.slice(cursor, start) + paint(documentXml.slice(start, end));
    cursor = end;
  }
  return xml + documentXml.slice(cursor);
}

/**
 * Paints out a figure: its words (including text-box labels), pictures and drawn shapes. Nothing
 * moves - a transparent picture keeps its size and wrapping - so the figure leaves a blank where it
 * was printed.
 */
export function paintedOut(xml: string): string {
  return withoutDrawingInk(whiteText(xml, { keepTextBoxes: false }));
}

/**
 * Shades a table solid, cell by cell, and every paragraph of a range laid out as one with tab stops.
 * Shading fills each cell to its borders and takes no room, so the changed area is the whole table
 * and nothing below it moves. (Removing borders instead would move everything: a border's width
 * is part of the row height.)
 */
export function shadedOver(xml: string): string {
  return xml
    .replace(/<w:tcPr\/>/g, '<w:tcPr></w:tcPr>')
    .replace(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/g, (_match, inner: string) =>
      `<w:tcPr>${insertBefore(inner.replace(/<w:shd\b[^>]*\/>/g, ''), SOLID_SHADING, AFTER_CELL_SHADING)}</w:tcPr>`
    )
    .replace(/<w:tc(\s[^>]*[^/])?>(?!\s*<w:tcPr\b)/g, (match) => `${match}<w:tcPr>${SOLID_SHADING}</w:tcPr>`)
    .replace(/<w:pPr\/>/g, '<w:pPr></w:pPr>')
    .replace(/<w:pPr>((?:(?!<\/w:pPr>)[\s\S])*?)<\/w:pPr>/g, (_match, inner: string) =>
      `<w:pPr>${insertBefore(withoutParagraphShading(inner), SOLID_SHADING, AFTER_PARAGRAPH_SHADING)}</w:pPr>`
    )
    .replace(/<w:p(\s[^>]*[^/])?>(?!\s*<w:pPr\b)/g, (match) => `${match}<w:pPr>${SOLID_SHADING}</w:pPr>`);
}

/** A paragraph's own shading, leaving the shading of its paragraph-mark run properties alone. */
function withoutParagraphShading(pPrInner: string): string {
  return pPrInner
    .split(/(<w:rPr>[\s\S]*?<\/w:rPr>)/g)
    .map((part) => (part.startsWith('<w:rPr>') ? part : part.replace(/<w:shd\b[^>]*\/>/g, '')))
    .join('');
}

/**
 * Paints out only the words of a range, keeping its drawings and the labels typed in them: the
 * words around a figure stay in the prompt as text, so only the drawing is pictured.
 */
export function wordsPaintedOut(xml: string): string {
  return whiteText(xml, { keepTextBoxes: true });
}

/** Removes highlighting: a Source-of-Truth marks its answers with it, and a picture would show them. */
export function withoutHighlights(xml: string): string {
  return xml.replace(/<w:highlight\b[^>]*\/>/g, '');
}

/**
 * The empty paragraphs directly after a figure, up to `limit`: the room a floating figure may be
 * drawn over. Returned as block indexes, in order.
 */
export function emptyParagraphsAfter(documentXml: string, afterBlock: number, limit: number): number[] {
  const blocks = topLevelBlocks(documentXml);
  const found: number[] = [];
  for (let index = afterBlock + 1; index < blocks.length && found.length < limit; index += 1) {
    const block = blocks[index]!;
    if (block.kind !== 'p' || !isEmptyParagraph(block.inner)) break;
    found.push(index);
  }
  return found;
}

/**
 * Marks with which a paragraph's place on the page is read. A bar rises nearly to the top of its
 * line, which is where a line is measured from; a square is small, so marks on neighbouring lines
 * never touch. Both are in every font, so no line falls back to another font and grows.
 */
export type ParagraphMark = 'bar' | 'square';
const MARK_TEXT: Readonly<Record<ParagraphMark, string>> = { bar: '|', square: '■' };

/**
 * Types a mark at the end of each of the given paragraphs, in the paragraph's own size so no line
 * grows. Where each mark prints says where its paragraph prints.
 */
export function withMarkedParagraphs(documentXml: string, blockIndexes: readonly number[], mark: ParagraphMark): string {
  const all = topLevelBlocks(documentXml);
  const marked = blockIndexes.map((index) => all[index]!);
  if (marked.some((block) => !block || block.kind !== 'p')) throw new Error('Only paragraphs can be marked.');
  let xml = '';
  let cursor = 0;
  for (const block of marked) {
    const original = documentXml.slice(block.start, block.end);
    const markRun = `<w:r>${markProperties(block.inner)}<w:t>${MARK_TEXT[mark]}</w:t></w:r>`;
    const withMark = original.endsWith('/>') ? `${original.slice(0, -2)}>${markRun}</w:p>` : original.replace(/<\/w:p>$/, `${markRun}</w:p>`);
    xml += documentXml.slice(cursor, block.start) + withMark;
    cursor = block.end;
  }
  return xml + documentXml.slice(cursor);
}

/**
 * The document as printed: tracked insertions kept, deletions dropped, and comment anchors removed,
 * so no change marks or comment balloons appear in the pictures.
 */
export function asFinallyPrinted(documentXml: string): string {
  return documentXml
    .replace(/<w:(del|moveFrom)\b[^>]*\/>/g, '')
    .replace(/<w:(del|moveFrom)\b[^>]*>[\s\S]*?<\/w:\1>/g, '')
    .replace(/<w:(ins|moveTo)\b[^>]*\/>/g, '')
    .replace(/<w:(ins|moveTo)\b[^>]*>([\s\S]*?)<\/w:\1>/g, '$2')
    .replace(/<w:(rPrChange|pPrChange|tblPrChange|tcPrChange|trPrChange|sectPrChange|numberingChange)\b[^>]*>[\s\S]*?<\/w:\1>/g, '')
    .replace(/<w:(commentRangeStart|commentRangeEnd|moveFromRangeStart|moveFromRangeEnd|moveToRangeStart|moveToRangeEnd)\b[^>]*\/>/g, '')
    .replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:commentReference\b[^>]*\/>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g, '');
}

function span(blocks: DocxBlock[], firstBlock: number, lastBlock: number): { start: number; end: number } {
  const first = blocks[firstBlock];
  const last = blocks[lastBlock];
  if (!first || !last || lastBlock < firstBlock) throw new Error(`Blocks ${firstBlock}-${lastBlock} lie outside the document body.`);
  return { start: first.start, end: last.end };
}

/**
 * Every run and every paragraph mark white. A paragraph mark carries the colour of its list number,
 * so each paragraph gets one; a run with no properties gets them.
 */
function whiteText(xml: string, options: { keepTextBoxes: boolean }): string {
  const paint = (part: string) =>
    part
      .replace(/<w:rPr\/>/g, '<w:rPr></w:rPr>')
      .replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (_match, inner: string) => `<w:rPr>${whiteRunProperties(inner)}</w:rPr>`)
      .replace(/<w:r(\s[^>]*[^/])?>(?!\s*<w:rPr\b)/g, (match) => `${match}<w:rPr>${WHITE_COLOUR}</w:rPr>`)
      .replace(/<w:pPr\/>/g, '<w:pPr></w:pPr>')
      .replace(/<w:pPr>((?:(?!<\/w:pPr>)[\s\S])*?)<\/w:pPr>/g, (match, inner: string) =>
        /<w:rPr>/.test(inner) ? match : `<w:pPr>${insertBefore(inner, `<w:rPr>${WHITE_COLOUR}</w:rPr>`, AFTER_PARAGRAPH_RUN)}</w:pPr>`
      )
      .replace(/<w:p(\s[^>]*[^/])?>(?!\s*<w:pPr\b)/g, (match) => `${match}<w:pPr><w:rPr>${WHITE_COLOUR}</w:rPr></w:pPr>`);
  if (!options.keepTextBoxes) return paint(xml);
  // Text boxes are painted only when the whole range is painted out; otherwise they are left as is.
  return xml
    .split(/(<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>)/g)
    .map((part) => (part.startsWith('<w:txbxContent') ? part : paint(part)))
    .join('');
}

function whiteRunProperties(inner: string): string {
  const cleaned = inner
    .replace(/<w:color\b[^>]*\/>/g, '')
    .replace(/<w:highlight\b[^>]*\/>/g, '')
    .replace(/<w:shd\b[^>]*\/>/g, '')
    // A border round the words keeps its width, which is part of the line, and only turns white.
    .replace(/<w:bdr\b([^>]*?)\s*\/>/g, (_match, attributes: string) => `<w:bdr${attributes.replace(/\s+w:color=["'][^"']*["']/, '')} w:color="FFFFFF"/>`)
    // An underline in a colour of its own would still print.
    .replace(/(<w:u\b[^>]*?)\s+w:color=["'][^"']*["']/g, '$1');
  return insertBefore(cleaned, WHITE_COLOUR, AFTER_COLOUR);
}

/**
 * Pictures fully transparent and shapes without fill, outline or effects. Their size and position
 * are untouched, so text still wraps around them exactly as before.
 */
function withoutDrawingInk(xml: string): string {
  return xml
    .replace(/<a:blip\b([^>]*?)(\/?)>/g, (_match, attributes: string, closed: string) =>
      `<a:blip${attributes}><a:alphaModFix amt="0"/>${closed ? '</a:blip>' : ''}`
    )
    .replace(/<(wps:spPr|pic:spPr)\b([^>]*?)\/>/g, '<$1$2></$1>')
    .replace(/<(wps:spPr|pic:spPr)\b([^>]*)>([\s\S]*?)<\/\1>/g, (_match, tag: string, attributes: string, inner: string) =>
      `<${tag}${attributes}>${inkless(inner)}</${tag}>`
    );
}

/** Shape properties with every fill, outline and effect replaced by none, in schema order. */
function inkless(inner: string): string {
  // Office's extensions (a hidden fill or line kept for older readers) must keep their own fills,
  // which Word requires there, so only the shape's own properties are replaced.
  const extensions = /<a:extLst\b[\s\S]*<\/a:extLst>/.exec(inner);
  const own = extensions ? inner.slice(0, extensions.index) : inner;
  const tail = extensions ? inner.slice(extensions.index) : '';
  return inklessOwn(own) + tail;
}

function inklessOwn(inner: string): string {
  const stripped = inner
    .replace(/<a:(noFill|solidFill|gradFill|blipFill|pattFill|grpFill)\b[^>]*\/>/g, '')
    .replace(/<a:(solidFill|gradFill|blipFill|pattFill)\b[^>]*>[\s\S]*?<\/a:\1>/g, '')
    .replace(/<a:ln\b[^>]*\/>|<a:ln\b[^>]*>[\s\S]*?<\/a:ln>/g, '')
    .replace(/<a:(effectLst|effectDag)\b[^>]*\/>|<a:(effectLst|effectDag)\b[^>]*>[\s\S]*?<\/a:\2>/g, '');
  const none = '<a:noFill/><a:ln><a:noFill/></a:ln><a:effectLst/>';
  const geometry = /<a:(prstGeom|custGeom)\b[^>]*\/>|<a:(prstGeom|custGeom)\b[^>]*>[\s\S]*?<\/a:\2>/.exec(stripped);
  if (geometry) return stripped.slice(0, geometry.index + geometry[0].length) + none + stripped.slice(geometry.index + geometry[0].length);
  const transform = /<a:xfrm\b[^>]*\/>|<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/.exec(stripped);
  if (transform) return stripped.slice(0, transform.index + transform[0].length) + none + stripped.slice(transform.index + transform[0].length);
  return none + stripped;
}

/** The run properties a mark typed into an empty paragraph takes: those of the paragraph mark. */
function markProperties(paragraphInner: string): string {
  const mark = /<w:pPr\b[^>]*>[\s\S]*?<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(paragraphInner)?.[1] ?? '';
  // The size stays the paragraph's, so no line grows; the colour is always black, even in a
  // paragraph that was painted white, so the mark always prints.
  const runOnly = mark.replace(/<w:(ins|del|moveFrom|moveTo|rPrChange|color|vanish|webHidden)\b[^>]*\/>/g, '');
  return `<w:rPr>${insertBefore(runOnly, '<w:color w:val="000000"/>', AFTER_COLOUR)}</w:rPr>`;
}

/** Inserts `element` before the first child the schema places after it, or at the end. */
function insertBefore(inner: string, element: string, followers: readonly string[]): string {
  let at = inner.length;
  for (const name of followers) {
    const match = new RegExp(`<w:${name}(?=[\\s/>])`).exec(inner);
    if (match && match.index < at) at = match.index;
  }
  return inner.slice(0, at) + element + inner.slice(at);
}
