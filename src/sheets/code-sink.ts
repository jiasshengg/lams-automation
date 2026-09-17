/**
 * Publishes a lesson's 5-digit code to the Google Apps Script Web App that writes it
 * back into the Kanban sheet. The sheet matches on "TBL/Quiz Details" (column G), which
 * is the same string this automation already carries as `config.lessonTitle`
 * (for example "FOM TBL06 030926 2026Y1"), so that is what we send as `identifier`.
 *
 * The endpoint and the shared secret are read from the environment, never from
 * configuration, so the secret is not committed alongside the LAMS settings.
 */

export interface CodeSinkOptions {
  /** Apps Script Web App /exec URL. Defaults to LAMS_SHEET_WEBHOOK_URL. */
  url?: string;
  /** Shared secret the Apps Script checks. Defaults to LAMS_SHEET_SECRET. */
  secret?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Total attempts, including the first. A transient network blip is common here. */
  attempts?: number;
  timeoutMs?: number;
}

export interface CodeSinkResult {
  status: string;
  message?: string;
}

/**
 * The code is the LAMS lesson ID out of the monitoring URL
 * (monitorLesson.do?lessonID=41192), and the sheet expects five digits. Lesson IDs are
 * allocated sequentially, so this will need revisiting if LAMS ever reaches six.
 */
export function assertLessonCode(code: string): string {
  if (!/^\d{5}$/.test(code)) {
    throw new Error(`Expected a 5-digit lesson code (the LAMS lesson ID), got "${code}".`);
  }
  return code;
}

/** The identifier must match column G exactly, so only outer whitespace is forgiven. */
export function assertIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) throw new Error('Sheet identifier (TBL/Quiz Details) must not be empty.');
  return trimmed;
}

export function resolveSinkEndpoint(options: CodeSinkOptions = {}): { url: string; secret: string } {
  const url = options.url ?? process.env.LAMS_SHEET_WEBHOOK_URL ?? '';
  const secret = options.secret ?? process.env.LAMS_SHEET_SECRET ?? '';
  if (!url) throw new Error('Set LAMS_SHEET_WEBHOOK_URL to the Apps Script /exec URL before sending codes.');
  if (!secret) throw new Error('Set LAMS_SHEET_SECRET to the shared secret before sending codes.');
  return { url, secret };
}

/**
 * Reads the Apps Script answer out of a response body.
 *
 * The usual body is bare JSON, but the googleusercontent redirect the Web App bounces
 * through sometimes serves an HTML interstitial carrying the same JSON inside it, and a
 * straight `JSON.parse` turned that into a misleading "check the Web App access setting"
 * error that hid the script's real message. So parse directly when we can, and otherwise
 * pull the first `{...}` carrying a `status` out of the markup.
 *
 * Returns undefined when the body holds no answer at all, which is the genuine sign-in
 * page / wrong-access case the caller still reports.
 */
export function parseSinkBody(body: string): CodeSinkResult | undefined {
  const direct = tryParse(body);
  if (direct) return direct;

  const withoutScripts = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = decodeEntities(withoutScripts.replace(/<[^>]+>/g, ' '));
  for (const candidate of jsonCandidates(text)) {
    const parsed = tryParse(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function tryParse(text: string): CodeSinkResult | undefined {
  try {
    const value: unknown = JSON.parse(text.trim());
    if (value && typeof value === 'object' && typeof (value as CodeSinkResult).status === 'string') {
      return value as CodeSinkResult;
    }
  } catch {
    // Not JSON on its own; the caller falls back to scanning the markup.
  }
  return undefined;
}

/** Yields each brace-balanced `{...}` run that mentions a status, in document order. */
function* jsonCandidates(text: string): Generator<string> {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, index + 1);
          if (candidate.includes('"status"')) yield candidate;
          break;
        }
      }
    }
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** A definitive answer from the script itself: retrying would not change it. */
class SheetRejection extends Error {}

/**
 * POSTs `{ code, identifier, secret }` and fails loudly unless the Apps Script answers
 * `{"status":"ok"}`. Apps Script answers 302 to its own googleusercontent host on success,
 * which the global fetch follows by default; a non-2xx or unreadable body is treated as a
 * failure rather than silently accepted.
 *
 * Only transport-level trouble is retried. A status the script itself rejected (an
 * identifier that is not in column G, say) is raised on the first attempt, so a request
 * the sheet may already have acted on is never replayed.
 */
export async function sendCodeToSheet(
  code: string,
  identifier: string,
  options: CodeSinkOptions = {}
): Promise<CodeSinkResult> {
  const validCode = assertLessonCode(code);
  const validIdentifier = assertIdentifier(identifier);
  const { url, secret } = resolveSinkEndpoint(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = Math.max(1, options.attempts ?? 3);
  const timeoutMs = options.timeoutMs ?? 20_000;

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: validCode, identifier: validIdentifier, secret }),
        signal: AbortSignal.timeout(timeoutMs)
      });

      const body = await response.text();
      if (!response.ok) {
        throw new Error(`Sheet endpoint returned HTTP ${response.status}: ${body.slice(0, 200)}`);
      }

      const result = parseSinkBody(body);
      if (!result) {
        // No answer anywhere in the body means a sign-in page rather than the script,
        // i.e. the Web App is not deployed as "Anyone" / the NTU domain.
        throw new Error(`Sheet endpoint did not return JSON (check the Web App access setting): ${body.slice(0, 200)}`);
      }
      if (result.status !== 'ok') {
        throw new SheetRejection(`Failed to send code: ${result.message ?? JSON.stringify(result)}`);
      }
      return result;
    } catch (error) {
      if (error instanceof SheetRejection) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts) await delay(attempt * 1_000);
    }
  }
  throw new Error(`Could not publish code ${validCode} for "${validIdentifier}" after ${attempts} attempts: ${lastError?.message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
