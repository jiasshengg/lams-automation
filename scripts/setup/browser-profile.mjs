import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

export function resolveBrowserProfile(userDataDir = '.playwright/lams-profile') {
  if (typeof userDataDir !== 'string' || !userDataDir.trim()) {
    throw new Error('browser.userDataDir must be a non-empty path.');
  }
  return path.resolve(repositoryRoot, userDataDir);
}

export async function launchLamsBrowser(userDataDir, options) {
  const profile = resolveBrowserProfile(userDataDir);
  console.log(`Browser profile: ${profile}`);
  console.log(`Browser: ${options.channel || 'chromium'}`);
  return chromium.launchPersistentContext(profile, options);
}
