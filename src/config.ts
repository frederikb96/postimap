import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- Zod schema: types and constraints only, NO defaults ---

const PostImapConfigSchema = z.object({
  database: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    name: z.string().min(1),
    user: z.string().min(1),
    password: z.string().min(1),
  }),
  imap: z.object({
    tls_reject_unauthorized: z.boolean(),
  }),
  sync: z.object({
    interval_seconds: z.number().int().positive(),
    idle_restart_seconds: z.number().int().positive(),
    outbound_poll_seconds: z.number().int().positive(),
    max_retry_attempts: z.number().int().positive(),
  }),
  logging: z.object({
    level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
  }),
  health: z.object({
    port: z.number().int().positive(),
  }),
  encryption_key: z.string().optional(),
});

export type PostImapConfig = z.infer<typeof PostImapConfigSchema>;

// --- YAML loading ---

function findProjectRoot(): string {
  // In production container: /app
  // In dev/test: walk up from this file to find package.json
  const containerRoot = "/app";
  if (existsSync(path.join(containerRoot, "config", "config.yaml"))) {
    return containerRoot;
  }
  let dir = import.meta.dirname;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error("Cannot find project root (no package.json found in parent directories)");
}

function loadYaml(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  return parseYaml(content) as Record<string, unknown>;
}

// --- Deep merge ---

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (isPlainObject(result[key]) && isPlainObject(override[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        override[key] as Record<string, unknown>,
      );
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

// --- Placeholder resolution ---

function resolveEnvPlaceholders(obj: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof obj === "string") {
    // Match ${VAR} patterns
    return obj.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const val = env[varName];
      if (val === undefined) {
        throw new Error(
          `Environment variable ${varName} is not set (required by config placeholder)`,
        );
      }
      return val;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvPlaceholders(item, env));
  }
  if (isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveEnvPlaceholders(val, env);
    }
    return result;
  }
  return obj;
}

// --- Env var overrides (POSTIMAP_SECTION_KEY) ---

const ENV_PREFIX = "POSTIMAP_";

function applyEnvOverrides(
  config: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const result = structuredClone(config);

  for (const [envKey, envVal] of Object.entries(env)) {
    if (!envKey.startsWith(ENV_PREFIX) || envVal === undefined) continue;

    const path = envKey.slice(ENV_PREFIX.length).toLowerCase().split("_");
    if (path.length < 2) continue;

    // Try to find the matching nested path in config
    // e.g., POSTIMAP_DATABASE_HOST -> database.host
    // e.g., POSTIMAP_SYNC_INTERVAL_SECONDS -> sync.interval_seconds
    const resolved = resolveConfigPath(result, path);
    if (resolved) {
      const { parent, key, currentType } = resolved;
      parent[key] = coerceValue(envVal, currentType);
    }
  }

  return result;
}

interface ResolvedPath {
  parent: Record<string, unknown>;
  key: string;
  currentType: string;
}

function resolveConfigPath(
  config: Record<string, unknown>,
  pathParts: string[],
): ResolvedPath | null {
  // Try greedy matching: first part is section, rest is the key with underscores
  // e.g., ["database", "host"] -> config.database.host
  // e.g., ["sync", "interval", "seconds"] -> config.sync.interval_seconds
  // e.g., ["health", "port"] -> config.health.port
  const section = pathParts[0];
  if (!isPlainObject(config[section])) return null;

  const sectionObj = config[section] as Record<string, unknown>;
  const keyParts = pathParts.slice(1);

  // Try joining remaining parts with underscores to match config keys
  const key = keyParts.join("_");
  if (key in sectionObj) {
    return {
      parent: sectionObj,
      key,
      currentType: typeof sectionObj[key],
    };
  }

  return null;
}

function coerceValue(val: string, targetType: string): unknown {
  switch (targetType) {
    case "number":
      return Number(val);
    case "boolean":
      return val === "true" || val === "1";
    default:
      return val;
  }
}

// --- Public API ---

export interface LoadConfigOptions {
  /** Override environment variables (for testing) */
  env?: Record<string, string | undefined>;
  /** Override project root (for testing) */
  projectRoot?: string;
  /** Override config override path (for testing) */
  overridePath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): PostImapConfig {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? findProjectRoot();

  // 1. Load default config (required)
  const defaultConfigPath = path.join(projectRoot, "config", "config.yaml");
  if (!existsSync(defaultConfigPath)) {
    throw new Error(`Default config not found: ${defaultConfigPath}`);
  }
  let config = loadYaml(defaultConfigPath);

  // 2. Load custom override (optional)
  const overridePath =
    options.overridePath ??
    env.CONFIG_OVERRIDE_PATH ??
    path.join(projectRoot, "config-custom", "config.override.yaml");

  if (existsSync(overridePath)) {
    const override = loadYaml(overridePath);
    config = deepMerge(config, override);
  }

  // 3. Resolve ${VAR} placeholders from env
  config = resolveEnvPlaceholders(config, env) as Record<string, unknown>;

  // 4. Apply POSTIMAP_* env var overrides
  config = applyEnvOverrides(config, env);

  // 5. Validate with Zod (no defaults -- fails fast on missing values)
  return PostImapConfigSchema.parse(config);
}

/**
 * Compose a DATABASE_URL from config parts.
 * Consumers that need a connection string use this.
 */
export function getDatabaseUrl(config: PostImapConfig): string {
  const { host, port, name, user, password } = config.database;
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}
