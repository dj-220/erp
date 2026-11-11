import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { type Db, openDb } from "../db/client";
import { approvalRequests, auditLog, locations, purchaseOrderLines, purchaseOrders, warehouses } from "../db/schema";
import { createBom } from "./boms";
import { decideApproval, escalateApproval, listPendingApprovals } from "./approvals";
import { createCompany } from "./company";
import { createStockDocument, postStockDocument } from "./inventory";
import { createItem } from "./items";
import { createParty } from "./parties";
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  submitPurchaseOrder,
} from "./purchasing";
import {
  cancelPurchaseRequest,
  closePurchaseRequest,
  createPurchaseRequest,
  createRequestFromReorder,
  createRequestFromShortages,
  getPurchaseRequest,
  submitPurchaseRequest,
} from "./purchase-requests";
import { confirmSalesOrder, createSalesOrder } from "./sales";
import { getOrderRisks } from "./sales-queries";
import { calculateShortages, getReorderSuggestions, getStockValuation } from "./stock-queries";
import { addMember, errorText, expectDomainError, freshGstin } from "./test-helpers";

let db: Db;
let seq = 0;

beforeAll(async () => {
  ({ db } = await openDb());
});

/** A company with a small team, each with a different approval limit. */
async function world(label: string) {
  seq += 1;
  const { company, owner } = await createCompany(db, {
    legalName: `${label} ${seq}`,
    gstin: freshGstin("27"),
    owner: { email: `owner${seq}@buy.example`, name: "Rajiv (owner)" },
  });
  const c = company.id;
  const team = {
    owner: owner.id,
    deepak: await addMember(db, c, { email: `deepak${seq}@buy.example`, name: "Deepak", role: "purchase", limitRupees: 100_000 }),
    asha: await addMember(db, c, { email: `asha${seq}@buy.example`, name: "Asha", role: "purchase", limitRupees: 10_000 }),
    ravi: await addMember(db, c, { email: `ravi${seq}@buy.example`, name: "Ravi", role: "accountant", limitRupees: 0 }),
    vik: await addMember(db, c, { email: `vik${seq}@buy.example`, name: "Vik", role: "viewer", limitRupees: 90_000_000 }),
  };
  const far = await createParty(db, { companyId: c, kind: "supplier", name: "Mewar Weaving Mills", gstin: freshGstin("29"), creditDays: 30 });
  const near = await createParty(db, { companyId: c, kind: "supplier", name: "Patel Textiles", gstin: freshGstin("27") });
  await createItem(db, { companyId: c, sku: "FAB", name: "Oxford fabric", kind: "raw_material", uomCode: "MTR", hsnSac: "5208", gstRate: 5, purchasePrice: "240" });
  await createItem(db, { companyId: c, sku: "BTN", name: "Button", kind: "raw_material", uomCode: "PCS", hsnSac: "9606", gstRate: 18, purchasePrice: "2" });
  return { c, team, far, near };
}

type World = Awaited<ReturnType<typeof world>>;

