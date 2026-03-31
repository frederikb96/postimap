import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./schema.js";

export function createDatabase(databaseUrl: string): Kysely<Database> {
  const pg = postgres(databaseUrl);
  return new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: pg }),
  });
}
