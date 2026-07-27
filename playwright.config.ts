import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/web-bridge-e2e',
  testMatch: '**/*.pw.ts',
  timeout: 30_000,
  retries: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
  },
})