const order = (w: World, actor: string, supplier: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  createPurchaseOrder(db, {
    companyId: w.c,
    actorUserId: actor,
    supplierId: supplier,
    orderDate: "2025-06-01",
    expectedDate: "2025-06-20",
    lines,
    ...extra,
  } as never);

describe("a purchase order from draft to receipt", () => {
  let w: World;
  let poId: string; // Rs 25,200, above Asha's limit
  let approvalId: string;

  beforeAll(async () => {
    w = await world("Flow");
  });

  it("works out tax from the supplier's state and the delivery state", async () => {
    const po = await order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 100 }]);
    poId = po.id;
    expect(po).toMatchObject({
      state: "draft",
      number: null,
      supplierName: "Mewar Weaving Mills",
      supplyKind: "inter", // Karnataka supplier, Maharashtra warehouse
      placeOfSupplyStateCode: "27",
      taxableValuePaise: 2_400_000, // 100 m x Rs 240
      igstPaise: 120_000, // 5%
      cgstPaise: 0,
      totalPaise: 2_520_000,
    });
    expect(po.lines[0]).toMatchObject({ sku: "FAB", hsnSac: "5208", gstRate: "5.00", unitPrice: "240.0000", open: "100.000", received: "0.000" });

    const local = await order(w, w.team.asha, w.near.id, [{ sku: "BTN", qty: 1000 }]);
    expect(local).toMatchObject({ supplyKind: "intra", taxableValuePaise: 200_000, cgstPaise: 18_000, sgstPaise: 18_000, totalPaise: 236_000 });
  });

  it("sends it up to the next person whose limit covers it", async () => {
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: poId, actorUserId: w.team.asha });
    expect(po).toMatchObject({ state: "pending_approval", number: "PO/25-26/00001" });
    approvalId = po.approval?.id as string;
    // Asha's limit is Rs 10,000; Deepak's Rs 1,00,000 covers Rs 25,200. Vik is a viewer, Ravi has no limit.
    expect(po.approval).toMatchObject({ state: "pending", assignedTo: w.team.deepak, requestedBy: w.team.asha, amountPaise: 2_520_000, isAuto: false });

    const pending = await listPendingApprovals(db, { companyId: w.c, forUserId: w.team.deepak });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ docNumber: "PO/25-26/00001", supplierName: "Mewar Weaving Mills", requestedByName: "Asha", assignedToName: "Deepak", canDecide: true });
    const who = async (userId: string) => (await listPendingApprovals(db, { companyId: w.c, forUserId: userId }))[0]?.canDecide;
    expect(await who(w.team.owner)).toBe(true);
    expect(await who(w.team.asha)).toBe(false); // the requester
    expect(await who(w.team.ravi)).toBe(false); // limit too low
    expect(await who(w.team.vik)).toBe(false); // viewer
  });

  it("refuses the wrong people and enforces the rules in code", async () => {
    const decide = (actor: string, extra: Record<string, unknown> = {}) =>
      decideApproval(db, { companyId: w.c, requestId: approvalId, actorUserId: actor, decision: "approve", ...extra } as never);
    await expectDomainError(decide(w.team.asha), "SELF_APPROVAL");
    await expectDomainError(decide(w.team.ravi), "INSUFFICIENT_AUTHORITY");
    await expectDomainError(decide(w.team.vik), "INSUFFICIENT_AUTHORITY");
    await expectDomainError(decide(crypto.randomUUID()), "NOT_A_MEMBER");
    await expectDomainError(decide(w.team.deepak, { decision: "reject" }), "COMMENT_REQUIRED");
    // Still waiting after all those attempts
    expect((await getPurchaseOrder(db, { companyId: w.c, orderId: poId })).state).toBe("pending_approval");
  });

  it("cannot be received or sent before it is approved", async () => {
    await expectDomainError(receivePurchaseOrder(db, { companyId: w.c, orderId: poId, docDate: "2025-06-10" }), "NOT_RECEIVABLE");
    await expectDomainError(markPurchaseOrderSent(db, { companyId: w.c, orderId: poId }), "INVALID_TRANSITION");
  });

  it("is approved by someone with enough authority, once", async () => {
    const po = await decideApproval(db, { companyId: w.c, requestId: approvalId, actorUserId: w.team.deepak, decision: "approve", comment: "Go ahead" });
    expect(po.state).toBe("approved");
    expect(po.approvedAt).not.toBeNull();
    expect(po.approval).toMatchObject({ state: "approved", decidedBy: w.team.deepak, comment: "Go ahead", isAuto: false });
    await expectDomainError(
      decideApproval(db, { companyId: w.c, requestId: approvalId, actorUserId: w.team.owner, decision: "reject", comment: "changed my mind" }),
      "NOT_PENDING",
    );
    expect(await listPendingApprovals(db, { companyId: w.c })).toEqual([]);
  });

  it("receives goods in two parts, valued at the ordered price without GST", async () => {
    const first = await receivePurchaseOrder(db, { companyId: w.c, orderId: poId, docDate: "2025-06-10", lines: [{ lineNo: 1, qty: 40 }], supplierChallanRef: "MW-5521" });
    expect(first).toMatchObject({ number: "GRN/25-26/00001", state: "done", reference: "Order PO/25-26/00001 / MW-5521" });
    expect(first.lines[0]).toMatchObject({ sku: "FAB", from: "Vendors", to: "Main / Stock", qty: "40.000", unitCost: "240.0000", valuePaise: 960_000 });
    expect((await getPurchaseOrder(db, { companyId: w.c, orderId: poId })).lines[0]).toMatchObject({ received: "40.000", open: "60.000" });

    await expectDomainError(receivePurchaseOrder(db, { companyId: w.c, orderId: poId, docDate: "2025-06-11", lines: [{ lineNo: 1, qty: 61 }] }), "OVER_RECEIPT");
    await expectDomainError(receivePurchaseOrder(db, { companyId: w.c, orderId: poId, docDate: "2025-05-01" }), "RECEIPT_BEFORE_ORDER");
    await markPurchaseOrderSent(db, { companyId: w.c, orderId: poId }); // receiving still works once sent

    const rest = await receivePurchaseOrder(db, { companyId: w.c, orderId: poId, docDate: "2025-06-12" });
    expect(rest.number).toBe("GRN/25-26/00002");
    expect(rest.lines[0]?.qty).toBe("60.000");
    await expectDomainError(receivePurchaseOrder(db, { companyId: w.c, orderId: poId, docDate: "2025-06-13" }), "NOTHING_TO_RECEIVE");

    const valuation = await getStockValuation(db, { companyId: w.c });
    expect(valuation.rows).toEqual([{ sku: "FAB", name: "Oxford fabric", uom: "MTR", qty: "100.000", valuePaise: 2_400_000, avgCost: "240.0000" }]);
  });

  it("can be closed but not cancelled once goods have arrived", async () => {
    await expectDomainError(cancelPurchaseOrder(db, { companyId: w.c, orderId: poId }), "HAS_RECEIPTS");
    expect((await closePurchaseOrder(db, { companyId: w.c, orderId: poId })).state).toBe("closed");
    await expectDomainError(closePurchaseOrder(db, { companyId: w.c, orderId: poId }), "INVALID_TRANSITION");
  });

  it("keeps a full trail in the audit log", async () => {
    const log = await db.select().from(auditLog).where(and(eq(auditLog.companyId, w.c), eq(auditLog.entityId, poId)));
    expect(log.map((l) => l.action)).toEqual([
      "purchase_order.created",
      "purchase_order.submitted",
      "purchase_order.approved",
      "purchase_order.sent",
      "purchase_order.closed",
    ]);
  });
});

