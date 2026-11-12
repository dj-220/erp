import ExcelJS from "exceljs";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { exportBatches, exportedDocuments, payments } from "../db/schema";
import { seedDemo } from "../demo/seed";
import type { SheetName } from "../domain/permissions";
import { buildExcel, buildTally, exportTally } from "./exports";
import { reversePayment } from "./payments";
import { errorText, expectDomainError } from "./test-helpers";

const TODAY = "2025-08-20";
const ALL_SHEETS: SheetName[] = ["parties", "items", "stock", "valuation", "sales_orders", "sales_invoices", "purchase_orders", "bills", "payments", "payables", "receivables"];

let db: Db;
let companyId: string;
let people: Record<string, string>;

beforeAll(async () => {
  ({ db } = await openDb());
  ({ companyId, people } = await seedDemo(db, TODAY));
}, 120_000);

async function load(sheets: SheetName[]) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildExcel(db, { companyId, sheets, asOf: TODAY })) as never);
  return wb;
}
const sheetRows = (wb: ExcelJS.Workbook, name: string) => {
  const ws = wb.getWorksheet(name);
  if (!ws) throw new Error(`no sheet ${name}`);
  const headers = (ws.getRow(1).values as unknown[]).slice(1) as string[];
  const rows: Record<string, unknown>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const values = (row.values as unknown[]).slice(1);
    rows.push(Object.fromEntries(headers.map((h, i) => [h, values[i] ?? null])));
  });
  return rows;
};

