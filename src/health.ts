import * as http from "node:http";
import type { Orchestrator } from "./sync/orchestrator.js";
import { createLogger } from "./util/logger.js";

const log = createLogger("health");

interface HealthResponse {
  status: "ok" | "not_ready";
  accounts: Record<string, number>;
}

export function createHealthServer(orchestrator: Orchestrator, port: number): http.Server {
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
      handleReadyz(orchestrator, res);
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

function handleHealthz(orchestrator: Orchestrator, res: http.ServerResponse): void {
  const status = orchestrator.getStatus();
  const body: HealthResponse = {
    status: "ok",
    accounts: status.summary,
  };
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleReadyz(orchestrator: Orchestrator, res: http.ServerResponse): void {
  const status = orchestrator.getStatus();
  const hasActive = status.summary.active > 0;
  const body: HealthResponse = {
    status: hasActive ? "ok" : "not_ready",
    accounts: status.summary,
  };
  const statusCode = hasActive ? 200 : 503;
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