describe("approval limits and escalation", () => {
  it("approves at once, and says so, within the submitter's own limit", async () => {
    const w = await world("Auto");
    const small = await order(w, w.team.asha, w.near.id, [{ sku: "BTN", qty: 1000 }]); // Rs 2,360
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: small.id, actorUserId: w.team.asha });
    expect(po).toMatchObject({ state: "approved", number: "PO/25-26/00001" });
    expect(po.approval).toMatchObject({ state: "approved", isAuto: true, decidedBy: w.team.asha, assignedTo: null });
    const log = await db.select().from(auditLog).where(and(eq(auditLog.companyId, w.c), eq(auditLog.entityId, small.id)));
    expect(log.map((l) => l.action)).toContain("purchase_order.approved_automatically");
    // An owner is never held up, however large the order
    const big = await order(w, w.team.owner, w.far.id, [{ sku: "FAB", qty: 5000 }]);
    expect((await submitPurchaseOrder(db, { companyId: w.c, orderId: big.id, actorUserId: w.team.owner })).state).toBe("approved");
  });

  it("goes to the owner when it is above everyone else's limit, and the owner can reject it", async () => {
    const w = await world("Owner");
    const big = await order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 1000 }]); // Rs 2,52,000
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: big.id, actorUserId: w.team.asha });
    expect(po.approval?.assignedTo).toBe(w.team.owner);
    await expectDomainError(
      decideApproval(db, { companyId: w.c, requestId: po.approval?.id as string, actorUserId: w.team.deepak, decision: "approve" }),
      "INSUFFICIENT_AUTHORITY",
    );
    const rejected = await decideApproval(db, { companyId: w.c, requestId: po.approval?.id as string, actorUserId: w.team.owner, decision: "reject", comment: "Get a second quote" });
    expect(rejected).toMatchObject({ state: "rejected" });
    expect(rejected.approval).toMatchObject({ state: "rejected", comment: "Get a second quote", decidedBy: w.team.owner });
    // Rejected is final
    await expectDomainError(cancelPurchaseOrder(db, { companyId: w.c, orderId: big.id }), "INVALID_TRANSITION");
    await expectDomainError(receivePurchaseOrder(db, { companyId: w.c, orderId: big.id, docDate: "2025-06-10" }), "NOT_RECEIVABLE");
  });

  it("can be escalated up the chain, but only by the right people, and not past the top", async () => {
    const w = await world("Escalate");
    const mid = await order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 100 }]); // Rs 25,200: Deepak first
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: mid.id, actorUserId: w.team.asha });
    const requestId = po.approval?.id as string;
    expect(po.approval?.assignedTo).toBe(w.team.deepak);

    await expectDomainError(escalateApproval(db, { companyId: w.c, requestId, actorUserId: w.team.ravi }), "NOT_ALLOWED");
    const moved = await escalateApproval(db, { companyId: w.c, requestId, actorUserId: w.team.asha });
    expect(moved).toMatchObject({ assignedTo: w.team.owner, escalationCount: 1 });
    await expectDomainError(escalateApproval(db, { companyId: w.c, requestId, actorUserId: w.team.owner }), "NO_HIGHER_APPROVER");

    const pending = await listPendingApprovals(db, { companyId: w.c });
    expect(pending[0]).toMatchObject({ assignedToName: "Rajiv (owner)", escalationCount: 1 });
    expect((await decideApproval(db, { companyId: w.c, requestId, actorUserId: w.team.owner, decision: "approve" })).state).toBe("approved");
  });

  it("withdraws the approval request when the order is cancelled", async () => {
    const w = await world("Withdraw");
    const mid = await order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 100 }]);
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: mid.id, actorUserId: w.team.asha });
    await cancelPurchaseOrder(db, { companyId: w.c, orderId: mid.id });
    expect(await listPendingApprovals(db, { companyId: w.c })).toEqual([]);
    expect((await getPurchaseOrder(db, { companyId: w.c, orderId: mid.id })).approval?.state).toBe("cancelled");
    await expectDomainError(
      decideApproval(db, { companyId: w.c, requestId: po.approval?.id as string, actorUserId: w.team.owner, decision: "approve" }),
      "NOT_PENDING",
    );
  });

  it("only lets a company member submit", async () => {
    const w = await world("Outsider");
    const draft = await order(w, w.team.asha, w.near.id, [{ sku: "BTN", qty: 10 }]);
    await expectDomainError(submitPurchaseOrder(db, { companyId: w.c, orderId: draft.id, actorUserId: crypto.randomUUID() }), "NOT_A_MEMBER");
    await expectDomainError(order(w, crypto.randomUUID(), w.near.id, [{ sku: "BTN", qty: 10 }]), "NOT_A_MEMBER");
  });
});

