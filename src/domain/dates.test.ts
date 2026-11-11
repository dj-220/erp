import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "./dates";

describe("addDays", () => {
  it("moves across month, year and leap-day boundaries", () => {
    expect(addDays("2025-06-30", 1)).toBe("2025-07-01");
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
    expect(addDays("2025-06-15", 30)).toBe("2025-07-15");
    expect(addDays("2025-06-15", 0)).toBe("2025-06-15");
  });

  it("rejects bad dates and fractional days", () => {
    expect(() => addDays("2025-02-30", 1)).toThrow(/not a valid/);
    expect(() => addDays("15-06-2025", 1)).toThrow();
    expect(() => addDays("2025-06-15", 1.5)).toThrow();
  });
});

describe("daysBetween", () => {
  it("counts whole days, positive when the second date is later", () => {
    expect(daysBetween("2025-06-01", "2025-06-10")).toBe(9);
    expect(daysBetween("2025-06-10", "2025-06-01")).toBe(-9);
    expect(daysBetween("2025-06-01", "2025-06-01")).toBe(0);
    expect(daysBetween("2024-12-31", "2025-01-01")).toBe(1);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2); // leap year
  });
});
