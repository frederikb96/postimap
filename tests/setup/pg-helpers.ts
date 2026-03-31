import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FileMigrationProvider, Kysely, Migrator } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "../../src/db/schema.js";
import { env, getDatabaseUrl } from "./env.js";

export { getDatabaseUrl } from "./env.js";

/**
 * Create a postgres.js connection to the test database.
 */
export function connectPg(schema?: string): postgres.Sql {
  return postgres(getDatabaseUrl(schema));
}

/**
 * Create a Kysely instance pointed at the test database (optionally in a specific schema).
 */
export function createTestDb(connectionUrl?: string): Kysely<Database> {
  const url = connectionUrl ?? getDatabaseUrl();
  const pg = postgres(url);
  return new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: pg }),
  });
}

/**
 * Create an isolated PG schema with a random name, run all migrations into it.
 * Returns the schema name for later cleanup.
 */
export async function createTestSchema(sql: postgres.Sql): Promise<string> {
  const schema = `test_${randomUUID().slice(0, 8)}`;
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await sql.unsafe(`SET search_path TO "${schema}", public`);
  await runMigrations(schema);
  return schema;
}

/**
 * Drop a test schema and all its objects.
 */
export async function dropTestSchema(sql: postgres.Sql, schema: string): Promise<void> {
  await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
}

/**
 * TRUNCATE all application tables (for E2E test isolation within a shared schema).
 */
export async function truncateAll(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    "TRUNCATE sync_audit, sync_queue, sync_state, attachments, messages, folders, accounts CASCADE",
  );
}

/**
 * Run Kysely migrations into a specific schema.
 */
export async function runMigrations(schema?: string): Promise<void> {
  const url = getDatabaseUrl(schema);
  const pg = postgres(url);
  const db = new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: pg }),
  });

  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.resolve(import.meta.dirname, "../../src/db/migrations"),
    }),
    migrationTableSchema: schema,
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    if (result.status === "Error") {
      console.error(`Migration FAILED: ${result.migrationName}`);
    }
  }

  if (error) {
    await db.destroy();
    throw new Error(`Migration failed: ${error}`);
  }

  await db.destroy();
}
