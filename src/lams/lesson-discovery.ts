import { expect, type Locator, type Page } from '@playwright/test';

export interface DiscoveryOptions {
  /** Exact direct child folder names under Courses; omitted searches all of Courses. */
  roots?: string[];
  /** Every whitespace-separated term must occur in the title or folder path. */
  query?: string;
  maxExpansions?: number;
  timeoutMs: number;
}

export interface LessonCandidate {
  sourceLessonTitle: string;
  sourceFolderPath: string[];
}

interface TreeRow {
  text: string;
  level: number;
  folder: boolean;
  expanded: string | null;
  path: string[];
}

async function readTree(dialog: Locator): Promise<TreeRow[]> {
  // Observed LAMS bootstrap-treeview markup, also used by find:lesson:
  // flat treeitems, direct .indent children encode depth, .tree-parent marks folders.
  const rows = await dialog.getByRole('treeitem').evaluateAll(elements => elements.map(element => ({
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    level: element.querySelectorAll(':scope > .indent').length,
    folder: element.classList.contains('tree-parent'),
    expanded: element.getAttribute('aria-expanded')
  })));
  const ancestors: string[] = [];
  return rows.map(row => {
    if (row.level > ancestors.length) throw new Error('Unrecognised Authoring tree depth; stopping discovery.');
    ancestors.length = row.level;
    const result = { ...row, path: [...ancestors, row.text] };
    ancestors.push(row.text);
    return result;
  });
}

export async function discoverLessons(page: Page, options: DiscoveryOptions): Promise<LessonCandidate[]> {
  const limit = options.maxExpansions ?? 1000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('maxExpansions must be a positive integer.');
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  let expansions = 0;

  async function expand(index: number, rows: TreeRow[]): Promise<void> {
    if (++expansions > limit) throw new Error('Discovery expansion budget exhausted; results are incomplete. Narrow --roots or increase --max-expansions.');
    const row = rows[index]!;
    if (row.expanded !== 'false') throw new Error(`Unknown folder expansion state: ${row.path.join(' > ')}`);
    // Positional fallback is necessary because duplicate folder names are allowed.
    // Derive the index from the current full tree path and revalidate it before clicking.
    const fresh = await readTree(dialog);
    if (JSON.stringify(fresh) !== JSON.stringify(rows)) throw new Error('Authoring tree changed before expansion; retry discovery.');
    const target = dialog.getByRole('treeitem').nth(index);
    await target.click();
    await expect(target).toHaveAttribute('aria-expanded', 'true', { timeout: options.timeoutMs });
    // The existing treeview populates children during expansion. Wait for its DOM to settle.
    let last = '';
    await expect.poll(async () => {
      const current = JSON.stringify(await readTree(dialog));
      const stable = current === last;
      last = current;
      return stable;
    }, { timeout: options.timeoutMs, intervals: [250, 250, 500] }).toBe(true);
  }

  let rows = await readTree(dialog);
  const courses = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.folder && row.text === 'Courses' && row.level === 0);
  if (courses.length !== 1) throw new Error(`Expected one top-level Courses folder; found ${courses.length}.`);
  if (courses[0]!.row.expanded !== 'true') await expand(courses[0]!.index, rows);
  rows = await readTree(dialog);
  for (const root of options.roots ?? []) {
    const matches = rows.filter(row => row.folder && row.path.length === 2 && row.path[0] === 'Courses' && row.text === root);
    if (matches.length !== 1) throw new Error(`Expected one folder Courses > ${root}; found ${matches.length}.`);
  }
  const inScope = (row: TreeRow): boolean => row.path[0] === 'Courses' &&
    (!options.roots?.length || options.roots.includes(row.path[1] ?? ''));
  while (true) {
    rows = await readTree(dialog);
    const index = rows.findIndex(row => inScope(row) && row.folder && row.expanded !== 'true');
    if (index < 0) break;
    await expand(index, rows);
  }
  const terms = (options.query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => !row.folder && inScope(row) && terms.every(term => row.path.join(' ').toLocaleLowerCase().includes(term)))
    .map(row => ({ sourceLessonTitle: row.text, sourceFolderPath: row.path.slice(0, -1) }));
}
