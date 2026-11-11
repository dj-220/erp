import { isValidStateCode } from "./states";

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Structure: 2-digit state, 10-char PAN, entity number (1-9/A-Z), literal Z, check char. */
const STRUCTURE = /^(\d{2})([A-Z]{5}\d{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;

/** Compute the 15th character from the first 14 (base-36 weighted checksum used by GSTN). */
export function gstinChecksumChar(first14: string): string {
  if (first14.length !== 14) throw new RangeError("GSTIN checksum needs exactly 14 characters");
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = CHARSET.indexOf(first14[i] as string);
    if (value < 0) throw new RangeError(`Invalid GSTIN character "${first14[i]}"`);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36] as string;
}

export type GstinParse =
  | { valid: true; gstin: string; stateCode: string; pan: string; entityNumber: string }
  | { valid: false; reason: "LENGTH" | "FORMAT" | "STATE" | "CHECKSUM" };

/** Validate a GSTIN offline (format, state code, checksum). Does not prove it is active. */
export function parseGstin(input: string): GstinParse {
  const gstin = input.trim().toUpperCase();
  if (gstin.length !== 15) return { valid: false, reason: "LENGTH" };
  const match = STRUCTURE.exec(gstin);
  if (!match) return { valid: false, reason: "FORMAT" };
  const [, stateCode, pan, entityNumber, check] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (!isValidStateCode(stateCode)) return { valid: false, reason: "STATE" };
  if (gstinChecksumChar(gstin.slice(0, 14)) !== check) return { valid: false, reason: "CHECKSUM" };
  return { valid: true, gstin, stateCode, pan, entityNumber };
}

export function isValidGstin(input: string): boolean {
  return parseGstin(input).valid;
}
