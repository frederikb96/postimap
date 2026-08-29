import pino from "pino";

const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

/**
 * Sets the running log level. Modules create their child logger at import time, before
 * config has loaded, so the level configured in config.yaml is applied by calling this
 * once at startup rather than by reading it into the pino() constructor above.
 */
export function setLogLevel(level: string): void {
  rootLogger.level = level;
}

export function createLogger(name: string): pino.Logger {
  return rootLogger.child({ module: name });
}

export { rootLogger as logger };
