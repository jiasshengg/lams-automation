import type { BrowserContext, chromium } from '@playwright/test';
export function resolveBrowserProfile(userDataDir?: string): string;
export function launchLamsBrowser(userDataDir: string, options: NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>): Promise<BrowserContext>;
