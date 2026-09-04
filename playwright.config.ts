import { defineConfig } from '@playwright/test';

const port = Number(process.env.PORT ?? 4010);
const baseURL = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  testMatch: [
    'api/**/*.spec.ts',
    'contract/**/*.spec.ts',
    'integration/**/*.spec.ts',
    'resiliency/**/*.spec.ts',
    'observability/**/*.spec.ts',
    'journeys/**/*.spec.ts',
    'performance/**/*.spec.ts',
    'security/**/*.spec.ts',
  ],
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
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
