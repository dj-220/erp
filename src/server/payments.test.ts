import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { paymentAllocations, payments } from "../db/schema";
import { createBill, getBill, postBill, submitBill } from "./bills";
import { createCompany } from "./company";
import { createStockDocument, postStockDocument } from "./inventory";
import { createInvoiceFromOrder, createNote, postInvoice } from "./invoicing";
import { createItem } from "./items";
import { getPayablesAgeing, getReceivablesAgeing } from "./ledger-queries";
import { createParty } from "./parties";
import { allocatePayment, getPayment, recordPayment, reversePayment } from "./payments";
import { confirmSalesOrder, createSalesOrder, deliverSalesOrder } from "./sales";
import { addMember, errorText, expectDomainError, freshGstin } from "./test-helpers";
import { type BuyingWorld, buyingWorld, receivedPo } from "./test-world";

let db: Db;

beforeAll(async () => {
  ({ db } = await openDb());
});

let billSeq = 0;
/** A supplier bill that has matched and been posted. */
async function postedBill(
  w: BuyingWorld,
  args: { supplierId?: string; sku?: string; qty?: number; unitPrice?: number; gstRate?: number; billDate?: string } = {},
) {
  billSeq += 1;
  const sku = args.sku ?? "FAB";
  const qty = args.qty ?? 100;
  const unitPrice = args.unitPrice ?? 240;
  const po = await receivedPo(db, w, { supplierId: args.supplierId ?? w.near.id, lines: [{ sku, qty, unitPrice }] });
  const draft = await createBill(db, {
    companyId: w.c,
    actorUserId: w.team.asha,
    purchaseOrderId: po.id,
    supplierBillNo: `B-${billSeq}`,
    billDate: args.billDate ?? "2025-06-12",
    supplierGstin: ((args.supplierId ?? w.near.id) === w.near.id ? w.near.gstin : w.far.gstin) as string,
    lines: [{ poLineNo: 1, qty, unitPrice, gstRate: args.gstRate ?? (sku === "FAB" ? 5 : 18) }],
  });
  await submitBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.asha });
  return postBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.ravi });
}

const pay = (w: BuyingWorld, actor: string, supplierId: string, amount: string, allocations: { docId: string; amount: string }[], extra: Record<string, unknown> = {}) =>
  recordPayment(db, {
    companyId: w.c,
    actorUserId: actor,
    direction: "paid",
    partyId: supplierId,
    paymentDate: "2025-06-20",
    amount,
    mode: "bank",
    allocations,
    ...extra,
  } as never);

