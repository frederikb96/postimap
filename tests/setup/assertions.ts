/**
 * Compare two flag sets for equality (order-independent).
 */
export function expectFlagsEqual(actual: Set<string>, expected: string[]): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((f) => !actual.has(f));
  const extra = [...actual].filter((f) => !expectedSet.has(f));

  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`extra: ${extra.join(", ")}`);
    throw new Error(
      `Flag mismatch: ${parts.join("; ")}. Actual: [${[...actual].join(", ")}], Expected: [${expected.join(", ")}]`,
    );
  }
}

export interface PgMessageRow {
  subject: string | null;
  from_addr: string | null;
  is_seen: boolean;
  is_flagged: boolean;
  is_answered: boolean;
  is_draft: boolean;
  is_deleted: boolean;
}

export interface ImapMessageLike {
  envelope: {
    subject?: string;
    from?: Array<{ address?: string }>;
  };
  flags: Set<string>;
}

/**
 * Assert that a PG message row matches an IMAP message on key fields.
 */
export function expectMessageMatch(pgRow: PgMessageRow, imapMessage: ImapMessageLike): void {
  const errors: string[] = [];

  if (pgRow.subject !== (imapMessage.envelope.subject ?? null)) {
    errors.push(`subject: PG="${pgRow.subject}" IMAP="${imapMessage.envelope.subject}"`);
  }

  const imapFrom = imapMessage.envelope.from?.[0]?.address ?? null;
  if (pgRow.from_addr !== imapFrom) {
    errors.push(`from_addr: PG="${pgRow.from_addr}" IMAP="${imapFrom}"`);
  }

  // Flag checks
  const flagMap: [keyof PgMessageRow, string][] = [
    ["is_seen", "\\Seen"],
    ["is_flagged", "\\Flagged"],
    ["is_answered", "\\Answered"],
    ["is_draft", "\\Draft"],
    ["is_deleted", "\\Deleted"],
  ];

  for (const [pgField, imapFlag] of flagMap) {
    const pgVal = pgRow[pgField] as boolean;
    const imapVal = imapMessage.flags.has(imapFlag);
    if (pgVal !== imapVal) {
      errors.push(`${pgField}: PG=${pgVal} IMAP(${imapFlag})=${imapVal}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Message mismatch:\n  ${errors.join("\n  ")}`);
  }
}
