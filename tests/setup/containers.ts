import type { StartedTestContainer } from "testcontainers";

export interface ContainerConfig {
  pgHost: string;
  pgPort: number;
  imapHost: string;
  imapPort: number;
  lmtpHost: string;
  lmtpPort: number;
  mailpitHost: string;
  mailpitSmtpPort: number;
  mailpitHttpPort: number;
}

interface ManagedContainers {
  pg?: StartedTestContainer;
  mail?: StartedTestContainer;
  toxiproxy?: StartedTestContainer;
  mailpit?: StartedTestContainer;
}

let managed: ManagedContainers = {};

export function setManagedContainers(containers: ManagedContainers): void {
  managed = containers;
}

export function getManagedContainers(): ManagedContainers {
  return managed;
}
