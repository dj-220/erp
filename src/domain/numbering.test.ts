import { describe, expect, it } from "vitest";
import { formatDocNumber, isValidGstDocumentNumber } from "./numbering";

describe("formatDocNumber", () => {
  it("builds PREFIX/FY/serial", () => {
    expect(formatDocNumber({ docType: "sales_invoice", fyShort: "25-26", serial: 1 })).toBe("INV/25-26/00001");
    expect(formatDocNumber({ docType: "purchase_order", fyShort: "25-26", serial: 123 })).toBe("PO/25-26/00123");
  });

  it("keeps GST documents within 16 characters", () => {
    const n = formatDocNumber({ docType: "sales_invoice", fyShort: "25-26", serial: 99999 });
    expect(n.length).toBeLessThanOrEqual(16);
    expect(isValidGstDocumentNumber(n)).toBe(true);
    // 7-digit serial -> 17 characters: must fail loudly rather than issue an illegal invoice number.
    expect(() => formatDocNumber({ docType: "sales_invoice", fyShort: "25-26", serial: 1_000_000 })).toThrow(/16 characters/);
  });

  it("does not apply the 16-character rule to internal documents", () => {
    expect(formatDocNumber({ docType: "purchase_order", fyShort: "25-26", serial: 1_000_000 })).toBe("PO/25-26/1000000");
  });

  it("rejects a bad serial", () => {
    expect(() => formatDocNumber({ docType: "sales_order", fyShort: "25-26", serial: 0 })).toThrow();
    expect(() => formatDocNumber({ docType: "sales_order", fyShort: "25-26", serial: 1.5 })).toThrow();
  });
});

describe("isValidGstDocumentNumber", () => {
  it("allows letters, digits, hyphen and slash up to 16 characters", () => {
    expect(isValidGstDocumentNumber("INV/25-26/00001")).toBe(true);
    expect(isValidGstDocumentNumber("INV 25-26 0001")).toBe(false);
    expect(isValidGstDocumentNumber("INV/25-26/000001X")).toBe(false); // 17 chars
    expect(isValidGstDocumentNumber("")).toBe(false);
  });
});
