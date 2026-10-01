import { stat } from 'node:fs/promises';
import path from 'node:path';

export const AWAIT_AE_JSON_FLAG = '--await-ae-json';
export const AE_WAIT_MINUTES_FLAG = '--ae-wait-minutes';
export const DEFAULT_AE_WAIT_MINUTES = 60;
const DEFAULT_POLL_MS = 5_000;

export interface AwaitAEJsonOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

/**
 * Waits for an AE JSON that is still being prepared while the browser copies the lesson and
 * writes the iRAT, and returns what `load` makes of the first version it accepts.
 *
 * `load` holds every check the eager `--ae-json` path runs, so a waited-for plan reaches LAMS
 * only on the same terms. A version it refuses (half-written, drifted from the Source-of-Truth,
 * a missing image) is reported and skipped; the next change to the file is tried again, so the
 * extraction can be corrected while the browser holds its place.
 */
export async function awaitAEJson<T>(filePath: string, load: (file: string) => Promise<T>, options: AwaitAEJsonOptions): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? console.log;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = now() + options.timeoutMs;
  let rejectedVersion: string | undefined;
  let lastReason = 'it never appeared';

  log(`Waiting for the AE JSON at ${filePath} (up to ${Math.round(options.timeoutMs / 60_000)} min).`);
  for (;;) {
    const version = await fileVersion(filePath);
    if (version && version !== rejectedVersion) {
      try {
        const loaded = await load(filePath);
        log(`AE JSON accepted: ${filePath}`);
        return loaded;
      } catch (error) {
        rejectedVersion = version;
        lastReason = error instanceof Error ? error.message : String(error);
        log(`AE JSON not accepted yet; waiting for a corrected file. Reason: ${lastReason}`);
      }
    }
    if (now() >= deadline) {
      throw new Error(
        `No acceptable AE JSON arrived at ${filePath} within ${Math.round(options.timeoutMs / 60_000)} min (last reason: ${lastReason}). ` +
          'The copy and iRAT are already saved; write AE on this lesson with apply:ae once the AE JSON is ready.'
      );
    }
    await sleep(pollMs);
  }
}

/**
 * The waited-for AE JSON is an output of the preparation step, so its path is literal, never fuzzy.
 * It must not exist yet: a file left by an earlier run would otherwise be written to LAMS at once.
 */
export async function resolveAwaitedAEJsonPath(value: string): Promise<string> {
  const resolved = path.resolve(value.trim());
  if (path.extname(resolved).toLowerCase() !== '.json') throw new Error(`${AWAIT_AE_JSON_FLAG} must name a .json file.`);
  if (await fileVersion(resolved)) {
    throw new Error(`${resolved} already exists. Pass it with --ae-json if it is ready, or give ${AWAIT_AE_JSON_FLAG} a new path.`);
  }
  return resolved;
}

export function parseAEWaitMinutes(value: string | undefined): number {
  if (value === undefined) return DEFAULT_AE_WAIT_MINUTES;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`${AE_WAIT_MINUTES_FLAG} must be a positive number of minutes; received "${value}".`);
  return minutes;
}

/** Size and modification time together mark a new version, including a rewrite within one mtime tick. */
async function fileVersion(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? `${info.mtimeMs}:${info.size}` : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
