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
