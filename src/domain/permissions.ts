import type { Role } from "./approval";

/**
 * Who may do what. This is the single table the API consults; nothing else decides access.
 * Approval authority is separate: it also depends on the person's limit and is checked by the
 * service doing the approving. `write` marks actions that change data, so that read-only roles
 * can be proven never to have one.
 */
const ALL: readonly Role[] = ["owner", "admin", "accountant", "purchase", "sales", "stores", "viewer"];
const MANAGERS: readonly Role[] = ["owner", "admin"];
const FINANCE: readonly Role[] = ["owner", "admin", "accountant"];

export const PERMISSIONS = {
  // Everyone
  "dashboard.view": { roles: ALL, write: false },
  "master.read": { roles: ALL, write: false },
  "stock.read": { roles: ALL, write: false },
  "sales.read": { roles: ALL, write: false },
  "purchase.read": { roles: ALL, write: false },

  // Master data
  "party.write": { roles: ["owner", "admin", "accountant", "purchase", "sales"], write: true },
  "item.write": { roles: ["owner", "admin", "purchase", "stores"], write: true },
  "bom.write": { roles: ["owner", "admin", "purchase", "stores"], write: true },

  // Stock
  "stock.write": { roles: ["owner", "admin", "stores", "purchase"], write: true },
  "stock.valuation": { roles: FINANCE, write: false },

  // The factory floor: areas, what is in each, and moving material between them
  "plant.read": { roles: ALL, write: false },
  "plant.move": { roles: ["owner", "admin", "stores", "purchase"], write: true },
  "plant.manage": { roles: MANAGERS, write: true },

  // Sales
  "sales.write": { roles: ["owner", "admin", "sales"], write: true },
  "sales.deliver": { roles: ["owner", "admin", "sales", "stores"], write: true },
  "sales.invoice": { roles: ["owner", "admin", "accountant", "sales"], write: true },

  // Purchasing
  "purchase.write": { roles: ["owner", "admin", "purchase"], write: true },
  "purchase.receive": { roles: ["owner", "admin", "purchase", "stores"], write: true },
  "approval.view": { roles: ["owner", "admin", "accountant", "purchase"], write: false },
  // Deciding also needs a limit that covers the amount; the approval service checks that.
  "approval.decide": { roles: ["owner", "admin", "accountant", "purchase", "sales", "stores"], write: true },

  // Bills and money
  "bill.read": { roles: ["owner", "admin", "accountant", "purchase"], write: false },
  "bill.write": { roles: ["owner", "admin", "accountant", "purchase"], write: true },
  "bill.post": { roles: FINANCE, write: true },
  "payment.read": { roles: FINANCE, write: false },
  "payment.write": { roles: FINANCE, write: true },
  "report.money": { roles: FINANCE, write: false },

  // Exports
  "export.excel": { roles: FINANCE, write: false },
  "export.tally": { roles: FINANCE, write: true },

  // Administration
  "audit.read": { roles: MANAGERS, write: false },
  "member.read": { roles: FINANCE, write: false },
  "member.manage": { roles: MANAGERS, write: true },
  "company.update": { roles: MANAGERS, write: true },
} as const satisfies Record<string, { roles: readonly Role[]; write: boolean }>;

export type Action = keyof typeof PERMISSIONS;

export function can(role: Role, action: Action): boolean {
  return (PERMISSIONS[action].roles as readonly Role[]).includes(role);
}

/** The parts of the dashboard a role may see; the server leaves out the rest, it does not just hide them. */
export type DashboardSection = "orders" | "stock" | "purchasing" | "bills" | "money" | "activity";

const SECTIONS: Record<DashboardSection, readonly Role[]> = {
  orders: ALL,
  stock: ["owner", "admin", "stores", "purchase", "accountant", "viewer"],
  purchasing: ["owner", "admin", "purchase", "accountant", "stores"],
  bills: ["owner", "admin", "accountant", "purchase"],
  money: FINANCE,
  activity: MANAGERS,
};

export function dashboardSections(role: Role): DashboardSection[] {
  return (Object.keys(SECTIONS) as DashboardSection[]).filter((s) => SECTIONS[s].includes(role));
}

/** The sheets of the Excel export. */
export type SheetName =
  | "parties"
  | "items"
  | "stock"
  | "valuation"
  | "sales_orders"
  | "sales_invoices"
  | "purchase_orders"
  | "bills"
  | "payments"
  | "payables"
  | "receivables";

/** Roles that may change the role or limit of a member: owners are managed by owners only. */
export function canManageMember(actor: Role, target: Role, newRole?: Role): boolean {
  if (!can(actor, "member.manage")) return false;
  if (actor === "owner") return true;
  return target !== "owner" && newRole !== "owner";
}
