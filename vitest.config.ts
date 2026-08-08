import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Builds dist/ once up front; suites that spawn the bundles must never
    // build them concurrently. See test/global-setup.ts.
    globalSetup: ['test/global-setup.ts'],
  },
})
