import { DomainError } from "./errors";

const DAY_MS = 86_400_000;

function parse(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(year, month - 1, day);
    const d = new Date(ms);
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) return ms;
  }
  throw new DomainError("INVALID_DATE", `"${iso}" is not a valid YYYY-MM-DD date`);
}

/** Calendar date plus a number of days (negative allowed), as "YYYY-MM-DD". */
export function addDays(iso: string, days: number): string {
  if (!Number.isInteger(days)) throw new RangeError("days must be a whole number");
  return new Date(parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parse(toIso) - parse(fromIso)) / DAY_MS);
}
