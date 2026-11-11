import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { auditLog, salesInvoiceLines, salesInvoices, salesOrderLines, salesOrders } from "../db/schema";
import { gstinChecksumChar } from "../domain/gstin";
import { createBom } from "./boms";
import { createCompany } from "./company";
import { cancelInvoice, createInvoiceFromOrder, createNote, getInvoice, postInvoice } from "./invoicing";
import { createStockDocument, postStockDocument } from "./inventory";
import { createItem } from "./items";
import { createParty } from "./parties";
import { cancelSalesOrder, closeSalesOrder, confirmSalesOrder, createSalesOrder, deliverSalesOrder } from "./sales";
import { getOrderRisks, getSalesOrder } from "./sales-queries";
import { getStockBalances } from "./stock-queries";
import { errorText, expectDomainError } from "./test-helpers";

let db: Db;
let seq = 0;

beforeAll(async () => {
  ({ db } = await openDb());
});

/** A GSTIN no other test uses. */
function freshGstin(state = "27") {
  seq += 1;
  const body = `${state}ABCDE${String(1000 + seq)}F1Z`;
  return body + gstinChecksumChar(body);
}

async function newCompany(label: string, options: { registered?: boolean } = {}) {
  seq += 1;
  const { company } = await createCompany(db, {
    legalName: `${label} ${seq}`,
    ...(options.registered === false ? { stateCode: "27" } : { gstin: freshGstin("27") }),
    owner: { email: `owner${seq}@sales.example`, name: "Owner" },
  });
  return company.id;
}

const customer = (companyId: string, name: string, extra: Record<string, unknown> = {}) =>
  createParty(db, { companyId, kind: "customer", name, gstin: freshGstin("27"), creditDays: 30, ...extra } as never);

async function stockIn(companyId: string, sku: string, qty: number, unitCost = "100", docDate = "2025-05-01") {
  const doc = await createStockDocument(db, { companyId, docType: "goods_receipt", docDate, lines: [{ sku, qty, unitCost }] });
  await postStockDocument(db, { companyId, documentId: doc.id });
}

const confirmed = async (companyId: string, input: Omit<Parameters<typeof createSalesOrder>[1], "companyId">) => {
  const order = await createSalesOrder(db, { companyId, ...input });
  return confirmSalesOrder(db, { companyId, orderId: order.id });
};

