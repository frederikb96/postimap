const NUL = String.fromCharCode(0);

/**
 * PostgreSQL cannot represent a NUL byte (0x00) in a `text` value under any encoding --
 * this isn't a driver flag or an encoding setting, so anything decoded from message content
 * has to be stripped of it before it is ever bound to a query parameter. The byte is removed
 * rather than replaced: a substitute character would show up in a subject line the sender
 * never wrote, while everything else in the string is left untouched.
 */
export function stripNulBytes(value: string): string {
  return value.includes(NUL) ? value.split(NUL).join("") : value;
}

type Sanitizable =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | Sanitizable[]
  | { [key: string]: Sanitizable };

/**
 * Recursively strips NUL bytes from every string reachable from `value` -- through arrays
 * (address lists, `references`) and plain objects (`raw_headers`) alike -- so a single call
 * at the boundary where parsed message content becomes database parameters covers every
 * text-shaped column, not just the one a particular message happened to trip.
 */
export function sanitizeNulBytesDeep<T extends Sanitizable>(value: T): T {
  if (typeof value === "string") {
    return stripNulBytes(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNulBytesDeep(item)) as T;
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const result: Record<string, Sanitizable> = {};
    for (const [key, val] of Object.entries(value as Record<string, Sanitizable>)) {
      result[key] = sanitizeNulBytesDeep(val);
    }
    return result as T;
  }
  return value;
}
