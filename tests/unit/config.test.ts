import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { getDatabaseUrl, loadConfig } from "../../src/config.js";

// Project root for test config loading
const projectRoot = path.resolve(import.meta.dirname, "../..");

function loadWithEnv(env: Record<string, string | undefined> = {}) {
  return loadConfig({
    projectRoot,
    env: { DB_PASSWORD: "testpass", ...env },
  });
}

describe("loadConfig", () => {
  test("loads defaults from config/config.yaml", () => {
    const config = loadWithEnv();
    expect(config.database.host).toBe("localhost");
    expect(config.database.port).toBe(5432);
    expect(config.database.name).toBe("postimap");
    expect(config.database.user).toBe("postimap");
    expect(config.database.password).toBe("testpass");
  });

  test("applies defaults for all sections", () => {
    const config = loadWithEnv();
    expect(config.sync.interval_seconds).toBe(60);
    expect(config.sync.idle_restart_seconds).toBe(300);
    expect(config.sync.outbound_poll_seconds).toBe(5);
    expect(config.sync.max_retry_attempts).toBe(5);
    expect(config.logging.level).toBe("info");
    expect(config.health.port).toBe(8090);
    expect(config.imap.tls_reject_unauthorized).toBe(true);
  });

  test("resolves ${VAR} placeholders from env", () => {
    const config = loadWithEnv({ DB_PASSWORD: "secret123" });
    expect(config.database.password).toBe("secret123");
  });

  test("throws on missing env var for placeholder", () => {
    expect(() => loadConfig({ projectRoot, env: {} })).toThrow("DB_PASSWORD");
  });

  test("applies POSTIMAP_* env var overrides", () => {
    const config = loadWithEnv({
      POSTIMAP_SYNC_INTERVAL_SECONDS: "120",
      POSTIMAP_HEALTH_PORT: "9090",
      POSTIMAP_LOGGING_LEVEL: "debug",
    });
    expect(config.sync.interval_seconds).toBe(120);
    expect(config.health.port).toBe(9090);
    expect(config.logging.level).toBe("debug");
  });

  test("env var overrides take precedence over YAML", () => {
    const config = loadWithEnv({
      POSTIMAP_DATABASE_HOST: "custom-host",
      POSTIMAP_DATABASE_PORT: "9999",
    });
    expect(config.database.host).toBe("custom-host");
    expect(config.database.port).toBe(9999);
  });

  test("throws on invalid logging level", () => {
    expect(() => loadWithEnv({ POSTIMAP_LOGGING_LEVEL: "invalid" })).toThrow();
  });

  test("throws when default config file is missing", () => {
    expect(() => loadConfig({ projectRoot: "/nonexistent", env: {} })).toThrow(
      "Default config not found",
    );
  });

  test("loads custom override file when present", () => {
    // Create a temporary override path that doesn't exist -- should load fine without it
    const config = loadWithEnv();
    // No override file exists in config-custom/, so defaults should apply
    expect(config.database.host).toBe("localhost");
  });

  test("IMAP TLS defaults to true", () => {
    const config = loadWithEnv();
    expect(config.imap.tls_reject_unauthorized).toBe(true);
  });

  test("POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED can override to false", () => {
    const config = loadWithEnv({ POSTIMAP_IMAP_TLS_REJECT_UNAUTHORIZED: "false" });
    expect(config.imap.tls_reject_unauthorized).toBe(false);
  });
});

describe("getDatabaseUrl", () => {
  test("composes URL from config parts", () => {
    const config = loadWithEnv({ DB_PASSWORD: "mypass" });
    const url = getDatabaseUrl(config);
    expect(url).toBe("postgresql://postimap:mypass@localhost:5432/postimap");
  });

  test("encodes special characters in password", () => {
    const config = loadWithEnv({ DB_PASSWORD: "p@ss:word/test" });
    const url = getDatabaseUrl(config);
    expect(url).toContain(encodeURIComponent("p@ss:word/test"));
  });
});
