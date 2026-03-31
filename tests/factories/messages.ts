import { randomUUID } from "node:crypto";
import { faker } from "@faker-js/faker";
import { Factory } from "fishery";
import type postgres from "postgres";
import type { MessageTable } from "../../src/db/schema.js";
import { env } from "../setup/env.js";
import { accountFactory } from "./accounts.js";
import { inboxFactory } from "./folders.js";

type MessageBuild = {
  [K in keyof MessageTable]: MessageTable[K] extends import("kysely").Generated<infer U>
    ? U
    : MessageTable[K] extends import("kysely").ColumnType<infer S, infer _I, infer _U>
      ? S
      : MessageTable[K];
};

export const messageFactory = Factory.define<MessageBuild>(({ sequence, associations }) => ({
  id: randomUUID(),
  account_id: (associations as { account_id?: string }).account_id ?? randomUUID(),
  folder_id: (associations as { folder_id?: string }).folder_id ?? randomUUID(),
  imap_uid: String(sequence),
  message_id: `<msg-${sequence}@${env.TEST_DOMAIN}>`,
  subject: faker.lorem.sentence(),
  from_addr: faker.internet.email(),
  to_addrs: [faker.internet.email()],
  cc_addrs: null,
  bcc_addrs: null,
  reply_to: null,
  in_reply_to: null,
  references: null,
  body_text: faker.lorem.paragraphs(2),
  body_html: `<p>${faker.lorem.paragraph()}</p>`,
  raw_headers: null,
  raw_source: null,
  received_at: faker.date.recent({ days: 30 }),
  size_bytes: faker.number.int({ min: 500, max: 50_000 }),
  modseq: String(sequence),
  is_seen: false,
  is_flagged: false,
  is_answered: false,
  is_draft: false,
  is_deleted: false,
  keywords: [],
  sync_version: "0",
  deleted_at: null,
  search_vector: undefined,
  created_at: new Date(),
}));

/**
 * Composable helper: create an account + inbox folder + N messages in PG.
 * Returns the inserted objects for assertions.
 */
export async function seedAccountWithMessages(
  sql: postgres.Sql,
  opts?: { count?: number },
): Promise<{
  account: ReturnType<typeof accountFactory.build>;
  folder: ReturnType<typeof inboxFactory.build>;
  messages: ReturnType<typeof messageFactory.build>[];
}> {
  const account = accountFactory.build();
  const folder = inboxFactory.build({ account_id: account.id });
  const count = opts?.count ?? 10;
  const messages = messageFactory.buildList(count, {
    account_id: account.id,
    folder_id: folder.id,
  });

  // Insert account (postgres.js auto-handles Buffer as bytea)
  await sql`
    INSERT INTO accounts (id, name, imap_host, imap_port, imap_user, imap_password,
      smtp_host, smtp_port, smtp_user, smtp_password, is_active, state, state_error, capabilities)
    VALUES (
      ${account.id}, ${account.name}, ${account.imap_host}, ${account.imap_port},
      ${account.imap_user}, ${account.imap_password},
      ${account.smtp_host}, ${account.smtp_port}, ${account.smtp_user},
      ${account.smtp_password}, ${account.is_active}, ${account.state},
      ${account.state_error}, ${account.capabilities as null}
    )
  `;

  // Insert folder
  await sql`
    INSERT INTO folders (id, account_id, imap_name, display_name, separator, special_use,
      uidvalidity, uidnext, highestmodseq)
    VALUES (
      ${folder.id}, ${folder.account_id}, ${folder.imap_name}, ${folder.display_name},
      ${folder.separator}, ${folder.special_use}, ${folder.uidvalidity},
      ${folder.uidnext}, ${folder.highestmodseq}
    )
  `;

  // Insert messages
  for (const msg of messages) {
    await sql`
      INSERT INTO messages (id, account_id, folder_id, imap_uid, message_id, subject,
        from_addr, to_addrs, body_text, body_html, received_at, size_bytes, modseq,
        is_seen, is_flagged, is_answered, is_draft, is_deleted, keywords, sync_version)
      VALUES (
        ${msg.id}, ${msg.account_id}, ${msg.folder_id}, ${msg.imap_uid}, ${msg.message_id},
        ${msg.subject}, ${msg.from_addr}, ${sql.json(msg.to_addrs as string[])},
        ${msg.body_text}, ${msg.body_html}, ${msg.received_at}, ${msg.size_bytes},
        ${msg.modseq}, ${msg.is_seen}, ${msg.is_flagged}, ${msg.is_answered},
        ${msg.is_draft}, ${msg.is_deleted}, ${msg.keywords}, ${msg.sync_version}
      )
    `;
  }

  return { account, folder, messages };
}
