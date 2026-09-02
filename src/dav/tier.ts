export type SyncTier = "sync" | "ctag" | "full";

export interface TierInput {
  supportedReports: string[];
  syncToken: string | null;
  ctag: string | null;
}

/**
 * Per-collection tier selection, not per-server: a Nextcloud account's calendars support
 * `sync-collection` while its `z-app-generated--contactsinteraction--recent` address book
 * answers `getctag` but refuses the REPORT with `415`. Deciding once per server would pick
 * a tier the least capable collection cannot actually use.
 */
export function selectTier(input: TierInput): SyncTier {
  if (input.supportedReports.includes("syncCollection") && input.syncToken) {
    return "sync";
  }
  if (input.ctag) {
    return "ctag";
  }
  return "full";
}

/**
 * Whether the home listing proves a collection has not changed since the stored state, so
 * the cycle can skip its REPORT or etag diff. The `full` tier has no such proof and never
 * skips; a missing value on either side is "unknown", never "unchanged".
 */
export function collectionUnchanged(
  tier: string | null,
  stored: { syncToken: string | null; ctag: string | null },
  server: { syncToken: string | null; ctag: string | null },
): boolean {
  if (tier === "sync") return stored.syncToken !== null && stored.syncToken === server.syncToken;
  if (tier === "ctag") return stored.ctag !== null && stored.ctag === server.ctag;
  return false;
}
