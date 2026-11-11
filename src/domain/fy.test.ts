import { describe, expect, it } from "vitest";
import { financialYearOf, todayIST } from "./fy";

describe("financialYearOf", () => {
  it("runs 1 April to 31 March", () => {
    expect(financialYearOf("2026-03-31")).toMatchObject({ label: "2025-26", short: "25-26", start: "2025-04-01", end: "2026-03-31" });
    expect(financialYearOf("2026-04-01")).toMatchObject({ label: "2026-27", short: "26-27", start: "2026-04-01", end: "2027-03-31" });
    expect(financialYearOf("2025-12-31").label).toBe("2025-26");
    expect(financialYearOf("2026-01-01").label).toBe("2025-26");
  });

  it("handles leap days and the century boundary", () => {
    expect(financialYearOf("2028-02-29").label).toBe("2027-28");
    expect(financialYearOf("2099-06-01").label).toBe("2099-00");
  });

  it("rejects impossible dates", () => {
    expect(() => financialYearOf("2026-02-30")).toThrow(/not a valid/);
    expect(() => financialYearOf("26-04-01")).toThrow();
    expect(() => financialYearOf("2026-13-01")).toThrow();
  });
});

describe("todayIST", () => {
  it("uses the Indian calendar date, not UTC", () => {
    // 19:00 UTC on 31 Mar is already 00:30 on 1 Apr in India.
    expect(todayIST(new Date("2026-03-31T19:00:00Z"))).toBe("2026-04-01");
    expect(todayIST(new Date("2026-03-31T18:00:00Z"))).toBe("2026-03-31");
  });
});
