import { mkdir, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Chromium also locks profiles. This lock reports the owning automation process
// before launch and never deletes Chromium's own lock or session files.
/** Whether a process is still alive; signal 0 asks without touching it. */
function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

export async function acquireProfileLock(profile, options = {}) {
  await mkdir(profile, { recursive: true });
  const canonical = await realpath(profile);
  const directory = `${canonical}.automation-lock`;
  const owner = { pid: process.pid, id: randomUUID() };
  // One profile serves every run and every window opened for reading, so a lesson left open holds
  // it. Waiting for that window to close is what the operator expects; failing outright just makes
  // them run the command again.
  const deadline = Date.now() + (options.waitMs ?? 0);
  let announced = false;
  for (;;) {
    try { await mkdir(directory); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readFile(`${directory}/owner.json`, 'utf8').then(JSON.parse).catch(() => ({}));
      // A run killed mid-flight cannot release its own reservation. Nothing owns it once that
      // process is gone, so it is taken over rather than waited on. Chromium's own lock still
      // guards a profile a browser window is actually using.
      if (typeof existing.pid === 'number' && !isRunning(existing.pid)) {
        console.log(`Taking over the profile reservation left by PID ${existing.pid}, which is no longer running.`);
        await rm(directory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`LAMS profile is already reserved by automation (PID ${existing.pid ?? 'unknown'}): ${canonical}. Wait for that run to close. If it crashed, verify no process/browser uses the profile before removing only ${directory}.`);
      }
      if (!announced) {
        announced = true;
        console.log(`Waiting for the LAMS profile held by PID ${existing.pid ?? 'unknown'}; close that browser window to continue.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
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
