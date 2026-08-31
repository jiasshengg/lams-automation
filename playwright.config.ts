import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    headless: false,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  }
});

