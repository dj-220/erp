import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { auditLog, companies, purchaseBillLines, purchaseBills } from "../db/schema";
import { cancelBill, createBill, getBill, listBills, overrideHeldBill, postBill, rejectHeldBill, submitBill } from "./bills";
import { createParty } from "./parties";
import { createPurchaseOrder, submitPurchaseOrder } from "./purchasing";
import { errorText, expectDomainError, freshGstin } from "./test-helpers";
import { type BuyingWorld, buyingWorld, receivedPo } from "./test-world";

let db: Db;

beforeAll(async () => {
  ({ db } = await openDb());
});

/** Record a bill as Asha, the buyer. */
const bill = (w: BuyingWorld, purchaseOrderId: string, extra: Record<string, unknown> = {}) =>
  createBill(db, {
    companyId: w.c,
    actorUserId: w.team.asha,
    purchaseOrderId,
    supplierBillNo: `MW/${Math.random().toString(36).slice(2, 8)}`,
    billDate: "2025-06-12",
    supplierGstin: w.far.gstin as string,
    lines: [{ poLineNo: 1, qty: 2500, unitPrice: 262, gstRate: 5 }],
    ...extra,
  } as never);

/** 2,500 m of fabric at Rs 262/m from the Karnataka supplier, all received. */
const fabricPo = (w: BuyingWorld, lines = [{ sku: "FAB", qty: 2500, unitPrice: 262 }]) =>
  receivedPo(db, w, { supplierId: w.far.id, lines });

describe("a bill that matches", () => {
  let w: BuyingWorld;
  let poId: string;
  let billId: string;

  beforeAll(async () => {
    w = await buyingWorld(db, "Clean");
    poId = (await fabricPo(w)).id;
  });

  it("is recorded as printed, with totals worked out when the paper bill is not to hand", async () => {
    const b = await bill(w, poId, { supplierBillNo: "MW/2025/0417" });
    billId = b.id;
    expect(b).toMatchObject({
      state: "draft",
      number: null,
      supplierName: "Mewar Weaving Mills",
      supplierBillNo: "MW/2025/0417",
      billDate: "2025-06-12",
      dueDate: "2025-07-12", // 30 credit days
      statedTaxablePaise: 65_500_000, // 2,500 x Rs 262
      statedIgstPaise: 3_275_000, // 5%, Karnataka to Maharashtra
      statedTotalPaise: 68_775_000,
    });
    expect(b.lines[0]).toMatchObject({ sku: "FAB", poLineNo: 1, qty: "2500.000", taxableValuePaise: 65_500_000 });
  });

  it("matches, and is posted with our own voucher number", async () => {
    const matched = await submitBill(db, { companyId: w.c, billId, actorUserId: w.team.asha });
    expect(matched).toMatchObject({ state: "matched", findings: [] });
    expect(matched.matchedAt).not.toBeNull();

    const posted = await postBill(db, { companyId: w.c, billId, actorUserId: w.team.ravi });
    expect(posted).toMatchObject({ state: "posted", number: "PB/25-26/00001", outstandingPaise: 68_775_000, paidPaise: 0 });
    const log = await db.select().from(auditLog).where(and(eq(auditLog.companyId, w.c), eq(auditLog.entityId, billId)));
    expect(log.map((l) => l.action)).toEqual(["purchase_bill.recorded", "purchase_bill.matched", "purchase_bill.posted"]);
  });

  it("cannot be recorded twice, however the number is typed", async () => {
    await expectDomainError(bill(w, poId, { supplierBillNo: "mw/2025/0417 " }), "DUPLICATE_BILL");
    await expectDomainError(bill(w, poId, { supplierBillNo: "MW/2025/0417" }), "DUPLICATE_BILL");
  });

  it("is frozen once posted", async () => {
    await expect(db.update(purchaseBills).set({ statedTotalPaise: 1 }).where(eq(purchaseBills.id, billId))).rejects.toSatisfy((e) =>
      errorText(e).includes("a posted purchase bill cannot be changed"),
    );
    await expect(db.update(purchaseBillLines).set({ qty: "1" }).where(eq(purchaseBillLines.billId, billId))).rejects.toSatisfy((e) =>
      errorText(e).includes("lines of a posted purchase bill cannot be changed"),
    );
    await expect(db.delete(purchaseBills).where(eq(purchaseBills.id, billId))).rejects.toSatisfy((e) => errorText(e).includes("cannot be deleted"));
    await expectDomainError(postBill(db, { companyId: w.c, billId, actorUserId: w.team.ravi }), "NOT_MATCHED");
    await expectDomainError(cancelBill(db, { companyId: w.c, billId, actorUserId: w.team.asha }), "NOT_CANCELLABLE");
    await expectDomainError(submitBill(db, { companyId: w.c, billId, actorUserId: w.team.asha }), "NOT_DRAFT");
  });
});

