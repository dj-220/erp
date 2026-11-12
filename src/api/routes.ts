import type { Hono } from "hono";
import { z } from "zod";
import type { Role } from "../domain/approval";
import { DomainError } from "../domain/errors";
import { todayIST } from "../domain/fy";
import { type Action, type SheetName, can } from "../domain/permissions";
import { decideApproval, escalateApproval, listPendingApprovals } from "../server/approvals";
import { getCompany, updateCompanySettings } from "../server/company-settings";
import { cancelBill, createBill, CreateBillInput, getBill, listBills, overrideHeldBill, postBill, rejectHeldBill, submitBill } from "../server/bills";
import { createBom, CreateBomInput } from "../server/boms";
import { getDashboard } from "../server/dashboard";
import { buildExcel, buildTally, exportTally } from "../server/exports";
import { CreateStockDocumentInput, cancelStockDocument, createStockCount, createStockDocument, getStockDocument, postStockDocument } from "../server/inventory";
import { CreateInvoiceFromOrderInput, CreateNoteInput, cancelInvoice, createInvoiceFromOrder, createNote, getInvoice, postInvoice } from "../server/invoicing";
import { CreateItemInput, createItem } from "../server/items";
import { getPayablesAgeing, getReceivablesAgeing } from "../server/ledger-queries";
import {
  listAudit, listBoms, listItems, listParties, listPayments, listPurchaseOrders, listPurchaseRequests,
  listSalesInvoices, listSalesOrders, listStockDocuments, listUoms, listWarehouses,
} from "../server/lists";
import { CreatePartyInput, createParty } from "../server/parties";
import { CreatePlantAreaInput, MovePlantStockInput, createPlantArea, getPlantArea, getPlantBoard, listPlantAreas, movePlantStock, reorderPlantAreas, updatePlantArea } from "../server/plant";
import { PLANT_AREA_KINDS } from "../domain/plant";
import { RecordPaymentInput, allocatePayment, getPayment, recordPayment, reversePayment } from "../server/payments";
import {
  CreatePurchaseRequestInput, cancelPurchaseRequest, closePurchaseRequest, createPurchaseRequest, createRequestFromReorder,
  createRequestFromShortages, getPurchaseRequest, submitPurchaseRequest,
} from "../server/purchase-requests";
import {
  CreatePurchaseOrderInput, cancelPurchaseOrder, closePurchaseOrder, createPurchaseOrder, getPurchaseOrder,
  markPurchaseOrderSent, receivePurchaseOrder, submitPurchaseOrder,
} from "../server/purchasing";
import { CreateSalesOrderInput, cancelSalesOrder, closeSalesOrder, confirmSalesOrder, createSalesOrder, deliverSalesOrder } from "../server/sales";
import { getOrderRisks, getSalesOrder } from "../server/sales-queries";
import { ShortageInput, calculateShortages, getReorderSuggestions, getStockBalances, getStockValuation } from "../server/stock-queries";
import { AddMemberInput, addTeamMember, listTeam, removeTeamMember, resetMemberPassword, updateTeamMember } from "../server/team";
import type { AppContext, Env } from "./app";

/** What a handler knows about the request: the company and person always come from the session. */
interface Caller {
  db: AppContext["var"]["db"];
  companyId: string;
  userId: string;
  role: Role;
  limitPaise: number;
  today: string;
}

const Paging = { limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() };
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const Id = z.uuid();
const SHEETS: SheetName[] = ["parties", "items", "stock", "valuation", "sales_orders", "sales_invoices", "purchase_orders", "bills", "payments", "payables", "receivables"];

const jsonBody = async (c: AppContext) => c.req.json().catch(() => ({}));
/** Parse and validate the body; anything the client says about company or user is discarded by the schema. */
const body = async <S extends z.ZodType>(c: AppContext, schema: S): Promise<z.output<S>> => schema.parse(await jsonBody(c));
const query = <S extends z.ZodType>(c: AppContext, schema: S): z.output<S> => schema.parse(c.req.query());
const param = (c: AppContext, name: string): string => Id.parse(c.req.param(name));

type Method = "get" | "post" | "patch" | "delete";