/** The company, customer and goods used by most tests. */
async function world(label: string) {
  const c = await newCompany(label);
  const buyer = await customer(c, "Harbor & Pine");
  await createItem(db, { companyId: c, sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS", hsnSac: "6205", gstRate: 18, salesPrice: "1000" });
  await createItem(db, { companyId: c, sku: "TRIM", name: "Trim", kind: "trading", uomCode: "PCS", hsnSac: "9606", gstRate: 5 });
  await createItem(db, { companyId: c, sku: "STITCH", name: "Stitching job", kind: "service", uomCode: "NOS", hsnSac: "998821", gstRate: 18, salesPrice: "50" });
  await stockIn(c, "SHIRT", 100, "400");
  await stockIn(c, "TRIM", 10, "20");
  return { c, buyer };
}

describe("order to cash: intra-state, in two shipments", () => {
  let c: string;
  let buyerId: string;
  let orderId: string;
  let firstInvoiceId: string;
  const lines = [
    { sku: "SHIRT", qty: 10 }, // Rs 1,000 x 10
    { sku: "TRIM", qty: 3, unitPrice: "33.33", discountPct: "12.5" }, // 99.99 less 12.5% = Rs 87.49
  ];

  beforeAll(async () => {
    const w = await world("Cash");
    c = w.c;
    buyerId = w.buyer.id;
  });

  it("confirms an order and gives it a number", async () => {
    const draft = await createSalesOrder(db, { companyId: c, customerId: buyerId, orderDate: "2025-06-01", promisedDate: "2025-06-10", customerPoRef: "HP-771", lines });
    const order = await confirmSalesOrder(db, { companyId: c, orderId: draft.id });
    orderId = order.id; // later steps build on this order
    expect(draft).toMatchObject({ state: "draft", number: null, shipToStateCode: "27" });
    expect(draft.lines.map((l) => [l.hsnSac, l.gstRate, l.unitPrice])).toEqual([
      ["6205", "18.00", "1000.0000"], // HSN and rate copied from the item
      ["9606", "5.00", "33.3300"],
    ]);
    expect(order).toMatchObject({ state: "confirmed", number: "SO/25-26/00001" });

    const view = await getSalesOrder(db, { companyId: c, orderId });
    expect(view.taxableValuePaise).toBe(1_008_749);
    expect(view.lines.map((l) => [l.delivered, l.invoiceable, l.toDeliver])).toEqual([
      ["0.000", "0.000", "10.000"],
      ["0.000", "0.000", "3.000"],
    ]);
  });

  it("will not invoice goods that have not left", async () => {
    await expectDomainError(createInvoiceFromOrder(db, { companyId: c, orderId, invoiceDate: "2025-06-05" }), "NOTHING_TO_INVOICE");
  });

  it("delivers part of the order and reduces stock", async () => {
    const delivery = await deliverSalesOrder(db, { companyId: c, orderId, docDate: "2025-06-04", lines: [{ lineNo: 1, qty: 4 }] });
    expect(delivery).toMatchObject({ number: "DEL/25-26/00001", state: "done", reference: "Order SO/25-26/00001" });
    expect(await getStockBalances(db, { companyId: c, sku: "SHIRT" })).toMatchObject([{ qty: "96.000" }]);
    const view = await getSalesOrder(db, { companyId: c, orderId });
    expect(view.lines[0]).toMatchObject({ delivered: "4.000", invoiceable: "4.000", toDeliver: "6.000" });
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId, docDate: "2025-06-04", lines: [{ lineNo: 1, qty: 7 }] }), "OVER_DELIVERY");
  });

  it("drafts, then posts, a GST invoice for what was delivered", async () => {
    const draft = await createInvoiceFromOrder(db, { companyId: c, orderId, invoiceDate: "2025-06-05" });
    firstInvoiceId = draft.id;
    expect(draft).toMatchObject({
      kind: "tax_invoice",
      state: "draft",
      number: null,
      dueDate: "2025-07-05", // 30 credit days
      supplyKind: "intra",
      placeOfSupplyStateCode: "27",
      customerName: "Harbor & Pine",
      taxableValuePaise: 400_000,
      cgstPaise: 36_000, // 9% of Rs 4,000
      sgstPaise: 36_000,
      igstPaise: 0,
      roundOffPaise: 0,
      totalPaise: 472_000,
    });
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ sku: "SHIRT", hsnSac: "6205", qty: "4.000", taxableValuePaise: 400_000, totalPaise: 472_000 });

    // The delivered goods are claimed by the draft: no second invoice can take them.
    await expectDomainError(createInvoiceFromOrder(db, { companyId: c, orderId, invoiceDate: "2025-06-05" }), "NOTHING_TO_INVOICE");

    const posted = await postInvoice(db, { companyId: c, invoiceId: draft.id });
    expect(posted).toMatchObject({ state: "posted", number: "INV/25-26/00001" });
    expect(posted.postedAt).not.toBeNull();
  });

  it("delivers the rest and invoices it, with the round-off shown separately", async () => {
    const delivery = await deliverSalesOrder(db, { companyId: c, orderId, docDate: "2025-06-11" });
    expect(delivery.number).toBe("DEL/25-26/00002");
    expect(delivery.lines.map((l) => [l.sku, l.qty])).toEqual([["SHIRT", "6.000"], ["TRIM", "3.000"]]);
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId, docDate: "2025-06-11" }), "NOTHING_TO_DELIVER");

    const draft = await createInvoiceFromOrder(db, { companyId: c, orderId, invoiceDate: "2025-06-12" });
    // SHIRT 6 x 1000 = 6,000.00 (cgst/sgst 540.00 each); TRIM 87.49 (cgst/sgst 2.19 each)
    expect(draft).toMatchObject({
      taxableValuePaise: 608_749,
      cgstPaise: 54_219,
      sgstPaise: 54_219,
      roundOffPaise: 13, // Rs 7,171.87 rounds up to Rs 7,172
      totalPaise: 717_200,
    });
    const posted = await postInvoice(db, { companyId: c, invoiceId: draft.id });
    expect(posted.number).toBe("INV/25-26/00002");

    const view = await getSalesOrder(db, { companyId: c, orderId });
    expect(view.lines.map((l) => [l.delivered, l.invoiced, l.invoiceable, l.toDeliver])).toEqual([
      ["10.000", "10.000", "0.000", "0.000"],
      ["3.000", "3.000", "0.000", "0.000"],
    ]);
  });

  it("leaves a trail in the audit log", async () => {
    const log = await db.select().from(auditLog).where(and(eq(auditLog.companyId, c), eq(auditLog.entityId, firstInvoiceId)));
    expect(log.map((l) => l.action)).toEqual(["sales_invoice.created", "sales_invoice.posted"]);
  });

  it("credits part of a posted invoice at its original tax, within what was invoiced", async () => {
    const credit = await createNote(db, {
      companyId: c,
      kind: "credit_note",
      originalInvoiceId: firstInvoiceId,
      noteDate: "2025-06-20",
      reason: "One shirt returned",
      lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 1000 }],
    });
    expect(credit).toMatchObject({
      kind: "credit_note",
      state: "draft",
      originalInvoiceId: firstInvoiceId,
      supplyKind: "intra",
      placeOfSupplyStateCode: "27",
      taxableValuePaise: 100_000,
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      totalPaise: 118_000,
    });
    expect(credit.lines[0]).toMatchObject({ hsnSac: "6205", gstRate: "18.00" });
    expect((await postInvoice(db, { companyId: c, invoiceId: credit.id })).number).toBe("CN/25-26/00001");

    // 4 shirts were invoiced and 1 credited: 3 more can be credited, not 4
    const note = (qty: number, noteDate = "2025-06-21") =>
      createNote(db, { companyId: c, kind: "credit_note", originalInvoiceId: firstInvoiceId, noteDate, reason: "Return", lines: [{ invoiceLineNo: 1, qty, unitPrice: 1000 }] });
    await expectDomainError(note(4), "CREDIT_EXCEEDS_INVOICE");
    const rest = await note(3, "2025-06-15"); // 3 shirts: exactly what is left
    // A draft's credit counts too, so nothing more can be credited until it is dealt with
    await expectDomainError(note(1), "CREDIT_EXCEEDS_INVOICE");

    // Dated before the CN already issued: the series cannot run backwards
    await expectDomainError(postInvoice(db, { companyId: c, invoiceId: rest.id }), "INVOICE_DATE_ORDER");
    await cancelInvoice(db, { companyId: c, invoiceId: rest.id });
    expect((await getInvoice(db, { companyId: c, invoiceId: rest.id })).state).toBe("cancelled");
  });

  it("debits for a price increase, with no cap", async () => {
    const debit = await createNote(db, {
      companyId: c,
      kind: "debit_note",
      originalInvoiceId: firstInvoiceId,
      noteDate: "2025-06-22",
      reason: "Rate difference of Rs 50 on one shirt",
      lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 50 }],
    });
    expect(debit).toMatchObject({ taxableValuePaise: 5_000, cgstPaise: 450, sgstPaise: 450, totalPaise: 5_900 });
    expect((await postInvoice(db, { companyId: c, invoiceId: debit.id })).number).toBe("DN/25-26/00001");
  });

  it("only allows a note against a posted tax invoice, dated on or after it, with a reason", async () => {
    const note = (extra: Record<string, unknown>) =>
      createNote(db, { companyId: c, kind: "credit_note", originalInvoiceId: firstInvoiceId, noteDate: "2025-06-25", reason: "x", lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 1 }], ...extra } as never);
    await expectDomainError(note({ noteDate: "2025-06-01" }), "NOTE_BEFORE_INVOICE");
    await expectDomainError(note({ lines: [{ invoiceLineNo: 9, qty: 1, unitPrice: 1 }] }), "UNKNOWN_LINE");
    await expect(note({ reason: " " })).rejects.toThrow();
    await expectDomainError(note({ originalInvoiceId: crypto.randomUUID() }), "UNKNOWN_INVOICE");
    const creditNote = (await db.select().from(salesInvoices).where(and(eq(salesInvoices.companyId, c), eq(salesInvoices.kind, "credit_note"))))[0];
    await expectDomainError(note({ originalInvoiceId: creditNote?.id }), "ORIGINAL_NOT_POSTED");
  });

  it("is immutable once posted", async () => {
    await expect(db.update(salesInvoices).set({ totalPaise: 1 }).where(eq(salesInvoices.id, firstInvoiceId))).rejects.toSatisfy((e) =>
      errorText(e).includes("posted sales invoice cannot be changed or deleted"),
    );
    await expect(db.delete(salesInvoices).where(eq(salesInvoices.id, firstInvoiceId))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot be changed or deleted"),
    );
    await expect(db.update(salesInvoiceLines).set({ qty: "1" }).where(eq(salesInvoiceLines.invoiceId, firstInvoiceId))).rejects.toSatisfy((e) =>
      errorText(e).includes("lines of a posted sales invoice cannot be changed"),
    );
    await expectDomainError(postInvoice(db, { companyId: c, invoiceId: firstInvoiceId }), "NOT_DRAFT");
    await expectDomainError(cancelInvoice(db, { companyId: c, invoiceId: firstInvoiceId }), "NOT_DRAFT");
  });
});

