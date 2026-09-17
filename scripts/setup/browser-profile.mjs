import path from 'node:path';
import { acquireProfileLock } from './profile-lock.mjs';
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
  const release = await acquireProfileLock(profile);
  try {
    const context = await chromium.launchPersistentContext(profile, options);
    context.once('close', () => { void release().catch(error => console.error(`Profile lock cleanup failed: ${error.message}`)); });
    const close = context.close.bind(context);
    context.close = async (...args) => { await close(...args); await release(); };
    return context;
  } catch (error) {
    await release();
    throw error;
  }
}
