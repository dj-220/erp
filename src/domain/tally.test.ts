import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  type BillDoc,
  type PaymentDoc,
  type SalesDoc,
  type Voucher,
  TALLY_LEDGERS,
  assertBalanced,
  paymentVoucher,
  purchaseVoucher,
  renderMastersXml,
  renderVouchersXml,
  salesVoucher,
  standardLedgers,
  xml,
} from "./tally";

const sales = (over: Partial<SalesDoc> = {}): SalesDoc => ({
  kind: "tax_invoice",
  number: "INV/25-26/00001",
  date: "2025-06-05",
  partyLedger: "Harbor & Pine",
  creditDays: 30,
  taxable: 400_000,
  cgst: 36_000,
  sgst: 36_000,
  utgst: 0,
  igst: 0,
  cess: 0,
  roundOff: 0,
  total: 472_000,
  ...over,
});

const bill = (over: Partial<BillDoc> = {}): BillDoc => ({
  number: "PB/25-26/00001",
  date: "2025-06-12",
  supplierBillNo: "MW/2025/0417",
  partyLedger: "Mewar Weaving Mills",
  creditDays: 30,
  taxable: 65_500_000,
  cgst: 0,
  sgst: 0,
  utgst: 0,
  igst: 3_275_000,
  cess: 0,
  roundOff: 0,
  total: 68_775_000,
  ...over,
});

const entry = (v: Voucher, ledger: string) => v.entries.find((e) => e.ledger === ledger);

describe("sales vouchers", () => {
  it("debit the customer and credit sales and each tax", () => {
    const v = salesVoucher(sales());
    expect(v).toMatchObject({ type: "Sales", number: "INV/25-26/00001", party: "Harbor & Pine" });
    expect(entry(v, "Harbor & Pine")).toMatchObject({ debit: true, amountPaise: 472_000 });
    expect(entry(v, TALLY_LEDGERS.sales)).toMatchObject({ debit: false, amountPaise: 400_000 });
    expect(entry(v, TALLY_LEDGERS.outputCgst)).toMatchObject({ debit: false, amountPaise: 36_000 });
    expect(entry(v, TALLY_LEDGERS.outputSgst)).toMatchObject({ debit: false, amountPaise: 36_000 });
    expect(entry(v, TALLY_LEDGERS.outputIgst)).toBeUndefined(); // zero amounts are left out
    expect(entry(v, "Harbor & Pine")?.billRefs).toEqual([{ name: "INV/25-26/00001", type: "New Ref", amountPaise: 472_000, creditDays: 30 }]);
  });

  it("put IGST on its own ledger", () => {
    const v = salesVoucher(sales({ cgst: 0, sgst: 0, igst: 72_000 }));
    expect(entry(v, TALLY_LEDGERS.outputIgst)?.amountPaise).toBe(72_000);
  });

  it("book round-off to the side that balances, in both directions", () => {
    // Rs 7,171.87 rounded up to Rs 7,172: the extra 13 paise is income
    const up = salesVoucher(sales({ taxable: 608_749, cgst: 54_219, sgst: 54_219, roundOff: 13, total: 717_200 }));
    expect(entry(up, TALLY_LEDGERS.roundOff)).toMatchObject({ debit: false, amountPaise: 13 });
    // Rs 1,180.49 rounded down to Rs 1,180: 49 paise given up
    const down = salesVoucher(sales({ taxable: 100_049, cgst: 0, sgst: 0, igst: 18_000, roundOff: -49, total: 118_000 }));
    expect(entry(down, TALLY_LEDGERS.roundOff)).toMatchObject({ debit: true, amountPaise: 49 });
  });

  it("turn a credit note into a Credit Note voucher with everything reversed", () => {
    const v = salesVoucher(sales({ kind: "credit_note", number: "CN/25-26/00001", taxable: 100_000, cgst: 9_000, sgst: 9_000, total: 118_000, againstNumber: "INV/25-26/00001", reason: "One returned" }));
    expect(v.type).toBe("Credit Note");
    expect(entry(v, "Harbor & Pine")).toMatchObject({ debit: false, amountPaise: 118_000 });
    expect(entry(v, TALLY_LEDGERS.salesReturns)).toMatchObject({ debit: true, amountPaise: 100_000 });
    expect(entry(v, TALLY_LEDGERS.outputCgst)).toMatchObject({ debit: true, amountPaise: 9_000 });
    expect(v.narration).toBe("Credit note CN/25-26/00001 against INV/25-26/00001: One returned");
    const rounded = salesVoucher(sales({ kind: "credit_note", taxable: 100_049, cgst: 0, sgst: 0, igst: 18_000, roundOff: -49, total: 118_000 }));
    expect(entry(rounded, TALLY_LEDGERS.roundOff)).toMatchObject({ debit: false }); // reversed too
  });

  it("record a debit note as a Sales voucher, since Tally's Debit Note is for purchase returns", () => {
    const v = salesVoucher(sales({ kind: "debit_note", number: "DN/25-26/00001", taxable: 5_000, cgst: 450, sgst: 450, total: 5_900, againstNumber: "INV/25-26/00001" }));
    expect(v.type).toBe("Sales");
    expect(entry(v, "Harbor & Pine")?.debit).toBe(true);
    expect(v.narration).toContain("Debit note DN/25-26/00001 against INV/25-26/00001");
  });
});