export function registerBusinessRoutes(app: Hono<Env>) {
  function define(method: Method, path: string, action: Action, handler: (c: AppContext, who: Caller) => Promise<unknown>, status: 200 | 201 = 200) {
    app[method](`/api${path}`, async (c) => {
      const session = c.get("session");
      const role = session.role as Role;
      if (!can(role, action)) throw new DomainError("FORBIDDEN", "You do not have access to that");
      const result = await handler(c, {
        db: c.get("db"),
        companyId: session.companyId as string,
        userId: session.user.id,
        role,
        limitPaise: session.limitPaise,
        today: todayIST(c.get("now")()),
      });
      return result instanceof Response ? result : c.json(result as object, status);
    });
  }
  const acting = (who: Caller) => ({ companyId: who.companyId, actorUserId: who.userId });

  // ---------------------------------------------------------------- Dashboard
  define("get", "/dashboard", "dashboard.view", (_c, w) => getDashboard(w.db, { companyId: w.companyId, userId: w.userId, role: w.role, today: w.today }));

  // ---------------------------------------------------------------- Company and team
  define("get", "/company", "master.read", (_c, w) => getCompany(w.db, w.companyId));
  define("patch", "/company", "company.update", async (c, w) => updateCompanySettings(w.db, { ...acting(w), changes: await jsonBody(c) as never }));
  define("get", "/members", "member.read", (_c, w) => listTeam(w.db, w.companyId));
  define("post", "/members", "member.manage", async (c, w) => addTeamMember(w.db, { ...acting(w), ...(await body(c, AddMemberInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("patch", "/members/:userId", "member.manage", async (c, w) => {
    const changes = await body(c, z.object({ role: z.enum(["owner", "admin", "accountant", "purchase", "sales", "stores", "viewer"]).optional(), limitRupees: z.union([z.string(), z.number()]).optional() }));
    await updateTeamMember(w.db, { ...acting(w), userId: param(c, "userId"), ...changes });
    return { ok: true };
  });
  define("post", "/members/:userId/reset-password", "member.manage", async (c, w) => {
    await resetMemberPassword(w.db, { ...acting(w), userId: param(c, "userId"), ...(await body(c, z.object({ temporaryPassword: z.string().min(1) }))) });
    return { ok: true };
  });
  define("delete", "/members/:userId", "member.manage", async (c, w) => {
    await removeTeamMember(w.db, { ...acting(w), userId: param(c, "userId") });
    return { ok: true };
  });

  // ---------------------------------------------------------------- Master data
  define("get", "/parties", "master.read", (c, w) => listParties(w.db, { companyId: w.companyId, ...query(c, z.object({ kind: z.enum(["customer", "supplier"]).optional(), q: z.string().optional(), ...Paging })) }));
  define("post", "/parties", "party.write", async (c, w) => createParty(w.db, { ...acting(w), ...(await body(c, CreatePartyInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("get", "/items", "master.read", (c, w) => listItems(w.db, { companyId: w.companyId, ...query(c, z.object({ q: z.string().optional(), ...Paging })) }));
  define("post", "/items", "item.write", async (c, w) => createItem(w.db, { ...acting(w), ...(await body(c, CreateItemInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("get", "/uoms", "master.read", (_c, w) => listUoms(w.db, w.companyId));
  define("get", "/warehouses", "master.read", (_c, w) => listWarehouses(w.db, w.companyId));
  define("get", "/boms", "master.read", (_c, w) => listBoms(w.db, w.companyId));
  define("post", "/boms", "bom.write", async (c, w) => createBom(w.db, { ...acting(w), ...(await body(c, CreateBomInput.omit({ companyId: true, actorUserId: true }))) }), 201);

  // ---------------------------------------------------------------- Stock
  define("get", "/stock/balances", "stock.read", (c, w) => getStockBalances(w.db, { companyId: w.companyId, ...query(c, z.object({ sku: z.string().optional(), locationName: z.string().optional() })) }));
  define("get", "/stock/valuation", "stock.valuation", (_c, w) => getStockValuation(w.db, { companyId: w.companyId }));
  define("get", "/stock/reorder", "stock.read", (_c, w) => getReorderSuggestions(w.db, { companyId: w.companyId }));
  define("post", "/stock/shortages", "stock.read", async (c, w) => calculateShortages(w.db, { companyId: w.companyId, ...(await body(c, ShortageInput.omit({ companyId: true }))) }));
  define("get", "/stock/documents", "stock.read", (c, w) => listStockDocuments(w.db, { companyId: w.companyId, ...query(c, z.object({ docType: z.enum(["goods_receipt", "delivery", "transfer", "adjustment"]).optional(), state: z.enum(["draft", "done", "cancelled"]).optional(), ...Paging })) }));
  define("get", "/stock/documents/:id", "stock.read", (c, w) => getStockDocument(w.db, { companyId: w.companyId, documentId: param(c, "id") }));
  // Links to sales and purchase order lines are set only by the delivery and receipt flows, never by a client.
  const StockDocumentBody = CreateStockDocumentInput.omit({ companyId: true, actorUserId: true, salesOrderId: true, purchaseOrderId: true }).extend({
    lines: z.array(CreateStockDocumentInput.shape.lines.element.omit({ salesOrderLineId: true, purchaseOrderLineId: true, productionOrderId: true })).min(1),
    // Production entries are made by issuing material to a production order, which works out the quantities.
    docType: z.enum(["goods_receipt", "delivery", "transfer", "adjustment"]),
  });
  define("post", "/stock/documents", "stock.write", async (c, w) => createStockDocument(w.db, { ...acting(w), ...(await body(c, StockDocumentBody)) }), 201);
  define("post", "/stock/documents/:id/post", "stock.write", (c, w) => postStockDocument(w.db, { companyId: w.companyId, actorUserId: w.userId, documentId: param(c, "id") }));
  define("post", "/stock/documents/:id/cancel", "stock.write", (c, w) => cancelStockDocument(w.db, { companyId: w.companyId, actorUserId: w.userId, documentId: param(c, "id") }));
  define("post", "/stock/counts", "stock.write", async (c, w) => createStockCount(w.db, {
    ...acting(w),
    ...(await body(c, z.object({ docDate: DateStr, location: z.string().optional(), reference: z.string().optional(), counts: z.array(z.object({ sku: z.string(), countedQty: z.union([z.string(), z.number()]), unitCost: z.union([z.string(), z.number()]).optional() })).min(1) }))),
  }), 201);

  // ---------------------------------------------------------------- Factory floor
  define("get", "/plant/areas", "plant.read", (c, w) => listPlantAreas(w.db, { companyId: w.companyId, includeInactive: query(c, z.object({ all: z.string().optional() })).all === "1" }));
  define("get", "/plant/board", "plant.read", (_c, w) => getPlantBoard(w.db, { companyId: w.companyId }));
  define("get", "/plant/areas/:id", "plant.read", (c, w) => getPlantArea(w.db, { companyId: w.companyId, areaId: param(c, "id") }));
  define("post", "/plant/areas", "plant.manage", async (c, w) => createPlantArea(w.db, { ...acting(w), ...(await body(c, CreatePlantAreaInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("post", "/plant/areas/reorder", "plant.manage", async (c, w) => reorderPlantAreas(w.db, { ...acting(w), ...(await body(c, z.object({ areaIds: z.array(Id).min(1) }))) }));
  define("patch", "/plant/areas/:id", "plant.manage", async (c, w) =>
    updatePlantArea(w.db, { ...acting(w), areaId: param(c, "id"), ...(await body(c, z.object({ name: z.string().optional(), kind: z.enum(PLANT_AREA_KINDS).optional(), isActive: z.boolean().optional() }))) }));
  define("post", "/plant/moves", "plant.move", async (c, w) => movePlantStock(w.db, { ...acting(w), ...(await body(c, MovePlantStockInput.omit({ companyId: true, actorUserId: true }))) }), 201);

  // ---------------------------------------------------------------- Sales
  define("get", "/sales/board", "sales.read", (_c, w) => getOrderRisks(w.db, { companyId: w.companyId, today: w.today }));
  define("get", "/sales/orders", "sales.read", (c, w) => listSalesOrders(w.db, { companyId: w.companyId, ...query(c, z.object({ state: z.enum(["draft", "confirmed", "closed", "cancelled"]).optional(), q: z.string().optional(), ...Paging })) }));
  define("get", "/sales/orders/:id", "sales.read", (c, w) => getSalesOrder(w.db, { companyId: w.companyId, orderId: param(c, "id") }));
  define("post", "/sales/orders", "sales.write", async (c, w) => createSalesOrder(w.db, { ...acting(w), ...(await body(c, CreateSalesOrderInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("post", "/sales/orders/:id/confirm", "sales.write", (c, w) => confirmSalesOrder(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/sales/orders/:id/cancel", "sales.write", (c, w) => cancelSalesOrder(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/sales/orders/:id/close", "sales.write", (c, w) => closeSalesOrder(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/sales/orders/:id/deliver", "sales.deliver", async (c, w) =>
    deliverSalesOrder(w.db, {
      ...acting(w),
      orderId: param(c, "id"),
      ...(await body(c, z.object({ docDate: DateStr, fromLocation: z.string().optional(), lines: z.array(z.object({ lineNo: z.number().int().positive(), qty: z.union([z.string(), z.number()]) })).optional() }))),
    }), 201);
  define("post", "/sales/orders/:id/invoice", "sales.invoice", async (c, w) =>
    createInvoiceFromOrder(w.db, { ...acting(w), orderId: param(c, "id"), ...(await body(c, CreateInvoiceFromOrderInput.omit({ companyId: true, actorUserId: true, orderId: true }))) }), 201);
  define("get", "/sales/invoices", "sales.read", (c, w) => listSalesInvoices(w.db, { companyId: w.companyId, ...query(c, z.object({ kind: z.enum(["tax_invoice", "credit_note", "debit_note"]).optional(), state: z.enum(["draft", "posted", "cancelled"]).optional(), customerId: Id.optional(), q: z.string().optional(), ...Paging })) }));
  define("get", "/sales/invoices/:id", "sales.read", (c, w) => getInvoice(w.db, { companyId: w.companyId, invoiceId: param(c, "id") }));
  define("post", "/sales/invoices/:id/post", "sales.invoice", (c, w) => postInvoice(w.db, { companyId: w.companyId, actorUserId: w.userId, invoiceId: param(c, "id") }));
  define("post", "/sales/invoices/:id/cancel", "sales.invoice", (c, w) => cancelInvoice(w.db, { companyId: w.companyId, actorUserId: w.userId, invoiceId: param(c, "id") }));
  define("post", "/sales/invoices/:id/notes", "sales.invoice", async (c, w) =>
    createNote(w.db, { ...acting(w), originalInvoiceId: param(c, "id"), ...(await body(c, CreateNoteInput.omit({ companyId: true, actorUserId: true, originalInvoiceId: true }))) }), 201);

  // ---------------------------------------------------------------- Purchasing
  const requestStates = z.enum(["draft", "submitted", "closed", "cancelled"]);
  define("get", "/purchasing/requests", "purchase.read", (c, w) => listPurchaseRequests(w.db, { companyId: w.companyId, ...query(c, z.object({ state: requestStates.optional(), ...Paging })) }));
  define("get", "/purchasing/requests/:id", "purchase.read", (c, w) => getPurchaseRequest(w.db, { companyId: w.companyId, requestId: param(c, "id") }));
  define("post", "/purchasing/requests", "purchase.write", async (c, w) => createPurchaseRequest(w.db, { ...acting(w), ...(await body(c, CreatePurchaseRequestInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("post", "/purchasing/requests/from-shortages", "purchase.write", async (c, w) =>
    createRequestFromShortages(w.db, { ...acting(w), ...(await body(c, z.object({ requestDate: DateStr, neededBy: DateStr.optional(), notes: z.string().optional(), demands: ShortageInput.shape.demands }))) }), 201);
  define("post", "/purchasing/requests/from-reorder", "purchase.write", async (c, w) =>
    createRequestFromReorder(w.db, { ...acting(w), ...(await body(c, z.object({ requestDate: DateStr, neededBy: DateStr, notes: z.string().optional() }))) }), 201);
  define("post", "/purchasing/requests/:id/submit", "purchase.write", (c, w) => submitPurchaseRequest(w.db, { companyId: w.companyId, actorUserId: w.userId, requestId: param(c, "id") }));
  define("post", "/purchasing/requests/:id/cancel", "purchase.write", (c, w) => cancelPurchaseRequest(w.db, { companyId: w.companyId, actorUserId: w.userId, requestId: param(c, "id") }));
  define("post", "/purchasing/requests/:id/close", "purchase.write", (c, w) => closePurchaseRequest(w.db, { companyId: w.companyId, actorUserId: w.userId, requestId: param(c, "id") }));

  define("get", "/purchasing/orders", "purchase.read", (c, w) => listPurchaseOrders(w.db, { companyId: w.companyId, ...query(c, z.object({ state: z.enum(["draft", "pending_approval", "approved", "rejected", "sent", "closed", "cancelled"]).optional(), q: z.string().optional(), ...Paging })) }));
  define("get", "/purchasing/orders/:id", "purchase.read", (c, w) => getPurchaseOrder(w.db, { companyId: w.companyId, orderId: param(c, "id") }));
  define("post", "/purchasing/orders", "purchase.write", async (c, w) => createPurchaseOrder(w.db, { ...acting(w), ...(await body(c, CreatePurchaseOrderInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("post", "/purchasing/orders/:id/submit", "purchase.write", (c, w) => submitPurchaseOrder(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/purchasing/orders/:id/send", "purchase.write", (c, w) => markPurchaseOrderSent(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/purchasing/orders/:id/cancel", "purchase.write", (c, w) => cancelPurchaseOrder(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/purchasing/orders/:id/close", "purchase.write", (c, w) => closePurchaseOrder(w.db, { companyId: w.companyId, actorUserId: w.userId, orderId: param(c, "id") }));
  define("post", "/purchasing/orders/:id/receive", "purchase.receive", async (c, w) =>
    receivePurchaseOrder(w.db, {
      ...acting(w),
      orderId: param(c, "id"),
      ...(await body(c, z.object({ docDate: DateStr, supplierChallanRef: z.string().optional(), toLocation: z.string().optional(), lines: z.array(z.object({ lineNo: z.number().int().positive(), qty: z.union([z.string(), z.number()]) })).optional() }))),
    }), 201);

  define("get", "/approvals/pending", "approval.view", (_c, w) => listPendingApprovals(w.db, { companyId: w.companyId, forUserId: w.userId }));
  define("post", "/approvals/:id/decide", "approval.decide", async (c, w) =>
    decideApproval(w.db, { companyId: w.companyId, actorUserId: w.userId, requestId: param(c, "id"), ...(await body(c, z.object({ decision: z.enum(["approve", "reject"]), comment: z.string().optional() }))) }));
  define("post", "/approvals/:id/escalate", "approval.decide", (c, w) => escalateApproval(w.db, { companyId: w.companyId, actorUserId: w.userId, requestId: param(c, "id") }));

  // ---------------------------------------------------------------- Bills and payments
  define("get", "/bills", "bill.read", (c, w) => {
    const { states } = query(c, z.object({ states: z.string().optional() }));
    const allowed = ["draft", "held", "matched", "posted", "rejected", "cancelled"] as const;
    const list = (states ? states.split(",") : []).filter((s): s is (typeof allowed)[number] => (allowed as readonly string[]).includes(s));
    return listBills(w.db, { companyId: w.companyId, ...(list.length ? { states: list } : {}) });
  });
  define("get", "/bills/:id", "bill.read", (c, w) => getBill(w.db, { companyId: w.companyId, billId: param(c, "id") }));
  define("post", "/bills", "bill.write", async (c, w) => createBill(w.db, { ...acting(w), ...(await body(c, CreateBillInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("post", "/bills/:id/submit", "bill.write", (c, w) => submitBill(w.db, { companyId: w.companyId, actorUserId: w.userId, billId: param(c, "id") }));
  define("post", "/bills/:id/release", "bill.write", async (c, w) => overrideHeldBill(w.db, { ...acting(w), billId: param(c, "id"), ...(await body(c, z.object({ reason: z.string() }))) }));
  define("post", "/bills/:id/reject", "bill.write", async (c, w) => rejectHeldBill(w.db, { ...acting(w), billId: param(c, "id"), ...(await body(c, z.object({ reason: z.string() }))) }));
  define("post", "/bills/:id/cancel", "bill.write", (c, w) => cancelBill(w.db, { companyId: w.companyId, actorUserId: w.userId, billId: param(c, "id") }));
  define("post", "/bills/:id/post", "bill.post", (c, w) => postBill(w.db, { companyId: w.companyId, actorUserId: w.userId, billId: param(c, "id") }));

  define("get", "/payments", "payment.read", (c, w) => listPayments(w.db, { companyId: w.companyId, ...query(c, z.object({ direction: z.enum(["paid", "received"]).optional(), partyId: Id.optional(), ...Paging })) }));
  define("get", "/payments/:id", "payment.read", (c, w) => getPayment(w.db, { companyId: w.companyId, paymentId: param(c, "id") }));
  define("post", "/payments", "payment.write", async (c, w) => recordPayment(w.db, { ...acting(w), ...(await body(c, RecordPaymentInput.omit({ companyId: true, actorUserId: true }))) }), 201);
  define("post", "/payments/:id/allocate", "payment.write", async (c, w) =>
    allocatePayment(w.db, { companyId: w.companyId, actorUserId: w.userId, paymentId: param(c, "id"), ...(await body(c, z.object({ allocations: z.array(z.object({ docId: Id, amount: z.union([z.string(), z.number()]) })).min(1) }))) }));
  define("post", "/payments/:id/reverse", "payment.write", async (c, w) =>
    reversePayment(w.db, { companyId: w.companyId, actorUserId: w.userId, paymentId: param(c, "id"), ...(await body(c, z.object({ reason: z.string() }))) }));

  // ---------------------------------------------------------------- Reports and audit
  const asOf = z.object({ asOf: DateStr.optional() });
  define("get", "/reports/payables-ageing", "report.money", (c, w) => getPayablesAgeing(w.db, { companyId: w.companyId, asOf: query(c, asOf).asOf ?? w.today }));
  define("get", "/reports/receivables-ageing", "report.money", (c, w) => getReceivablesAgeing(w.db, { companyId: w.companyId, asOf: query(c, asOf).asOf ?? w.today }));
  define("get", "/audit", "audit.read", (c, w) => listAudit(w.db, { companyId: w.companyId, ...query(c, z.object({ entityType: z.string().optional(), entityId: z.string().optional(), ...Paging })) }));

  // ---------------------------------------------------------------- Exports
  define("get", "/exports/excel", "export.excel", async (c, w) => {
    const { sheets } = query(c, z.object({ sheets: z.string().optional() }));
    const wanted = !sheets || sheets === "all" ? SHEETS : sheets.split(",").map((s) => z.enum(SHEETS as [SheetName, ...SheetName[]]).parse(s.trim()));
    const file = await buildExcel(w.db, { companyId: w.companyId, sheets: wanted, asOf: w.today });
    return new Response(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="erp-export-${w.today}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  });
  const range = z.object({ from: DateStr, to: DateStr });
  define("get", "/exports/tally/preview", "export.tally", async (c, w) => {
    const build = await buildTally(w.db, { companyId: w.companyId, ...query(c, range) });
    return { from: build.from, to: build.to, voucherCount: build.voucherCount, counts: build.counts, warnings: build.warnings };
  });
  define("get", "/exports/tally/masters", "export.tally", async (c, w) => {
    const build = await buildTally(w.db, { companyId: w.companyId, ...query(c, range) });
    return new Response(build.mastersXml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="tally-masters-${w.today}.xml"` } });
  });
  define("post", "/exports/tally/vouchers", "export.tally", async (c, w) => {
    const done = await exportTally(w.db, { ...acting(w), ...(await body(c, range)) });
    return new Response(done.vouchersXml, {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Content-Disposition": `attachment; filename="tally-vouchers-${done.from}-to-${done.to}.xml"`,
        "X-Batch-Id": done.batchId,
        "X-Voucher-Count": String(done.voucherCount),
        "X-Warning-Count": String(done.warnings.length),
      },
    });
  });
}
