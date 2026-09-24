import path from 'node:path';
import { existsSync } from 'node:fs';
import { acquireProfileLock } from './profile-lock.mjs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Whether a browser window currently has this profile open. Chromium keeps a lock inside the
 * profile for as long as one does, so the answer costs nothing — and asking this way matters:
 * launching to find out hands a blank tab to that window every time.
 */
export function isProfileOpenInBrowser(profile) {
  return ['lockfile', 'SingletonLock'].some((name) => existsSync(path.join(profile, name)));
}

/** Launches once no window holds the profile, reporting the wait rather than opening stray tabs. */
async function launchWhenFree(profile, options, waitMs) {
  const deadline = Date.now() + waitMs;
  let announced = false;
  while (isProfileOpenInBrowser(profile) && Date.now() < deadline) {
    if (!announced) {
      announced = true;
      console.log('The LAMS profile is open in another browser window; waiting for that window to be closed.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return chromium.launchPersistentContext(profile, options);
}

export function resolveBrowserProfile(userDataDir = '.playwright/lams-profile') {
  if (typeof userDataDir !== 'string' || !userDataDir.trim()) {
    throw new Error('browser.userDataDir must be a non-empty path.');
  }
  return path.resolve(repositoryRoot, userDataDir);
}

/** How long a run waits for a window someone left open on the same profile. */
const PROFILE_WAIT_MS = 5 * 60 * 1000;

/**
 * Chromium refuses to start on a profile another window already has open. That window may be one
 * someone left on a lesson, so the message says exactly that rather than reading like a failure.
 */
export function isProfileBusyError(error) {
  return /existing browser session/i.test(error?.message ?? '');
}

export async function launchLamsBrowser(userDataDir, options) {
  const profile = resolveBrowserProfile(userDataDir);
  console.log(`Browser profile: ${profile}`);
  console.log(`Browser: ${options.channel || 'chromium'}`);
  const waitMs = options.profileWaitMs ?? PROFILE_WAIT_MS;
  const release = await acquireProfileLock(profile, { waitMs });
  try {
    const context = await launchWhenFree(profile, options, waitMs);
    context.once('close', () => { void release().catch(error => console.error(`Profile lock cleanup failed: ${error.message}`)); });
    const close = context.close.bind(context);
    context.close = async (...args) => { await close(...args); await release(); };
    return context;
  } catch (error) {
    await release();
    throw error;
  }
}