describe("purchase vouchers", () => {
  it("debit purchases and input tax and credit the supplier, with the supplier's bill as the reference", () => {
    const v = purchaseVoucher(bill());
    expect(v).toMatchObject({ type: "Purchase", number: "PB/25-26/00001", reference: "MW/2025/0417", warnings: [] });
    expect(entry(v, TALLY_LEDGERS.purchase)).toMatchObject({ debit: true, amountPaise: 65_500_000 });
    expect(entry(v, TALLY_LEDGERS.inputIgst)).toMatchObject({ debit: true, amountPaise: 3_275_000 });
    expect(entry(v, "Mewar Weaving Mills")).toMatchObject({ debit: false, amountPaise: 68_775_000 });
    expect(entry(v, "Mewar Weaving Mills")?.billRefs?.[0]).toMatchObject({ name: "MW/2025/0417", type: "New Ref" });
  });

  it("books a printed total that disagrees with its parts to Round Off, and says so", () => {
    const v = purchaseVoucher(bill({ total: 68_780_000 })); // Rs 50 more than the parts
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toContain("MW/2025/0417");
    expect(entry(v, TALLY_LEDGERS.roundOff)).toMatchObject({ debit: true, amountPaise: 5_000 });
    expect(() => assertBalanced(v)).not.toThrow();
  });

  it("handles a negative round-off on a bill", () => {
    const v = purchaseVoucher(bill({ taxable: 100_049, igst: 18_000, cgst: 0, roundOff: -49, total: 118_000 }));
    expect(v.warnings).toEqual([]);
    expect(entry(v, TALLY_LEDGERS.roundOff)).toMatchObject({ debit: false, amountPaise: 49 });
  });
});

describe("payment and receipt vouchers", () => {
  const paid = (over: Partial<PaymentDoc> = {}): PaymentDoc => ({
    direction: "paid",
    number: "PAY/25-26/00001",
    date: "2025-06-20",
    mode: "bank",
    partyLedger: "Mewar Weaving Mills",
    amountPaise: 3_000_000,
    reference: "UTR 4471",
    settles: [{ name: "MW/2025/0417", amountPaise: 1_000_000 }],
    ...over,
  });

  it("pay a supplier from the bank, settle named bills, and keep the rest as an advance", () => {
    const v = paymentVoucher(paid());
    expect(v.type).toBe("Payment");
    expect(entry(v, "Mewar Weaving Mills")).toMatchObject({ debit: true, amountPaise: 3_000_000 });
    expect(entry(v, TALLY_LEDGERS.bank)).toMatchObject({ debit: false, amountPaise: 3_000_000 });
    expect(entry(v, "Mewar Weaving Mills")?.billRefs).toEqual([
      { name: "MW/2025/0417", type: "Agst Ref", amountPaise: 1_000_000 },
      { name: "PAY/25-26/00001", type: "Advance", amountPaise: 2_000_000 },
    ]);
    expect(v.narration).toBe("Paid by bank (UTR 4471)");
  });

  it("use the Cash ledger for cash, and no advance when everything is settled", () => {
    const v = paymentVoucher(paid({ mode: "cash", amountPaise: 1_000_000 }));
    expect(entry(v, TALLY_LEDGERS.cash)).toBeDefined();
    expect(entry(v, TALLY_LEDGERS.bank)).toBeUndefined();
    expect(entry(v, "Mewar Weaving Mills")?.billRefs).toHaveLength(1);
  });

  it("receive from a customer into the bank", () => {
    const v = paymentVoucher(paid({ direction: "received", number: "RCT/25-26/00001", partyLedger: "Harbor & Pine", settles: [{ name: "INV/25-26/00001", amountPaise: 3_000_000 }] }));
    expect(v.type).toBe("Receipt");
    expect(entry(v, TALLY_LEDGERS.bank)).toMatchObject({ debit: true });
    expect(entry(v, "Harbor & Pine")).toMatchObject({ debit: false });
  });
});

describe("assertBalanced", () => {
  it("refuses a voucher whose sides differ", () => {
    const bad: Voucher = {
      type: "Sales",
      date: "2025-06-05",
      number: "X",
      party: "P",
      narration: "",
      warnings: [],
      entries: [{ ledger: "P", debit: true, amountPaise: 100 }, { ledger: "Sales", debit: false, amountPaise: 99 }],
    };
    expect(() => assertBalanced(bad)).toThrow(DomainError);
  });
});