describe("order rules", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("Rules");
    await createItem(db, { companyId: w.c, sku: "NOPRICE", name: "No price", kind: "raw_material", uomCode: "PCS" });
    await createItem(db, { companyId: w.c, sku: "SVC", name: "Job work", kind: "service", uomCode: "NOS" });
  });
  const one = (line: Record<string, unknown>, extra: Record<string, unknown> = {}, supplier = w.near.id) =>
    order(w, w.team.asha, supplier, [{ sku: "BTN", qty: 1, ...line }], extra);

  it("validates lines", async () => {
    await expectDomainError(one({ sku: "NOPE" }), "UNKNOWN_ITEM");
    await expectDomainError(one({ sku: "SVC" }), "NOT_STOCKED");
    await expectDomainError(one({ sku: "NOPRICE" }), "PRICE_REQUIRED");
    await expectDomainError(one({ unitPrice: -1 }), "INVALID_PRICE");
    await expectDomainError(one({ discountPct: 150 }), "INVALID_DISCOUNT");
    await expectDomainError(one({ gstRate: 12 }), "INVALID_GST_RATE");
    await expectDomainError(one({ qty: "1.5" }), "QTY_PRECISION");
    await expect(order(w, w.team.asha, w.near.id, [])).rejects.toThrow();
  });

  it("validates the supplier, dates and warehouse", async () => {
    await expectDomainError(one({}, { expectedDate: "2025-05-31" }), "EXPECTED_BEFORE_ORDER");
    await expectDomainError(one({}, { warehouseCode: "NOPE" }), "UNKNOWN_WAREHOUSE");
    await expectDomainError(one({}, {}, crypto.randomUUID()), "UNKNOWN_PARTY");
    const buyer = await createParty(db, { companyId: w.c, kind: "customer", name: "A Customer", stateCode: "27" });
    await expectDomainError(one({}, {}, buyer.id), "WRONG_PARTY_KIND");
    const sez = await createParty(db, { companyId: w.c, kind: "supplier", name: "SEZ Supplier", gstin: freshGstin("27"), registrationType: "sez" });
    await expectDomainError(one({}, {}, sez.id), "UNSUPPORTED_REGISTRATION");
    const abroad = await createParty(db, { companyId: w.c, kind: "supplier", name: "Overseas Mill", stateCode: "27", registrationType: "overseas" });
    await expectDomainError(one({}, {}, abroad.id), "UNSUPPORTED_REGISTRATION");
  });

  it("charges no GST on a purchase from an unregistered or composition supplier", async () => {
    const small = await createParty(db, { companyId: w.c, kind: "supplier", name: "Village Trader", stateCode: "27" });
    const po = await one({ qty: 100, unitPrice: 10 }, {}, small.id); // item says 18%
    expect(po.lines[0]?.gstRate).toBe("0.00");
    expect(po).toMatchObject({ taxableValuePaise: 100_000, totalPaise: 100_000, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  });

  it("applies a line discount before tax, and receives at the discounted cost", async () => {
    const draft = await order(w, w.team.owner, w.near.id, [{ sku: "FAB", qty: 100, unitPrice: 250, discountPct: 10 }]);
    expect(draft).toMatchObject({ taxableValuePaise: 2_250_000, totalPaise: 2_362_500 }); // 22,500 + 5%
    const approved = await submitPurchaseOrder(db, { companyId: w.c, orderId: draft.id, actorUserId: w.team.owner });
    const receipt = await receivePurchaseOrder(db, { companyId: w.c, orderId: approved.id, docDate: "2025-06-10" });
    expect(receipt.lines[0]).toMatchObject({ unitCost: "225.0000", valuePaise: 2_250_000 });
  });

  it("delivers to, and receives into, the warehouse the order was placed for", async () => {
    const north = (await db.insert(warehouses).values({ companyId: w.c, code: "NORTH", name: "North depot", stateCode: "29" }).returning())[0];
    await db.insert(locations).values({ companyId: w.c, warehouseId: north?.id as string, name: "North / Stock", kind: "internal", isPrimary: true });
    // Karnataka supplier delivering to a Karnataka warehouse: intra-state, even though the company is in Maharashtra
    const draft = await order(w, w.team.owner, w.far.id, [{ sku: "FAB", qty: 100 }], { warehouseCode: "NORTH" });
    expect(draft).toMatchObject({ placeOfSupplyStateCode: "29", supplyKind: "intra", cgstPaise: 60_000, sgstPaise: 60_000, igstPaise: 0, totalPaise: 2_520_000 });
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: draft.id, actorUserId: w.team.owner });
    const receipt = await receivePurchaseOrder(db, { companyId: w.c, orderId: po.id, docDate: "2025-06-10" });
    expect(receipt.lines[0]?.to).toBe("North / Stock");
  });

  it("freezes a submitted order in the database itself", async () => {
    const draft = await order(w, w.team.asha, w.near.id, [{ sku: "BTN", qty: 5 }]);
    const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: draft.id, actorUserId: w.team.owner });
    await expect(db.update(purchaseOrders).set({ expectedDate: "2025-12-31" }).where(eq(purchaseOrders.id, po.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("the terms of a submitted purchase order cannot be changed"),
    );
    await expect(db.update(purchaseOrderLines).set({ qty: "999" }).where(eq(purchaseOrderLines.orderId, po.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("lines of a approved purchase order cannot be changed"),
    );
    await expect(db.update(purchaseOrders).set({ state: "draft" }).where(eq(purchaseOrders.id, po.id))).rejects.toSatisfy((e) =>
      errorText(e).includes("cannot go from approved to draft"),
    );
    await expect(db.delete(purchaseOrders).where(eq(purchaseOrders.id, po.id))).rejects.toSatisfy((e) => errorText(e).includes("cannot be deleted"));
  });

  it("keeps decided approvals and the approval trail untouchable", async () => {
    const approval = (await db.select().from(approvalRequests).where(and(eq(approvalRequests.companyId, w.c), eq(approvalRequests.state, "approved"))))[0];
    expect(approval).toBeDefined();
    await expect(db.update(approvalRequests).set({ comment: "edited" }).where(eq(approvalRequests.id, approval?.id as string))).rejects.toSatisfy((e) =>
      errorText(e).includes("approved approval request cannot be changed"),
    );
    await expect(db.delete(approvalRequests).where(eq(approvalRequests.id, approval?.id as string))).rejects.toSatisfy((e) =>
      errorText(e).includes("approval requests cannot be deleted"),
    );
  });
});

