import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { addDays } from "../domain/dates";
import { gstinChecksumChar } from "../domain/gstin";
import { registerAccount } from "../server/auth";
import { createBill, postBill, submitBill } from "../server/bills";
import { createBom } from "../server/boms";
import { createStockDocument, postStockDocument } from "../server/inventory";
import { createInvoiceFromOrder, createNote, postInvoice } from "../server/invoicing";
import { createItem } from "../server/items";
import { createParty } from "../server/parties";
import { recordPayment } from "../server/payments";
import { listPlantAreas, movePlantStock, updatePlantArea } from "../server/plant";
import { getStockBalances } from "../server/stock-queries";
import { createPurchaseOrder, receivePurchaseOrder, submitPurchaseOrder } from "../server/purchasing";
import { confirmSalesOrder, createSalesOrder, deliverSalesOrder } from "../server/sales";
import { addTeamMember } from "../server/team";

/**
 * A made-up garment factory with a few months of history, so every screen has something to show:
 * orders late, at risk and on time; bills held, matched and posted; approvals waiting; money owed
 * both ways. It is built through the real services, so it also exercises them. Everything is dated
 * relative to `today`, so the demo always looks current.
 *
 * These are DEMO credentials for a throwaway database. Never reuse them for a real company.
 */
export const DEMO_PASSWORD = "sunrise-demo-2025";
export const DEMO_COMPANY = "Sunrise Garments Pvt Ltd";

const gstin = (state: string, pan: string) => {
  const body = `${state}${pan}1Z`;
  return body + gstinChecksumChar(body);
};

export const DEMO_TEAM = [
  { key: "owner", email: "rajiv@sunrise.example", name: "Rajiv Mehta", role: "owner", limit: 0 },
  { key: "deepak", email: "deepak@sunrise.example", name: "Deepak Jain", role: "purchase", limit: 100_000 },
  { key: "asha", email: "asha@sunrise.example", name: "Asha Rao", role: "purchase", limit: 10_000 },
  { key: "ravi", email: "ravi@sunrise.example", name: "Ravi Nair", role: "accountant", limit: 50_000 },
  { key: "suman", email: "suman@sunrise.example", name: "Suman Kapoor", role: "sales", limit: 0 },
  { key: "imran", email: "imran@sunrise.example", name: "Imran Sheikh", role: "stores", limit: 0 },
  { key: "vik", email: "vikram@sunrise.example", name: "Vikram Shah", role: "viewer", limit: 0 },
] as const;

export type DemoPerson = (typeof DEMO_TEAM)[number]["key"];

