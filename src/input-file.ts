import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const excluded = new Set(['node_modules', 'dist', 'artifacts', 'playwright-report', 'test-results']);

/** Resolve input files only. Output paths must never use fuzzy lookup. */
export async function resolveInputFile(
  query: string,
  extension: string,
  roots = [process.cwd(), ...['Documents', 'Downloads', 'Desktop'].map((name) => path.join(os.homedir(), name))]
): Promise<string> {
  const value = query.trim();
  if (!value) throw new Error('Supply a filename, part of a filename, or a path.');
  const expanded = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const direct = path.resolve(expanded);
  const explicitPath = expanded.includes(path.sep);
  const matchesExtension = (name: string) => path.extname(name).toLowerCase() === extension.toLowerCase();
  if (explicitPath) {
    if (!matchesExtension(direct)) throw new Error(`Input must be a ${extension} file.`);
    if (!(await stat(direct)).isFile()) throw new Error(`Not a file: ${direct}`);
    return direct;
  }

  const visited = new Set<string>();
  const matches = new Set<string>();
  const needle = value.toLowerCase();
  async function walk(directory: string): Promise<void> {
    const absolute = path.resolve(directory);
    if (visited.has(absolute)) return;
    visited.add(absolute);
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || excluded.has(entry.name)) continue;
      const filename = path.join(absolute, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && matchesExtension(entry.name) && entry.name.toLowerCase().includes(needle)) matches.add(filename);
    }
  }
  for (const root of roots) await walk(root);
  const all = [...matches].sort();
  const exact = all.filter((filename) => path.basename(filename).toLowerCase() === needle);
  const candidates = exact.length ? exact : all;
  if (candidates.length === 1) return candidates[0]!;
  if (!candidates.length) throw new Error(`No ${extension} file matched "${value}" in: ${roots.join(', ')}. Supply a more specific name or path.`);
  throw new Error(`Multiple files matched "${value}". Choose a more specific name or one of these paths:\n${candidates.map((name, index) => `${index + 1}. ${name}`).join('\n')}`);
}
