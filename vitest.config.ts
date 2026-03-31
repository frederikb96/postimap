import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "chaos",
          include: ["tests/chaos/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: "property",
          include: ["tests/property/**/*.test.ts"],
          environment: "node",
          testTimeout: 300_000,
          globalSetup: ["tests/setup/global-setup.ts"],
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