export async function seedDemo(db: Db, today: string) {
  const d = (days: number) => addDays(today, days);
  const { companyId, userId: ownerId } = await registerAccount(db, {
    legalName: DEMO_COMPANY,
    gstin: gstin("27", "AAHCS4521K"),
    tallyCompanyName: DEMO_COMPANY,
    owner: { email: DEMO_TEAM[0].email, name: DEMO_TEAM[0].name, password: DEMO_PASSWORD },
  });
  const c = companyId;
  const people: Record<string, string> = { owner: ownerId };
  for (const p of DEMO_TEAM.slice(1)) {
    const added = await addTeamMember(db, { companyId: c, actorUserId: ownerId, email: p.email, name: p.name, role: p.role, limitRupees: p.limit, initialPassword: DEMO_PASSWORD });
    people[p.key] = added.userId;
  }
  // Demo logins are not asked to pick a new password.
  for (const id of Object.values(people)) await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, id));
  const { owner, deepak, asha, ravi } = people as Record<"owner" | "deepak" | "asha" | "ravi", string>;

  // ---- Customers and suppliers
  const customer = (name: string, state: string, pan: string, creditDays = 30) =>
    createParty(db, { companyId: c, kind: "customer", name, gstin: gstin(state, pan), creditDays, city: undefined });
  const supplier = (name: string, state: string, pan: string, creditDays: number, isMsme = false) =>
    createParty(db, { companyId: c, kind: "supplier", name, gstin: gstin(state, pan), creditDays, isMsme });
  const harbor = await customer("Harbor & Pine", "27", "AAHCH2310F");
  const nordlys = await customer("Nordlys Apparel", "29", "AAFCN7742Q");
  const marlow = await customer("Marlow & Co", "24", "AABFM5521L");
  await customer("Little Tern", "27", "AAICL9031D");
  const mewar = await supplier("Mewar Weaving Mills", "08", "AAGFM6120B", 30, true);
  const patel = await supplier("Patel Textiles", "24", "AAFCP3318R", 15);
  const shubh = await supplier("Shubh Fabrics", "24", "AAEFS8802J", 30);
  const om = await supplier("Om Buttons", "07", "AAJCO1170M", 15);
  await supplier("Shakti Poly", "27", "AABCS4410H", 15);

  // ---- Items and bills of materials
  const item = (sku: string, name: string, kind: "raw_material" | "finished", uomCode: string, hsnSac: string, gstRate: number, extra: Record<string, unknown> = {}) =>
    createItem(db, { companyId: c, sku, name, kind, uomCode, hsnSac, gstRate, ...extra } as never);
  await item("FAB-OXFORD", "Oxford fabric, blue", "raw_material", "MTR", "5208", 5, { purchasePrice: "235", reorderLevel: 2000, reorderQty: 3000 });
  await item("FAB-LINEN", "Linen blend fabric", "raw_material", "MTR", "5309", 5, { purchasePrice: "262", reorderLevel: 1000, reorderQty: 2000 });
  await item("BTN-14L", "Shirt button 14L", "raw_material", "PCS", "9606", 18, { purchasePrice: "0.42", reorderLevel: 30000, reorderQty: 30000 });
  await item("POLY-12X16", "Polybag 12x16", "raw_material", "PCS", "3923", 18, { purchasePrice: "1.30", reorderLevel: 25000, reorderQty: 20000 });
  await item("SHIRT-OXFORD", "Oxford button-down, blue", "finished", "PCS", "6205", 5, { salesPrice: "1450" });
  await item("SHIRT-CHAMBRAY", "Men's chambray shirt, sky", "finished", "PCS", "6205", 5, { salesPrice: "1250" });
  await item("SHIRT-LINEN", "Linen camp shirt", "finished", "PCS", "6205", 5, { salesPrice: "1350" });
  await item("DRESS-FLORAL", "Kids' floral dress", "finished", "PCS", "6104", 5, { salesPrice: "950" });
  await createBom(db, { companyId: c, outputSku: "SHIRT-OXFORD", lines: [{ componentSku: "FAB-OXFORD", qty: "1.6", scrapPct: 5 }, { componentSku: "BTN-14L", qty: 8 }, { componentSku: "POLY-12X16", qty: 1 }] });
  await createBom(db, { companyId: c, outputSku: "SHIRT-LINEN", lines: [{ componentSku: "FAB-LINEN", qty: "1.5", scrapPct: 5 }, { componentSku: "BTN-14L", qty: 8 }, { componentSku: "POLY-12X16", qty: 1 }] });

  // ---- Opening stock
  const opening = await createStockDocument(db, {
    companyId: c,
    actorUserId: owner,
    docType: "goods_receipt",
    docDate: d(-120),
    reference: "Opening stock",
    lines: [
      { sku: "FAB-OXFORD", qty: 3000, unitCost: "235" },
      { sku: "FAB-LINEN", qty: 1500, unitCost: "262" },
      { sku: "BTN-14L", qty: 40000, unitCost: "0.42" },
      { sku: "POLY-12X16", qty: 20000, unitCost: "1.30" },
      { sku: "SHIRT-CHAMBRAY", qty: 1200, unitCost: "640" },
      { sku: "SHIRT-LINEN", qty: 400, unitCost: "720" },
      { sku: "DRESS-FLORAL", qty: 600, unitCost: "410" },
    ],
  });
  await postStockDocument(db, { companyId: c, documentId: opening.id, actorUserId: owner });

  // ---- Sales history, oldest first (invoice numbers follow dates)
  const sell = async (customerId: string, sku: string, qty: number, orderDate: string, promisedDate: string, ship?: { deliver: string; invoice: string }) => {
    const draft = await createSalesOrder(db, { companyId: c, customerId, orderDate, promisedDate, lines: [{ sku, qty }] });
    const order = await confirmSalesOrder(db, { companyId: c, orderId: draft.id, actorUserId: owner });
    if (!ship) return { order, invoice: null };
    await deliverSalesOrder(db, { companyId: c, orderId: order.id, docDate: ship.deliver, actorUserId: owner });
    const draftInvoice = await createInvoiceFromOrder(db, { companyId: c, orderId: order.id, invoiceDate: ship.invoice, actorUserId: owner });
    return { order, invoice: await postInvoice(db, { companyId: c, invoiceId: draftInvoice.id, actorUserId: owner }) };
  };
  await sell(harbor.id, "SHIRT-CHAMBRAY", 300, d(-96), d(-90), { deliver: d(-94), invoice: d(-94) }); // never paid: long overdue
  const marlowSale = await sell(marlow.id, "SHIRT-LINEN", 200, d(-52), d(-45), { deliver: d(-50), invoice: d(-50) });
  const nordlysSale = await sell(nordlys.id, "DRESS-FLORAL", 300, d(-12), d(-8), { deliver: d(-10), invoice: d(-10) });
  await postInvoice(db, {
    companyId: c,
    invoiceId: (await createNote(db, { companyId: c, kind: "credit_note", originalInvoiceId: nordlysSale.invoice?.id as string, noteDate: d(-5), reason: "20 dresses returned: stitching fault", lines: [{ invoiceLineNo: 1, qty: 20, unitPrice: 950 }] })).id,
    actorUserId: owner,
  });
  await recordPayment(db, { companyId: c, actorUserId: ravi, direction: "received", partyId: marlow.id, paymentDate: d(-30), amount: "100000", mode: "bank", reference: "NEFT 88213", allocations: [{ docId: marlowSale.invoice?.id as string, amount: "100000" }] });

  // ---- Open orders: one late, one at risk, one that will make it
  await sell(nordlys.id, "SHIRT-CHAMBRAY", 1500, d(-20), d(-2));
  await sell(harbor.id, "SHIRT-OXFORD", 2400, d(-5), d(8));
  await sell(nordlys.id, "SHIRT-LINEN", 1100, d(-3), d(14));

  // ---- Purchasing
  const buy = async (supplierId: string, sku: string, qty: number, unitPrice: number, orderDate: string, expectedDate: string, actor: string, receiveOn?: string) => {
    const draft = await createPurchaseOrder(db, { companyId: c, actorUserId: actor, supplierId, orderDate, expectedDate, lines: [{ sku, qty, unitPrice }] });
    const po = await submitPurchaseOrder(db, { companyId: c, orderId: draft.id, actorUserId: actor });
    if (receiveOn) await receivePurchaseOrder(db, { companyId: c, orderId: po.id, docDate: receiveOn, actorUserId: owner });
    return po;
  };
  const billFor = async (poId: string, supplierBillNo: string, billDate: string, supplierGstin: string | null, line: { qty: number; unitPrice: number; gstRate: number }, stated?: Record<string, string>) =>
    createBill(db, { companyId: c, actorUserId: asha, purchaseOrderId: poId, supplierBillNo, billDate, ...(supplierGstin ? { supplierGstin } : {}), lines: [{ poLineNo: 1, ...line }], ...(stated ? { stated } : {}) });
  const settle = async (billId: string) => {
    await submitBill(db, { companyId: c, billId, actorUserId: asha });
    return postBill(db, { companyId: c, billId, actorUserId: ravi });
  };

  // Posted and part-paid; the supplier is a micro-enterprise, so its 45-day limit has passed
  const mewarPo = await buy(mewar.id, "FAB-OXFORD", 500, 230, d(-70), d(-62), owner, d(-62));
  const mewarBill = await settle((await billFor(mewarPo.id, "MW/25/0417", d(-62), mewar.gstin, { qty: 500, unitPrice: 230, gstRate: 5 })).id);
  await recordPayment(db, { companyId: c, actorUserId: deepak, direction: "paid", partyId: mewar.id, paymentDate: d(-20), amount: "100000", mode: "bank", reference: "UTR 4471", allocations: [{ docId: mewarBill.id, amount: "100000" }] });
  // Posted, a few days overdue; an advance was also paid on account
  const patelPo = await buy(patel.id, "BTN-14L", 20000, 0.44, d(-30), d(-22), owner, d(-21));
  await settle((await billFor(patelPo.id, "PT/1180", d(-20), patel.gstin, { qty: 20000, unitPrice: 0.44, gstRate: 18 })).id);
  await recordPayment(db, { companyId: c, actorUserId: deepak, direction: "paid", partyId: patel.id, paymentDate: d(-3), amount: "5000", mode: "upi", reference: "UPI 90112", allocations: [] });
  // Held: 2,550 m billed against 2,500 m received, no GSTIN on the bill
  const shubhPo = await buy(shubh.id, "FAB-LINEN", 2500, 262, d(-12), d(-8), owner, d(-8));
  const heldBill = await billFor(shubhPo.id, "SF/2025/118", d(-6), null, { qty: 2550, unitPrice: 262, gstRate: 5 }, { taxable: "668100", igst: "33405", total: "701505" });
  await submitBill(db, { companyId: c, billId: heldBill.id, actorUserId: asha });
  // Matched, waiting for the accountant to post it
  const omPo = await buy(om.id, "BTN-14L", 10000, 0.45, d(-10), d(-6), owner, d(-8));
  await submitBill(db, { companyId: c, billId: (await billFor(omPo.id, "OB-2201", d(-4), om.gstin, { qty: 10000, unitPrice: 0.45, gstRate: 18 })).id, actorUserId: asha });
  // On order, arriving after the at-risk order is promised
  await buy(mewar.id, "FAB-OXFORD", 3000, 236, d(-1), d(12), owner);
  // Waiting for approval: one for Deepak, one for the owner
  await buy(patel.id, "POLY-12X16", 40000, 1.3, d(-1), d(9), asha);
  await buy(mewar.id, "FAB-OXFORD", 1500, 235, d(0), d(14), asha);

  // The floor of a garment factory: rename two of the standard areas, switch off the two it has no use for
  const standard = await listPlantAreas(db, { companyId: c });
  const std = (name: string) => (standard.find((a) => a.name === name) as (typeof standard)[number]).id;
  await updatePlantArea(db, { companyId: c, actorUserId: owner, areaId: std("Machining"), name: "Stitching" });
  await updatePlantArea(db, { companyId: c, actorUserId: owner, areaId: std("Painting / Finishing"), name: "Finishing" });
  await updatePlantArea(db, { companyId: c, actorUserId: owner, areaId: std("Welding"), isActive: false });
  await updatePlantArea(db, { companyId: c, actorUserId: owner, areaId: std("Assembly"), isActive: false });
  const store = std("Raw Material Store");
  const cutting = std("Cutting");
  const stitching = std("Machining");
  const shift = (fromAreaId: string, toAreaId: string, sku: string, qty: string | number, docDate: string, post = true) =>
    movePlantStock(db, { companyId: c, actorUserId: owner, fromAreaId, toAreaId, docDate, lines: [{ sku, qty }], post });
  // Finished garments belong in the finished goods store, not with the raw material
  for (const b of await getStockBalances(db, { companyId: c })) {
    if (b.sku.startsWith("SHIRT-") || b.sku.startsWith("DRESS-")) await shift(store, std("Finished Goods"), b.sku, b.qty, d(-1));
  }
  // Work in progress: linen issued to cutting, part of it on to stitching, a little rejected
  await shift(store, cutting, "FAB-LINEN", 600, d(-2));
  await shift(cutting, stitching, "FAB-LINEN", 250, d(-1));
  await shift(stitching, std("Scrap / Rework"), "FAB-LINEN", 12, d(0));
  // Sent to cutting but not yet confirmed as received there
  await shift(store, cutting, "FAB-OXFORD", 300, d(0), false);

  return { companyId: c, people };
}