describe("the over-billed bill with no GSTIN", () => {
  let w: BuyingWorld;
  let poId: string;
  let billId: string;

  beforeAll(async () => {
    w = await buyingWorld(db, "Held");
    poId = (await fabricPo(w)).id;
  });

  it("is held for every reason, in plain words", async () => {
    // 2,550 m billed against 2,500 m received, no supplier GSTIN, Rs 13,100 too much
    const draft = await bill(w, poId, {
      supplierBillNo: "MW/2025/0501",
      supplierGstin: undefined,
      lines: [{ poLineNo: 1, qty: 2550, unitPrice: 262, gstRate: 5 }],
      stated: { taxable: "668100", igst: "33405", total: "701505" },
    });
    billId = draft.id;
    const held = await submitBill(db, { companyId: w.c, billId, actorUserId: w.team.asha });
    expect(held.state).toBe("held");
    expect(held.findings.map((f) => f.code)).toEqual(["GSTIN_MISSING", "QTY_OVER_RECEIVED", "AMOUNT_OVER_RECEIVED_VALUE"]);
    expect(held.findings[1]).toMatchObject({ line: 1, message: "FAB: billed 2550 but only 2500 received and not yet billed" });
    expect(held.findings[2]?.message).toContain("₹13,100.00 more");
    expect(held.matchedAt).toBeNull();
  });

  it("cannot be posted or paid while on hold, and shows up on the held list", async () => {
    await expectDomainError(postBill(db, { companyId: w.c, billId, actorUserId: w.team.ravi }), "NOT_MATCHED");
    await expectDomainError(cancelBill(db, { companyId: w.c, billId, actorUserId: w.team.asha }), "NOT_CANCELLABLE");
    const held = await listBills(db, { companyId: w.c, states: ["held"] });
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ supplierBillNo: "MW/2025/0501", totalPaise: 70_150_500, supplierName: "Mewar Weaving Mills" });
    expect(held[0]?.findings).toHaveLength(3);
  });

  it("is released only by someone with authority who did not enter it, and who says why", async () => {
    const release = (actor: string, reason = "Supplier confirmed the extra 50 m was delivered separately") =>
      overrideHeldBill(db, { companyId: w.c, billId, actorUserId: actor, reason });
    await expectDomainError(release(w.team.asha), "SELF_OVERRIDE"); // entered it
    await expectDomainError(release(w.team.ravi), "INSUFFICIENT_AUTHORITY"); // limit Rs 5,000
    await expectDomainError(release(w.team.deepak), "INSUFFICIENT_AUTHORITY"); // limit Rs 1,00,000 < Rs 7,01,505
    await expectDomainError(release(w.team.vik), "READ_ONLY");
    await expectDomainError(release(w.team.owner, "  "), "REASON_REQUIRED");
    expect((await getBill(db, { companyId: w.c, billId })).state).toBe("held");

    const released = await release(w.team.owner);
    expect(released).toMatchObject({ state: "matched", overriddenBy: w.team.owner, overrideReason: expect.stringContaining("extra 50 m") });
    expect(released.findings).toHaveLength(3); // the reasons stay on record
    const log = await db.select().from(auditLog).where(and(eq(auditLog.companyId, w.c), eq(auditLog.entityId, billId)));
    expect(log.map((l) => l.action)).toContain("purchase_bill.released_from_hold");
  });

  it("can then be posted, since a person has accepted it", async () => {
    const posted = await postBill(db, { companyId: w.c, billId, actorUserId: w.team.ravi });
    expect(posted).toMatchObject({ state: "posted", number: "PB/25-26/00001", outstandingPaise: 70_150_500 });
    await expectDomainError(overrideHeldBill(db, { companyId: w.c, billId, actorUserId: w.team.owner, reason: "again" }), "NOT_HELD");
  });
});

