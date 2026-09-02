import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      // Raw pino JSON otherwise dominates test output
      LOG_LEVEL: process.env.POSTIMAP_TEST_LOG_LEVEL ?? "silent",
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "pg-integration",
          include: ["tests/integration/pg/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          // Vitest's hookTimeout defaults to 10s regardless of testTimeout; beforeAll
          // (schema creation + migrations) can exceed that under load -- e.g. every
          // project's containers starting/reusing at once in a combined `npm test` run.
          hookTimeout: 30_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "imap-integration",
          include: ["tests/integration/imap/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "dav-integration",
          include: ["tests/integration/dav/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          hookTimeout: 30_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          env: { POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED: "false" },
        },
      },
      {
        test: {
          name: "chaos",
          include: ["tests/chaos/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 60_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          env: { POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED: "false" },
        },
      },
      {
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
          environment: "node",
          testTimeout: 300_000,
          hookTimeout: 60_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          env: { POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED: "false" },
        },
      },
    ],
  },
});
