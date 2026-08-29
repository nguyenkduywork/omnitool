// playwright.config.ts — Task 8 golden-flow e2e tests.
//
// These run against the PRODUCTION build, never `vite dev`: a bug that only
// shows up in the built, code-split bundle (a chunk that fails to load, a
// worker path that only resolves correctly post-build, etc.) is exactly what
// this suite exists to catch. `webServer` below builds fresh and then serves
// `dist/` with `vite preview` — the same kind of static file server GitHub
// Pages effectively is. `base: './'` in vite.config.ts is relative, which
// resolves correctly however the server exposes the root, so no path
// rewriting is needed here.
import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
