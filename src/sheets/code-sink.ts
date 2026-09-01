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

/** The Apps Script only accepts a 5-digit LAMS code; catch a bad value before the POST. */
export function assertLessonCode(code: string): string {
  if (!/^\d{5}$/.test(code)) {
    throw new Error(`Expected a 5-digit lesson code, got "${code}".`);
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
 * POSTs `{ code, identifier, secret }` and fails loudly unless the Apps Script answers
 * `{"status":"ok"}`. Apps Script answers 302 to its own googleusercontent host on success,
 * which the global fetch follows by default; a non-2xx or non-JSON body is treated as a
 * failure rather than silently accepted.
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

      let result: CodeSinkResult;
      try {
        result = JSON.parse(body) as CodeSinkResult;
      } catch {
        // A login page instead of JSON means the Web App is not deployed as
        // "Anyone" / the NTU domain, which is the failure worth naming here.
        throw new Error(`Sheet endpoint did not return JSON (check the Web App access setting): ${body.slice(0, 200)}`);
      }
      if (result.status !== 'ok') {
        throw new Error(`Failed to send code: ${result.message ?? JSON.stringify(result)}`);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts) await delay(attempt * 1_000);
    }
  }
  throw new Error(`Could not publish code ${validCode} for "${validIdentifier}" after ${attempts} attempts: ${lastError?.message}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
