/**
 * RFC 9051 sequence-set parsing and formatting.
 * Handles ranges like "1:5,7,10:15" and the special "*" value.
 */

/**
 * Parse an RFC 9051 sequence-set string into an array of UIDs.
 * Supports ranges (1:5), individual values (7), and mixed (1:3,5,8:10).
 * The "*" token is ignored since its meaning is context-dependent.
 */
export function parseUidSet(uidSet: string): number[] {
  if (!uidSet || uidSet.trim() === "") return [];

  const result: number[] = [];
  const parts = uidSet.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    if (trimmed.includes(":")) {
      const [startStr, endStr] = trimmed.split(":");
      if (startStr === "*" || endStr === "*") continue;
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let i = lo; i <= hi; i++) {
        result.push(i);
      }
    } else {
      if (trimmed === "*") continue;
      const uid = Number.parseInt(trimmed, 10);
      if (!Number.isNaN(uid)) {
        result.push(uid);
      }
    }
  }

  return result;
}

/**
 * Format an array of UIDs into a compact RFC 9051 sequence-set string.
 * Consecutive UIDs are collapsed into ranges: [1,2,3,5,7,8,9] -> "1:3,5,7:9"
 */
export function formatUidSet(uids: number[]): string {
  if (uids.length === 0) return "";

  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}:${rangeEnd}`);
      rangeStart = sorted[i];
      rangeEnd = sorted[i];
    }
  }

  ranges.push(rangeStart === rangeEnd ? `${rangeStart}` : `${rangeStart}:${rangeEnd}`);
  return ranges.join(",");
}
