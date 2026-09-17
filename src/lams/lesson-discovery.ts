import { expect, type Locator, type Page } from '@playwright/test';

export interface DiscoveryOptions {
  /** Exact direct child folder names under Courses; omitted searches all of Courses. */
  roots?: string[];
  /** Every whitespace-separated term must occur in the title or folder path. */
  query?: string;
  /** When supplied, return only lessons whose title exactly matches this value. */
  exactTitle?: string;
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
    folder: element.classList.contains('tree-parent') || element.querySelector('.node-icon.treeview-empty') !== null,
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

function matchesCandidate(candidate: LessonCandidate, terms: string[], exactTitle: string | undefined): boolean {
  const searchable = [...candidate.sourceFolderPath, candidate.sourceLessonTitle].join(' ').toLocaleLowerCase();
  return terms.every(term => searchable.includes(term)) &&
    (exactTitle === undefined || candidate.sourceLessonTitle.toLocaleLowerCase() === exactTitle);
}

/**
 * Traverse LAMS's observed lazy-folder endpoint one request at a time. The server
 * has returned HTML under burst traffic, so this deliberately avoids Promise.all.
 * Any non-JSON response abandons the shortcut before returning results and lets
 * the verified DOM traversal take over.
 */
async function discoverWithFolderApi(
  page: Page,
  options: DiscoveryOptions,
  terms: string[],
  exactTitle: string | undefined
): Promise<LessonCandidate[] | undefined> {
  const lamsUrl = await page.evaluate(() => (window as Window & { LAMS_URL?: unknown }).LAMS_URL);
  if (typeof lamsUrl !== 'string' || !lamsUrl.trim()) return undefined;
  const baseUrl = new URL(lamsUrl, page.url());
  if (baseUrl.origin !== new URL(page.url()).origin) return undefined;
  const limit = options.maxExpansions ?? 1000;
  let requests = 0;

  async function getFolder(folderID: number | null, retry = true): Promise<FolderContentsResponse | undefined> {
    if (++requests > limit) {
      throw new Error('Discovery expansion budget exhausted; results are incomplete. Narrow --roots or increase --max-expansions.');
    }
    const url = new URL('home/getFolderContents.do', baseUrl);
    url.searchParams.set('folderID', folderID === null ? '' : String(folderID));
    url.searchParams.set('allowInvalidDesigns', 'true');
    const response = await page.evaluate(async ({ requestUrl, timeoutMs }) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await fetch(requestUrl, { credentials: 'same-origin', signal: controller.signal });
        return {
          location: new URL(result.url).origin + new URL(result.url).pathname,
          redirected: result.redirected,
          ok: result.ok,
          status: result.status,
          contentType: result.headers.get('content-type') ?? '',
          text: await result.text()
        };
      } finally {
        clearTimeout(timeout);
      }
    }, { requestUrl: url.toString(), timeoutMs: options.timeoutMs });
    if (!response.ok || !response.contentType.toLocaleLowerCase().includes('json')) {
      const detail = `Folder ${folderID ?? 'root'}: HTTP ${response.status}, type ${response.contentType || 'missing'}, final URL ${response.location}, redirected=${response.redirected}`;
      options.onProgress?.(detail);
      if (response.redirected && /login|signin|saml|authorize/i.test(response.location)) {
        throw new Error(`Discovery reached authentication instead of folder data. ${detail}. Run npm run login:check with the same profile; no complete results were returned.`);
      }
      if (retry && (response.ok || response.status === 429 || response.status >= 500)) {
        await page.waitForTimeout(500);
        return getFolder(folderID, false);
      }
      if (!response.ok) throw new Error(`LAMS discovery request failed. ${detail}`);
      return undefined;
    }
    let body: FolderContentsResponse;
    try {
      body = JSON.parse(response.text) as FolderContentsResponse;
    } catch {
      options.onProgress?.(`Folder ${folderID ?? 'root'} returned invalid JSON at ${response.location}.`);
      return undefined;
    }
    if ((body.folders !== undefined && !Array.isArray(body.folders)) ||
      (body.learningDesigns !== undefined && !Array.isArray(body.learningDesigns))) return undefined;
    body.folders ??= [];
    body.learningDesigns ??= [];
    return body;
  }

  const topLevel = await getFolder(null);
  if (!topLevel) return undefined;
  const courses = topLevel.folders!.filter(folder => folder.name === 'Courses');
  if (courses.length !== 1) throw new Error(`Expected one top-level Courses folder; found ${courses.length}.`);
  const coursesEntry = { id: courses[0]!.folderID, path: ['Courses'] };
  let queue: Array<{ id: number; path: string[] }> = [coursesEntry];
  if (options.roots?.length) {
    const courseContents = await getFolder(coursesEntry.id);
    if (!courseContents) return undefined;
    queue = [];
    for (const root of options.roots) {
      const matches = courseContents.folders!.filter(folder => folder.name === root);
      if (matches.length !== 1) throw new Error(`Expected one folder Courses > ${root}; found ${matches.length}.`);
      queue.push({ id: matches[0]!.folderID, path: ['Courses', root] });
    }
  }

  const candidates = new Map<number, LessonCandidate>();
  const visited = new Set<number>();
  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (visited.has(entry.id)) continue;
    visited.add(entry.id);
    const content = await getFolder(entry.id);
    if (!content) return undefined;
    for (const design of content.learningDesigns!) {
      if (typeof design.name !== 'string' || !Number.isInteger(design.learningDesignId)) {
        throw new Error('LAMS folder discovery returned an invalid design entry.');
      }
      const candidate = { sourceLessonTitle: design.name, sourceFolderPath: entry.path };
      if (matchesCandidate(candidate, terms, exactTitle)) candidates.set(design.learningDesignId, candidate);
    }
    for (const folder of content.folders!) {
      if (typeof folder.name !== 'string' || !Number.isInteger(folder.folderID)) {
        throw new Error('LAMS folder discovery returned an invalid folder entry.');
      }
      queue.push({ id: folder.folderID, path: [...entry.path, folder.isRunSequencesFolder ? 'Run sequences' : folder.name] });
    }
    if (visited.size % 50 === 0) options.onProgress?.(`Scanned ${visited.size} Authoring folders; ${queue.length} queued.`);
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
  const exactTitle = options.exactTitle?.toLocaleLowerCase();
  const apiResults = await discoverWithFolderApi(page, options, terms, exactTitle);
  if (apiResults) return apiResults;
  options.onProgress?.('Folder endpoint did not return JSON; continuing with rendered-tree discovery.');
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
    // Captured bootstrap-treeview DOM exposes .expand-icon on expandable folders.
    // A row click can select without expanding; prefer the observed expansion control.
    const icon = target.locator('.expand-icon');
    if (await icon.isVisible()) await icon.click();
    else await target.click();
    await expect.poll(async () => {
      const current = await readTree(dialog);
      const currentIndex = current.findIndex(candidate => JSON.stringify(candidate.path) === JSON.stringify(row.path));
      return currentIndex >= 0 && (current[currentIndex]!.empty || isVisiblyExpanded(current, currentIndex));
    }, {
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
    options.onProgress?.(`Expanded ${expansions} Authoring folder${expansions === 1 ? '' : 's'}.`);
  }

  let rows = await readTree(dialog);
  const courses = rows.map((row, index) => ({ row, index }))
    .filter(({ row }) => row.folder && row.text === 'Courses' && row.level === 0);
  if (courses.length !== 1) throw new Error(`Expected one top-level Courses folder; found ${courses.length}.`);
  if (!courses[0]!.row.empty && !isVisiblyExpanded(rows, courses[0]!.index)) await expand(courses[0]!.index, rows);
  rows = await readTree(dialog);
  const loadedCourses = rows.find(row => row.level === 0 && row.text === 'Courses');
  if (loadedCourses?.empty) {
    throw new Error('Courses rendered as empty after the folder API failed. Discovery is incomplete; verify access/session with login:check and retry. No complete results were returned.');
  }
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
  return rows.filter(row => !row.folder && inScope(row) &&
      matchesCandidate({ sourceLessonTitle: row.text, sourceFolderPath: row.path.slice(0, -1) }, terms, exactTitle))
    .map(row => ({ sourceLessonTitle: row.text, sourceFolderPath: row.path.slice(0, -1) }));
}
