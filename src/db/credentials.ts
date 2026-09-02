import type { Kysely } from "kysely";
import { decryptPassword, encryptPassword, isPlaintextCredential } from "../crypto.js";
import type { Database } from "./schema.js";
import { withSyncWriter } from "./writer.js";

/**
 * Re-encrypt an account's stored credentials to AES-256-GCM when an encryption key is
 * configured and they are still in plaintext format.
 *
 * A consumer always writes format 0x00 -- it holds no key and must not implement the
 * format. This is the only place a stored credential becomes format 0x01, so without it
 * a configured encryption key would validate at startup and then never encrypt anything
 * at rest.
 *
 * Returns the columns it rewrote; empty when there was nothing to do.
 */
export async function encryptStoredCredentials(
  db: Kysely<Database>,
  accountId: string,
  hexKey: string | undefined,
): Promise<string[]> {
  if (!hexKey) return [];

  const row = await db
    .selectFrom("accounts")
    .select(["imap_password", "smtp_password"])
    .where("id", "=", accountId)
    .executeTakeFirst();
  if (!row) return [];

  const updates: { imap_password?: Buffer; smtp_password?: Buffer } = {};
  if (isPlaintextCredential(row.imap_password)) {
    updates.imap_password = encryptPassword(decryptPassword(row.imap_password), hexKey);
  }
  if (row.smtp_password && isPlaintextCredential(row.smtp_password)) {
    updates.smtp_password = encryptPassword(decryptPassword(row.smtp_password), hexKey);
  }

  const columns = Object.keys(updates);
  if (columns.length === 0) return [];

  await withSyncWriter(db, (trx) =>
    trx.updateTable("accounts").set(updates).where("id", "=", accountId).execute(),
  );
  return columns;
}

/**
 * Same re-encryption as {@link encryptStoredCredentials}, for `dav_accounts.password` --
 * one credential column instead of two, and a different table, so it is its own function
 * rather than a generalised one: Kysely's table types are resolved at the call site, and a
 * single shared helper would need to give that up.
 */
export async function encryptStoredDavCredential(
  db: Kysely<Database>,
  accountId: string,
  hexKey: string | undefined,
): Promise<boolean> {
  if (!hexKey) return false;

  const row = await db
    .selectFrom("dav_accounts")
    .select("password")
    .where("id", "=", accountId)
    .executeTakeFirst();
  if (!row || !isPlaintextCredential(row.password)) return false;

  const encrypted = encryptPassword(decryptPassword(row.password), hexKey);
  await withSyncWriter(db, (trx) =>
    trx
      .updateTable("dav_accounts")
      .set({ password: encrypted })
      .where("id", "=", accountId)
      .execute(),
  );
  return true;
}