describe("paying suppliers", () => {
  let w: BuyingWorld;
  beforeAll(async () => {
    w = await buyingWorld(db, "Pay");
  });

  it("settles a bill in parts, numbering each payment", async () => {
    const b = await postedBill(w); // 100 m at Rs 240 + 5% = Rs 25,200
    expect(b.outstandingPaise).toBe(2_520_000);

    const first = await pay(w, w.team.deepak, w.near.id, "10000", [{ docId: b.id, amount: "10000" }], { reference: "UTR 4471" });
    expect(first).toMatchObject({ number: "PAY/25-26/00001", state: "posted", amountPaise: 1_000_000, allocatedPaise: 1_000_000, unallocatedPaise: 0, reference: "UTR 4471", warnings: [] });
    expect(await getBill(db, { companyId: w.c, billId: b.id })).toMatchObject({ paidPaise: 1_000_000, outstandingPaise: 1_520_000 });

    await expectDomainError(pay(w, w.team.deepak, w.near.id, "15200.01", [{ docId: b.id, amount: "15200.01" }]), "OVER_ALLOCATION");
    const second = await pay(w, w.team.deepak, w.near.id, "15200", [{ docId: b.id, amount: "15200" }]);
    expect(second.number).toBe("PAY/25-26/00002");
    expect(await getBill(db, { companyId: w.c, billId: b.id })).toMatchObject({ outstandingPaise: 0 });
    await expectDomainError(pay(w, w.team.deepak, w.near.id, "1", [{ docId: b.id, amount: "1" }]), "OVER_ALLOCATION"); // nothing left
  });

  it("refuses what it cannot settle, and a refused payment uses no number", async () => {
    const x = await buyingWorld(db, "PayRules");
    const bill = await postedBill(x);
    const otherSupplierBill = await postedBill(x, { supplierId: x.far.id });
    const customer = await createParty(db, { companyId: x.c, kind: "customer", name: "Buyer", stateCode: "27" });

    await expectDomainError(pay(x, x.team.deepak, x.near.id, "10000", [{ docId: bill.id, amount: "12000" }]), "OVER_ALLOCATION"); // more than the payment
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "30000", [{ docId: bill.id, amount: "30000" }]), "OVER_ALLOCATION"); // more than the bill
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "100", [{ docId: otherSupplierBill.id, amount: "100" }]), "WRONG_PARTY");
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "100", [{ docId: crypto.randomUUID(), amount: "100" }]), "NOT_PAYABLE");
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "100", [{ docId: bill.id, amount: "50" }, { docId: bill.id, amount: "50" }]), "DUPLICATE_ALLOCATION");
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "100", [{ docId: bill.id, amount: "0" }]), "INVALID_ALLOCATION");
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "0", []), "INVALID_AMOUNT");
    await expectDomainError(pay(x, x.team.deepak, customer.id, "100", []), "WRONG_PARTY_KIND");
    await expectDomainError(pay(x, x.team.deepak, crypto.randomUUID(), "100", []), "UNKNOWN_PARTY");
    await expectDomainError(pay(x, x.team.vik, x.near.id, "100", []), "READ_ONLY");
    await expectDomainError(pay(x, crypto.randomUUID(), x.near.id, "100", []), "NOT_A_MEMBER");
    // The buyer's limit is Rs 10,000; this payment is Rs 25,200
    await expectDomainError(pay(x, x.team.asha, x.near.id, "25200", [{ docId: bill.id, amount: "25200" }]), "INSUFFICIENT_AUTHORITY");
    expect(await db.select().from(payments).where(eq(payments.companyId, x.c))).toHaveLength(0);

    // Within her limit it goes through, as the first number in the series
    const ok = await pay(x, x.team.asha, x.near.id, "5000", [{ docId: bill.id, amount: "5000" }]);
    expect(ok.number).toBe("PAY/25-26/00001");
  });

  it("cannot pay a bill that is on hold or not yet posted", async () => {
    const x = await buyingWorld(db, "PayHeld");
    const po = await receivedPo(db, x, { supplierId: x.near.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const draft = await createBill(db, {
      companyId: x.c, actorUserId: x.team.asha, purchaseOrderId: po.id, supplierBillNo: "H-1", billDate: "2025-06-12",
      lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 5 }],
    }); // no GSTIN printed: held
    const held = await submitBill(db, { companyId: x.c, billId: draft.id, actorUserId: x.team.asha });
    expect(held.state).toBe("held");
    await expectDomainError(pay(x, x.team.deepak, x.near.id, "100", [{ docId: held.id, amount: "100" }]), "NOT_PAYABLE");
  });

  it("keeps an advance on account and applies it later", async () => {
    const x = await buyingWorld(db, "PayAdvance");
    const bill = await postedBill(x);
    const advance = await pay(x, x.team.deepak, x.near.id, "30000", [{ docId: bill.id, amount: "10000" }]);
    expect(advance).toMatchObject({ allocatedPaise: 1_000_000, unallocatedPaise: 2_000_000 });
    expect((await getPayablesAgeing(db, { companyId: x.c, asOf: "2025-06-30" })).totalUnappliedPaise).toBe(2_000_000);

    const applied = await allocatePayment(db, { companyId: x.c, paymentId: advance.id, actorUserId: x.team.ravi, allocations: [{ docId: bill.id, amount: "15200" }] });
    expect(applied).toMatchObject({ allocatedPaise: 2_520_000, unallocatedPaise: 480_000 });
    expect(await getBill(db, { companyId: x.c, billId: bill.id })).toMatchObject({ outstandingPaise: 0 });
    await expectDomainError(allocatePayment(db, { companyId: x.c, paymentId: advance.id, actorUserId: x.team.ravi, allocations: [{ docId: bill.id, amount: "1" }] }), "OVER_ALLOCATION");
    expect((await getPayablesAgeing(db, { companyId: x.c, asOf: "2025-06-30" })).totalUnappliedPaise).toBe(480_000);
  });

  it("reverses a payment, re-opening the bill, with a reason and enough authority", async () => {
    const x = await buyingWorld(db, "PayReverse");
    const bill = await postedBill(x);
    const paid = await pay(x, x.team.deepak, x.near.id, "25200", [{ docId: bill.id, amount: "25200" }], { mode: "cheque", reference: "000123" });
    expect((await getBill(db, { companyId: x.c, billId: bill.id })).outstandingPaise).toBe(0);

    await expectDomainError(reversePayment(db, { companyId: x.c, paymentId: paid.id, actorUserId: x.team.asha, reason: "bounced" }), "INSUFFICIENT_AUTHORITY");
    await expectDomainError(reversePayment(db, { companyId: x.c, paymentId: paid.id, actorUserId: x.team.deepak, reason: " " }), "REASON_REQUIRED");
    const reversed = await reversePayment(db, { companyId: x.c, paymentId: paid.id, actorUserId: x.team.deepak, reason: "Cheque bounced" });
    expect(reversed).toMatchObject({ state: "reversed", reverseReason: "Cheque bounced", unallocatedPaise: 0 });
    expect(await getBill(db, { companyId: x.c, billId: bill.id })).toMatchObject({ paidPaise: 0, outstandingPaise: 2_520_000 });
    await expectDomainError(reversePayment(db, { companyId: x.c, paymentId: paid.id, actorUserId: x.team.deepak, reason: "again" }), "ALREADY_REVERSED");
    await expectDomainError(allocatePayment(db, { companyId: x.c, paymentId: paid.id, actorUserId: x.team.deepak, allocations: [{ docId: bill.id, amount: "1" }] }), "PAYMENT_REVERSED");

    // Paying again works, and the new payment takes the next number
    const again = await pay(x, x.team.deepak, x.near.id, "25200", [{ docId: bill.id, amount: "25200" }]);
    expect(again.number).toBe("PAY/25-26/00002");
  });

  it("can never be edited or deleted in the database, and allocations never exceed the payment", async () => {
    const x = await buyingWorld(db, "PayImmutable");
    const bill = await postedBill(x);
    const paid = await pay(x, x.team.deepak, x.near.id, "10000", [{ docId: bill.id, amount: "10000" }]);

    await expect(db.update(payments).set({ amountPaise: 1 }).where(eq(payments.id, paid.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("a recorded payment cannot be edited"),
    );
    await expect(db.delete(payments).where(eq(payments.id, paid.id))).rejects.toSatisfy((e) => errorText(e).includes("payments cannot be deleted"));
    await expect(db.update(paymentAllocations).set({ amountPaise: 1 }).where(eq(paymentAllocations.paymentId, paid.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("payment allocations cannot be changed or deleted"),
    );
    await expect(db.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, paid.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("payment allocations cannot be changed or deleted"),
    );
    await expect(
      db.insert(paymentAllocations).values({ companyId: x.c, paymentId: paid.id, docType: "purchase_bill", docId: crypto.randomUUID(), amountPaise: 1 }),
    ).rejects.toSatisfy((e) => errorText(e).includes("would exceed the payment"));
  });

  it("warns, without blocking, about large cash payments", async () => {
    const x = await buyingWorld(db, "PayCash");
    const cash = (amount: string, date = "2025-06-20") => pay(x, x.team.owner, x.near.id, amount, [], { mode: "cash", paymentDate: date });
    expect((await cash("6000")).warnings).toEqual([]);
    const second = await cash("6000"); // Rs 12,000 to the same supplier on the same day
    expect(second.warnings[0]).toContain("section 40A(3)");
    expect(second.state).toBe("posted"); // a warning, not an error
    expect((await cash("6000", "2025-06-21")).warnings).toEqual([]); // a different day starts again
  });
});

/** A company that sells: shirts in stock, a customer, and a posted invoice for 10 of them. */
async function sellingWorld(label: string) {
  const { company, owner } = await createCompany(db, {
    legalName: label,
    gstin: freshGstin("27"),
    owner: { email: `${label.toLowerCase().replace(/\W/g, "")}@sell.example`, name: "Owner" },
  });
  const c = company.id;
  const asha = await addMember(db, c, { email: `asha@${label.toLowerCase().replace(/\W/g, "")}.example`, role: "sales", limitRupees: 10_000 });
  const buyer = await createParty(db, { companyId: c, kind: "customer", name: "Harbor & Pine", gstin: freshGstin("27"), creditDays: 30 });
  await createItem(db, { companyId: c, sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS", hsnSac: "6205", gstRate: 18, salesPrice: "1000" });
  const stock = await createStockDocument(db, { companyId: c, docType: "goods_receipt", docDate: "2025-05-01", lines: [{ sku: "SHIRT", qty: 100, unitCost: "400" }] });
  await postStockDocument(db, { companyId: c, documentId: stock.id });

  const invoiceFor = async (qty: number, invoiceDate: string) => {
    const draft = await createSalesOrder(db, { companyId: c, customerId: buyer.id, orderDate: "2025-06-01", promisedDate: "2025-06-30", lines: [{ sku: "SHIRT", qty }] });
    const order = await confirmSalesOrder(db, { companyId: c, orderId: draft.id });
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: "2025-06-02" });
    const inv = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate });
    return postInvoice(db, { companyId: c, invoiceId: inv.id });
  };
  return { c, owner: owner.id, asha, buyer, invoiceFor };
}

