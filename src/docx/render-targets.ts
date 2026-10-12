import { paragraphBlocks, topLevelBlocks, withoutCompatibilityFallback } from './blocks.js';

/**
 * What the AE draft hands to Word to render as a picture of the printed page, rather than
 * rebuilding it: a table (merged cells, shading and coloured text do not survive as HTML), or a
 * figure drawn with shapes (a group of pictures with arrows and text-box labels, whose arrangement
 * an upload of the separate pictures loses).
 *
 * Blocks are counted as `topLevelBlocks` counts them: each body paragraph and each whole table is
 * one block, so a target names the same place in the document wherever it is read from.
 */
export type RenderKind = 'table' | 'figure';

export interface RenderTarget {
  id: string;
  kind: RenderKind;
  firstBlock: number;
  lastBlock: number;
  /** The rendered blocks hold embedded pictures, which the rendered image then stands in for. */
  hasPictures: boolean;
}

export function renderTargetId(firstBlock: number, lastBlock: number): string {
  return firstBlock === lastBlock ? `b${firstBlock}` : `b${firstBlock}-${lastBlock}`;
}

const DRAWING = /<w:drawing\b[\s\S]*?<\/w:drawing>|<w:pict\b[\s\S]*?<\/w:pict>/g;
const PICTURE = /<pic:pic\b|<a:blip\b[^>]*\br:embed=|<v:imagedata\b[^>]*\br:id=/;
/** A drawn shape: a DrawingML shape, group or canvas, a text box, or a VML shape. */
const SHAPE = /<wps:wsp\b|<wpg:wgp\b|<wpc:wpc\b|<w:txbxContent\b|<v:(?:group|line|rect|roundrect|oval|polyline|arc|curve)\b/;
const VML_SHAPE = /<v:shape\b(?:[^>]*\/>|[\s\S]*?<\/v:shape>)/g;
const FLOATING = /<wp:anchor\b|<w:pict\b/;
const HAS_DRAWING = /<w:drawing\b|<w:pict\b/;
const ANSWER_TEXT = /^\s*(?:Answers?|Correct answer|Rationale|Explanation)\b/i;

/** Whether a paragraph draws shapes, not only pictures. */
export function hasDrawnShapes(paragraphXml: string): boolean {
  const xml = withoutCompatibilityFallback(paragraphXml);
  if (SHAPE.test(xml)) return true;
  // A VML shape that only frames a picture is the picture; one without is a drawn shape.
  return [...xml.matchAll(VML_SHAPE)].some((shape) => !/<v:imagedata\b/.test(shape[0]));
}

function hasPictures(xml: string): boolean {
  return PICTURE.test(withoutCompatibilityFallback(xml));
}

/** The words a paragraph prints itself, leaving out everything typed inside its drawings. */
function mainText(paragraphXml: string): string {
  const body = withoutCompatibilityFallback(paragraphXml).replace(DRAWING, '');
  return [...body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1] ?? '').join('').trim();
}

export function isEmptyParagraph(xml: string): boolean {
  return mainText(xml) === '' && !HAS_DRAWING.test(xml);
}

/**
 * Every table and every drawn figure in the body, in document order.
 *
 * A figure is a run of paragraphs that hold only drawings, with nothing but empty paragraphs
 * between them: a collage of floating pictures with their labels and arrows is laid out across
 * several such paragraphs, and only together do they show what the page prints. A run of plain
 * pictures with no drawn shapes is left alone, so each picture is still uploaded as its own file.
 * A floating shape anchored in a line of text with no picture of its own (an arrow in the caption)
 * is drawn over the run just above it, so that run's figure takes in the caption's paragraph too.
 */
export function findRenderTargets(documentXml: string): RenderTarget[] {
  const blocks = topLevelBlocks(documentXml);
  const targets: RenderTarget[] = [];
  let previousRun: { first: number; last: number } | null = null;
  let index = 0;
  while (index < blocks.length) {
    const block = blocks[index]!;
    if (block.kind === 'tbl') {
      const table = tableTarget(block.inner, index);
      if (table) targets.push(table);
      previousRun = null;
      index += 1;
      continue;
    }
    if (isDrawingOnly(block.inner)) {
      let last = index;
      for (let next = index + 1; next < blocks.length && blocks[next]!.kind === 'p'; next += 1) {
        const inner = blocks[next]!.inner;
        if (isDrawingOnly(inner)) last = next;
        else if (!isEmptyParagraph(inner)) break;
      }
      const run = blocks.slice(index, last + 1);
      if (run.some((entry) => hasDrawnShapes(entry.inner))) targets.push(figureTarget(blocks, index, last));
      previousRun = { first: index, last };
      index = last + 1;
      continue;
    }
    if (hasDrawnShapes(block.inner)) {
      const overlaysRunAbove =
        previousRun !== null && !hasPictures(block.inner) && FLOATING.test(block.inner) && onlyEmptyBetween(blocks, previousRun.last, index);
      const first = overlaysRunAbove ? previousRun!.first : index;
      if (overlaysRunAbove && targets.at(-1)?.firstBlock === first) targets.pop();
      targets.push(figureTarget(blocks, first, index));
    }
    if (!isEmptyParagraph(block.inner)) previousRun = null;
    index += 1;
  }
  return targets;
}

function tableTarget(inner: string, index: number): RenderTarget | null {
  const content = withoutCompatibilityFallback(inner);
  // A table that carries its own answer key stays text, where the key can be seen and left out.
  if (paragraphBlocks(content).some((paragraph) => ANSWER_TEXT.test(mainText(paragraph)))) return null;
  if (!/<w:t(?:\s[^>]*)?>[^<]*\S/.test(content) && !hasPictures(content) && !HAS_DRAWING.test(content)) return null;
  return { id: renderTargetId(index, index), kind: 'table', firstBlock: index, lastBlock: index, hasPictures: hasPictures(content) };
}

function figureTarget(blocks: { inner: string }[], first: number, last: number): RenderTarget {
  const pictures = blocks.slice(first, last + 1).some((entry) => hasPictures(entry.inner));
  return { id: renderTargetId(first, last), kind: 'figure', firstBlock: first, lastBlock: last, hasPictures: pictures };
}

/** A paragraph that prints a drawing and no words of its own. */
function isDrawingOnly(xml: string): boolean {
  return HAS_DRAWING.test(xml) && mainText(xml) === '';
}

function onlyEmptyBetween(blocks: { kind: 'p' | 'tbl'; inner: string }[], from: number, to: number): boolean {
  return blocks.slice(from + 1, to).every((entry) => entry.kind === 'p' && isEmptyParagraph(entry.inner));
}

/**
 * For each paragraph `readParagraphsWithListLabels` reads (body paragraphs, and every paragraph of
 * a table where the table sits), the block it belongs to. Image positions are counted in that
 * reading, so this is how a picture is matched to the rendered figure that contains it.
 */
export function readParagraphBlockIndexes(documentXml: string): number[] {
  return topLevelBlocks(documentXml).flatMap((block, index) =>
    block.kind === 'p' ? [index] : paragraphBlocks(block.inner).map(() => index)
  );
}
