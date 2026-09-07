import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Minimal ZIP reader for Office Open XML files. DOCX files use stored or raw-deflate
 * entries; encrypted and ZIP64 archives are intentionally rejected.
 */
export function readZipEntries(buffer: Buffer): Map<string, Buffer> {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  const minimumEocdSize = 22;
  let eocdOffset = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error('DOCX ZIP end-of-central-directory record was not found.');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, Buffer>();
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== centralSignature) throw new Error('Invalid DOCX ZIP central directory.');
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if ((flags & 0x1) !== 0) throw new Error(`Encrypted DOCX ZIP entry is unsupported: ${name}`);
    if (buffer.readUInt32LE(localOffset) !== localSignature) throw new Error(`Invalid local ZIP header for ${name}.`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : undefined;
    if (!data) throw new Error(`Unsupported DOCX ZIP compression method ${method} for ${name}.`);
    if (data.length !== uncompressedSize) throw new Error(`DOCX ZIP entry size mismatch for ${name}.`);
    entries.set(name, data);
  }
  return entries;
}

export function requireZipEntry(entries: Map<string, Buffer>, name: string): Buffer {
  const entry = entries.get(name);
  if (!entry) throw new Error(`DOCX entry was not found: ${name}`);
  return entry;
}