describe("rejecting a held bill", () => {
  it("asks the supplier for a corrected one, and lets the same number be entered again", async () => {
    const w = await buyingWorld(db, "Reject");
    const po = await fabricPo(w);
    const draft = await bill(w, po.id, { supplierBillNo: "MW/2025/0600", supplierGstin: undefined });
    await submitBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.asha });
    await expectDomainError(rejectHeldBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.asha, reason: "" }), "REASON_REQUIRED");
    const rejected = await rejectHeldBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.asha, reason: "Resend with your GSTIN printed" });
    expect(rejected).toMatchObject({ state: "rejected", rejectReason: "Resend with your GSTIN printed" });
    await expectDomainError(rejectHeldBill(db, { companyId: w.c, billId: draft.id, actorUserId: w.team.asha, reason: "again" }), "NOT_HELD");

    // The corrected bill arrives under the same number
    const corrected = await bill(w, po.id, { supplierBillNo: "MW/2025/0600" });
    expect((await submitBill(db, { companyId: w.c, billId: corrected.id, actorUserId: w.team.asha })).state).toBe("matched");
  });
});

describe("what the match catches", () => {
  let w: BuyingWorld;
  beforeAll(async () => {
    w = await buyingWorld(db, "Catches");
  });
  const run = async (po: { id: string }, extra: Record<string, unknown>) => {
    const b = await bill(w, po.id, extra);
    return submitBill(db, { companyId: w.c, billId: b.id, actorUserId: w.team.asha });
  };

  it("counts earlier bills against the goods received", async () => {
    const po = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 200, unitPrice: 240 }], receive: [{ lineNo: 1, qty: 100 }] });
    const first = await run(po, { lines: [{ poLineNo: 1, qty: 60, unitPrice: 240, gstRate: 5 }] });
    expect(first.state).toBe("matched");
    const second = await run(po, { lines: [{ poLineNo: 1, qty: 50, unitPrice: 240, gstRate: 5 }] });
    expect(second.state).toBe("held");
    expect(second.findings.find((f) => f.code === "QTY_OVER_RECEIVED")).toMatchObject({ expected: "40", actual: "50" });
    // Cancelling the first frees its quantity
    await cancelBill(db, { companyId: w.c, billId: first.id, actorUserId: w.team.asha });
    const third = await run(po, { lines: [{ poLineNo: 1, qty: 50, unitPrice: 240, gstRate: 5 }] });
    expect(third.state).toBe("matched");
  });

  it("holds a different price and a different GST rate", async () => {
    const po = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const dearer = await run(po, { lines: [{ poLineNo: 1, qty: 100, unitPrice: 250, gstRate: 5 }] });
    expect(dearer.findings.map((f) => f.code)).toEqual(["RATE_MISMATCH", "AMOUNT_OVER_RECEIVED_VALUE"]);
    const po2 = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const wrongRate = await run(po2, { lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 18 }] });
    expect(wrongRate.findings.map((f) => f.code)).toEqual(["GST_RATE_MISMATCH"]);
  });

  it("holds the wrong kind of tax, printed on the bill, which would cost input credit", async () => {
    const po = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    // Karnataka to Maharashtra is IGST; this bill charges CGST + SGST
    const held = await run(po, { lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 5 }], stated: { cgst: "600", sgst: "600" } });
    expect(held.findings.map((f) => f.code)).toEqual(["TAX_TYPE_MISMATCH"]);
  });

  it("holds a bill whose own arithmetic is wrong", async () => {
    const po = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const held = await run(po, { lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 5 }], stated: { taxable: "24000", igst: "1200", total: "25500" } });
    expect(held.findings.map((f) => f.code)).toEqual(["ARITHMETIC"]);
  });

  it("holds a different supplier's GSTIN, and tax charged by a supplier who may not charge it", async () => {
    const po = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const other = await run(po, { supplierGstin: freshGstin("29"), lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 5 }] });
    expect(other.findings.map((f) => f.code)).toEqual(["GSTIN_MISMATCH"]);

    const trader = await createParty(db, { companyId: w.c, kind: "supplier", name: "Village Trader", stateCode: "27" });
    const po2 = await receivedPo(db, w, { supplierId: trader.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const taxed = await run(po2, {
      supplierGstin: undefined,
      lines: [{ poLineNo: 1, qty: 100, unitPrice: 240, gstRate: 0 }],
      stated: { taxable: "24000", cgst: "1200", total: "25200" },
    });
    expect(taxed.findings.map((f) => f.code)).toEqual(["TAX_AMOUNT_MISMATCH"]);
  });

  it("honours the company's tolerances, and re-checks before posting", async () => {
    const po = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const dearer = { lines: [{ poLineNo: 1, qty: 100, unitPrice: 244, gstRate: 5 }] }; // 1.7% over
    expect((await run(po, dearer)).state).toBe("held");

    await db.update(companies).set({ billRateTolerancePct: "2" }).where(eq(companies.id, w.c));
    const po2 = await receivedPo(db, w, { supplierId: w.far.id, lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }] });
    const ok = await run(po2, dearer);
    expect(ok.state).toBe("matched");

    // The tolerance is tightened before the bill is posted: it no longer matches
    await db.update(companies).set({ billRateTolerancePct: "0" }).where(eq(companies.id, w.c));
    await expectDomainError(postBill(db, { companyId: w.c, billId: ok.id, actorUserId: w.team.ravi }), "MATCH_CHANGED");
  });
});

