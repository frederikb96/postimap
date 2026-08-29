import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // sync_queue -- internal outbound work queue, never granted to consumers
  await sql`
    CREATE TABLE sync_queue (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      message_id      UUID REFERENCES messages(id) ON DELETE SET NULL,
      folder_id       UUID REFERENCES folders(id) ON DELETE SET NULL,
      action          TEXT NOT NULL CHECK (action IN ('flag_add','flag_remove','move','delete')),
      payload         JSONB NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','completed','failed','dead')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 5,
      error           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at    TIMESTAMPTZ,
      next_retry_at   TIMESTAMPTZ DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_sq_pending ON sync_queue(account_id, status, next_retry_at)
      WHERE status IN ('pending', 'failed')
  `.execute(db);

  await sql`
    CREATE INDEX idx_sq_message_status ON sync_queue(message_id, status)
  `.execute(db);

  // sync_state
  await sql`
    CREATE TABLE sync_state (
      account_id      UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      last_full_sync  TIMESTAMPTZ,
      last_incr_sync  TIMESTAMPTZ,
      sync_tier       TEXT CHECK (sync_tier IN ('qresync','condstore','full')),
      folders_synced  INTEGER NOT NULL DEFAULT 0,
      folders_total   INTEGER NOT NULL DEFAULT 0,
      messages_synced BIGINT NOT NULL DEFAULT 0,
      error_count     INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  // sync_audit
  await sql`
    CREATE TABLE sync_audit (
      id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      direction       TEXT NOT NULL CHECK (direction IN ('inbound','outbound','conflict')),
      action          TEXT NOT NULL,
      message_id      UUID,
      folder_id       UUID,
      detail          JSONB,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_audit_account ON sync_audit(account_id, created_at DESC)
  `.execute(db);

  // outbox -- schema only; composition, SMTP send and Sent-copy APPEND are implemented
  // separately. App inserts structured fields, PostIMAP owns the status lifecycle.
  await sql`
    CREATE TABLE outbox (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind            TEXT NOT NULL CHECK (kind IN ('send','draft')),
      from_addr       TEXT,
      to_addrs        JSONB,
      cc_addrs        JSONB,
      bcc_addrs       JSONB,
      subject         TEXT,
      body_text       TEXT,
      body_html       TEXT,
      in_reply_to     TEXT,
      "references"    TEXT[],
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','processing','sent','failed')),
      error           TEXT,
      attempts        INTEGER NOT NULL DEFAULT 0,
      sent_message_id TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      sent_at         TIMESTAMPTZ
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_outbox_pending ON outbox(account_id, status) WHERE status = 'pending'
  `.execute(db);

  await sql`
    CREATE TABLE outbox_attachments (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      outbox_id       UUID NOT NULL REFERENCES outbox(id) ON DELETE CASCADE,
      filename        TEXT,
      content_type    TEXT,
      data            BYTEA
    )
  `.execute(db);

  await sql`
    CREATE INDEX idx_outbox_att_outbox ON outbox_attachments(outbox_id)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("outbox_attachments").ifExists().execute();
  await db.schema.dropTable("outbox").ifExists().execute();
  await db.schema.dropTable("sync_audit").ifExists().execute();
  await db.schema.dropTable("sync_state").ifExists().execute();
  await db.schema.dropTable("sync_queue").ifExists().execute();
}
