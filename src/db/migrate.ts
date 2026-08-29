import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FileMigrationProvider, Migrator } from "kysely/migration";
import { getDatabaseSsl, getDatabaseUrl, loadConfig } from "../config.js";
import { createDatabase, type DatabaseSslOptions } from "./connection.js";

export async function migrateUp(databaseUrl: string, ssl?: DatabaseSslOptions): Promise<void> {
  const db = createDatabase(databaseUrl, ssl);
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, "migrations"),
    }),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const result of results ?? []) {
    const prefix = result.status === "Success" ? "UP" : "FAILED";
    console.log(`${prefix}: ${result.migrationName}`);
  }

  if (error) {
    console.error("Migration failed:", error);
    await db.destroy();
    process.exit(1);
  }

  await db.destroy();
}

export async function migrateDown(databaseUrl: string, ssl?: DatabaseSslOptions): Promise<void> {
  const db = createDatabase(databaseUrl, ssl);
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: path.join(import.meta.dirname, "migrations"),
    }),
  });

  const { error, results } = await migrator.migrateDown();

  for (const result of results ?? []) {
    const prefix = result.status === "Success" ? "DOWN" : "FAILED";
    console.log(`${prefix}: ${result.migrationName}`);
  }

  if (error) {
    console.error("Migration rollback failed:", error);
    await db.destroy();
    process.exit(1);
  }

  await db.destroy();
}

// CLI entrypoint — only runs when executed directly, not when imported
const isCli = process.argv[1]?.endsWith("migrate.js") || process.argv[1]?.endsWith("migrate.ts");

if (isCli) {
  // Same config chain as the running service (config.yaml -> config-custom override ->
  // ${VAR} placeholders -> POSTIMAP_* env overrides), composed into a connection string
  // via getDatabaseUrl -- not a standalone DATABASE_URL, so the CLI can never drift from
  // how the app itself connects. DATABASE_URL remains a supported override since it's a
  // conventional escape hatch, but it is no longer required. TLS is only resolved from
  // config -- an explicit DATABASE_URL is taken as a full override that speaks for itself
  // (e.g. via its own `?sslmode=` if needed), the same way it already did before TLS existed.
  let databaseUrl: string;
  let ssl: DatabaseSslOptions | undefined;
  if (process.env.DATABASE_URL) {
    databaseUrl = process.env.DATABASE_URL;
  } else {
    const config = loadConfig();
    databaseUrl = getDatabaseUrl(config);
    ssl = getDatabaseSsl(config);
  }

  const command = process.argv[2] ?? "up";
  if (command === "down") {
    await migrateDown(databaseUrl, ssl);
  } else {
    await migrateUp(databaseUrl, ssl);
  }
}
