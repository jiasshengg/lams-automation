import { deflateSync } from 'node:zlib';

const EMR_HEADER = 1;
const EMR_EOF = 14;
const EMR_STRETCHDIBITS = 81;
const BI_RGB = 0;

/**
 * Word stores a pasted screenshot as an EMF that holds nothing but one bitmap. A browser cannot
 * show EMF, so such a file is unpacked into a PNG of exactly that bitmap. Any other EMF (vector
 * drawing, several records, compressed or palette bitmaps) is refused rather than approximated.
 */
export function emfBitmapToPng(emf: Buffer): Buffer {
  const records: { type: number; offset: number; size: number }[] = [];
  for (let offset = 0; offset + 8 <= emf.length; ) {
    const type = emf.readUInt32LE(offset);
    const size = emf.readUInt32LE(offset + 4);
    if (size < 8 || offset + size > emf.length) throw new Error('EMF record extends past the end of the file.');
    records.push({ type, offset, size });
    offset += size;
    if (type === EMR_EOF) break;
  }
  const kinds = records.map((record) => record.type);
  if (kinds.length !== 3 || kinds[0] !== EMR_HEADER || kinds[1] !== EMR_STRETCHDIBITS || kinds[2] !== EMR_EOF) {
    throw new Error(`EMF is not a single embedded bitmap (record types ${kinds.join(', ')}); convert it to PNG by hand.`);
  }
  const record = records[1]!;
  const at = record.offset;
  const bitmapInfoOffset = emf.readUInt32LE(at + 48);
  const bitsOffset = emf.readUInt32LE(at + 56);
  const bitsSize = emf.readUInt32LE(at + 60);
  const header = at + bitmapInfoOffset;
  const width = emf.readInt32LE(header + 4);
  const signedHeight = emf.readInt32LE(header + 8);
  const bitsPerPixel = emf.readUInt16LE(header + 14);
  const compression = emf.readUInt32LE(header + 16);
  if (compression !== BI_RGB || (bitsPerPixel !== 24 && bitsPerPixel !== 32) || width <= 0 || signedHeight === 0) {
    throw new Error(`EMF bitmap format is unsupported (${bitsPerPixel} bpp, compression ${compression}); convert it to PNG by hand.`);
  }
  const height = Math.abs(signedHeight);
  const stride = Math.ceil((width * bitsPerPixel) / 32) * 4;
  const bits = emf.subarray(at + bitsOffset, at + bitsOffset + bitsSize);
  if (bits.length < stride * height) throw new Error('EMF bitmap is shorter than its declared size.');
  const bytesPerPixel = bitsPerPixel / 8;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // A positive height stores the bottom row first.
    const source = (signedHeight > 0 ? height - 1 - y : y) * stride;
    let target = y * (width * 3 + 1) + 1;
    for (let x = 0; x < width; x += 1) {
      const pixel = source + x * bytesPerPixel;
      raw[target++] = bits[pixel + 2]!;
      raw[target++] = bits[pixel + 1]!;
      raw[target++] = bits[pixel]!;
    }
  }
  const imageHeader = Buffer.alloc(13);
  imageHeader.writeUInt32BE(width, 0);
  imageHeader.writeUInt32BE(height, 4);
  imageHeader.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', imageHeader),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
