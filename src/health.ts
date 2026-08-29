import * as http from "node:http";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "./db/schema.js";
import type { Orchestrator } from "./sync/orchestrator.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("health");

interface HealthResponse {
  status: "ok" | "not_ready";
  accounts: Record<string, number>;
}

export function createHealthServer(
  orchestrator: Orchestrator,
  db: Kysely<Database>,
  port: number,
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";

    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    if (url === "/healthz") {
      handleHealthz(orchestrator, res);
    } else if (url === "/readyz") {
      handleReadyz(orchestrator, db, res).catch((err) => {
        log.error({ err }, "readyz check failed");
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "not_ready", accounts: {} }));
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  server.listen(port, () => {
    log.info({ port }, "Health server listening");
  });

  return server;
}

/** Liveness: the process is up and serving HTTP. No dependency checks. */
function handleHealthz(orchestrator: Orchestrator, res: http.ServerResponse): void {
  const status = orchestrator.getStatus();
  const body: HealthResponse = {
    status: "ok",
    accounts: status.summary,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Readiness: this process can serve, not "there is work to do". A fresh deployment with
 * zero accounts yet, or every account currently in backoff, is a perfectly ready process
 * -- pulling it out of the Service's endpoints for that would be wrong for a system whose
 * job is to keep retrying. Per-account sync health belongs in `sync_state`, not here.
 */
async function handleReadyz(
  orchestrator: Orchestrator,
  db: Kysely<Database>,
  res: http.ServerResponse,
): Promise<void> {
  const status = orchestrator.getStatus();

  let dbReachable = true;
  try {
    await sql`SELECT 1`.execute(db);
  } catch {
    dbReachable = false;
  }

  const ready = status.running && dbReachable;
  const body: HealthResponse = {
    status: ready ? "ok" : "not_ready",
    accounts: status.summary,
  };
  res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
