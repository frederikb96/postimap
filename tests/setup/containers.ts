import net from "node:net";
import type { StartedTestContainer } from "testcontainers";
import { env } from "./env.js";

export type ContainerMode = "compose" | "testcontainers";

export interface ContainerConfig {
  mode: ContainerMode;
  pgHost: string;
  pgPort: number;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  stalwartAdminUrl: string;
}

interface ManagedContainers {
  pg?: StartedTestContainer;
  stalwart?: StartedTestContainer;
}

let managed: ManagedContainers = {};

export function setManagedContainers(containers: ManagedContainers): void {
  managed = containers;
}

export function getManagedContainers(): ManagedContainers {
  return managed;
}

/**
 * TCP connect check with short timeout. Returns true if the port is reachable.
 */
export function checkConnection(host: string, port: number, timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket
      .connect(port, host, () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      })
      .on("error", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
  });
}

/**
 * Build container config for compose mode (uses env.ts defaults).
 */
export function composeConfig(): ContainerConfig {
  return {
    mode: "compose",
    pgHost: env.PG_HOST,
    pgPort: env.PG_PORT,
    imapHost: env.IMAP_HOST,
    imapPort: env.IMAP_PORT,
    smtpHost: env.SMTP_HOST,
    smtpPort: env.SMTP_PORT,
    stalwartAdminUrl: env.STALWART_ADMIN_URL,
  };
}
