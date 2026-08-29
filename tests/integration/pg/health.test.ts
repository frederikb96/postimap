import type * as http from "node:http";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHealthServer } from "../../../src/health.js";
import type { Orchestrator, OrchestratorStatus } from "../../../src/sync/orchestrator.js";
import {
  connectPg,
  createTestDb,
  createTestSchema,
  dropTestSchema,
} from "../../setup/pg-helpers.js";

/** Fake orchestrator exposing just the surface health.ts reads. */
function fakeOrchestrator(status: OrchestratorStatus): Orchestrator {
  return { getStatus: () => status } as unknown as Orchestrator;
}

async function getJson(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.on("listening", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

describe("health endpoints", () => {
  let sql: postgres.Sql;
  let schema: string;

  beforeAll(async () => {
    const bootstrap = connectPg();
    schema = await createTestSchema(bootstrap);
    await bootstrap.end();
    sql = connectPg(schema);
  });

  afterAll(async () => {
    if (sql && schema) {
      await dropTestSchema(sql, schema);
      await sql.end();
    }
  });

  test("/healthz is 200 even when zero accounts are active (liveness, not work-based)", async () => {
    const db = createTestDb();
    const status: OrchestratorStatus = {
      running: true,
      accounts: [],
      summary: { created: 0, syncing: 0, active: 0, error: 0, disabled: 0 },
    };
    const server = createHealthServer(fakeOrchestrator(status), db, 0);
    const port = await listen(server);

    try {
      const { status: code, body } = await getJson(port, "/healthz");
      expect(code).toBe(200);
      expect((body as { status: string }).status).toBe("ok");
    } finally {
      server.close();
      await db.destroy();
    }
  });

  test("/readyz is 200 when DB is reachable and the orchestrator is running, regardless of account count", async () => {
    const db = createTestDb();
    const status: OrchestratorStatus = {
      running: true,
      accounts: [],
      summary: { created: 0, syncing: 0, active: 0, error: 0, disabled: 0 },
    };
    const server = createHealthServer(fakeOrchestrator(status), db, 0);
    const port = await listen(server);

    try {
      const { status: code, body } = await getJson(port, "/readyz");
      expect(code).toBe(200);
      expect((body as { status: string }).status).toBe("ok");
    } finally {
      server.close();
      await db.destroy();
    }
  });

  test("/readyz is 503 when the orchestrator has not started, even with zero accounts", async () => {
    const db = createTestDb();
    const status: OrchestratorStatus = {
      running: false,
      accounts: [],
      summary: { created: 0, syncing: 0, active: 0, error: 0, disabled: 0 },
    };
    const server = createHealthServer(fakeOrchestrator(status), db, 0);
    const port = await listen(server);

    try {
      const { status: code, body } = await getJson(port, "/readyz");
      expect(code).toBe(503);
      expect((body as { status: string }).status).toBe("not_ready");
    } finally {
      server.close();
      await db.destroy();
    }
  });

  test("/readyz is 503 when the database is unreachable", async () => {
    // Deliberately bad connection: nothing listens on port 1.
    const db = createTestDb("postgresql://nouser:nopass@127.0.0.1:1/nodb?connect_timeout=1");
    const status: OrchestratorStatus = {
      running: true,
      accounts: [],
      summary: { created: 0, syncing: 0, active: 0, error: 0, disabled: 0 },
    };
    const server = createHealthServer(fakeOrchestrator(status), db, 0);
    const port = await listen(server);

    try {
      const { status: code, body } = await getJson(port, "/readyz");
      expect(code).toBe(503);
      expect((body as { status: string }).status).toBe("not_ready");
    } finally {
      server.close();
      // No db.destroy() here: postgres.js keeps a background reconnect scheduled for a
      // connection that never succeeded even once, and .destroy() waits on it
      // indefinitely -- a pool that was never reachable has nothing to flush anyway.
    }
  });
});