/** Entry-level amounts of each voucher in a vouchers file (bill allocations carry a BILLTYPE in between, so they are not matched). */
function voucherSums(file: string): number[] {
  return file
    .split("</VOUCHER>")
    .slice(0, -1)
    .map((chunk) => {
      let sum = 0;
      for (const m of chunk.matchAll(/<ISDEEMEDPOSITIVE>(Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)) {
        sum += Math.round(Number(m[2]) * 100);
      }
      return sum;
    });
}

describe("the vouchers file", () => {
  const vouchers = [
    salesVoucher(sales()),
    salesVoucher(sales({ number: "INV/25-26/00002", taxable: 608_749, cgst: 54_219, sgst: 54_219, roundOff: 13, total: 717_200 })),
    salesVoucher(sales({ kind: "credit_note", number: "CN/25-26/00001", taxable: 100_049, cgst: 0, sgst: 0, igst: 18_000, roundOff: -49, total: 118_000 })),
    purchaseVoucher(bill()),
    purchaseVoucher(bill({ number: "PB/25-26/00002", supplierBillNo: "B-2", total: 68_780_000 })),
    paymentVoucher({ direction: "paid", number: "PAY/25-26/00001", date: "2025-06-20", mode: "cash", partyLedger: "Mewar Weaving Mills", amountPaise: 2_500_000, settles: [{ name: "MW/2025/0417", amountPaise: 1_000_000 }] }),
  ];
  const file = renderVouchersXml({ company: "Sunrise Garments Pvt Ltd", vouchers });

  it("balances to zero in every voucher, in the XML itself", () => {
    expect(voucherSums(file)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("follows Tally's import structure and sign convention", () => {
    expect(file).toContain("<TALLYREQUEST>Import Data</TALLYREQUEST>");
    expect(file).toContain("<REPORTNAME>Vouchers</REPORTNAME>");
    expect(file).toContain("<SVCURRENTCOMPANY>Sunrise Garments Pvt Ltd</SVCURRENTCOMPANY>");
    expect(file).toContain('<VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">');
    expect(file).toContain("<DATE>20250605</DATE>");
    expect(file).toContain("<VOUCHERNUMBER>INV/25-26/00001</VOUCHERNUMBER>");
    // The customer is debited: marked deemed-positive, with a negative amount
    expect(file).toMatch(/<LEDGERNAME>Harbor &amp; Pine<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>-4720\.00<\/AMOUNT>/);
    // Sales is credited: positive
    expect(file).toMatch(/<LEDGERNAME>Sales<\/LEDGERNAME>\s*<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>4000\.00<\/AMOUNT>/);
    expect(file).toContain("<BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>");
    expect(file).toContain("<BILLTYPE>Agst Ref</BILLTYPE>");
    expect(file).toContain("<BILLTYPE>Advance</BILLTYPE>");
  });

  it("escapes names, so an ampersand or angle bracket cannot break the file", () => {
    expect(xml(`A & B <Ltd> "q" 'r'`)).toBe("A &amp; B &lt;Ltd&gt; &quot;q&quot; &apos;r&apos;");
    expect(xml("bad\u0000char\u0008here")).toBe("badcharhere");
    const odd = renderVouchersXml({ company: "A & B", vouchers: [salesVoucher(sales({ partyLedger: "Tom & <Jerry> Ltd" }))] });
    expect(odd).toContain("Tom &amp; &lt;Jerry&gt; Ltd");
    expect(odd).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});

describe("the masters file", () => {
  it("creates every ledger the vouchers post to, with GST details", () => {
    const names = new Set(standardLedgers().map((l) => l.name));
    for (const name of Object.values(TALLY_LEDGERS)) expect(names.has(name), name).toBe(true);

    const file = renderMastersXml({
      company: "Sunrise Garments Pvt Ltd",
      ledgers: [
        ...standardLedgers(),
        { name: "Harbor & Pine", parent: "Sundry Debtors", billwise: true, gstin: "27ABCDE1234F1Z5", registrationType: "Regular" },
      ],
    });
    expect(file).toContain("<REPORTNAME>All Masters</REPORTNAME>");
    expect(file).toContain('<LEDGER NAME="Output IGST" ACTION="Create">');
    expect(file).toContain("<GSTDUTYHEAD>Integrated Tax</GSTDUTYHEAD>");
    expect(file).toContain("<PARENT>Duties &amp; Taxes</PARENT>");
    expect(file).toContain("<PARENT>Sundry Debtors</PARENT>");
    expect(file).toContain("<ISBILLWISEON>Yes</ISBILLWISEON>");
    expect(file).toContain("<PARTYGSTIN>27ABCDE1234F1Z5</PARTYGSTIN>");
    expect(file).toContain('NAME="Harbor &amp; Pine"');
  });
});
