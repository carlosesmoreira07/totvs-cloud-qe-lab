import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 4010);
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: ['api/**/*.spec.ts', 'contract/**/*.spec.ts'],
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  ...(process.env.CI ? { workers: 2 } : {}),
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    extraHTTPHeaders: {
      accept: 'application/json',
    },
  },
  ...(process.env.BASE_URL
    ? {}
    : { webServer: {
        command: 'npm run dev',
        url: `${baseURL}/health`,
        reuseExistingServer: false,
        timeout: 30_000,
        env: { PORT: String(port) },
      } }),
});
