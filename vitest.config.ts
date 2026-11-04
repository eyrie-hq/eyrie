import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/web/test/**/*.test.ts', 'apps/desktop/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts', 'scripts/**/test/**/*.test.ts'],
    testTimeout: 20_000,
    // One test file at a time. The engine test needs real file events, and on macOS
    // they are dropped (not delayed) while other files create git repositories in
    // the same temp folder, so it failed 1 run in 3. Costs about 4 s.
    fileParallelism: false,
  },
});
