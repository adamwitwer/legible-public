/**
 * `written_on` is a calendar date — the day the note was written, or the date on
 * the scanned page. It is NOT a timestamp, so it must be derived in the user's
 * local timezone. Deriving it from toISOString() dates anything written after
 * ~7pm EST to tomorrow.
 *
 * created_at / updated_at stay UTC ISO strings: those are instants, and sync
 * ordering and last-write-wins both depend on them being absolute.
 */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local calendar date for an absolute timestamp. */
export const toLocalDate = (iso: string): string => localDate(new Date(iso));

/**
 * Coerce anything date-shaped to YYYY-MM-DD. A Postgres `date` that slipped
 * through as a timestamp is UTC midnight of that calendar day, so truncating at
 * the T is correct — converting to local time would shift it back a day.
 */
export const asCalendarDate = (v: string): string => (v.length > 10 ? v.slice(0, 10) : v);

/** The date to show for a note: what's on the page, else the day it was created. */
export const displayDate = (n: { written_on: string | null; created_at: string }): string =>
  n.written_on ? asCalendarDate(n.written_on) : toLocalDate(n.created_at);
