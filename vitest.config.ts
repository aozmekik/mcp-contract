import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // End-to-end suites spawn real server processes; give them room on loaded CI machines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The bin shim only wires process globals into `main()`, which is covered directly.
      exclude: ['src/cli.ts'],
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});

export default config;
