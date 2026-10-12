import { deflateSync, inflateSync } from 'node:zlib';

/** An image as 8-bit RGBA pixels, row by row. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Bytes per pixel for each 8-bit colour type: grey, RGB, -, -, grey+alpha, -, RGBA. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Reads an 8-bit, non-interlaced PNG, the kind the page renderers write. Anything else is refused
 * rather than misread, since a wrongly decoded page would crop the wrong figure.
 */
export function decodePng(png: Buffer): RgbaImage {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file.');
  let width = 0;
  let height = 0;
  let colourType = -1;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset + 8 <= png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8]!;
      colourType = body[9]!;
      if (depth !== 8 || CHANNELS[colourType] === undefined || body[12] !== 0) {
        throw new Error(`Unsupported PNG (bit depth ${depth}, colour type ${colourType}, interlace ${body[12]}).`);
      }
    } else if (type === 'IDAT') {
      compressed.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colourType];
  if (!channels || width === 0 || height === 0) throw new Error('The PNG has no image header.');
  const raw = unfilter(inflateSync(Buffer.concat(compressed)), width, height, channels);
  const data = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const from = pixel * channels;
    const to = pixel * 4;
    const grey = channels <= 2;
    data[to] = raw[from]!;
    data[to + 1] = grey ? raw[from]! : raw[from + 1]!;
    data[to + 2] = grey ? raw[from]! : raw[from + 2]!;
    data[to + 3] = channels === 2 ? raw[from + 1]! : channels === 4 ? raw[from + 3]! : 255;
  }
  return { width, height, data };
}

/** Writes RGB (alpha dropped onto white) as a PNG, the way the Windows renderer saves its pictures. */
export function encodePng(image: RgbaImage): Buffer {
  const stride = image.width * 3 + 1;
  const raw = Buffer.alloc(stride * image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const from = (y * image.width + x) * 4;
      const alpha = image.data[from + 3]! / 255;
      for (let channel = 0; channel < 3; channel += 1) {
        raw[y * stride + 1 + x * 3 + channel] = Math.round(image.data[from + channel]! * alpha + 255 * (1 - alpha));
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The rectangle `[left, top, right, bottom)` of an image as a new image. */
export function cropImage(image: RgbaImage, box: Box): RgbaImage {
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const from = ((box.top + y) * image.width + box.left) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function unfilter(filtered: Buffer, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (stride + 1)]!;
    const line = filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[y * stride + x - channels]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? out[(y - 1) * stride + x - channels]! : 0;
      const predictor =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : filter === 4 ? paeth(left, up, upLeft) : NaN;
      if (Number.isNaN(predictor)) throw new Error(`Unknown PNG row filter ${filter}.`);
      out[y * stride + x] = (line[x]! + predictor) & 0xff;
    }
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  return toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_value, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