describe("Excel export", () => {
  it("makes one sheet per list, after an About sheet", async () => {
    const wb = await load(ALL_SHEETS);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "About", "Parties", "Items", "Stock", "Stock value", "Sales orders", "Sales invoices", "Purchase orders", "Supplier bills", "Payments and receipts", "Payables", "Receivables",
    ]);
    const about = wb.getWorksheet("About");
    expect(about?.getCell("B1").value).toBe("Sunrise Garments Pvt Ltd");
    expect(about?.getCell("B3").value).toBe(TODAY);
  });

  it("writes money in rupees, dates as real dates and totals at the bottom", async () => {
    const wb = await load(["sales_invoices"]);
    const rows = sheetRows(wb, "Sales invoices");
    const invoices = rows.filter((r) => r.Type === "tax invoice");
    expect(invoices).toHaveLength(3);
    const first = invoices[0] as Record<string, unknown>;
    expect(first).toMatchObject({ Number: "INV/25-26/00001", Customer: "Harbor & Pine", Taxable: 375000, CGST: 9375, "SGST / UTGST": 9375, IGST: 0, Total: 393750 });
    expect(first.Date).toBeInstanceOf(Date);
    expect((first.Date as Date).toISOString().slice(0, 10)).toBe("2025-05-18");
    // A credit note is negative, so the totals row nets it off against sales
    const credit = rows.find((r) => r.Type === "credit note");
    expect(credit).toMatchObject({ Taxable: -19000, IGST: -950, Total: -19950 });
    const total = rows.at(-1) as Record<string, unknown>;
    expect(total).toMatchObject({ Type: "Total", Taxable: 375000 + 270000 + 285000 - 19000, Total: 393750 + 283500 + 299250 - 19950 });
    const ws = wb.getWorksheet("Sales invoices");
    expect(ws?.getColumn(15).numFmt).toBe("#,##0.00");
    expect(ws?.getColumn(4).numFmt).toBe("dd-mmm-yyyy");
    expect(ws?.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("lists what is owed in the ageing sheets, with the MSME flag", async () => {
    const wb = await load(["payables", "receivables"]);
    const payables = sheetRows(wb, "Payables").filter((r) => r.Document !== null);
    expect(payables.map((r) => [r.Supplier, r["Days overdue"], r.Age, r["MSME limit passed"]])).toEqual([
      ["Mewar Weaving Mills", 32, "31-60 days", "Yes"],
      ["Patel Textiles", 5, "1-30 days", null],
    ]);
    const receivables = sheetRows(wb, "Receivables").filter((r) => r.Document !== null);
    // Largest balance first: Harbor & Pine, Nordlys, then Marlow
    expect(receivables.map((r) => [r.Customer, r.Document, r.Outstanding])).toEqual([
      ["Harbor & Pine", "INV/25-26/00001", 393750],
      ["Nordlys Apparel", "INV/25-26/00003", 279300],
      ["Marlow & Co", "INV/25-26/00002", 183500],
    ]);
  });

  it("shows why a bill is held", async () => {
    const wb = await load(["bills"]);
    const held = sheetRows(wb, "Supplier bills").find((r) => r.Status === "held");
    expect(held).toMatchObject({ "Supplier's bill no.": "SF/2025/118", Supplier: "Shubh Fabrics", Total: 701505 });
    expect(String(held?.["Held for"])).toContain("input tax credit is at risk");
    expect(String(held?.["Held for"])).toContain("billed 2550 but only 2500 received");
  });

  it("includes stock, value, parties, items and orders", async () => {
    const wb = await load(["stock", "valuation", "parties", "items", "sales_orders", "purchase_orders", "payments"]);
    expect(sheetRows(wb, "Stock").find((r) => r.SKU === "FAB-OXFORD")).toMatchObject({ Quantity: 3500, Location: "Main / Stock" });
    expect(sheetRows(wb, "Stock value").some((r) => r.SKU === "SHIRT-CHAMBRAY")).toBe(true);
    expect(sheetRows(wb, "Parties").find((r) => r.Name === "Mewar Weaving Mills")).toMatchObject({ MSME: "Yes", "Credit days": 30 });
    expect(sheetRows(wb, "Items").find((r) => r.SKU === "SHIRT-OXFORD")).toMatchObject({ "HSN / SAC": "6205", "GST %": 5, "Sales price": 1450 });
    expect(sheetRows(wb, "Sales orders").filter((r) => r.Status === "confirmed")).toHaveLength(6);
    expect(sheetRows(wb, "Purchase orders").some((r) => r.Status === "pending_approval")).toBe(true);
    expect(sheetRows(wb, "Payments and receipts").map((r) => r.Direction).sort()).toEqual(["paid", "paid", "received"]);
  });

  it("does not let a cell be read as a formula", async () => {
    const wb = await load(["parties"]);
    const cell = wb.getWorksheet("Parties")?.getCell("A2");
    expect(typeof cell?.value).toBe("string");
  });
});

describe("Tally export", () => {
  const range = { companyId: "", from: "2025-04-01", to: TODAY };
  const withCompany = () => ({ ...range, companyId });

  /** Entry-level amounts per voucher; bill allocations carry a BILLTYPE in between, so they are not matched. */
  const sums = (xml: string) =>
    xml
      .split("</VOUCHER>")
      .slice(0, -1)
      .map((chunk) => [...chunk.matchAll(/<ISDEEMEDPOSITIVE>(?:Yes|No)<\/ISDEEMEDPOSITIVE>\s*<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].reduce((s, m) => s + Math.round(Number(m[1]) * 100), 0));

  it("previews every posted document, balanced, without recording anything", async () => {
    const build = await buildTally(db, withCompany());
    expect(build.counts).toEqual({ invoices: 3, creditNotes: 1, debitNotes: 0, bills: 2, payments: 2, receipts: 1 });
    expect(build.voucherCount).toBe(9);
    expect(sums(build.vouchersXml)).toEqual(Array(9).fill(0));
    expect(build.vouchersXml).toContain("<SVCURRENTCOMPANY>Sunrise Garments Pvt Ltd</SVCURRENTCOMPANY>");
    expect(build.warnings).toEqual([]);
    expect(await db.select().from(exportBatches)).toHaveLength(0);
    // The held bill and the matched-but-unposted bill are not accounted for yet
    expect(build.vouchersXml).not.toContain("SF/2025/118");
    expect(build.vouchersXml).not.toContain("OB-2201");
  });

  it("orders vouchers by date and settles payments against the bills they paid", async () => {
    const { vouchersXml } = await buildTally(db, withCompany());
    const numbers = [...vouchersXml.matchAll(/<VOUCHERNUMBER>(.*?)<\/VOUCHERNUMBER>/g)].map((m) => m[1]);
    expect(numbers).toEqual([
      "INV/25-26/00001", // 18 May
      "PB/25-26/00001", // 19 Jun
      "INV/25-26/00002", // 1 Jul
      "RCT/25-26/00001", // 21 Jul
      "PAY/25-26/00001", // 31 Jul
      "PB/25-26/00002", // 31 Jul
      "INV/25-26/00003", // 10 Aug
      "CN/25-26/00001", // 15 Aug
      "PAY/25-26/00002", // 17 Aug
    ]);
    expect(vouchersXml).toContain("<NAME>MW/25/0417</NAME>"); // the payment settles Mewar's own bill number
    expect(vouchersXml).toMatch(/<BILLTYPE>Advance<\/BILLTYPE>/); // the Rs 5,000 paid on account
  });

  it("creates ledgers for every party and the standard accounts", async () => {
    const { mastersXml } = await buildTally(db, withCompany());
    expect(mastersXml).toContain('<LEDGER NAME="Harbor &amp; Pine" ACTION="Create">');
    expect(mastersXml).toContain("<PARENT>Sundry Creditors</PARENT>");
    expect(mastersXml).toContain('<LEDGER NAME="Input IGST" ACTION="Create">');
    expect(mastersXml).toMatch(/<PARTYGSTIN>08[A-Z0-9]{13}<\/PARTYGSTIN>/); // Mewar, Rajasthan
  });

  it("limits itself to the dates asked for", async () => {
    const june = await buildTally(db, { companyId, from: "2025-06-01", to: "2025-06-30" });
    expect(june.docs.map((d) => d.voucherNumber)).toEqual(["PB/25-26/00001"]);
    await expectDomainError(buildTally(db, { companyId, from: "2025-07-01", to: "2025-06-01" }), "INVALID_RANGE");
    await expectDomainError(buildTally(db, { companyId, from: "2025-02-30", to: "2025-06-01" }), "INVALID_DATE");
  });

  it("records what it exported, so nothing is sent twice", async () => {
    const first = await exportTally(db, { companyId, actorUserId: people.ravi as string, from: "2025-04-01", to: TODAY });
    expect(first.voucherCount).toBe(9);
    expect(await db.select().from(exportedDocuments).where(eq(exportedDocuments.batchId, first.batchId))).toHaveLength(9);
    const [batch] = await db.select().from(exportBatches).where(eq(exportBatches.id, first.batchId));
    expect(batch).toMatchObject({ kind: "tally", voucherCount: 9, dateFrom: "2025-04-01", dateTo: TODAY });
    expect(batch?.fileSha256).toHaveLength(64);

    await expectDomainError(exportTally(db, { companyId, actorUserId: people.ravi as string, from: "2025-04-01", to: TODAY }), "NOTHING_TO_EXPORT");
    expect((await buildTally(db, withCompany())).voucherCount).toBe(0);
    // A deliberate re-export of the same documents is possible, and records nothing new
    const again = await buildTally(db, { ...withCompany(), includeExported: true });
    expect(again.voucherCount).toBe(9);
    expect(await db.select().from(exportBatches)).toHaveLength(1);
  });

  it("warns when a payment that was already exported is reversed", async () => {
    const [advance] = await db.select().from(payments).where(eq(payments.companyId, companyId));
    const target = (await db.select().from(payments).where(eq(payments.companyId, companyId))).find((p) => p.mode === "upi") ?? advance;
    await reversePayment(db, { companyId, paymentId: target?.id as string, actorUserId: people.deepak as string, reason: "Paid to the wrong account" });
    const build = await buildTally(db, { ...withCompany(), includeExported: true });
    expect(build.warnings.join(" ")).toContain("has since been reversed");
    expect(build.counts.payments).toBe(1); // the reversed one is no longer exported
  });

  it("keeps the export records permanent", async () => {
    await expect(db.delete(exportedDocuments).where(eq(exportedDocuments.companyId, companyId))).rejects.toSatisfy((e) => errorText(e).includes("append-only"));
    await expect(db.update(exportBatches).set({ voucherCount: 1 }).where(eq(exportBatches.companyId, companyId))).rejects.toSatisfy((e) => errorText(e).includes("append-only"));
  });
});
