import { defineConfig, devices } from '@playwright/test';

// Requires the optional real-model Compose stack to be running. There are no
// mocked prediction routes or automatically substituted inference backends.
export default defineConfig({
  testDir: './trained-test', workers: 1, fullyParallel: false,
  timeout: 120_000, expect: { timeout: 20_000 }, retries: 0,
  forbidOnly: Boolean(process.env.CI), reporter: 'list',
  use: { baseURL: process.env.CONTAINER_BASE_URL ?? 'http://127.0.0.1:8080',
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
