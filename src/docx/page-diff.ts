import { cropImage, type Box, type RgbaImage } from './png.js';

/** A channel must move further than this for a pixel to count as changed: renders are not bit-exact. */
const CHANGE_TOLERANCE = 24;
/**
 * A pixel the copy repainted moves this far or more: ink painted white, or white shaded black.
 * Two exports of unchanged text can redraw a glyph a shade differently (seen: 50 pixels, at most
 * 70 apart), which must not stretch a picture up to that line.
 */
const STRONG_CHANGE = 128;
/** Faint changes this close (in rows) to a strong band belong to it: a pale fill, an anti-aliased edge. */
const NEIGHBOUR_ROWS = 24;
/** Below this on any channel a pixel is ink, as the Windows renderer counts it. */
const INK_THRESHOLD = 245;

interface Band {
  top: number;
  bottom: number;
  left: number;
  right: number;
  strong: boolean;
}

/**
 * Where two renders of the same page differ because the copy repainted something, or null when
 * they do not. Changes too faint to be repainting count only next to ones that are.
 */
export function changedBox(before: RgbaImage, after: RgbaImage): Box | null {
  const kept = repaintedBands(before, after);
  if (kept.length === 0) return null;
  return {
    left: Math.min(...kept.map((band) => band.left)),
    top: kept[0]!.top,
    right: Math.max(...kept.map((band) => band.right)),
    bottom: kept.at(-1)!.bottom
  };
}

/**
 * The horizontal bands, top to bottom, in which the copy repainted a page. Each mark typed into a
 * paragraph changes one band, so the bands say where those paragraphs print.
 */
export function changedBands(before: RgbaImage, after: RgbaImage, joinedRows = 0): { top: number; bottom: number }[] {
  const bands: { top: number; bottom: number }[] = [];
  for (const { top, bottom } of differingBands(before, after).filter((band) => band.strong)) {
    const last = bands.at(-1);
    if (last && top - last.bottom <= joinedRows) last.bottom = bottom;
    else bands.push({ top, bottom });
  }
  return bands;
}

/**
 * The ink inside `region` of a page, cut out with a white margin of `padding` pixels: the same
 * picture the Windows renderer saves of a range, which is trimmed to what is not white.
 */
export function inkPicture(page: RgbaImage, region: Box, padding: number): RgbaImage | null {
  let left = region.right;
  let top = region.bottom;
  let right = -1;
  let bottom = -1;
  for (let y = region.top; y < region.bottom; y += 1) {
    for (let x = region.left; x < region.right; x += 1) {
      const at = (y * page.width + x) * 4;
      if (page.data[at]! >= INK_THRESHOLD && page.data[at + 1]! >= INK_THRESHOLD && page.data[at + 2]! >= INK_THRESHOLD) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  return withMargin(cropImage(page, { left, top, right: right + 1, bottom: bottom + 1 }), padding);
}

/**
 * Grows a table's area outward, up to `reach` pixels each way, onto its border lines: shading stops
 * at the middle of a border, so the outer half lies just outside the shaded area. Only a row or
 * column inked across most of the table counts as a border, so the descenders of the line above a
 * table are never taken in with it.
 */
export function withBorderLines(page: RgbaImage, box: Box, reach: number): Box {
  const grown = { ...box };
  const inkShare = (x0: number, x1: number, y0: number, y1: number): number => {
    let ink = 0;
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (isInk(page, x, y)) ink += 1;
    return ink / Math.max(1, (x1 - x0) * (y1 - y0));
  };
  for (let step = 0; step < reach && grown.top > 0 && inkShare(box.left, box.right, grown.top - 1, grown.top) >= BORDER_SHARE; step += 1) grown.top -= 1;
  for (let step = 0; step < reach && grown.bottom < page.height && inkShare(box.left, box.right, grown.bottom, grown.bottom + 1) >= BORDER_SHARE; step += 1) grown.bottom += 1;
  for (let step = 0; step < reach && grown.left > 0 && inkShare(grown.left - 1, grown.left, box.top, box.bottom) >= BORDER_SHARE; step += 1) grown.left -= 1;
  for (let step = 0; step < reach && grown.right < page.width && inkShare(grown.right, grown.right + 1, box.top, box.bottom) >= BORDER_SHARE; step += 1) grown.right += 1;
  return grown;
}

/** How much of a row or column must be ink for it to be a border line. */
const BORDER_SHARE = 0.6;

function isInk(page: RgbaImage, x: number, y: number): boolean {
  const at = (y * page.width + x) * 4;
  return page.data[at]! < INK_THRESHOLD || page.data[at + 1]! < INK_THRESHOLD || page.data[at + 2]! < INK_THRESHOLD;
}

/** Strong bands, and the faint ones that lie within reach of a strong band. */
function repaintedBands(before: RgbaImage, after: RgbaImage): Band[] {
  const bands = differingBands(before, after);
  const kept = bands.map((band) => band.strong);
  for (let changed = true; changed; ) {
    changed = false;
    bands.forEach((band, index) => {
      if (kept[index]) return;
      const near = bands.some((other, at) => kept[at] && (other.top - band.bottom <= NEIGHBOUR_ROWS && band.top - other.bottom <= NEIGHBOUR_ROWS));
      if (near) kept[index] = changed = true;
    });
  }
  return bands.filter((_band, index) => kept[index]);
}

/** Runs of rows holding a changed pixel, with their horizontal extent and whether any change is strong. */
function differingBands(before: RgbaImage, after: RgbaImage): Band[] {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error('The two renders of a page differ in size, so the copy was laid out differently.');
  }
  const bands: Band[] = [];
  for (let y = 0; y < before.height; y += 1) {
    let left = before.width;
    let right = -1;
    let strong = false;
    for (let x = 0; x < before.width; x += 1) {
      const change = pixelChange(before, after, y * before.width + x);
      if (change <= CHANGE_TOLERANCE) continue;
      if (x < left) left = x;
      right = x;
      if (change >= STRONG_CHANGE) strong = true;
    }
    if (right < 0) continue;
    const last = bands.at(-1);
    if (last && last.bottom === y) {
      last.bottom = y + 1;
      last.left = Math.min(last.left, left);
      last.right = Math.max(last.right, right + 1);
      last.strong ||= strong;
    } else {
      bands.push({ top: y, bottom: y + 1, left, right: right + 1, strong });
    }
  }
  return bands;
}

function withMargin(image: RgbaImage, padding: number): RgbaImage {
  const width = image.width + padding * 2;
  const height = image.height + padding * 2;
  const data = new Uint8Array(width * height * 4).fill(255);
  for (let y = 0; y < image.height; y += 1) {
    data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((y + padding) * width + padding) * 4);
  }
  return { width, height, data };
}

/** How far the most-changed channel of a pixel moved. */
function pixelChange(before: RgbaImage, after: RgbaImage, pixel: number): number {
  const at = pixel * 4;
  return Math.max(
    Math.abs(before.data[at]! - after.data[at]!),
    Math.abs(before.data[at + 1]! - after.data[at + 1]!),
    Math.abs(before.data[at + 2]! - after.data[at + 2]!)
  );
}
