import { expect, type Locator, type Page } from '@playwright/test';

export interface DiscoveryOptions {
  /** Exact direct child folder names under Courses; omitted searches all of Courses. */
  roots?: string[];
  /** Every whitespace-separated term must occur in the title or folder path. */
  query?: string;
  maxExpansions?: number;
  timeoutMs: number;
  onProgress?: (message: string) => void;
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
  empty: boolean;
  path: string[];
}

interface FolderEntry {
  name: string;
  folderID: number;
  isRunSequencesFolder?: boolean;
}

interface FolderDesign {
  name: string;
  learningDesignId: number;
}

interface FolderContentsResponse {
  folders?: FolderEntry[];
  learningDesigns?: FolderDesign[];
}

async function readTree(dialog: Locator): Promise<TreeRow[]> {
  // Observed LAMS bootstrap-treeview markup, also used by find:lesson:
  // flat treeitems, direct .indent children encode depth, .tree-parent marks folders.
  const rows = await dialog.getByRole('treeitem').evaluateAll(elements => elements.map(element => ({
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
    level: element.querySelectorAll(':scope > .indent').length,
    folder: element.classList.contains('tree-parent'),
    expanded: element.getAttribute('aria-expanded'),
    // Recorded in the discovery diagnostics: empty folders keep aria-expanded=false.
    empty: element.querySelector('.node-icon.treeview-empty') !== null
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

function isVisiblyExpanded(rows: TreeRow[], index: number): boolean {
  const row = rows[index]!;
  // LAMS normally updates aria-expanded, but some populated folders have been
  // observed leaving it false after their descendant rows are rendered.
  return row.expanded === 'true' || (rows[index + 1]?.level ?? -1) > row.level;
}

function queryTerms(query: string | undefined): string[] {
  return (query ?? '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
}

function matchesQuery(candidate: LessonCandidate, terms: string[]): boolean {
  const searchable = [...candidate.sourceFolderPath, candidate.sourceLessonTitle].join(' ').toLocaleLowerCase();
  return terms.every(term => searchable.includes(term));
}

/**
 * Reads the native folder-content endpoint used by LAMS's lazy Authoring tree in
 * bounded parallel batches. This preserves complete traversal without serially
 * clicking and waiting for hundreds of unrelated folders to render. It returns
 * undefined on older pages without the observed LAMS_URL global so the verified
 * DOM traversal remains available as a fallback.
 */
async function discoverWithFolderApi(
  page: Page,
  options: DiscoveryOptions,
  terms: string[]
): Promise<LessonCandidate[] | undefined> {
  const lamsUrl = await page.evaluate(() => (window as Window & { LAMS_URL?: unknown }).LAMS_URL);
  if (typeof lamsUrl !== 'string' || !lamsUrl.trim()) return undefined;
  const baseUrl = new URL(lamsUrl, page.url());
  if (baseUrl.origin !== new URL(page.url()).origin) {
    throw new Error('The native folder-content URL is not same-origin with the Authoring page.');
  }
  const limit = options.maxExpansions ?? 1000;
  let requests = 0;
  async function getFolderBatch(folderIDs: Array<number | null>): Promise<FolderContentsResponse[]> {
    if ((requests += folderIDs.length) > limit) {
      throw new Error('Discovery expansion budget exhausted; results are incomplete. Narrow --roots or increase --max-expansions.');
    }
    const urls = folderIDs.map(folderID => {
      const url = new URL('home/getFolderContents.do', baseUrl);
      if (folderID !== null) url.searchParams.set('folderID', String(folderID));
      url.searchParams.set('allowInvalidDesigns', 'true');
      return url.toString();
    });
    const responses = await page.evaluate(async ({ requestUrls, timeoutMs }) => Promise.all(requestUrls.map(async requestUrl => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(requestUrl, { credentials: 'same-origin', signal: controller.signal });
        return { ok: response.ok, status: response.status, statusText: response.statusText, body: await response.json() as unknown };
      } finally {
        clearTimeout(timeout);
      }
    })), { requestUrls: urls, timeoutMs: options.timeoutMs });
    return responses.map(response => {
      if (!response.ok) throw new Error(`LAMS discovery request failed (${response.status} ${response.statusText}).`);
      const body = response.body as FolderContentsResponse;
      if ((body.folders !== undefined && !Array.isArray(body.folders)) ||
        (body.learningDesigns !== undefined && !Array.isArray(body.learningDesigns))) {
        throw new Error('LAMS folder discovery returned an unrecognised response.');
      }
      body.folders ??= [];
      body.learningDesigns ??= [];
      return body;
    });
  }

  const [topLevel] = await getFolderBatch([null]);
  const courses = topLevel!.folders!.filter(folder => folder.name === 'Courses');
  if (courses.length !== 1) throw new Error(`Expected one top-level Courses folder; found ${courses.length}.`);
  const coursesEntry = { id: courses[0]!.folderID, path: ['Courses'] };
  let queue: Array<{ id: number; path: string[] }> = [coursesEntry];
  if (options.roots?.length) {
    const [courseContents] = await getFolderBatch([coursesEntry.id]);
    queue = [];
    for (const root of options.roots) {
      const matches = courseContents!.folders!.filter(folder => folder.name === root);
      if (matches.length !== 1) throw new Error(`Expected one folder Courses > ${root}; found ${matches.length}.`);
      queue.push({ id: matches[0]!.folderID, path: ['Courses', root] });
    }
  }

  const candidates = new Map<number, LessonCandidate>();
  const visited = new Set<number>();
  let nextProgress = 50;
  while (queue.length > 0) {
    const batch = queue.splice(0, 16).filter(entry => !visited.has(entry.id));
    if (batch.length === 0) continue;
    batch.forEach(entry => visited.add(entry.id));
    const contents = await getFolderBatch(batch.map(entry => entry.id));
    for (let index = 0; index < batch.length; index += 1) {
      const entry = batch[index]!;
      const content = contents[index]!;
      for (const design of content.learningDesigns!) {
        if (typeof design.name !== 'string' || !Number.isInteger(design.learningDesignId)) {
          throw new Error('LAMS folder discovery returned an invalid design entry.');
        }
        const candidate = { sourceLessonTitle: design.name, sourceFolderPath: entry.path };
        if (matchesQuery(candidate, terms)) candidates.set(design.learningDesignId, candidate);
      }
      for (const folder of content.folders!) {
        if (typeof folder.name !== 'string' || !Number.isInteger(folder.folderID)) {
          throw new Error('LAMS folder discovery returned an invalid folder entry.');
        }
        queue.push({
          id: folder.folderID,
          path: [...entry.path, folder.isRunSequencesFolder ? 'Run sequences' : folder.name]
        });
      }
    }
    if (visited.size >= nextProgress) {
      options.onProgress?.(`Scanned ${visited.size} Authoring folders; ${queue.length} queued.`);
      nextProgress = Math.ceil((visited.size + 1) / 50) * 50;
    }
  }
  options.onProgress?.(`Completed Authoring scan across ${visited.size} folders.`);
  return [...candidates.values()].sort((a, b) =>
    [...a.sourceFolderPath, a.sourceLessonTitle].join('\u0000').localeCompare([...b.sourceFolderPath, b.sourceLessonTitle].join('\u0000'))
  );
}

export async function discoverLessons(page: Page, options: DiscoveryOptions): Promise<LessonCandidate[]> {
  const limit = options.maxExpansions ?? 1000;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('maxExpansions must be a positive integer.');
  await page.locator('#openButton').click();
  const dialog = page.getByRole('dialog', { name: 'Open design', exact: true });
  await dialog.waitFor({ state: 'visible', timeout: options.timeoutMs });
  const terms = queryTerms(options.query);
  const apiResults = await discoverWithFolderApi(page, options, terms);
  if (apiResults) return apiResults;
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
    await expect.poll(async () => isVisiblyExpanded(await readTree(dialog), index), {
      timeout: options.timeoutMs
    }).toBe(true);
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
  if (!courses[0]!.row.empty && !isVisiblyExpanded(rows, courses[0]!.index)) await expand(courses[0]!.index, rows);
  rows = await readTree(dialog);
  for (const root of options.roots ?? []) {
    const matches = rows.filter(row => row.folder && row.path.length === 2 && row.path[0] === 'Courses' && row.text === root);
    if (matches.length !== 1) throw new Error(`Expected one folder Courses > ${root}; found ${matches.length}.`);
  }
  const inScope = (row: TreeRow): boolean => row.path[0] === 'Courses' &&
    (!options.roots?.length || options.roots.includes(row.path[1] ?? ''));
  while (true) {
    rows = await readTree(dialog);
    const index = rows.findIndex((row, index) => inScope(row) && row.folder && !row.empty && !isVisiblyExpanded(rows, index));
    if (index < 0) break;
    await expand(index, rows);
  }
  return rows.filter(row => !row.folder && inScope(row) && terms.every(term => row.path.join(' ').toLocaleLowerCase().includes(term)))
    .map(row => ({ sourceLessonTitle: row.text, sourceFolderPath: row.path.slice(0, -1) }));
}
