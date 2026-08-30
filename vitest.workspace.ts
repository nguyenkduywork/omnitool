import { defineWorkspace } from 'vitest/config';

// Two projects so ops that need real browser primitives (OffscreenCanvas,
// createImageBitmap, convertToBlob — none of which exist in Node) can be
// unit-tested in headless Chromium, while everything else keeps running
// fast under Node.
export default defineWorkspace([
  {
    test: {
      name: 'node',
      environment: 'node',
      include: ['tests/unit/**/*.test.ts'],
      exclude: ['**/*.browser.test.ts', 'tests/e2e/**', 'node_modules/**', 'dist/**'],
    },
  },
  {
    test: {
      name: 'browser',
      include: ['tests/unit/**/*.browser.test.ts'],
      exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
      browser: {
        enabled: true,
        provider: 'playwright',
        name: 'chromium',
        headless: true,
      },
    },
  },
]);