describe("place of supply decides the tax", () => {
  it("charges IGST to a customer in another state", async () => {
    const { c } = await world("Inter");
    const far = await customer(c, "Karnataka Retail", { gstin: freshGstin("29") });
    const order = await confirmed(c, { customerId: far.id, orderDate: "2025-06-01", promisedDate: "2025-06-10", lines: [{ sku: "SHIRT", qty: 10 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
    const invoice = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-03" });
    expect(invoice).toMatchObject({
      supplyKind: "inter",
      placeOfSupplyStateCode: "29",
      customerStateCode: "29",
      taxableValuePaise: 1_000_000,
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 180_000,
      totalPaise: 1_180_000,
    });
  });

  it("uses the ship-to state, not the customer's, as the place of supply", async () => {
    const { c, buyer } = await world("ShipTo");
    const order = await confirmed(c, { customerId: buyer.id, shipToStateCode: "24", orderDate: "2025-06-01", promisedDate: "2025-06-10", lines: [{ sku: "SHIRT", qty: 1 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
    const invoice = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-03" });
    // Customer is in Maharashtra (27), goods go to Gujarat (24): inter-state
    expect(invoice).toMatchObject({ supplyKind: "inter", placeOfSupplyStateCode: "24", customerStateCode: "27", igstPaise: 18_000 });
  });

  it("invoices an unregistered customer without a GSTIN", async () => {
    const { c } = await world("B2C");
    const walkIn = await createParty(db, { companyId: c, kind: "customer", name: "Walk-in", stateCode: "27" });
    const order = await confirmed(c, { customerId: walkIn.id, orderDate: "2025-06-01", promisedDate: "2025-06-01", lines: [{ sku: "SHIRT", qty: 1 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-01" });
    const invoice = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-01" });
    expect(invoice).toMatchObject({ customerGstin: null, dueDate: "2025-06-01", totalPaise: 118_000 });
  });
});

describe("services and special cases", () => {
  it("invoices a service without any delivery", async () => {
    const { c, buyer } = await world("Service");
    const order = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-10", lines: [{ sku: "STITCH", qty: 100 }] });
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02", lines: [{ lineNo: 1, qty: 1 }] }), "SERVICE_LINE");
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" }), "NOTHING_TO_DELIVER");
    const invoice = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-02", lines: [{ lineNo: 1, qty: 40 }] });
    expect(invoice).toMatchObject({ taxableValuePaise: 200_000, totalPaise: 236_000 }); // 40 x Rs 50, plus 18%
    expect(invoice.lines[0]?.hsnSac).toBe("998821");
    await expectDomainError(createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-02", lines: [{ lineNo: 1, qty: 61 }] }), "OVER_INVOICE");
  });

  it("refuses to invoice an item that has no HSN code", async () => {
    const { c, buyer } = await world("NoHsn");
    await createItem(db, { companyId: c, sku: "RAW", name: "Raw", kind: "trading", uomCode: "PCS", gstRate: 18 });
    await stockIn(c, "RAW", 5);
    const order = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-10", lines: [{ sku: "RAW", qty: 1, unitPrice: 10 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
    await expectDomainError(createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-03" }), "HSN_REQUIRED");
  });

  it("will not issue a tax invoice for a company with no GSTIN", async () => {
    const c = await newCompany("Unregistered", { registered: false });
    const buyer = await createParty(db, { companyId: c, kind: "customer", name: "Buyer", stateCode: "27" });
    await createItem(db, { companyId: c, sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS", hsnSac: "6205", gstRate: 5, salesPrice: "100" });
    await stockIn(c, "SHIRT", 5);
    const order = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-10", lines: [{ sku: "SHIRT", qty: 1 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
    await expectDomainError(createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-03" }), "COMPANY_NOT_REGISTERED");
  });

  it("keeps invoice dates in step with their numbers", async () => {
    const { c, buyer } = await world("DateOrder");
    const make = async (invoiceDate: string) => {
      const order = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-30", lines: [{ sku: "SHIRT", qty: 1 }] });
      await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
      return createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate });
    };
    const late = await make("2025-06-20");
    const early = await make("2025-06-10");
    await postInvoice(db, { companyId: c, invoiceId: late.id });
    await expectDomainError(postInvoice(db, { companyId: c, invoiceId: early.id }), "INVOICE_DATE_ORDER");
    // The refused post took no number: the next valid invoice follows directly
    const next = await make("2025-06-21");
    expect((await postInvoice(db, { companyId: c, invoiceId: next.id })).number).toBe("INV/25-26/00002");
  });

  it("does not let two drafts post the same goods", async () => {
    const { c, buyer } = await world("Race");
    const order = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-30", lines: [{ sku: "SHIRT", qty: 4 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
    const first = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-03" });
    await cancelInvoice(db, { companyId: c, invoiceId: first.id });
    const second = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-03" });
    await postInvoice(db, { companyId: c, invoiceId: second.id });
    // The cancelled draft released its claim; the posted one holds it
    await expectDomainError(createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: "2025-06-04" }), "NOTHING_TO_INVOICE");
  });
});

describe("order rules", () => {
  let c: string;
  let buyerId: string;
  const base = () => ({ companyId: c, customerId: buyerId, orderDate: "2025-06-01", promisedDate: "2025-06-10" });
  beforeAll(async () => {
    const w = await world("Rules");
    c = w.c;
    buyerId = w.buyer.id;
    await createItem(db, { companyId: c, sku: "NOPRICE", name: "No price", kind: "trading", uomCode: "PCS", hsnSac: "1234", gstRate: 18 });
  });

  it("validates lines", async () => {
    const one = (line: Record<string, unknown>) => createSalesOrder(db, { ...base(), lines: [{ sku: "SHIRT", qty: 1, ...line }] });
    await expectDomainError(one({ sku: "NOPE" }), "UNKNOWN_ITEM");
    await expectDomainError(one({ qty: "1.5" }), "QTY_PRECISION");
    await expectDomainError(one({ qty: 0 }), "INVALID_QTY");
    await expectDomainError(one({ sku: "NOPRICE" }), "PRICE_REQUIRED");
    await expectDomainError(one({ unitPrice: -5 }), "INVALID_PRICE");
    await expectDomainError(one({ discountPct: 101 }), "INVALID_DISCOUNT");
    await expectDomainError(one({ gstRate: 12 }), "INVALID_GST_RATE");
    await expect(createSalesOrder(db, { ...base(), lines: [] })).rejects.toThrow();
  });

  it("validates the customer and dates", async () => {
    const lines = [{ sku: "SHIRT", qty: 1 }];
    await expectDomainError(createSalesOrder(db, { ...base(), promisedDate: "2025-05-31", lines }), "PROMISE_BEFORE_ORDER");
    await expectDomainError(createSalesOrder(db, { ...base(), orderDate: "2025-02-30", lines }), "INVALID_DATE");
    await expectDomainError(createSalesOrder(db, { ...base(), customerId: crypto.randomUUID(), lines }), "UNKNOWN_PARTY");
    const vendor = await createParty(db, { companyId: c, kind: "supplier", name: "Mill", stateCode: "29" });
    await expectDomainError(createSalesOrder(db, { ...base(), customerId: vendor.id, lines }), "WRONG_PARTY_KIND");
    const sez = await createParty(db, { companyId: c, kind: "customer", name: "SEZ Unit", gstin: freshGstin("27"), registrationType: "sez" });
    await expectDomainError(createSalesOrder(db, { ...base(), customerId: sez.id, lines }), "UNSUPPORTED_REGISTRATION");
    const abroad = await createParty(db, { companyId: c, kind: "customer", name: "Overseas Buyer", stateCode: "27", registrationType: "overseas" });
    await expectDomainError(createSalesOrder(db, { ...base(), customerId: abroad.id, lines }), "UNSUPPORTED_REGISTRATION");
  });

  it("cancels a draft without using up an order number", async () => {
    const draft = await createSalesOrder(db, { ...base(), lines: [{ sku: "SHIRT", qty: 1 }] });
    await cancelSalesOrder(db, { companyId: c, orderId: draft.id });
    expect((await getSalesOrder(db, { companyId: c, orderId: draft.id })).state).toBe("cancelled");
    expect((await confirmed(c, { ...base(), lines: [{ sku: "SHIRT", qty: 1 }] })).number).toBe("SO/25-26/00001");
  });

  it("cancels an untouched confirmed order, but closes one with activity", async () => {
    const untouched = await confirmed(c, { ...base(), lines: [{ sku: "SHIRT", qty: 1 }] });
    await cancelSalesOrder(db, { companyId: c, orderId: untouched.id });
    await expectDomainError(cancelSalesOrder(db, { companyId: c, orderId: untouched.id }), "NOT_CANCELLABLE");
    await expectDomainError(confirmSalesOrder(db, { companyId: c, orderId: untouched.id }), "NOT_DRAFT");

    const active = await confirmed(c, { ...base(), lines: [{ sku: "SHIRT", qty: 5 }] });
    await deliverSalesOrder(db, { companyId: c, orderId: active.id, docDate: "2025-06-02", lines: [{ lineNo: 1, qty: 2 }] });
    await expectDomainError(cancelSalesOrder(db, { companyId: c, orderId: active.id }), "HAS_ACTIVITY");
    await closeSalesOrder(db, { companyId: c, orderId: active.id });
    // Short-closed: no more goods, but what was delivered can still be invoiced
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: active.id, docDate: "2025-06-03" }), "NOT_CONFIRMED");
    const invoice = await createInvoiceFromOrder(db, { companyId: c, orderId: active.id, invoiceDate: "2025-06-03" });
    expect(invoice.lines[0]?.qty).toBe("2.000");
    await expectDomainError(closeSalesOrder(db, { companyId: c, orderId: active.id }), "NOT_CONFIRMED");
  });

  it("cannot deliver a draft order, or before the order date", async () => {
    const draft = await createSalesOrder(db, { ...base(), lines: [{ sku: "SHIRT", qty: 1 }] });
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: draft.id, docDate: "2025-06-02" }), "NOT_CONFIRMED");
    const live = await confirmed(c, { ...base(), lines: [{ sku: "SHIRT", qty: 1 }] });
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: live.id, docDate: "2025-05-01" }), "DELIVERY_BEFORE_ORDER");
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: live.id, docDate: "2025-06-02", lines: [{ lineNo: 1, qty: 1 }, { lineNo: 1, qty: 1 }] }), "DUPLICATE_LINE");
    await expectDomainError(deliverSalesOrder(db, { companyId: c, orderId: live.id, docDate: "2025-06-02", lines: [{ lineNo: 5, qty: 1 }] }), "UNKNOWN_LINE");
  });

  it("delivers all or nothing when stock runs short", async () => {
    const w = await world("Atomic");
    // 10 TRIM in stock but the order wants 11: the SHIRT line must not ship either
    const order = await confirmed(w.c, { customerId: w.buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-10", lines: [{ sku: "SHIRT", qty: 5 }, { sku: "TRIM", qty: 11, unitPrice: 20 }] });
    await expectDomainError(deliverSalesOrder(db, { companyId: w.c, orderId: order.id, docDate: "2025-06-02" }), "INSUFFICIENT_STOCK");
    expect(await getStockBalances(db, { companyId: w.c, sku: "SHIRT" })).toMatchObject([{ qty: "100.000" }]);
    const view = await getSalesOrder(db, { companyId: w.c, orderId: order.id });
    expect(view.lines.map((l) => l.delivered)).toEqual(["0.000", "0.000"]);
    // A partial delivery of what is available works
    await deliverSalesOrder(db, { companyId: w.c, orderId: order.id, docDate: "2025-06-02", lines: [{ lineNo: 2, qty: 10 }] });
    expect((await getSalesOrder(db, { companyId: w.c, orderId: order.id })).lines[1]?.delivered).toBe("10.000");
  });

  it("freezes a confirmed order in the database itself", async () => {
    const order = await confirmed(c, { ...base(), lines: [{ sku: "SHIRT", qty: 1 }] });
    await expect(db.update(salesOrders).set({ promisedDate: "2025-12-31" }).where(eq(salesOrders.id, order.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("a confirmed sales order can only be closed or cancelled"),
    );
    await expect(db.update(salesOrderLines).set({ qty: "99" }).where(eq(salesOrderLines.orderId, order.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("lines of a confirmed sales order cannot be changed"),
    );
    await expect(db.delete(salesOrders).where(eq(salesOrders.id, order.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot be deleted"),
    );
    await closeSalesOrder(db, { companyId: c, orderId: order.id });
    await expect(db.update(salesOrders).set({ notes: "x" }).where(eq(salesOrders.id, order.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("a closed sales order cannot be changed"),
    );
  });
});

describe("the orders board", () => {
  it("marks orders on time, at risk or late using the stock left after earlier promises", async () => {
    const c = await newCompany("Board");
    const buyer = await customer(c, "Harbor & Pine");
    await createItem(db, { companyId: c, sku: "FAB", name: "Fabric", kind: "raw_material", uomCode: "MTR" });
    await createItem(db, { companyId: c, sku: "BTN", name: "Button", kind: "raw_material", uomCode: "PCS" });
    await createItem(db, { companyId: c, sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS", hsnSac: "6205", gstRate: 18, salesPrice: "1000" });
    await createBom(db, { companyId: c, outputSku: "SHIRT", lines: [{ componentSku: "FAB", qty: "1.5", scrapPct: 10 }, { componentSku: "BTN", qty: 8 }] });
    await stockIn(c, "FAB", 100);
    await stockIn(c, "BTN", 800);

    // Each order of 50 shirts needs 82.5 m of fabric and 400 buttons: stock covers one order, not two
    const early = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-07-10", lines: [{ sku: "SHIRT", qty: 50 }] });
    const later = await confirmed(c, { customerId: buyer.id, orderDate: "2025-06-02", promisedDate: "2025-07-20", lines: [{ sku: "SHIRT", qty: 50 }] });

    let board = await getOrderRisks(db, { companyId: c, today: "2025-07-01" });
    // At-risk orders are listed before on-time ones
    expect(board.map((r) => [r.number, r.status, r.reason, r.remainingValuePaise])).toEqual([
      [later.number, "at_risk", "Short of FAB", 5_000_000],
      [early.number, "on_time", "Stock covers what remains", 5_000_000],
    ]);
    expect(board.find((r) => r.orderId === later.id)?.shortOf).toEqual(["FAB"]);
    expect(board.find((r) => r.orderId === early.id)?.shortOf).toEqual([]);
    expect(board[0]?.customerName).toBe("Harbor & Pine");

    // Past the early order's promise date it is late, and late sorts first
    board = await getOrderRisks(db, { companyId: c, today: "2025-07-15" });
    expect(board.map((r) => [r.orderId, r.status, r.reason])).toEqual([
      [early.id, "late", "5 days overdue"],
      [later.id, "at_risk", "Short of FAB"],
    ]);

    // Ship the early order from finished stock: it is fulfilled and frees the fabric for the later one
    await stockIn(c, "SHIRT", 50, "400");
    await deliverSalesOrder(db, { companyId: c, orderId: early.id, docDate: "2025-07-16" });
    board = await getOrderRisks(db, { companyId: c, today: "2025-07-16" });
    expect(board.map((r) => [r.orderId, r.status, r.remainingValuePaise])).toEqual([
      [later.id, "on_time", 5_000_000],
      [early.id, "fulfilled", 0],
    ]);
  });

  it("is empty when there are no confirmed orders", async () => {
    const c = await newCompany("EmptyBoard");
    expect(await getOrderRisks(db, { companyId: c, today: "2025-07-01" })).toEqual([]);
  });
});
