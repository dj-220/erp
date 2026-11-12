/** Indian digit grouping: 1234567 -> "12,34,567". */
function group(digits: string): string {
  if (digits.length <= 3) return digits;
  return `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${digits.slice(-3)}`;
}

/** Paise to "₹12,34,567.89". */
export function inr(paise: number): string {
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${paise < 0 ? "-" : ""}₹${group(String(rupees))}.${rem}`;
}

/** A rupee amount held as decimal text ("1250.5000") with Indian grouping. Text in, text out: no floating point. */
export function rupees(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const extra = fraction.slice(2).replace(/0+$/, "");
  return `${negative ? "-" : ""}₹${group(whole || "0")}.${(fraction + "00").slice(0, 2)}${extra}`;
}

/** Whole rupees, no paise: "₹12,34,567". */
export function inrWhole(paise: number): string {
  const rupees = Math.round(Math.abs(paise) / 100);
  return `${paise < 0 ? "-" : ""}₹${group(String(rupees))}`;
}

/** Short form for tiles and axes: ₹4.2 Cr, ₹18.8 L, ₹12,450. */
export function inrShort(paise: number): string {
  const rupees = Math.abs(paise) / 100;
  const sign = paise < 0 ? "-" : "";
  const trim = (n: number) => n.toFixed(2).replace(/\.?0+$/, "");
  if (rupees >= 1e7) return `${sign}₹${trim(rupees / 1e7)} Cr`;
  if (rupees >= 1e5) return `${sign}₹${trim(rupees / 1e5)} L`;
  return `${sign}₹${group(String(Math.round(rupees)))}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-08-20" -> "20 Aug 2025" (no time-zone shifting: it is a calendar date). */
export function date(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? ""} ${y}`;
}

/** "2025-08" -> "Aug 25" */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1] ?? ""} ${(y ?? "").slice(2)}`;
}

export function dateTime(value: string | Date): string {
  return new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export const qty = (value: string | number): string => {
  const n = Number(value);
  return Number.isInteger(n) ? group(String(n)) : n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
};

/** Today's calendar date in India, as YYYY-MM-DD, whatever time zone the browser is in. */
export function today(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** "purchase_order.approved" -> "Purchase order approved" */
export function humanise(action: string): string {
  const text = action.replace(/[._]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A round axis maximum at or above `value`, with a step that gives about four ticks. */
export function niceScale(value: number): { max: number; step: number } {
  if (value <= 0) return { max: 1, step: 1 };
  const raw = value / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow);
  return { max: Math.ceil(value / step) * step, step };
}

/** "1250.0000" -> "1250", "0.4200" -> "0.42". Text only, so nothing is rounded. */
export function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

/** Paise to a plain rupee amount for typing into a box: 123456 -> "1234.56". Whole-number maths only. */
export function paiseToText(paise: number): string {
  const abs = Math.abs(paise);
  const rem = abs % 100;
  return `${paise < 0 ? "-" : ""}${Math.floor(abs / 100)}${rem ? `.${String(rem).padStart(2, "0")}` : ""}`;
}
