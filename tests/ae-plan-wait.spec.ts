import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { awaitAEJson, parseAEWaitMinutes, resolveAwaitedAEJsonPath } from '../src/ae/plan-wait.js';

/** A clock that advances only when the waiter sleeps, with a hook to change files between polls. */
function fakeClock(onSleep: (tick: number) => Promise<void> = async () => undefined) {
  let time = 0;
  let tick = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
      tick += 1;
      await onSleep(tick);
    }
  };
}

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lams-ae-wait-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

const parse = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { ok: boolean };

test('waits for the AE JSON to appear, then returns what the loader accepts', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'ae.json');
    const clock = fakeClock(async (tick) => { if (tick === 3) await writeFile(file, '{"ok":true}'); });
    const loaded = await awaitAEJson(file, parse, { timeoutMs: 60_000, pollMs: 1_000, ...clock, log: () => undefined });
    expect(loaded).toEqual({ ok: true });
    expect(clock.now()).toBe(3_000);
  });
});

test('skips a refused version and accepts the corrected rewrite', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'ae.json');
    await writeFile(file, '{"ok":');
    const attempts: string[] = [];
    const messages: string[] = [];
    const clock = fakeClock(async (tick) => { if (tick === 2) await writeFile(file, '{"ok":true, "fixed": 1}'); });
    const loaded = await awaitAEJson(
      file,
      async (name) => { attempts.push(name); return parse(name); },
      { timeoutMs: 60_000, pollMs: 1_000, ...clock, log: (message) => messages.push(message) }
    );
    expect(loaded).toEqual({ ok: true, fixed: 1 });
    // The truncated version is tried once, not on every poll.
    expect(attempts).toHaveLength(2);
    expect(messages.some((message) => message.includes('not accepted yet'))).toBe(true);
  });
});

test('stops with the last refusal reason when no acceptable JSON arrives in time', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'ae.json');
    await writeFile(file, '{}');
    const refuse = async () => { throw new Error('Question 3 prompt differs from the Source-of-Truth.'); };
    await expect(
      awaitAEJson(file, refuse, { timeoutMs: 5_000, pollMs: 1_000, ...fakeClock(), log: () => undefined })
    ).rejects.toThrow(/within 0 min \(last reason: Question 3 prompt differs.*apply:ae/s);
  });
});

test('reports a file that never appeared', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'never.json');
    await expect(
      awaitAEJson(file, parse, { timeoutMs: 3_000, pollMs: 1_000, ...fakeClock(), log: () => undefined })
    ).rejects.toThrow('last reason: it never appeared');
  });
});

test('refuses an awaited path that already exists or is not JSON', async () => {
  await withTempDir(async (directory) => {
    const file = path.join(directory, 'ae.json');
    expect(await resolveAwaitedAEJsonPath(file)).toBe(file);
    await writeFile(file, '{}');
    await expect(resolveAwaitedAEJsonPath(file)).rejects.toThrow('already exists');
    await expect(resolveAwaitedAEJsonPath(path.join(directory, 'ae.txt'))).rejects.toThrow('must name a .json file');
  });
});

test('reads the wait limit in minutes with a default', () => {
  expect(parseAEWaitMinutes(undefined)).toBe(60);
  expect(parseAEWaitMinutes('15')).toBe(15);
  expect(() => parseAEWaitMinutes('0')).toThrow('positive number of minutes');
  expect(() => parseAEWaitMinutes('soon')).toThrow('positive number of minutes');
});
