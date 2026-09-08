import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveInputFile } from '../src/input-file.js';

test('resolves partial and case-insensitive filenames, prefers exact names, and lists ambiguity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lams-input-'));
  try {
    await mkdir(path.join(root, 'nested'));
    const target = path.join(root, 'nested', 'FOM TBL01.docx');
    await writeFile(target, '');
    await writeFile(path.join(root, 'FOM TBL02.docx'), '');
    await writeFile(path.join(root, 'FOM TBL01.json'), '');
    expect(await resolveInputFile('tbl01', '.docx', [root, path.join(root, 'nested')])).toBe(target);
    expect(await resolveInputFile('fom tbl01.DOCX', '.docx', [root])).toBe(target);
    expect(await resolveInputFile(target, '.docx', [root])).toBe(target);
    expect(await resolveInputFile(target.split(path.sep).join('/'), '.docx', [root])).toBe(target);
    await expect(resolveInputFile('FOM', '.docx', [root])).rejects.toThrow('Multiple files matched');
    await expect(resolveInputFile('missing', '.docx', [root])).rejects.toThrow('No .docx file matched');
    await expect(resolveInputFile(target, '.json', [root])).rejects.toThrow('Input must be a .json file');
    await writeFile(path.join(root, 'FOM TBL01.docx'), '');
    await expect(resolveInputFile('FOM TBL01.docx', '.docx', [root])).rejects.toThrow('Multiple files matched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('accepts a forward-slash path relative to the working directory', async () => {
  expect(await resolveInputFile('configs/example.json', '.json')).toBe(path.resolve('configs/example.json'));
});
