/**
 * Word nests paragraphs: a text box drawn on a figure holds its own `<w:p>` inside the paragraph
 * that anchors the drawing, and table cells hold paragraphs inside `<w:tbl>`. A lazy
 * `<w:p>…</w:p>` match stops at the first nested `</w:p>`, which cut grouped figures in half and
 * dropped their pictures. These readers track depth so each block is read whole.
 */

export interface DocxBlock {
  kind: 'p' | 'tbl';
  /** The XML between the block's opening and closing tags. */
  inner: string;
}

const BLOCK_TAG = /<(\/?)(w:p|w:tbl)(?=[\s>/])[^>]*?(\/?)>/g;

/** The outermost paragraphs and tables of `xml`, in document order. */
export function topLevelBlocks(xml: string): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  const stack: { kind: 'p' | 'tbl'; innerStart: number }[] = [];
  for (const match of xml.matchAll(BLOCK_TAG)) {
    const closing = match[1] === '/';
    const kind = match[2] === 'w:p' ? 'p' : 'tbl';
    const selfClosing = match[3] === '/';
    const end = match.index! + match[0].length;
    if (selfClosing) {
      if (stack.length === 0) blocks.push({ kind, inner: '' });
      continue;
    }
    if (!closing) {
      stack.push({ kind, innerStart: end });
      continue;
    }
    const open = stack.pop();
    if (!open || open.kind !== kind) throw new Error(`Unbalanced <w:${kind}> in the DOCX document.`);
    if (stack.length === 0) blocks.push({ kind, inner: xml.slice(open.innerStart, match.index) });
  }
  if (stack.length > 0) throw new Error('The DOCX document ends inside an open paragraph or table.');
  return blocks;
}

/**
 * Every paragraph a reader meets in order: body paragraphs whole, and a table's cell paragraphs
 * one by one. Text boxes stay inside the paragraph that anchors them.
 */
export function paragraphBlocks(xml: string): string[] {
  return topLevelBlocks(xml).flatMap((block) => (block.kind === 'p' ? [block.inner] : paragraphBlocks(block.inner)));
}

/**
 * Word stores a drawing twice: the modern DrawingML choice and a legacy VML fallback of the same
 * picture. Only the choice is read, so nothing is counted or extracted twice.
 */
export function withoutCompatibilityFallback(xml: string): string {
  return xml.replace(/<mc:Fallback\b[^>]*>[\s\S]*?<\/mc:Fallback>/g, '');
}

/** Text typed in a text box drawn on a figure: a label printed on the image, not a line of prose. */
export function textBoxContents(xml: string): string[] {
  return [...xml.matchAll(/<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g)].map((match) => match[1] ?? '');
}

const DRAWING = /<w:drawing\b[\s\S]*?<\/w:drawing>|<w:pict\b[\s\S]*?<\/w:pict>/g;
const PICTURE = /<pic:pic\b|<a:blip\b|<v:imagedata\b/;

/** Whether a drawing embeds a picture, rather than being only a shape such as a text box. */
export function drawingHasPicture(drawingXml: string): boolean {
  return PICTURE.test(drawingXml);
}

/**
 * Removes the text boxes laid over pictures. A text box drawn on its own, with no picture in its
 * drawing, is a free-standing label ("Film B") that the reader needs, so it stays as prose.
 */
export function withoutTextBoxes(xml: string): string {
  return xml.replace(DRAWING, (drawing) => {
    if (drawingHasPicture(drawing)) return drawing.replace(/<w:txbxContent\b[^>]*>[\s\S]*?<\/w:txbxContent>/g, '');
    // Each label is its own word; run together they would read "BA" for the labels "B" and "A".
    const labels = textBoxContents(drawing).map((content) =>
      paragraphBlocks(content).map((paragraph) => textRuns(paragraph)).join('<w:r><w:t xml:space="preserve"> </w:t></w:r>')
    );
    return labels.map((label) => `<w:r><w:t xml:space="preserve"> </w:t></w:r>${label}<w:r><w:t xml:space="preserve"> </w:t></w:r>`).join('');
  });
}

/** The text runs of one paragraph, without its properties or any drawing it anchors. */
function textRuns(paragraphXml: string): string {
  return [...paragraphXml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map((run) => run[0]).join('');
}
