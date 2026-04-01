import { promises as fs } from "node:fs";
import * as path from "node:path";
import { FileMigrationProvider, Migrator } from "kysely";
import { createDatabase } from "./connection.js";

export async function migrateUp(databaseUrl: string): Promise<void> {
  const db = createDatabase(databaseUrl);
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

export async function migrateDown(databaseUrl: string): Promise<void> {
  const db = createDatabase(databaseUrl);
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
const isCli =
  process.argv[1]?.endsWith("migrate.js") ||
  process.argv[1]?.endsWith("migrate.ts");

if (isCli) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const command = process.argv[2] ?? "up";
  if (command === "down") {
    await migrateDown(databaseUrl);
  } else {
    await migrateUp(databaseUrl);
  }
}
