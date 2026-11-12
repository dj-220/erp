import { describe, expect, it } from "vitest";
import type { Role } from "./approval";
import { type Action, PERMISSIONS, can, canManageMember, dashboardSections } from "./permissions";

const ROLES: Role[] = ["owner", "admin", "accountant", "purchase", "sales", "stores", "viewer"];
const ACTIONS = Object.keys(PERMISSIONS) as Action[];

describe("permissions", () => {
  it("never lets a viewer change anything", () => {
    const writes = ACTIONS.filter((a) => PERMISSIONS[a].write);
    expect(writes.length).toBeGreaterThan(10);
    for (const action of writes) expect(can("viewer", action), action).toBe(false);
  });

  it("gives the owner every action", () => {
    for (const action of ACTIONS) expect(can("owner", action), action).toBe(true);
  });

  it("keeps the money, the audit trail and member management away from people who do not need them", () => {
    expect(can("sales", "payment.read")).toBe(false);
    expect(can("sales", "bill.read")).toBe(false);
    expect(can("stores", "report.money")).toBe(false);
    expect(can("purchase", "payment.write")).toBe(false);
    expect(can("purchase", "bill.post")).toBe(false);
    expect(can("viewer", "audit.read")).toBe(false);
    expect(can("accountant", "member.manage")).toBe(false);
    expect(can("accountant", "audit.read")).toBe(false);
  });

  it("gives each working role what its job needs", () => {
    expect(can("accountant", "bill.post")).toBe(true);
    expect(can("accountant", "export.tally")).toBe(true);
    expect(can("sales", "sales.write")).toBe(true);
    expect(can("sales", "sales.invoice")).toBe(true);
    expect(can("stores", "stock.write")).toBe(true);
    expect(can("stores", "purchase.receive")).toBe(true);
    expect(can("purchase", "purchase.write")).toBe(true);
    expect(can("purchase", "bill.write")).toBe(true);
    expect(can("admin", "member.manage")).toBe(true);
  });

  it("lets everyone open the dashboard", () => {
    for (const role of ROLES) expect(can(role, "dashboard.view")).toBe(true);
  });
});

describe("dashboardSections", () => {
  it("shows each role only the parts it may see", () => {
    expect(dashboardSections("owner")).toEqual(["orders", "stock", "purchasing", "bills", "money", "activity"]);
    expect(dashboardSections("admin")).toEqual(["orders", "stock", "purchasing", "bills", "money", "activity"]);
    expect(dashboardSections("accountant")).toEqual(["orders", "stock", "purchasing", "bills", "money"]);
    expect(dashboardSections("purchase")).toEqual(["orders", "stock", "purchasing", "bills"]);
    expect(dashboardSections("stores")).toEqual(["orders", "stock", "purchasing"]);
    expect(dashboardSections("sales")).toEqual(["orders"]);
    expect(dashboardSections("viewer")).toEqual(["orders", "stock"]);
  });
});

describe("canManageMember", () => {
  it("lets an owner manage anyone, and an admin manage everyone but owners", () => {
    expect(canManageMember("owner", "owner")).toBe(true);
    expect(canManageMember("owner", "sales", "owner")).toBe(true);
    expect(canManageMember("admin", "sales", "purchase")).toBe(true);
    expect(canManageMember("admin", "owner")).toBe(false);
    expect(canManageMember("admin", "sales", "owner")).toBe(false); // cannot make an owner
  });

  it("refuses everyone else", () => {
    for (const role of ["accountant", "purchase", "sales", "stores", "viewer"] as Role[]) {
      expect(canManageMember(role, "viewer")).toBe(false);
    }
  });
});