describe("recording a bill", () => {
  let w: BuyingWorld;
  let poId: string;
  beforeAll(async () => {
    w = await buyingWorld(db, "Rules");
    poId = (await fabricPo(w, [{ sku: "FAB", qty: 100, unitPrice: 240 }])).id;
  });
  const one = (extra: Record<string, unknown>) => bill(w, poId, { lines: [{ poLineNo: 1, qty: 10, unitPrice: 240, gstRate: 5 }], ...extra });

  it("validates the order, the people and the dates", async () => {
    await expectDomainError(one({ purchaseOrderId: crypto.randomUUID() }), "UNKNOWN_ORDER");
    await expectDomainError(one({ billDate: "2025-05-01" }), "BILL_BEFORE_ORDER");
    await expectDomainError(one({ billDate: "2025-02-30" }), "INVALID_DATE");
    await expectDomainError(one({ actorUserId: w.team.vik }), "READ_ONLY");
    await expectDomainError(one({ actorUserId: crypto.randomUUID() }), "NOT_A_MEMBER");
    // An order still waiting for approval cannot be billed
    const draft = await createPurchaseOrder(db, {
      companyId: w.c, actorUserId: w.team.asha, supplierId: w.far.id, orderDate: "2025-06-01", expectedDate: "2025-06-20", lines: [{ sku: "FAB", qty: 100, unitPrice: 240 }],
    });
    const pending = await submitPurchaseOrder(db, { companyId: w.c, orderId: draft.id, actorUserId: w.team.asha });
    expect(pending.state).toBe("pending_approval");
    await expectDomainError(bill(w, pending.id), "ORDER_NOT_BILLABLE");
  });

  it("validates the lines", async () => {
    const line = (l: Record<string, unknown>) => one({ lines: [{ poLineNo: 1, qty: 10, unitPrice: 240, gstRate: 5, ...l }] });
    await expectDomainError(line({ poLineNo: 9 }), "UNKNOWN_LINE");
    await expectDomainError(line({ qty: "1.2345" }), "QTY_PRECISION");
    await expectDomainError(line({ qty: 0 }), "INVALID_QTY");
    await expectDomainError(line({ unitPrice: -1 }), "INVALID_PRICE");
    await expectDomainError(line({ discountPct: 101 }), "INVALID_DISCOUNT");
    await expectDomainError(line({ gstRate: 150 }), "INVALID_GST_RATE");
    await expectDomainError(one({ lines: [{ poLineNo: 1, qty: 5, unitPrice: 240, gstRate: 5 }, { poLineNo: 1, qty: 5, unitPrice: 240, gstRate: 5 }] }), "DUPLICATE_LINE");
    await expect(one({ lines: [] })).rejects.toThrow();
  });

  it("applies a line discount before tax", async () => {
    const b = await one({ supplierBillNo: "DISC-1", lines: [{ poLineNo: 1, qty: 10, unitPrice: 240, discountPct: 10, gstRate: 5 }] });
    expect(b.lines[0]?.taxableValuePaise).toBe(216_000); // 10 x 240 less 10%
    expect(b.statedTaxablePaise).toBe(216_000);
  });

  it("can be discarded while it is a draft", async () => {
    const b = await one({ supplierBillNo: "DISCARD-1" });
    await cancelBill(db, { companyId: w.c, billId: b.id, actorUserId: w.team.asha });
    expect((await getBill(db, { companyId: w.c, billId: b.id })).state).toBe("cancelled");
  });

  it("is frozen against edits once submitted, whatever happens in the database", async () => {
    const b = await one({ supplierBillNo: "FREEZE-1", supplierGstin: undefined });
    const held = await submitBill(db, { companyId: w.c, billId: b.id, actorUserId: w.team.asha });
    expect(held.state).toBe("held");
    await expect(db.update(purchaseBills).set({ statedTotalPaise: 1 }).where(eq(purchaseBills.id, b.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("what a recorded purchase bill says cannot be changed"),
    );
    await expect(db.update(purchaseBills).set({ state: "posted" }).where(eq(purchaseBills.id, b.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot go from held to posted"),
    );
  });
});
