import { mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Chromium also locks profiles. This lock reports the owning automation process
// before launch and never deletes Chromium's own lock or session files.
export async function acquireProfileLock(profile) {
  await mkdir(profile, { recursive: true });
  const canonical = await realpath(profile);
  const directory = `${canonical}.automation-lock`;
  const owner = { pid: process.pid, id: randomUUID() };
  try { await mkdir(directory); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(`${directory}/owner.json`, 'utf8').then(JSON.parse).catch(() => ({}));
    throw new Error(`LAMS profile is already reserved by automation (PID ${existing.pid ?? 'unknown'}): ${canonical}. Wait for that run to close. If it crashed, verify no process/browser uses the profile before removing only ${directory}.`);
  }
  try { await writeFile(`${directory}/owner.json`, JSON.stringify(owner), { mode: 0o600 }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  let released = false;
  const onExit = () => {
    try {
      if (!released && JSON.parse(readFileSync(`${directory}/owner.json`, 'utf8')).id === owner.id) rmSync(directory, { recursive: true, force: true });
    } catch { /* Never remove a lock whose ownership cannot be verified. */ }
  };
  process.once('exit', onExit);
  let releasing;
  return () => {
    releasing ??= readFile(`${directory}/owner.json`, 'utf8').then(JSON.parse).catch(() => undefined).then(current => {
      if (current?.id === owner.id) return rm(directory, { recursive: true, force: true });
    }).then(() => {
      released = true;
      process.off('exit', onExit);
    });
    return releasing;
  };
}