const receive = (s: Awaited<ReturnType<typeof sellingWorld>>, amount: string, allocations: { docId: string; amount: string }[], extra: Record<string, unknown> = {}) =>
  recordPayment(db, {
    companyId: s.c,
    actorUserId: s.asha,
    direction: "received",
    partyId: s.buyer.id,
    paymentDate: "2025-06-25",
    amount,
    mode: "bank",
    allocations,
    ...extra,
  } as never);

describe("receiving money from customers", () => {
  it("settles an invoice net of credit notes, in parts, with no approval limit on receiving", async () => {
    const s = await sellingWorld("Receipts One");
    const invoice = await s.invoiceFor(10, "2025-06-05"); // 10 x Rs 1,000 + 18% = Rs 11,800
    expect(invoice).toMatchObject({ number: "INV/25-26/00001", totalPaise: 1_180_000, dueDate: "2025-07-05" });

    const first = await receive(s, "5000", [{ docId: invoice.id, amount: "5000" }]);
    expect(first).toMatchObject({ number: "RCT/25-26/00001", direction: "received", allocatedPaise: 500_000 });

    // A credit note for one shirt (Rs 1,180 with tax) reduces what is owed
    const credit = await createNote(db, { companyId: s.c, kind: "credit_note", originalInvoiceId: invoice.id, noteDate: "2025-06-20", reason: "One returned", lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 1000 }] });
    await postInvoice(db, { companyId: s.c, invoiceId: credit.id });
    let ageing = await getReceivablesAgeing(db, { companyId: s.c, asOf: "2025-07-20" });
    expect(ageing.totalOutstandingPaise).toBe(1_180_000 - 118_000 - 500_000); // Rs 5,620
    expect(ageing.parties[0]?.docs[0]).toMatchObject({ number: "INV/25-26/00001", creditedPaise: 118_000, paidPaise: 500_000, outstandingPaise: 562_000, daysOverdue: 15, bucket: "1_30" });

    await expectDomainError(receive(s, "5621", [{ docId: invoice.id, amount: "5621" }]), "OVER_ALLOCATION");
    await receive(s, "5620", [{ docId: invoice.id, amount: "5620" }]);
    ageing = await getReceivablesAgeing(db, { companyId: s.c, asOf: "2025-07-20" });
    expect(ageing.parties).toEqual([]);
  });

  it("only settles invoices of that customer, never credit notes, and not suppliers", async () => {
    const s = await sellingWorld("Receipts Two");
    const invoice = await s.invoiceFor(2, "2025-06-05");
    const credit = await createNote(db, { companyId: s.c, kind: "credit_note", originalInvoiceId: invoice.id, noteDate: "2025-06-20", reason: "Return", lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 1000 }] });
    const postedCredit = await postInvoice(db, { companyId: s.c, invoiceId: credit.id });
    await expectDomainError(receive(s, "100", [{ docId: postedCredit.id, amount: "100" }]), "NOT_PAYABLE");

    const other = await createParty(db, { companyId: s.c, kind: "customer", name: "Another Buyer", stateCode: "27" });
    await expectDomainError(receive(s, "100", [{ docId: invoice.id, amount: "100" }], { partyId: other.id }), "WRONG_PARTY");
    const vendor = await createParty(db, { companyId: s.c, kind: "supplier", name: "A Mill", stateCode: "29" });
    await expectDomainError(receive(s, "100", [], { partyId: vendor.id }), "WRONG_PARTY_KIND");
  });

  it("shows a credit balance when a credit note follows full payment, and an advance when more is received than is owed", async () => {
    const s = await sellingWorld("Receipts Three");
    const invoice = await s.invoiceFor(1, "2025-06-05"); // Rs 1,180
    await receive(s, "1180", [{ docId: invoice.id, amount: "1180" }]);
    const credit = await createNote(db, { companyId: s.c, kind: "credit_note", originalInvoiceId: invoice.id, noteDate: "2025-06-20", reason: "Price correction", lines: [{ invoiceLineNo: 1, qty: 1, unitPrice: 100 }] });
    await postInvoice(db, { companyId: s.c, invoiceId: credit.id }); // Rs 118 back to the customer
    await receive(s, "500", []); // Rs 500 on account

    const ageing = await getReceivablesAgeing(db, { companyId: s.c, asOf: "2025-07-20" });
    expect(ageing.parties).toHaveLength(1);
    expect(ageing.parties[0]).toMatchObject({ name: "Harbor & Pine", outstandingPaise: 0, creditBalancePaise: 11_800, unappliedPaise: 50_000, docs: [] });
    expect(ageing).toMatchObject({ totalOutstandingPaise: 0, totalCreditBalancePaise: 11_800, totalUnappliedPaise: 50_000 });
  });

  it("warns about large cash receipts", async () => {
    const s = await sellingWorld("Receipts Four");
    const small = await receive(s, "199999", [], { mode: "cash" });
    expect(small.warnings).toEqual([]);
    const big = await receive(s, "1", [], { mode: "cash", paymentDate: "2025-06-25" }); // same day: now Rs 2,00,000
    expect(big.warnings[0]).toContain("section 269ST");
  });

  it("re-opens the invoice when the receipt is reversed", async () => {
    const s = await sellingWorld("Receipts Five");
    const invoice = await s.invoiceFor(1, "2025-06-05"); // Rs 1,180
    const paid = await receive(s, "1180", [{ docId: invoice.id, amount: "1180" }]);
    expect((await getReceivablesAgeing(db, { companyId: s.c, asOf: "2025-07-20" })).parties).toEqual([]);
    await reversePayment(db, { companyId: s.c, paymentId: paid.id, actorUserId: s.owner, reason: "Bank returned it" });
    expect((await getReceivablesAgeing(db, { companyId: s.c, asOf: "2025-07-20" })).totalOutstandingPaise).toBe(118_000);
    expect((await getPayment(db, { companyId: s.c, paymentId: paid.id })).state).toBe("reversed");
  });

  it("says which invoice each part of a receipt went to", async () => {
    const s = await sellingWorld("Receipts Six");
    const invoice = await s.invoiceFor(1, "2025-06-05");
    const paid = await receive(s, "1180", [{ docId: invoice.id, amount: "1000" }]);
    const detail = await getPayment(db, { companyId: s.c, paymentId: paid.id });
    expect(detail.allocations).toHaveLength(1);
    expect(detail.allocations[0]).toMatchObject({ docId: invoice.id, amountPaise: 100_000, docNumber: invoice.number });
    expect(detail.unallocatedPaise).toBe(18_000);
  });
});

