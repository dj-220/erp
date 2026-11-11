import { DomainError } from "./errors";

export interface IndianState {
  /** Two-digit GST state code, as used in the first two characters of a GSTIN. */
  code: string;
  name: string;
  /**
   * Union territory without a legislature: intra-state supply attracts UTGST
   * instead of SGST.
   */
  utgst?: true;
  /** No longer issued; kept so old documents and GSTINs still validate. */
  legacy?: true;
}

export const STATES: readonly IndianState[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh", utgst: true },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "25", name: "Daman and Diu (before merger)", utgst: true, legacy: true },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu", utgst: true },
  { code: "27", name: "Maharashtra" },
  { code: "28", name: "Andhra Pradesh (before 2014 division)", legacy: true },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep", utgst: true },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands", utgst: true },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh", utgst: true },
  { code: "97", name: "Other Territory", utgst: true },
  { code: "99", name: "Centre Jurisdiction" },
];

const BY_CODE = new Map(STATES.map((s) => [s.code, s]));

export function findState(code: string): IndianState | undefined {
  return BY_CODE.get(code);
}

export function requireState(code: string): IndianState {
  const state = BY_CODE.get(code);
  if (!state) throw new DomainError("UNKNOWN_STATE", `Unknown GST state code "${code}"`);
  return state;
}

export function isValidStateCode(code: string): boolean {
  return BY_CODE.has(code);
}
