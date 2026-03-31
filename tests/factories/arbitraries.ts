import { randomUUID } from "node:crypto";
import fc from "fast-check";

const IMAP_FLAGS = ["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "\\Deleted"];

/**
 * Arbitrary for IMAP UID sequence sets (e.g., "1:5,7,10:*").
 */
export function arbUidSet(): fc.Arbitrary<string> {
  const singleUid = fc.integer({ min: 1, max: 100_000 }).map(String);
  const uidRange = fc
    .tuple(fc.integer({ min: 1, max: 50_000 }), fc.integer({ min: 1, max: 50_000 }))
    .map(([a, b]) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return `${lo}:${hi}`;
    });
  const uidStar = fc.constant("*");
  const rangeWithStar = fc.integer({ min: 1, max: 100_000 }).map((n) => `${n}:*`);

  const segment = fc.oneof(singleUid, uidRange, uidStar, rangeWithStar);
  return fc.array(segment, { minLength: 1, maxLength: 5 }).map((parts) => parts.join(","));
}

/**
 * Arbitrary for random IMAP flag combinations.
 */
export function arbFlags(): fc.Arbitrary<string[]> {
  return fc.subarray(IMAP_FLAGS, { minLength: 0, maxLength: IMAP_FLAGS.length });
}

/**
 * Arbitrary for message-like objects with randomized fields.
 */
export function arbMessage(): fc.Arbitrary<{
  id: string;
  imap_uid: number;
  subject: string;
  from_addr: string;
  is_seen: boolean;
  is_flagged: boolean;
  is_answered: boolean;
  is_draft: boolean;
  is_deleted: boolean;
}> {
  return fc.record({
    id: fc.constant(null).map(() => randomUUID()),
    imap_uid: fc.integer({ min: 1, max: 1_000_000 }),
    subject: fc.string({ minLength: 1, maxLength: 200 }),
    from_addr: fc.emailAddress(),
    is_seen: fc.boolean(),
    is_flagged: fc.boolean(),
    is_answered: fc.boolean(),
    is_draft: fc.boolean(),
    is_deleted: fc.boolean(),
  });
}
