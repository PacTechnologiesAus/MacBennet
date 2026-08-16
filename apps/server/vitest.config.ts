import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Integration and e2e tests share one Postgres database. Running files in
    // parallel would let one file's truncation wipe another's fixtures, so the
    // suite runs single-threaded. It is fast enough that this is not a problem.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
  },
});
