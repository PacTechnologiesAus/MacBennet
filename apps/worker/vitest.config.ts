import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 15_000,
    // As in the server: the opt-in tests read their switches straight from
    // process.env, and the file a developer is told to put them in is the
    // repository-root .env.
    setupFiles: ['./tests/helpers/load-env.ts'],
  },
});