describe("purchase requests", () => {
  let w: World;
  beforeAll(async () => {
    w = await world("Requests");
  });
  const request = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    createPurchaseRequest(db, { companyId: w.c, actorUserId: w.team.asha, requestDate: "2025-06-01", neededBy: "2025-06-20", lines, ...extra } as never);

  it("is ordered against in parts, and cannot be over-ordered", async () => {
    const draft = await request([{ sku: "FAB", qty: 100 }, { sku: "BTN", qty: 500 }]);
    expect(draft).toMatchObject({ state: "draft", number: null });
    // Not open for ordering until submitted
    await expectDomainError(order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 10, requestLineId: draft.lines[0]?.id }]), "REQUEST_NOT_OPEN");

    const submitted = await submitPurchaseRequest(db, { companyId: w.c, requestId: draft.id });
    expect(submitted).toMatchObject({ state: "submitted", number: "PR/25-26/00001" });
    const [fabLine, btnLine] = submitted.lines;

    await order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 60, requestLineId: fabLine?.id }]);
    let view = await getPurchaseRequest(db, { companyId: w.c, requestId: draft.id });
    expect(view.lines.map((l) => [l.sku, l.qty, l.ordered, l.stillToOrder])).toEqual([
      ["FAB", "100.000", "60.000", "40.000"],
      ["BTN", "500.000", "0.000", "500.000"],
    ]);
    await expectDomainError(order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 50, requestLineId: fabLine?.id }]), "OVER_REQUESTED");
    await expectDomainError(order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 5, requestLineId: btnLine?.id }]), "REQUEST_ITEM_MISMATCH");
    await expectDomainError(order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 5, requestLineId: crypto.randomUUID() }]), "UNKNOWN_REQUEST_LINE");
    await expect(order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 40, requestLineId: fabLine?.id }])).resolves.toBeDefined();
    view = await getPurchaseRequest(db, { companyId: w.c, requestId: draft.id });
    expect(view.lines[0]?.stillToOrder).toBe("0.000");

    await expectDomainError(cancelPurchaseRequest(db, { companyId: w.c, requestId: draft.id }), "HAS_ORDERS");
    expect((await closePurchaseRequest(db, { companyId: w.c, requestId: draft.id })).state).toBe("closed");
    await expectDomainError(closePurchaseRequest(db, { companyId: w.c, requestId: draft.id }), "NOT_SUBMITTED");
  });

  it("releases its quantity when the order against it is cancelled", async () => {
    const r = await submitPurchaseRequest(db, { companyId: w.c, requestId: (await request([{ sku: "BTN", qty: 100 }])).id });
    const po = await order(w, w.team.asha, w.near.id, [{ sku: "BTN", qty: 100, requestLineId: r.lines[0]?.id }]);
    expect((await getPurchaseRequest(db, { companyId: w.c, requestId: r.id })).lines[0]?.stillToOrder).toBe("0.000");
    await cancelPurchaseOrder(db, { companyId: w.c, orderId: po.id });
    expect((await getPurchaseRequest(db, { companyId: w.c, requestId: r.id })).lines[0]?.stillToOrder).toBe("100.000");
  });

  it("validates its input and can be cancelled as a draft", async () => {
    await expectDomainError(request([{ sku: "NOPE", qty: 1 }]), "UNKNOWN_ITEM");
    await expectDomainError(request([{ sku: "BTN", qty: "1.5" }]), "QTY_PRECISION");
    await expectDomainError(request([{ sku: "BTN", qty: 1 }], { neededBy: "2025-05-01" }), "NEEDED_BEFORE_REQUEST");
    await expectDomainError(request([{ sku: "BTN", qty: 1, preferredSupplierId: crypto.randomUUID() }]), "UNKNOWN_PARTY");
    const draft = await request([{ sku: "BTN", qty: 1 }]);
    await cancelPurchaseRequest(db, { companyId: w.c, requestId: draft.id });
    await expectDomainError(cancelPurchaseRequest(db, { companyId: w.c, requestId: draft.id }), "NOT_CANCELLABLE");
    await expectDomainError(submitPurchaseRequest(db, { companyId: w.c, requestId: draft.id }), "NOT_DRAFT");
  });
});

