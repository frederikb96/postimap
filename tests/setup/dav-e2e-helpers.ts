import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type postgres from "postgres";
import { encryptPassword } from "../../src/crypto.js";
import type { Database } from "../../src/db/schema.js";
import { env, getDatabaseUrl, getRadicaleUrl } from "./env.js";
import { connectPg, createTestDb, createTestSchema, dropTestSchema } from "./pg-helpers.js";

export interface DavE2EContext {
  pgSql: postgres.Sql;
  schema: string;
  db: Kysely<Database>;
  databaseUrl: string;
  davAccountId: string;
  davUsername: string;
}

/**
 * A fully isolated DAV E2E context: PG schema with migrations, a `dav_accounts` row
 * pointed at the test Radicale server. Radicale's `auth.type = none` means the username
 * itself is the isolation boundary -- a fresh one per context gets its own principal and
 * an empty calendar/address-book home, the same role a unique mailbox plays on the IMAP
 * side.
 */
export async function setupDavE2EContext(prefix = "dav-e2e"): Promise<DavE2EContext> {
  const davUsername = `${prefix}-${randomUUID().slice(0, 8)}`;
  const davAccountId = randomUUID();

  const bootstrapSql = connectPg();
  const schema = await createTestSchema(bootstrapSql);
  await bootstrapSql.end();
  const databaseUrl = getDatabaseUrl(schema);
  const pgSql = connectPg(schema);
  const db = createTestDb(databaseUrl);

  await pgSql`
    INSERT INTO dav_accounts (id, name, url, username, password, is_active, state)
    VALUES (${davAccountId}, ${davUsername}, ${getRadicaleUrl()}, ${davUsername},
      ${encryptPassword(env.DAV_PASSWORD)}, true, 'active')
  `;

  return { pgSql, schema, db, databaseUrl, davAccountId, davUsername };
}

export async function teardownDavE2EContext(ctx: DavE2EContext): Promise<void> {
  if (ctx.db) await ctx.db.destroy();
  if (ctx.pgSql && ctx.schema) {
    await dropTestSchema(ctx.pgSql, ctx.schema);
    await ctx.pgSql.end();
  }
}
