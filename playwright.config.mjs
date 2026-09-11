import { defineConfig } from '@playwright/test';

// PW_CHROMIUM_PATH points at a pre-installed Chromium (used by the remote dev
// environment); CI installs the browser Playwright expects instead.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs/,
  outputDir: 'tests/e2e/.artifacts/results',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'tests/e2e/.artifacts/report', open: 'never' }]]
    : [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 420, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
});
