import type { Kysely } from "kysely";
import { sql } from "kysely";

/**
 * postimap_info: single-row contract-version handshake. Consumers assert
 * contract_version at startup against the value they were built for.
 *
 * postimap_app: NOLOGIN role carrying the write contract as database-enforced grants,
 * not convention. Consumer login roles are granted membership in it. Role creation is
 * wrapped in an exception handler rather than an existence check because CREATE ROLE has
 * no IF NOT EXISTS form and concurrent migrations (parallel test schemas, for instance)
 * would otherwise race on the plain existence check.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE postimap_info (
      singleton         BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
      contract_version  INTEGER NOT NULL,
      service_version   TEXT NOT NULL DEFAULT 'unknown',
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);

  await sql`INSERT INTO postimap_info (contract_version) VALUES (1)`.execute(db);

  await sql`
    DO $$
    BEGIN
      CREATE ROLE postimap_app NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END
    $$
  `.execute(db);

  await sql`
    DO $$
    DECLARE schema_name text := current_schema();
    BEGIN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO postimap_app', schema_name);
    END
    $$
  `.execute(db);

  await sql`
    GRANT SELECT ON
      accounts, folders, messages, attachments, sync_state, sync_audit,
      outbox, outbox_attachments, postimap_info
    TO postimap_app
  `.execute(db);

  await sql`GRANT INSERT ON accounts, outbox, outbox_attachments TO postimap_app`.execute(db);

  await sql`
    GRANT UPDATE (is_active, imap_password, smtp_host, smtp_port, smtp_user, smtp_password, name)
    ON accounts TO postimap_app
  `.execute(db);

  await sql`
    GRANT UPDATE (
      is_seen, is_flagged, is_answered, is_draft, is_deleted,
      keywords, folder_id, imap_uid, expunged_at
    )
    ON messages TO postimap_app
  `.execute(db);

  // sync_queue is intentionally never granted -- it is PostIMAP-internal.
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    REVOKE ALL ON
      accounts, folders, messages, attachments, sync_state, sync_audit,
      outbox, outbox_attachments, postimap_info
    FROM postimap_app
  `.execute(db);

  await sql`
    DO $$
    DECLARE schema_name text := current_schema();
    BEGIN
      EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM postimap_app', schema_name);
    END
    $$
  `.execute(db);

  // The role itself is cluster-wide (shared across schemas/deployments) and outlives any
  // single schema's grants, so down() does not drop it.

  await db.schema.dropTable("postimap_info").ifExists().execute();
}
