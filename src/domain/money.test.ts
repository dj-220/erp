import { describe, expect, it } from "vitest";
import {
  assertPaise,
  formatINR,
  fromPaise,
  lineAmount,
  percentOf,
  roundToRupee,
  sumPaise,
  toPaise,
} from "./money";

describe("toPaise", () => {
  it("rounds half up", () => {
    expect(toPaise("1234.565")).toBe(123457);
    expect(toPaise("0.005")).toBe(1);
    expect(toPaise("0.004")).toBe(0);
  });

  it("avoids the floating-point trap (1.005 * 100 is 100.49999... in JS)", () => {
    expect(1.005 * 100).not.toBe(100.5);
    expect(toPaise(1.005)).toBe(101);
  });

  it("rounds negatives away from zero and never returns -0", () => {
    expect(toPaise("-0.005")).toBe(-1);
    expect(Object.is(toPaise("-0.001"), 0)).toBe(true);
  });

  it("rejects garbage", () => {
    expect(() => toPaise("abc")).toThrow();
    expect(() => toPaise(Number.NaN)).toThrow();
  });
});

describe("fromPaise / formatINR", () => {
  it("prints two decimals", () => {
    expect(fromPaise(123450)).toBe("1234.50");
    expect(fromPaise(-5)).toBe("-0.05");
    expect(fromPaise(0)).toBe("0.00");
  });

  it("uses lakh/crore grouping", () => {
    expect(formatINR(123456789)).toBe("₹12,34,567.89");
    expect(formatINR(100000000)).toBe("₹10,00,000.00");
    expect(formatINR(99999)).toBe("₹999.99");
    expect(formatINR(123400)).toBe("₹1,234.00");
    expect(formatINR(-5)).toBe("-₹0.05");
    expect(formatINR(0, { symbol: false })).toBe("0.00");
    expect(formatINR(1_00_00_00_000_00)).toBe("₹1,00,00,00,000.00");
  });
});

describe("arithmetic", () => {
  it("multiplies quantity by rate exactly", () => {
    // 7,600.5 m at Rs 241/m = Rs 18,31,720.50
    expect(lineAmount("7600.5", "241")).toBe(183172050);
    expect(lineAmount("0.333", "3")).toBe(100); // 0.999 -> 1.00
  });

  it("takes a percentage, rounding half up", () => {
    expect(percentOf(1000, "2.5")).toBe(25);
    expect(percentOf(50, "2.5")).toBe(1); // 1.25 paise
    expect(percentOf(100, "50")).toBe(50);
    expect(percentOf(-50, "5")).toBe(-3); // -2.5 -> -3
  });

  it("sums and guards integers", () => {
    expect(sumPaise([1, 2, 3])).toBe(6);
    expect(() => assertPaise(1.5)).toThrow(RangeError);
    expect(() => assertPaise(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  it("rounds an invoice total to the nearest rupee and reports the round-off", () => {
    expect(roundToRupee(123450)).toEqual({ rounded: 123500, roundOff: 50 });
    expect(roundToRupee(123449)).toEqual({ rounded: 123400, roundOff: -49 });
    expect(roundToRupee(123400)).toEqual({ rounded: 123400, roundOff: 0 });
    expect(roundToRupee(-123450)).toEqual({ rounded: -123500, roundOff: -50 });
  });
});
