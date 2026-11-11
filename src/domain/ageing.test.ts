import { describe, expect, it } from "vitest";
import { AGE_BUCKETS, ageBucket, cashWarnings, emptyBuckets, msmeDeadline } from "./ageing";

describe("ageBucket", () => {
  const due = "2025-07-01";
  it("puts amounts in the column for how late they are", () => {
    expect(ageBucket(due, "2025-06-30")).toBe("not_due");
    expect(ageBucket(due, "2025-07-01")).toBe("not_due"); // due today is not yet late
    expect(ageBucket(due, "2025-07-02")).toBe("1_30");
    expect(ageBucket(due, "2025-07-31")).toBe("1_30");
    expect(ageBucket(due, "2025-08-01")).toBe("31_60");
    expect(ageBucket(due, "2025-08-30")).toBe("31_60");
    expect(ageBucket(due, "2025-08-31")).toBe("61_90");
    expect(ageBucket(due, "2025-09-29")).toBe("61_90");
    expect(ageBucket(due, "2025-09-30")).toBe("over_90");
  });

  it("has an empty set of columns to add into", () => {
    expect(Object.keys(emptyBuckets())).toEqual([...AGE_BUCKETS]);
    expect(Object.values(emptyBuckets()).every((v) => v === 0)).toBe(true);
  });
});

describe("msmeDeadline", () => {
  it("is 45 days after the bill date", () => {
    expect(msmeDeadline("2025-06-01")).toBe("2025-07-16");
    expect(msmeDeadline("2025-12-20")).toBe("2026-02-03");
  });
});

describe("cashWarnings", () => {
  it("is silent for anything but cash", () => {
    expect(cashWarnings({ direction: "paid", mode: "bank", sameDayCashPaise: 0, amountPaise: 99_999_999 })).toEqual([]);
  });

  it("warns once cash paid to one person in a day passes Rs 10,000", () => {
    expect(cashWarnings({ direction: "paid", mode: "cash", sameDayCashPaise: 0, amountPaise: 1_000_000 })).toEqual([]);
    expect(cashWarnings({ direction: "paid", mode: "cash", sameDayCashPaise: 0, amountPaise: 1_000_100 })).toHaveLength(1);
    // Two payments that together pass the limit
    const second = cashWarnings({ direction: "paid", mode: "cash", sameDayCashPaise: 600_000, amountPaise: 600_000 });
    expect(second[0]).toContain("section 40A(3)");
    expect(second[0]).toContain("₹12,000.00");
  });

  it("warns on cash received of Rs 2,00,000 or more in a day", () => {
    expect(cashWarnings({ direction: "received", mode: "cash", sameDayCashPaise: 0, amountPaise: 19_999_999 })).toEqual([]);
    expect(cashWarnings({ direction: "received", mode: "cash", sameDayCashPaise: 0, amountPaise: 20_000_000 })[0]).toContain("section 269ST");
  });
});
