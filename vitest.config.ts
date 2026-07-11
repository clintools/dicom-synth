import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    pool: 'forks',
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    server: {
      deps: {
        inline: ['dcmjs'],
      },
    },
    coverage: {
      provider: 'v8',
      // bin/ is exercised by the CLI suites as subprocesses, which v8 cannot
      // instrument — only src/ is measured.
      include: ['src/**'],
      exclude: [
        // Type-only modules — no runtime statements to cover.
        'src/schema/types.ts',
        'src/dcmjs.d.ts',
        // ESM-interop fallbacks are unreachable within a single environment.
        'src/loadDcmjs.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
      },
    },
  },
})
