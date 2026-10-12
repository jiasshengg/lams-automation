import { expect, test } from '@playwright/test';
import { changedBands, changedBox, inkPicture, withBorderLines } from '../src/docx/page-diff.js';
import { cropImage, decodePng, encodePng, type RgbaImage } from '../src/docx/png.js';

/** A white page with grey rectangles painted on it: [left, top, right, bottom, grey]. */
function page(width: number, height: number, boxes: [number, number, number, number, number][] = []): RgbaImage {
  const data = new Uint8Array(width * height * 4).fill(255);
  for (const [left, top, right, bottom, grey] of boxes) {
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) data.set([grey, grey, grey, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

test('a PNG written by the renderer reads back pixel for pixel', () => {
  const image = page(7, 5, [[1, 1, 4, 3, 40]]);
  const decoded = decodePng(encodePng(image));
  expect(decoded.width).toBe(7);
  expect(Array.from(decoded.data)).toEqual(Array.from(image.data));
  expect(Array.from(cropImage(decoded, { left: 1, top: 1, right: 4, bottom: 3 }).data.subarray(0, 4))).toEqual([40, 40, 40, 255]);
});

test('the changed area is what the copy repainted, not a glyph two exports drew a shade apart', () => {
  // The table at rows 60-80 is shaded black, out to its borders; the glyph at rows 10-14 only moves by 60.
  const before = page(100, 100, [[20, 10, 24, 14, 120], [10, 60, 90, 80, 200]]);
  const shaded = page(100, 100, [[20, 10, 24, 14, 180], [5, 58, 95, 82, 0]]);
  expect(changedBox(before, shaded)).toEqual({ left: 5, top: 58, right: 95, bottom: 82 });
  expect(changedBox(before, before)).toBeNull();
});

test('a faint change beside a strong one belongs to it: a pale fill of the same figure', () => {
  const before = page(100, 100, [[10, 10, 50, 30, 0], [10, 34, 50, 40, 225]]);
  const after = page(100, 100);
  expect(changedBox(before, after)).toEqual({ left: 10, top: 10, right: 50, bottom: 40 });
});

test('marks a row or two apart are one band; marks on separate lines are separate bands', () => {
  const before = page(50, 100);
  const after = page(50, 100, [[5, 10, 10, 14, 0], [5, 16, 10, 20, 0], [5, 40, 10, 50, 0]]);
  expect(changedBands(before, after)).toEqual([{ top: 10, bottom: 14 }, { top: 16, bottom: 20 }, { top: 40, bottom: 50 }]);
  expect(changedBands(before, after, 3)).toEqual([{ top: 10, bottom: 20 }, { top: 40, bottom: 50 }]);
});

test('a picture is the ink in its area with a white margin', () => {
  const picture = inkPicture(page(60, 60, [[20, 20, 30, 25, 0]]), { left: 0, top: 0, right: 60, bottom: 60 }, 2)!;
  expect([picture.width, picture.height]).toEqual([14, 9]);
  expect(Array.from(picture.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  expect(inkPicture(page(10, 10), { left: 0, top: 0, right: 10, bottom: 10 }, 2)).toBeNull();
});

test("a table's area grows onto its border lines, never onto the descenders of the line above", () => {
  // Border line at row 9 across the table, sparse descenders at row 5 above it.
  const rendered = page(100, 60, [[10, 9, 90, 10, 0], [12, 5, 14, 6, 0], [40, 5, 42, 6, 0]]);
  expect(withBorderLines(rendered, { left: 10, top: 10, right: 90, bottom: 50 }, 6)).toEqual({ left: 10, top: 9, right: 90, bottom: 50 });
});
