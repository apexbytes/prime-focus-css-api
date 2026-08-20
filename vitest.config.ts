import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Tests sit beside the code they cover; `tests/` holds helpers and e2e specs.
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      // Overridden in CI. Integration specs only run when RUN_DB_TESTS=1.
      DATABASE_URL: 'postgres://css:css@localhost:5434/prime_focus_css',
      // Flow specs drive many logins from one IP; rateLimit.test.ts covers the
      // limiter itself with its own budget.
      AUTH_RATE_LIMIT_MAX: '5000',
      RATE_LIMIT_MAX: '100000',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/db/migrate.ts', 'src/**/*.types.ts'],
    },
    restoreMocks: true,
    clearMocks: true,
    // The integration suites share one Postgres database and truncate it
    // between cases, so two files running at once would wipe each other's
    // fixtures. Sequential files, and no concurrent cases within a file.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
