import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./schema.js";

/** TLS options for the PostgreSQL connection. Undefined means no TLS. */
export interface DatabaseSslOptions {
  rejectUnauthorized: boolean;
  /** PEM-encoded CA certificate content, for a server whose cert isn't publicly trusted. */
  ca?: string;
}

export function createDatabase(databaseUrl: string, ssl?: DatabaseSslOptions): Kysely<Database> {
  const pg = postgres(databaseUrl, {
    ssl: ssl
      ? { rejectUnauthorized: ssl.rejectUnauthorized, ...(ssl.ca ? { ca: ssl.ca } : {}) }
      : undefined,
  });
  return new Kysely<Database>({
    dialect: new PostgresJSDialect({ postgres: pg }),
  });
}