describe("payables ageing", () => {
  it("buckets what is owed by how overdue it is, and tracks the MSME 45-day limit", async () => {
    const w = await buyingWorld(db, "Ageing");
    // Mewar is a micro-enterprise (45-day limit) with 30 credit days; Patel gives 15 days
    const a = await postedBill(w, { supplierId: w.far.id, billDate: "2025-06-01" }); // Rs 25,200 due 2025-07-01
    const b = await postedBill(w, { supplierId: w.near.id, sku: "BTN", qty: 1000, unitPrice: 2, billDate: "2025-06-20" }); // Rs 2,360 due 2025-07-05
    expect([a.dueDate, b.dueDate]).toEqual(["2025-07-01", "2025-07-05"]);

    const at = (asOf: string) => getPayablesAgeing(db, { companyId: w.c, asOf });
    let ageing = await at("2025-06-30");
    expect(ageing.totalOutstandingPaise).toBe(2_756_000);
    expect(ageing.buckets).toEqual({ not_due: 2_756_000, "1_30": 0, "31_60": 0, "61_90": 0, over_90: 0 });
    expect(ageing.parties.map((p) => p.name)).toEqual(["Mewar Weaving Mills", "Patel Textiles"]); // largest first

    ageing = await at("2025-08-15");
    const mewar = ageing.parties[0];
    expect(mewar).toMatchObject({ isMsme: true, buckets: { "31_60": 2_520_000 } });
    expect(mewar?.docs[0]).toMatchObject({ daysOverdue: 45, bucket: "31_60", msmeDeadline: "2025-07-16", msmeBreached: true });
    expect(ageing.parties[1]?.docs[0]).toMatchObject({ daysOverdue: 41 });
    expect(ageing.parties[1]?.docs[0]?.msmeDeadline).toBeUndefined(); // not an MSME

    expect((await at("2025-09-15")).buckets["61_90"]).toBe(2_756_000);
    expect((await at("2025-10-15")).buckets.over_90).toBe(2_756_000);

    // A part payment reduces it; an advance to the other supplier is shown separately
    await pay(w, w.team.deepak, w.far.id, "10000", [{ docId: a.id, amount: "10000" }]);
    await pay(w, w.team.deepak, w.near.id, "5000", []);
    ageing = await at("2025-08-15");
    expect(ageing.parties[0]).toMatchObject({ name: "Mewar Weaving Mills", outstandingPaise: 1_520_000 });
    expect(ageing.parties[1]).toMatchObject({ name: "Patel Textiles", outstandingPaise: 236_000, unappliedPaise: 500_000 });
    expect(Object.values(ageing.buckets).reduce((s, v) => s + v, 0)).toBe(ageing.totalOutstandingPaise);
  });

  it("does not count a bill that has not been posted", async () => {
    const w = await buyingWorld(db, "AgeingHeld");
    const po = await receivedPo(db, w, { supplierId: w.near.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const draft = await createBill(db, { companyId: w.c, actorUserId: w.team.asha, purchaseOrderId: po.id, supplierBillNo: "X-1", billDate: "2025-06-12", lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 5 }] });
    await submitBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.asha }); // held: no GSTIN
    expect((await getPayablesAgeing(db, { companyId: w.c, asOf: "2025-08-15" })).parties).toEqual([]);
  });
});
