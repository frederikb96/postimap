import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // sync_queue
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
    CREATE INDEX idx_sq_message ON sync_queue(message_id)
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
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("sync_audit").ifExists().execute();
  await db.schema.dropTable("sync_state").ifExists().execute();
  await db.schema.dropTable("sync_queue").ifExists().execute();
}
