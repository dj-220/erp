import { DomainError } from "./errors";

export interface FinancialYear {
  startYear: number;
  /** "2025-26" */
  label: string;
  /** "25-26", used in document numbers. */
  short: string;
  /** First day, "2025-04-01". */
  start: string;
  /** Last day, "2026-03-31". */
  end: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Indian financial year (1 April to 31 March) for a calendar date given as "YYYY-MM-DD". */
export function financialYearOf(isoDate: string): FinancialYear {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [NaN, NaN, NaN];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    !m ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new DomainError("INVALID_DATE", `"${isoDate}" is not a valid YYYY-MM-DD date`);
  }
  const startYear = month >= 4 ? year : year - 1;
  const endYY = pad2((startYear + 1) % 100);
  return {
    startYear,
    label: `${startYear}-${endYY}`,
    short: `${pad2(startYear % 100)}-${endYY}`,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

/** Today's date in India (IST) as "YYYY-MM-DD", regardless of the server's time zone. */
export function todayIST(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}
