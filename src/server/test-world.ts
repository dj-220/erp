import type { Db } from "../db/client";
import { createCompany } from "./company";
import { createItem } from "./items";
import { createParty } from "./parties";
import { createPurchaseOrder, receivePurchaseOrder, submitPurchaseOrder } from "./purchasing";
import { addMember, freshGstin } from "./test-helpers";

let seq = 0;

/**
 * A small company for buying tests: an owner, a purchase manager (Rs 1,00,000 limit), a buyer
 * (Rs 10,000), an accountant (Rs 5,000) and a viewer, two suppliers (one in Karnataka and a
 * micro-enterprise, one in Maharashtra) and two raw materials.
 */
export async function buyingWorld(db: Db, label: string) {
  seq += 1;
  const { company, owner } = await createCompany(db, {
    legalName: `${label} ${seq}`,
    gstin: freshGstin("27"),
    owner: { email: `owner${seq}@world.example`, name: "Rajiv (owner)" },
  });
  const c = company.id;
  const team = {
    owner: owner.id,
    deepak: await addMember(db, c, { email: `deepak${seq}@world.example`, name: "Deepak", role: "purchase", limitRupees: 100_000 }),
    asha: await addMember(db, c, { email: `asha${seq}@world.example`, name: "Asha", role: "purchase", limitRupees: 10_000 }),
    ravi: await addMember(db, c, { email: `ravi${seq}@world.example`, name: "Ravi", role: "accountant", limitRupees: 5_000 }),
    vik: await addMember(db, c, { email: `vik${seq}@world.example`, name: "Vik", role: "viewer", limitRupees: 90_000_000 }),
  };
  const far = await createParty(db, { companyId: c, kind: "supplier", name: "Mewar Weaving Mills", gstin: freshGstin("29"), creditDays: 30, isMsme: true });
  const near = await createParty(db, { companyId: c, kind: "supplier", name: "Patel Textiles", gstin: freshGstin("27"), creditDays: 15 });
  await createItem(db, { companyId: c, sku: "FAB", name: "Oxford fabric", kind: "raw_material", uomCode: "MTR", hsnSac: "5208", gstRate: 5, purchasePrice: "240" });
  await createItem(db, { companyId: c, sku: "BTN", name: "Button", kind: "raw_material", uomCode: "PCS", hsnSac: "9606", gstRate: 18, purchasePrice: "2" });
  return { c, team, far, near };
}

export type BuyingWorld = Awaited<ReturnType<typeof buyingWorld>>;

/**
 * Raise a purchase order as the owner (so it is approved at once) and receive the goods.
 * Pass `receive` to take only part of the order, e.g. `[{ lineNo: 1, qty: 100 }]`.
 */
export async function receivedPo(
  db: Db,
  w: BuyingWorld,
  args: {
    supplierId: string;
    lines: Record<string, unknown>[];
    orderDate?: string;
    receiveDate?: string;
    receive?: { lineNo: number; qty: number }[];
  },
) {
  const draft = await createPurchaseOrder(db, {
    companyId: w.c,
    actorUserId: w.team.owner,
    supplierId: args.supplierId,
    orderDate: args.orderDate ?? "2025-06-01",
    expectedDate: "2025-06-20",
    lines: args.lines,
  } as never);
  const po = await submitPurchaseOrder(db, { companyId: w.c, orderId: draft.id, actorUserId: w.team.owner });
  await receivePurchaseOrder(db, {
    companyId: w.c,
    orderId: po.id,
    docDate: args.receiveDate ?? "2025-06-10",
    ...(args.receive ? { lines: args.receive } : {}),
  });
  return po;
}
