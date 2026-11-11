import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { assertInvoiceDateOrder, classifyOrder, invoiceableQty, lineTaxableValue } from "./sales";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : `non-domain: ${String(e)}`;
  }
  return undefined;
}

describe("lineTaxableValue", () => {
  it("multiplies quantity by price", () => {
    expect(lineTaxableValue({ qty: 10, unitPrice: 100 })).toBe(100000); // Rs 1,000
    expect(lineTaxableValue({ qty: "2.5", unitPrice: "241" })).toBe(60250);
  });

  it("applies a percentage discount before rounding", () => {
    expect(lineTaxableValue({ qty: 10, unitPrice: 100, discountPct: 10 })).toBe(90000);
    // 3 x 33.33 = 99.99; less 12.5% = 87.49125 -> 8749 paise
    expect(lineTaxableValue({ qty: 3, unitPrice: "33.33", discountPct: "12.5" })).toBe(8749);
    expect(lineTaxableValue({ qty: 3, unitPrice: 10, discountPct: 100 })).toBe(0);
  });

  it("rejects an impossible discount", () => {
    expect(codeOf(() => lineTaxableValue({ qty: 1, unitPrice: 1, discountPct: 101 }))).toBe("INVALID_DISCOUNT");
    expect(codeOf(() => lineTaxableValue({ qty: 1, unitPrice: 1, discountPct: -1 }))).toBe("INVALID_DISCOUNT");
  });
});

describe("invoiceableQty", () => {
  it("lets goods be invoiced only once delivered", () => {
    expect(invoiceableQty({ ordered: 10, delivered: 6, invoiced: 4, isGoods: true }).toString()).toBe("2");
    expect(invoiceableQty({ ordered: 10, delivered: 0, invoiced: 0, isGoods: true }).toString()).toBe("0");
  });

  it("lets services be invoiced up to the ordered quantity", () => {
    expect(invoiceableQty({ ordered: 10, delivered: 0, invoiced: 4, isGoods: false }).toString()).toBe("6");
  });

  it("never goes negative", () => {
    expect(invoiceableQty({ ordered: 10, delivered: 6, invoiced: 9, isGoods: true }).toString()).toBe("0");
  });
});

describe("assertInvoiceDateOrder", () => {
  it("accepts the same or a later date, or the first invoice", () => {
    expect(codeOf(() => assertInvoiceDateOrder("2025-06-10", null))).toBeUndefined();
    expect(codeOf(() => assertInvoiceDateOrder("2025-06-10", "2025-06-10"))).toBeUndefined();
    expect(codeOf(() => assertInvoiceDateOrder("2025-06-11", "2025-06-10"))).toBeUndefined();
  });

  it("rejects a date earlier than one already issued", () => {
    expect(codeOf(() => assertInvoiceDateOrder("2025-06-09", "2025-06-10"))).toBe("INVOICE_DATE_ORDER");
  });
});

describe("classifyOrder", () => {
  const base = { promisedDate: "2025-07-01", hasRemainingGoods: true, shortageNames: [] as string[] };

  it("is fulfilled when nothing remains", () => {
    expect(classifyOrder({ ...base, today: "2025-08-01", hasRemainingGoods: false })).toEqual({
      status: "fulfilled",
      reason: "Delivered in full",
    });
  });

  it("is late once the promised date has passed", () => {
    expect(classifyOrder({ ...base, today: "2025-07-04" })).toEqual({ status: "late", reason: "3 days overdue" });
    expect(classifyOrder({ ...base, today: "2025-07-02" })).toEqual({ status: "late", reason: "1 day overdue" });
    expect(classifyOrder({ ...base, today: "2025-07-04", shortageNames: ["FAB", "BTN"] })).toEqual({
      status: "late",
      reason: "3 days overdue, short of FAB, BTN",
    });
  });

  it("is at risk when not yet late but stock cannot cover what remains", () => {
    expect(classifyOrder({ ...base, today: "2025-06-20", shortageNames: ["FAB"] })).toEqual({
      status: "at_risk",
      reason: "Short of FAB",
    });
  });

  it("is on time when stock covers it, including on the promised day itself", () => {
    expect(classifyOrder({ ...base, today: "2025-06-20" }).status).toBe("on_time");
    expect(classifyOrder({ ...base, today: "2025-07-01" }).status).toBe("on_time");
  });
});