describe("what is on order changes what to buy", () => {
  it("counts approved orders that arrive in time, and ignores late or unapproved ones", async () => {
    const w = await world("OnOrder");
    const demands = [{ sku: "FAB", qty: 300, needBy: "2025-07-10" }];
    expect((await calculateShortages(db, { companyId: w.c, demands }))[0]?.qtyToBuy).toBe("300.000");

    // An order still waiting for approval is not a commitment
    const big = await order(w, w.team.asha, w.far.id, [{ sku: "FAB", qty: 100 }], { expectedDate: "2025-07-05" });
    const pending = await submitPurchaseOrder(db, { companyId: w.c, orderId: big.id, actorUserId: w.team.asha });
    expect(pending.state).toBe("pending_approval");
    expect((await calculateShortages(db, { companyId: w.c, demands }))[0]?.qtyToBuy).toBe("300.000");

    await decideApproval(db, { companyId: w.c, requestId: pending.approval?.id as string, actorUserId: w.team.deepak, decision: "approve" });
    expect((await calculateShortages(db, { companyId: w.c, demands }))[0]?.qtyToBuy).toBe("200.000");
    expect((await calculateShortages(db, { companyId: w.c, demands, includePurchaseOrders: false }))[0]?.qtyToBuy).toBe("300.000");

    // One arriving after the date it is needed does not help
    const late = await order(w, w.team.owner, w.far.id, [{ sku: "FAB", qty: 150 }], { expectedDate: "2025-07-25" });
    await submitPurchaseOrder(db, { companyId: w.c, orderId: late.id, actorUserId: w.team.owner });
    expect((await calculateShortages(db, { companyId: w.c, demands }))[0]?.qtyToBuy).toBe("200.000");
    // ...but does for a later demand
    expect((await calculateShortages(db, { companyId: w.c, demands: [{ sku: "FAB", qty: 300, needBy: "2025-07-30" }] }))[0]?.qtyToBuy).toBe("50.000");

    // Receiving part of an order leaves only the rest on order
    await receivePurchaseOrder(db, { companyId: w.c, orderId: big.id, docDate: "2025-07-02", lines: [{ lineNo: 1, qty: 100 }] });
    expect((await calculateShortages(db, { companyId: w.c, demands }))[0]?.qtyToBuy).toBe("200.000"); // now on hand instead
  });

  it("raises a purchase request from a shortage, and from reorder levels", async () => {
    const w = await world("FromShortage");
    const demands = [{ sku: "FAB", qty: 300, needBy: "2025-07-10" }];
    const covered = await order(w, w.team.owner, w.far.id, [{ sku: "FAB", qty: 100 }], { expectedDate: "2025-07-05" });
    await submitPurchaseOrder(db, { companyId: w.c, orderId: covered.id, actorUserId: w.team.owner });

    const pr = await createRequestFromShortages(db, { companyId: w.c, actorUserId: w.team.asha, requestDate: "2025-06-01", demands });
    expect(pr).toMatchObject({ state: "draft", neededBy: "2025-07-10" });
    expect(pr.lines.map((l) => [l.sku, l.qty])).toEqual([["FAB", "200.000"]]);
    await expectDomainError(
      createRequestFromShortages(db, { companyId: w.c, actorUserId: w.team.asha, requestDate: "2025-06-01", demands: [{ sku: "FAB", qty: 50, needBy: "2025-07-10" }] }),
      "NOTHING_SHORT",
    );

    await expectDomainError(createRequestFromReorder(db, { companyId: w.c, actorUserId: w.team.asha, requestDate: "2025-06-01", neededBy: "2025-06-10" }), "NOTHING_TO_REORDER");
    await createItem(db, { companyId: w.c, sku: "ZIP", name: "Zip", kind: "raw_material", uomCode: "PCS", reorderLevel: 50, reorderQty: 200 });
    const reorder = await createRequestFromReorder(db, { companyId: w.c, actorUserId: w.team.asha, requestDate: "2025-06-01", neededBy: "2025-06-10" });
    expect(reorder.lines.map((l) => [l.sku, l.qty])).toEqual([["ZIP", "200.000"]]);
  });

  it("stops suggesting a reorder once an approved order covers it", async () => {
    const w = await world("ReorderCovered");
    await createItem(db, { companyId: w.c, sku: "ZIP", name: "Zip", kind: "raw_material", uomCode: "PCS", purchasePrice: "5", reorderLevel: 50, reorderQty: 200 });
    expect((await getReorderSuggestions(db, { companyId: w.c })).map((r) => r.sku)).toEqual(["ZIP"]);
    const po = await order(w, w.team.owner, w.near.id, [{ sku: "ZIP", qty: 200 }]);
    expect((await getReorderSuggestions(db, { companyId: w.c })).map((r) => r.sku)).toEqual(["ZIP"]); // a draft is not on order
    await submitPurchaseOrder(db, { companyId: w.c, orderId: po.id, actorUserId: w.team.owner });
    expect(await getReorderSuggestions(db, { companyId: w.c })).toEqual([]);
  });

  it("lets an approved order rescue an at-risk sales order, if it arrives before the promise date", async () => {
    const w = await world("Board");
    const buyer = await createParty(db, { companyId: w.c, kind: "customer", name: "Harbor & Pine", gstin: freshGstin("27") });
    await createItem(db, { companyId: w.c, sku: "SHIRT", name: "Shirt", kind: "finished", uomCode: "PCS", hsnSac: "6205", gstRate: 18, salesPrice: "1000" });
    await createBom(db, { companyId: w.c, outputSku: "SHIRT", lines: [{ componentSku: "FAB", qty: "1.5", scrapPct: 10 }, { componentSku: "BTN", qty: 8 }] });
    const stock = await createStockDocument(db, { companyId: w.c, docType: "goods_receipt", docDate: "2025-05-01", lines: [{ sku: "FAB", qty: 100, unitCost: "240" }, { sku: "BTN", qty: 800, unitCost: "2" }] });
    await postStockDocument(db, { companyId: w.c, documentId: stock.id });
    // 50 shirts need 82.5 m of fabric; 100 m covers one order, not two
    for (const promised of ["2025-07-10", "2025-07-20"]) {
      const so = await createSalesOrder(db, { companyId: w.c, customerId: buyer.id, orderDate: "2025-06-01", promisedDate: promised, lines: [{ sku: "SHIRT", qty: 50 }] });
      await confirmSalesOrder(db, { companyId: w.c, orderId: so.id });
    }
    const status = async () => (await getOrderRisks(db, { companyId: w.c, today: "2025-07-01" })).map((r) => [r.promisedDate, r.status]);
    expect(await status()).toEqual([["2025-07-20", "at_risk"], ["2025-07-10", "on_time"]]);

    // 100 m more, but it will not arrive until after the second order is promised: no help
    const tooLate = await order(w, w.team.owner, w.far.id, [{ sku: "FAB", qty: 100 }], { expectedDate: "2025-07-25" });
    await submitPurchaseOrder(db, { companyId: w.c, orderId: tooLate.id, actorUserId: w.team.owner });
    expect(await status()).toEqual([["2025-07-20", "at_risk"], ["2025-07-10", "on_time"]]);

    // The same quantity arriving in time rescues it
    const inTime = await order(w, w.team.owner, w.far.id, [{ sku: "FAB", qty: 100 }], { expectedDate: "2025-07-12" });
    await submitPurchaseOrder(db, { companyId: w.c, orderId: inTime.id, actorUserId: w.team.owner });
    expect(await status()).toEqual([["2025-07-10", "on_time"], ["2025-07-20", "on_time"]]);
  });
});
