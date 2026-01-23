import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/services/**/*.ts', 'src/jobs/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/scripts/**/*.ts'],
    },
    // Timeout for async tests
    testTimeout: 10000,
    // Setup files to run before tests
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    alias: {
      '@': './src',
    },
  },
});

