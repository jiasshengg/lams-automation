import { inflateSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { emfBitmapToPng } from '../src/docx/emf.js';

function record(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(type, 0);
  head.writeUInt32LE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** A 2x2 bottom-up 24-bit bitmap: bottom row red, blue; top row green, white. */
function bitmapEmf(): Buffer {
  const fixed = Buffer.alloc(72);
  fixed.writeUInt32LE(80, 40); // offBmiSrc
  fixed.writeUInt32LE(40, 44); // cbBmiSrc
  fixed.writeUInt32LE(120, 48); // offBitsSrc
  fixed.writeUInt32LE(16, 52); // cbBitsSrc
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(2, 4);
  info.writeInt32LE(2, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(24, 14);
  const bits = Buffer.from([0, 0, 255, 255, 0, 0, 0, 0, 0, 255, 0, 255, 255, 255, 0, 0]);
  return Buffer.concat([record(1, Buffer.alloc(8)), record(81, Buffer.concat([fixed, info, bits])), record(14, Buffer.alloc(12))]);
}

test('a bitmap-only EMF becomes a PNG of that bitmap, top row first', () => {
  const png = emfBitmapToPng(bitmapEmf());
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(2);
  expect(png.readUInt32BE(20)).toBe(2);
  const idatLength = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  expect([...raw]).toEqual([0, 0, 255, 0, 255, 255, 255, 0, 255, 0, 0, 0, 0, 255]);
});

test('an EMF that is not a single bitmap is refused rather than approximated', () => {
  const vector = Buffer.concat([record(1, Buffer.alloc(8)), record(27, Buffer.alloc(8)), record(14, Buffer.alloc(12))]);
  expect(() => emfBitmapToPng(vector)).toThrow(/not a single embedded bitmap/);
});
