import type { BrowserContext } from '@playwright/test';
export function installNoInteractionGuard(context: BrowserContext): Promise<() => void>;
