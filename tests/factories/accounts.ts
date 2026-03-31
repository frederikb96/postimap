import { randomUUID } from "node:crypto";
import { faker } from "@faker-js/faker";
import { Factory } from "fishery";
import type { AccountTable } from "../../src/db/schema.js";
import { env } from "../setup/env.js";

type AccountBuild = {
  [K in keyof AccountTable]: AccountTable[K] extends import("kysely").Generated<infer U>
    ? U
    : AccountTable[K];
};

export const accountFactory = Factory.define<AccountBuild>(({ sequence }) => ({
  id: randomUUID(),
  name: `test-account-${sequence}`,
  imap_host: env.IMAP_HOST,
  imap_port: env.IMAP_PORT,
  imap_user: `user-${sequence}@${env.TEST_DOMAIN}`,
  imap_password: Buffer.from(`encrypted-password-${sequence}`),
  smtp_host: env.SMTP_HOST,
  smtp_port: env.SMTP_PORT,
  smtp_user: `user-${sequence}@${env.TEST_DOMAIN}`,
  smtp_password: Buffer.from(`encrypted-smtp-password-${sequence}`),
  is_active: true,
  state: "created",
  state_error: null,
  capabilities: null,
  created_at: new Date(),
  updated_at: new Date(),
}));

export const activeAccountFactory = accountFactory.params({
  state: "active",
  is_active: true,
});

export const disabledAccountFactory = accountFactory.params({
  state: "disabled",
  is_active: false,
});

export const errorAccountFactory = accountFactory.params({
  state: "error",
  state_error: "IMAP connection refused",
});
