import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * Conventions
 *  - Money is bigint paise (never numeric rupees). Quantities and rates are numeric.
 *  - Every business table has company_id. A "company" is one legal entity with one GSTIN and is
 *    the isolation boundary between customers of the product.
 *  - Each referenced table exposes UNIQUE (company_id, id) and children use a composite foreign
 *    key (company_id, x_id), so the database itself refuses a link across companies.
 */

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const roleEnum = pgEnum("role", ["owner", "admin", "accountant", "purchase", "sales", "stores", "viewer"]);
export const partyKindEnum = pgEnum("party_kind", ["customer", "supplier", "both"]);
export const gstRegistrationEnum = pgEnum("gst_registration", [
  "regular",
  "composition",
  "unregistered",
  "consumer",
  "sez",
  "overseas",
]);
export const itemKindEnum = pgEnum("item_kind", [
  "raw_material",
  "semi_finished",
  "finished",
  "trading",
  "consumable",
  "service",
]);
export const locationKindEnum = pgEnum("location_kind", [
  "internal",
  "supplier",
  "customer",
  "production",
  "adjustment",
  "transit",
]);

export const salesOrderStateEnum = pgEnum("sales_order_state", ["draft", "confirmed", "closed", "cancelled"]);
export const salesInvoiceKindEnum = pgEnum("sales_invoice_kind", ["tax_invoice", "credit_note", "debit_note"]);
export const salesInvoiceStateEnum = pgEnum("sales_invoice_state", ["draft", "posted", "cancelled"]);
export const purchaseRequestStateEnum = pgEnum("purchase_request_state", ["draft", "submitted", "closed", "cancelled"]);
export const purchaseOrderStateEnum = pgEnum("purchase_order_state", [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "sent",
  "closed",
  "cancelled",
]);
export const approvalStateEnum = pgEnum("approval_state", ["pending", "approved", "rejected", "cancelled"]);
export const billStateEnum = pgEnum("bill_state", ["draft", "held", "matched", "posted", "rejected", "cancelled"]);
export const paymentDirectionEnum = pgEnum("payment_direction", ["paid", "received"]);
export const paymentModeEnum = pgEnum("payment_mode", ["bank", "cash", "upi", "cheque", "card", "other"]);
export const paymentStateEnum = pgEnum("payment_state", ["posted", "reversed"]);
export const stockDocTypeEnum = pgEnum("stock_doc_type", ["goods_receipt", "delivery", "transfer", "adjustment", "production"]);
export const productionOrderStateEnum = pgEnum("production_order_state", ["draft", "released", "closed", "cancelled"]);
export const stockStateEnum = pgEnum("stock_state", ["draft", "done", "cancelled"]);

const GSTIN_SHAPE = sql`'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'`;

/* ------------------------------------------------------------------ Foundations */

export const companies = pgTable(
  "companies",
  {
    id: id(),
    legalName: text("legal_name").notNull(),
    tradeName: text("trade_name"),
    gstin: text("gstin"),
    pan: text("pan"),
    /** GST state code of the principal place of business. */
    stateCode: char("state_code", { length: 2 }).notNull(),
    addressLine: text("address_line"),
    city: text("city"),
    pincode: text("pincode"),
    phone: text("phone"),
    email: text("email"),
    /** Must equal the company name open in TallyPrime, or imports are rejected. */
    tallyCompanyName: text("tally_company_name"),
    /**
     * Many small factories receive goods before the purchase entry is made. When true, stock may
     * go negative instead of blocking the delivery; when false (default) it is refused.
     */
    allowNegativeStock: boolean("allow_negative_stock").notNull().default(false),
    /** How far a supplier's bill may exceed the order before it is held. Defaults allow only rounding. */
    billRateTolerancePct: numeric("bill_rate_tolerance_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    billQtyTolerancePct: numeric("bill_qty_tolerance_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    billAmountTolerancePaise: bigint("bill_amount_tolerance_paise", { mode: "number" }).notNull().default(100),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("companies_gstin_uq").on(t.gstin).where(sql`${t.gstin} IS NOT NULL`),
    check("companies_gstin_shape", sql`${t.gstin} IS NULL OR ${t.gstin} ~ ${GSTIN_SHAPE}`),
    check("companies_gstin_matches_state", sql`${t.gstin} IS NULL OR left(${t.gstin}, 2) = ${t.stateCode}`),
  ],
);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash"),
    isActive: boolean("is_active").notNull().default(true),
    /** Consecutive wrong passwords; reset by a successful login. */
    failedLoginCount: smallint("failed_login_count").notNull().default(0),
    /** After too many wrong passwords the account is locked until this time. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Set when an administrator chose the password; the person should replace it. */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    check("users_email_lower", sql`${t.email} = lower(${t.email})`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: roleEnum("role").notNull(),
    /**
     * Largest single purchase this person may approve, in paise. Owners are unlimited
     * (decided in code); everyone else defaults to 0 = cannot approve spend.
     */
    approvalLimitPaise: bigint("approval_limit_paise", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("memberships_company_user_uq").on(t.companyId, t.userId),
    check("memberships_limit_nonneg", sql`${t.approvalLimitPaise} >= 0`),
  ],
);

/** Append-only. UPDATE, DELETE and TRUNCATE are blocked by a trigger (see drizzle/ migrations). */
export const auditLog = pgTable("audit_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  actorUserId: uuid("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const numberSeries = pgTable(
  "number_series",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    docType: text("doc_type").notNull(),
    /** Financial year label, e.g. "2025-26". A new year starts a new series at 1. */
    fy: text("fy").notNull(),
    prefix: text("prefix").notNull(),
    padding: smallint("padding").notNull().default(5),
    nextSerial: integer("next_serial").notNull().default(1),
  },
  (t) => [
    unique("number_series_company_doc_fy_uq").on(t.companyId, t.docType, t.fy),
    check("number_series_next_positive", sql`${t.nextSerial} >= 1`),
  ],
);

/* ------------------------------------------------------------------ Master data */

export const parties = pgTable(
  "parties",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    kind: partyKindEnum("kind").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    gstin: text("gstin"),
    pan: text("pan"),
    registrationType: gstRegistrationEnum("registration_type").notNull(),
    /** Place of supply for sales / state of the vendor for purchases. */
    stateCode: char("state_code", { length: 2 }).notNull(),
    addressLine: text("address_line"),
    city: text("city"),
    pincode: text("pincode"),
    email: text("email"),
    phone: text("phone"),
    creditDays: integer("credit_days").notNull().default(0),
    /** MSME suppliers must be paid within the statutory window; drives payables alerts later. */
    isMsme: boolean("is_msme").notNull().default(false),
    udyamNo: text("udyam_no"),
    /** Ledger name used when exporting vouchers to Tally. Defaults to `name`. */
    tallyLedgerName: text("tally_ledger_name"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("parties_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("parties_company_gstin_uq").on(t.companyId, t.gstin).where(sql`${t.gstin} IS NOT NULL`),
    check("parties_gstin_shape", sql`${t.gstin} IS NULL OR ${t.gstin} ~ ${GSTIN_SHAPE}`),
    check("parties_gstin_matches_state", sql`${t.gstin} IS NULL OR left(${t.gstin}, 2) = ${t.stateCode}`),
    check("parties_credit_days_nonneg", sql`${t.creditDays} >= 0`),
  ],
);

/** Units of measure, with the GST "unit quantity code" used on e-invoices. */
export const uoms = pgTable(
  "uoms",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    uqc: text("uqc").notNull(),
    /** Decimal places allowed on quantities of this unit (0 for pieces, 3 for kg/m). */
    decimals: smallint("decimals").notNull().default(3),
  },
  (t) => [
    unique("uoms_company_id_uq").on(t.companyId, t.id),
    unique("uoms_company_code_uq").on(t.companyId, t.code),
    check("uoms_decimals_range", sql`${t.decimals} BETWEEN 0 AND 6`),
  ],
);

export const items = pgTable(
  "items",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    kind: itemKindEnum("kind").notNull(),
    /** HSN (goods) or SAC (services), 4, 6 or 8 digits. */
    hsnSac: text("hsn_sac"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull().default("0"),
    uomId: uuid("uom_id").notNull(),
    salesPrice: numeric("sales_price", { precision: 18, scale: 4 }),
    purchasePrice: numeric("purchase_price", { precision: 18, scale: 4 }),
    trackBatch: boolean("track_batch").notNull().default(false),
    reorderLevel: numeric("reorder_level", { precision: 18, scale: 3 }).notNull().default("0"),
    reorderQty: numeric("reorder_qty", { precision: 18, scale: 3 }).notNull().default("0"),
    /** Stock item name used when exporting to Tally. Defaults to `name`. */
    tallyItemName: text("tally_item_name"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("items_company_id_uq").on(t.companyId, t.id),
    unique("items_company_sku_uq").on(t.companyId, t.sku),
    foreignKey({
      name: "items_uom_fk",
      columns: [t.companyId, t.uomId],
      foreignColumns: [uoms.companyId, uoms.id],
    }),
    check("items_hsn_shape", sql`${t.hsnSac} IS NULL OR ${t.hsnSac} ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'`),
    check("items_rate_range", sql`${t.gstRate} BETWEEN 0 AND 100`),
    check("items_reorder_nonneg", sql`${t.reorderLevel} >= 0 AND ${t.reorderQty} >= 0`),
  ],
);

export const warehouses = pgTable(
  "warehouses",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    stateCode: char("state_code", { length: 2 }).notNull(),
    addressLine: text("address_line"),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    unique("warehouses_company_id_uq").on(t.companyId, t.id),
    unique("warehouses_company_code_uq").on(t.companyId, t.code),
  ],
);

/**
 * Stock lives in locations. Besides real shelves ("internal"), virtual locations model the
 * outside world (supplier, customer, production, adjustment), so every stock movement is a
 * balanced transfer from one location to another, the way Odoo does it.
 */
export const locations = pgTable(
  "locations",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** Null for virtual locations that sit outside any warehouse. */
    warehouseId: uuid("warehouse_id"),
    name: text("name").notNull(),
    kind: locationKindEnum("kind").notNull(),
    /**
     * The warehouse's primary stock location: where receipts land and deliveries leave from when
     * nobody names a location. At most one per warehouse, set explicitly, never inferred from names.
     */
    isPrimary: boolean("is_primary").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    unique("locations_company_id_uq").on(t.companyId, t.id),
    unique("locations_company_name_uq").on(t.companyId, t.name),
    uniqueIndex("locations_one_primary_per_warehouse_uq").on(t.warehouseId).where(sql`${t.isPrimary}`),
    check("locations_primary_is_internal", sql`NOT ${t.isPrimary} OR ${t.kind} = 'internal'`),
    foreignKey({
      name: "locations_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }),
    check("locations_internal_has_warehouse", sql`${t.kind} <> 'internal' OR ${t.warehouseId} IS NOT NULL`),
  ],
);

export const boms = pgTable(
  "boms",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** The item this bill of materials produces. */
    itemId: uuid("item_id").notNull(),
    version: integer("version").notNull().default(1),
    /** How many units of the item one run of this BOM yields. */
    outputQty: numeric("output_qty", { precision: 18, scale: 3 }).notNull().default("1"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("boms_company_id_uq").on(t.companyId, t.id),
    unique("boms_company_item_version_uq").on(t.companyId, t.itemId, t.version),
    foreignKey({
      name: "boms_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    check("boms_output_positive", sql`${t.outputQty} > 0`),
  ],
);

export const bomLines = pgTable(
  "bom_lines",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    bomId: uuid("bom_id").notNull(),
    componentItemId: uuid("component_item_id").notNull(),
    /** Quantity of the component needed per `boms.output_qty` units produced. */
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    /** Expected wastage, percent of qty. */
    scrapPct: numeric("scrap_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  },
  (t) => [
    unique("bom_lines_bom_component_uq").on(t.bomId, t.componentItemId),
    foreignKey({
      name: "bom_lines_bom_fk",
      columns: [t.companyId, t.bomId],
      foreignColumns: [boms.companyId, boms.id],
    }),
    foreignKey({
      name: "bom_lines_component_fk",
      columns: [t.companyId, t.componentItemId],
      foreignColumns: [items.companyId, items.id],
    }),
    check("bom_lines_qty_positive", sql`${t.qty} > 0`),
    check("bom_lines_scrap_range", sql`${t.scrapPct} >= 0 AND ${t.scrapPct} < 100`),
  ],
);

/* ------------------------------------------------------------------ Sales */

/**
 * A customer order. Draft -> confirmed (takes its number) -> closed or cancelled. Once confirmed
 * it cannot be edited (database trigger); what was delivered and invoiced is derived from the
 * stock moves and invoice lines that point at its lines, never stored on the order.
 */
export const salesOrders = pgTable(
  "sales_orders",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    number: text("number"),
    state: salesOrderStateEnum("state").notNull().default("draft"),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    promisedDate: date("promised_date", { mode: "string" }).notNull(),
    customerId: uuid("customer_id").notNull(),
    /** The buyer's own purchase order number. */
    customerPoRef: text("customer_po_ref"),
    /** Place of supply for goods: the state they are delivered to. */
    shipToStateCode: char("ship_to_state_code", { length: 2 }).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("sales_orders_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("sales_orders_number_uq").on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    foreignKey({
      name: "sales_orders_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    check("sales_orders_draft_has_no_number", sql`${t.state} <> 'draft' OR ${t.number} IS NULL`),
    check("sales_orders_confirmed_has_number", sql`${t.state} NOT IN ('confirmed', 'closed') OR ${t.number} IS NOT NULL`),
    check("sales_orders_promise_after_order", sql`${t.promisedDate} >= ${t.orderDate}`),
  ],
);

export const salesOrderLines = pgTable(
  "sales_order_lines",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    orderId: uuid("order_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    /** Copied from the item when the line is created, so later master-data edits do not change history. */
    hsnSac: text("hsn_sac"),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
  },
  (t) => [
    unique("sales_order_lines_company_id_uq").on(t.companyId, t.id),
    unique("sales_order_lines_order_line_uq").on(t.orderId, t.lineNo),
    foreignKey({
      name: "sales_order_lines_order_fk",
      columns: [t.companyId, t.orderId],
      foreignColumns: [salesOrders.companyId, salesOrders.id],
    }),
    foreignKey({
      name: "sales_order_lines_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    check("sales_order_lines_qty_positive", sql`${t.qty} > 0`),
    check("sales_order_lines_price_nonneg", sql`${t.unitPrice} >= 0`),
    check("sales_order_lines_discount_range", sql`${t.discountPct} BETWEEN 0 AND 100`),
  ],
);

/**
 * Tax invoice, credit note or debit note. Amounts and the customer's details are copied onto it
 * when it is created, so it stays exactly as issued whatever happens to the master data later.
 * Posting takes the legal number. A posted document can never change; correct it with a note.
 */
export const salesInvoices = pgTable(
  "sales_invoices",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    kind: salesInvoiceKindEnum("kind").notNull(),
    number: text("number"),
    state: salesInvoiceStateEnum("state").notNull().default("draft"),
    invoiceDate: date("invoice_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    customerId: uuid("customer_id").notNull(),
    salesOrderId: uuid("sales_order_id"),
    /** Credit and debit notes point at the tax invoice they correct. */
    originalInvoiceId: uuid("original_invoice_id"),
    reason: text("reason"),
    // Parties as they were on the day of issue.
    supplierGstin: text("supplier_gstin"),
    supplierStateCode: char("supplier_state_code", { length: 2 }).notNull(),
    placeOfSupplyStateCode: char("place_of_supply_state_code", { length: 2 }).notNull(),
    customerName: text("customer_name").notNull(),
    customerGstin: text("customer_gstin"),
    customerStateCode: char("customer_state_code", { length: 2 }).notNull(),
    /** "intra" = CGST + SGST/UTGST, "inter" = IGST. */
    supplyKind: text("supply_kind").notNull(),
    taxableValuePaise: bigint("taxable_value_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    utgstPaise: bigint("utgst_paise", { mode: "number" }).notNull(),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull(),
    cessPaise: bigint("cess_paise", { mode: "number" }).notNull(),
    roundOffPaise: bigint("round_off_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("sales_invoices_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("sales_invoices_number_uq")
      .on(t.companyId, t.kind, t.number)
      .where(sql`${t.number} IS NOT NULL`),
    index("sales_invoices_order_idx").on(t.companyId, t.salesOrderId),
    foreignKey({
      name: "sales_invoices_customer_fk",
      columns: [t.companyId, t.customerId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      name: "sales_invoices_order_fk",
      columns: [t.companyId, t.salesOrderId],
      foreignColumns: [salesOrders.companyId, salesOrders.id],
    }),
    foreignKey({
      name: "sales_invoices_original_fk",
      columns: [t.companyId, t.originalInvoiceId],
      foreignColumns: [t.companyId, t.id],
    }),
    check("sales_invoices_number_iff_posted", sql`(${t.state} = 'posted') = (${t.number} IS NOT NULL)`),
    check("sales_invoices_posted_at_iff_posted", sql`(${t.state} = 'posted') = (${t.postedAt} IS NOT NULL)`),
    check("sales_invoices_note_has_original", sql`(${t.kind} = 'tax_invoice') = (${t.originalInvoiceId} IS NULL)`),
    check("sales_invoices_supply_kind", sql`${t.supplyKind} IN ('intra', 'inter')`),
    check("sales_invoices_due_after_invoice", sql`${t.dueDate} >= ${t.invoiceDate}`),
    check(
      "sales_invoices_total_adds_up",
      sql`${t.taxableValuePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.utgstPaise} + ${t.igstPaise} + ${t.cessPaise} + ${t.roundOffPaise} = ${t.totalPaise}`,
    ),
  ],
);

export const salesInvoiceLines = pgTable(
  "sales_invoice_lines",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    invoiceId: uuid("invoice_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    hsnSac: text("hsn_sac").notNull(),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
    taxableValuePaise: bigint("taxable_value_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    utgstPaise: bigint("utgst_paise", { mode: "number" }).notNull(),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull(),
    cessPaise: bigint("cess_paise", { mode: "number" }).notNull(),
    /** The order line this bills, for invoices raised from an order. */
    salesOrderLineId: uuid("sales_order_line_id"),
    /** The invoice line a credit or debit note line corrects. */
    originalLineId: uuid("original_line_id"),
  },
  (t) => [
    unique("sales_invoice_lines_company_id_uq").on(t.companyId, t.id),
    unique("sales_invoice_lines_invoice_line_uq").on(t.invoiceId, t.lineNo),
    index("sales_invoice_lines_order_line_idx").on(t.companyId, t.salesOrderLineId),
    foreignKey({
      name: "sales_invoice_lines_invoice_fk",
      columns: [t.companyId, t.invoiceId],
      foreignColumns: [salesInvoices.companyId, salesInvoices.id],
    }),
    foreignKey({
      name: "sales_invoice_lines_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    foreignKey({
      name: "sales_invoice_lines_order_line_fk",
      columns: [t.companyId, t.salesOrderLineId],
      foreignColumns: [salesOrderLines.companyId, salesOrderLines.id],
    }),
    foreignKey({
      name: "sales_invoice_lines_original_fk",
      columns: [t.companyId, t.originalLineId],
      foreignColumns: [t.companyId, t.id],
    }),
    check("sales_invoice_lines_qty_positive", sql`${t.qty} > 0`),
    check("sales_invoice_lines_hsn_shape", sql`${t.hsnSac} ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'`),
  ],
);

/* ------------------------------------------------------------------ Purchasing */

/**
 * An internal ask to buy things, often raised from a shortage or reorder list. Draft -> submitted
 * (takes its number) -> closed or cancelled. How much of it has been ordered is derived from the
 * purchase order lines that point at its lines.
 */
export const purchaseRequests = pgTable(
  "purchase_requests",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    number: text("number"),
    state: purchaseRequestStateEnum("state").notNull().default("draft"),
    requestDate: date("request_date", { mode: "string" }).notNull(),
    neededBy: date("needed_by", { mode: "string" }).notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_requests_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("purchase_requests_number_uq").on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    check("purchase_requests_draft_has_no_number", sql`${t.state} <> 'draft' OR ${t.number} IS NULL`),
    check("purchase_requests_submitted_has_number", sql`${t.state} NOT IN ('submitted', 'closed') OR ${t.number} IS NOT NULL`),
    check("purchase_requests_needed_after_request", sql`${t.neededBy} >= ${t.requestDate}`),
  ],
);

export const purchaseRequestLines = pgTable(
  "purchase_request_lines",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    requestId: uuid("request_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    preferredSupplierId: uuid("preferred_supplier_id"),
    note: text("note"),
  },
  (t) => [
    unique("purchase_request_lines_company_id_uq").on(t.companyId, t.id),
    unique("purchase_request_lines_request_line_uq").on(t.requestId, t.lineNo),
    foreignKey({
      name: "purchase_request_lines_request_fk",
      columns: [t.companyId, t.requestId],
      foreignColumns: [purchaseRequests.companyId, purchaseRequests.id],
    }),
    foreignKey({
      name: "purchase_request_lines_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    foreignKey({
      name: "purchase_request_lines_supplier_fk",
      columns: [t.companyId, t.preferredSupplierId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    check("purchase_request_lines_qty_positive", sql`${t.qty} > 0`),
  ],
);

/**
 * An order to a supplier. Draft -> pending approval -> approved -> sent -> closed, or rejected /
 * cancelled. The supplier's details and the amounts are copied on, and once it leaves draft its
 * terms are frozen by a trigger. Received quantities are derived from the stock moves that point
 * at its lines.
 */
export const purchaseOrders = pgTable(
  "purchase_orders",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    number: text("number"),
    state: purchaseOrderStateEnum("state").notNull().default("draft"),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    expectedDate: date("expected_date", { mode: "string" }).notNull(),
    supplierId: uuid("supplier_id").notNull(),
    /** Where the goods are delivered; its state is the place of supply. */
    warehouseId: uuid("warehouse_id").notNull(),
    /** The supplier's own quotation or reference number. */
    supplierRef: text("supplier_ref"),
    notes: text("notes"),
    supplierName: text("supplier_name").notNull(),
    supplierGstin: text("supplier_gstin"),
    supplierStateCode: char("supplier_state_code", { length: 2 }).notNull(),
    placeOfSupplyStateCode: char("place_of_supply_state_code", { length: 2 }).notNull(),
    supplyKind: text("supply_kind").notNull(),
    taxableValuePaise: bigint("taxable_value_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    utgstPaise: bigint("utgst_paise", { mode: "number" }).notNull(),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull(),
    cessPaise: bigint("cess_paise", { mode: "number" }).notNull(),
    roundOffPaise: bigint("round_off_paise", { mode: "number" }).notNull(),
    totalPaise: bigint("total_paise", { mode: "number" }).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_orders_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("purchase_orders_number_uq").on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    foreignKey({
      name: "purchase_orders_supplier_fk",
      columns: [t.companyId, t.supplierId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      name: "purchase_orders_warehouse_fk",
      columns: [t.companyId, t.warehouseId],
      foreignColumns: [warehouses.companyId, warehouses.id],
    }),
    check("purchase_orders_draft_has_no_number", sql`${t.state} <> 'draft' OR ${t.number} IS NULL`),
    check(
      "purchase_orders_submitted_has_number",
      sql`${t.state} NOT IN ('pending_approval', 'approved', 'rejected', 'sent', 'closed') OR ${t.number} IS NOT NULL`,
    ),
    check("purchase_orders_supply_kind", sql`${t.supplyKind} IN ('intra', 'inter')`),
    check("purchase_orders_expected_after_order", sql`${t.expectedDate} >= ${t.orderDate}`),
    check(
      "purchase_orders_total_adds_up",
      sql`${t.taxableValuePaise} + ${t.cgstPaise} + ${t.sgstPaise} + ${t.utgstPaise} + ${t.igstPaise} + ${t.cessPaise} + ${t.roundOffPaise} = ${t.totalPaise}`,
    ),
  ],
);

export const purchaseOrderLines = pgTable(
  "purchase_order_lines",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    orderId: uuid("order_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    description: text("description"),
    hsnSac: text("hsn_sac"),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
    taxableValuePaise: bigint("taxable_value_paise", { mode: "number" }).notNull(),
    cgstPaise: bigint("cgst_paise", { mode: "number" }).notNull(),
    sgstPaise: bigint("sgst_paise", { mode: "number" }).notNull(),
    utgstPaise: bigint("utgst_paise", { mode: "number" }).notNull(),
    igstPaise: bigint("igst_paise", { mode: "number" }).notNull(),
    cessPaise: bigint("cess_paise", { mode: "number" }).notNull(),
    /** The purchase request line this order line fulfils, if any. */
    purchaseRequestLineId: uuid("purchase_request_line_id"),
  },
  (t) => [
    unique("purchase_order_lines_company_id_uq").on(t.companyId, t.id),
    unique("purchase_order_lines_order_line_uq").on(t.orderId, t.lineNo),
    index("purchase_order_lines_request_line_idx").on(t.companyId, t.purchaseRequestLineId),
    foreignKey({
      name: "purchase_order_lines_order_fk",
      columns: [t.companyId, t.orderId],
      foreignColumns: [purchaseOrders.companyId, purchaseOrders.id],
    }),
    foreignKey({
      name: "purchase_order_lines_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    foreignKey({
      name: "purchase_order_lines_request_line_fk",
      columns: [t.companyId, t.purchaseRequestLineId],
      foreignColumns: [purchaseRequestLines.companyId, purchaseRequestLines.id],
    }),
    check("purchase_order_lines_qty_positive", sql`${t.qty} > 0`),
    check("purchase_order_lines_price_nonneg", sql`${t.unitPrice} >= 0`),
    check("purchase_order_lines_discount_range", sql`${t.discountPct} BETWEEN 0 AND 100`),
  ],
);

/**
 * A request for someone to approve spending. It is data, not a flag: who asked, for how much,
 * who it is waiting on, and who decided it and why. A request within the requester's own limit is
 * recorded too, as approved automatically. Once decided it can never change.
 */
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    docType: text("doc_type").notNull(),
    docId: uuid("doc_id").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    /** Who it is waiting on now (the next person up the chain); empty once decided. */
    assignedTo: uuid("assigned_to").references(() => users.id),
    state: approvalStateEnum("state").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    comment: text("comment"),
    /** True when it was approved on submission because the amount was within the requester's own limit. */
    isAuto: boolean("is_auto").notNull().default(false),
    escalationCount: smallint("escalation_count").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("approval_requests_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("approval_requests_one_pending_uq")
      .on(t.companyId, t.docType, t.docId)
      .where(sql`${t.state} = 'pending'`),
    index("approval_requests_doc_idx").on(t.companyId, t.docType, t.docId),
    check("approval_requests_doc_type", sql`${t.docType} IN ('purchase_order')`),
    check("approval_requests_amount_nonneg", sql`${t.amountPaise} >= 0`),
    check("approval_requests_decided_iff_not_pending", sql`(${t.state} IN ('approved', 'rejected')) = (${t.decidedAt} IS NOT NULL)`),
    check("approval_requests_pending_has_assignee", sql`${t.state} <> 'pending' OR ${t.assignedTo} IS NOT NULL`),
    check("approval_requests_rejection_has_reason", sql`${t.state} <> 'rejected' OR ${t.comment} IS NOT NULL`),
  ],
);

/* ------------------------------------------------------------------ Bills and payments */

/**
 * A supplier's bill, recorded exactly as printed and checked against the order and the goods
 * received (the three-way match). Draft -> held (with reasons) or matched -> posted into the books.
 * A held bill is released by an authorised person (with a reason) or rejected so the supplier sends
 * a corrected one. The internal number is taken only when posted. Posted bills never change.
 */
export const purchaseBills = pgTable(
  "purchase_bills",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** Our own voucher number; taken when the bill is posted. */
    number: text("number"),
    state: billStateEnum("state").notNull().default("draft"),
    purchaseOrderId: uuid("purchase_order_id").notNull(),
    supplierId: uuid("supplier_id").notNull(),
    /** The supplier's own number for this bill. */
    supplierBillNo: text("supplier_bill_no").notNull(),
    /** Lower-case, trimmed copy of the bill number, used to catch the same bill entered twice. */
    supplierBillKey: text("supplier_bill_key").notNull(),
    billDate: date("bill_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    /** The supplier GSTIN as printed on the bill (may be missing or wrong; that is what the match checks). */
    supplierGstinOnBill: text("supplier_gstin_on_bill"),
    // Totals as printed on the bill.
    statedTaxablePaise: bigint("stated_taxable_paise", { mode: "number" }).notNull(),
    statedCgstPaise: bigint("stated_cgst_paise", { mode: "number" }).notNull(),
    statedSgstPaise: bigint("stated_sgst_paise", { mode: "number" }).notNull(),
    statedUtgstPaise: bigint("stated_utgst_paise", { mode: "number" }).notNull(),
    statedIgstPaise: bigint("stated_igst_paise", { mode: "number" }).notNull(),
    statedCessPaise: bigint("stated_cess_paise", { mode: "number" }).notNull(),
    statedRoundOffPaise: bigint("stated_round_off_paise", { mode: "number" }).notNull(),
    statedTotalPaise: bigint("stated_total_paise", { mode: "number" }).notNull(),
    /** Every reason the three-way match found; empty when it matched. */
    matchFindings: jsonb("match_findings").notNull().default(sql`'[]'::jsonb`),
    matchedAt: timestamp("matched_at", { withTimezone: true }),
    overriddenBy: uuid("overridden_by").references(() => users.id),
    overrideReason: text("override_reason"),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    rejectReason: text("reject_reason"),
    notes: text("notes"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("purchase_bills_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("purchase_bills_number_uq").on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    uniqueIndex("purchase_bills_one_per_supplier_bill_uq")
      .on(t.companyId, t.supplierId, t.supplierBillKey)
      .where(sql`${t.state} NOT IN ('rejected', 'cancelled')`),
    index("purchase_bills_order_idx").on(t.companyId, t.purchaseOrderId),
    foreignKey({
      name: "purchase_bills_order_fk",
      columns: [t.companyId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.companyId, purchaseOrders.id],
    }),
    foreignKey({
      name: "purchase_bills_supplier_fk",
      columns: [t.companyId, t.supplierId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    check("purchase_bills_number_iff_posted", sql`(${t.state} = 'posted') = (${t.number} IS NOT NULL)`),
    check("purchase_bills_posted_at_iff_posted", sql`(${t.state} = 'posted') = (${t.postedAt} IS NOT NULL)`),
    check("purchase_bills_rejection_has_reason", sql`${t.state} <> 'rejected' OR ${t.rejectReason} IS NOT NULL`),
    check("purchase_bills_override_has_reason", sql`(${t.overriddenBy} IS NULL) = (${t.overrideReason} IS NULL)`),
    check("purchase_bills_due_after_bill", sql`${t.dueDate} >= ${t.billDate}`),
  ],
);

export const purchaseBillLines = pgTable(
  "purchase_bill_lines",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    billId: uuid("bill_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    purchaseOrderLineId: uuid("purchase_order_line_id").notNull(),
    itemId: uuid("item_id").notNull(),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 18, scale: 4 }).notNull(),
    discountPct: numeric("discount_pct", { precision: 5, scale: 2 }).notNull().default("0"),
    gstRate: numeric("gst_rate", { precision: 5, scale: 2 }).notNull(),
    taxableValuePaise: bigint("taxable_value_paise", { mode: "number" }).notNull(),
  },
  (t) => [
    unique("purchase_bill_lines_company_id_uq").on(t.companyId, t.id),
    unique("purchase_bill_lines_bill_line_uq").on(t.billId, t.lineNo),
    unique("purchase_bill_lines_bill_po_line_uq").on(t.billId, t.purchaseOrderLineId),
    index("purchase_bill_lines_po_line_idx").on(t.companyId, t.purchaseOrderLineId),
    foreignKey({
      name: "purchase_bill_lines_bill_fk",
      columns: [t.companyId, t.billId],
      foreignColumns: [purchaseBills.companyId, purchaseBills.id],
    }),
    foreignKey({
      name: "purchase_bill_lines_po_line_fk",
      columns: [t.companyId, t.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.companyId, purchaseOrderLines.id],
    }),
    foreignKey({
      name: "purchase_bill_lines_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    check("purchase_bill_lines_qty_positive", sql`${t.qty} > 0`),
    check("purchase_bill_lines_price_nonneg", sql`${t.unitPrice} >= 0`),
    check("purchase_bill_lines_discount_range", sql`${t.discountPct} BETWEEN 0 AND 100`),
  ],
);

/**
 * Money paid to a supplier or received from a customer. A payment is a fact: once recorded it
 * never changes except to be reversed (with a reason). What it settles is recorded as allocations
 * to bills or invoices; any part not allocated is an advance on account.
 */
export const payments = pgTable(
  "payments",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    direction: paymentDirectionEnum("direction").notNull(),
    number: text("number").notNull(),
    partyId: uuid("party_id").notNull(),
    paymentDate: date("payment_date", { mode: "string" }).notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    mode: paymentModeEnum("mode").notNull(),
    /** Cheque number, UTR or bank reference. */
    reference: text("reference"),
    notes: text("notes"),
    state: paymentStateEnum("state").notNull().default("posted"),
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedBy: uuid("reversed_by").references(() => users.id),
    reverseReason: text("reverse_reason"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("payments_company_id_uq").on(t.companyId, t.id),
    unique("payments_company_direction_number_uq").on(t.companyId, t.direction, t.number),
    index("payments_party_idx").on(t.companyId, t.partyId, t.paymentDate),
    foreignKey({
      name: "payments_party_fk",
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    check("payments_amount_positive", sql`${t.amountPaise} > 0`),
    check("payments_reversed_iff_timestamp", sql`(${t.state} = 'reversed') = (${t.reversedAt} IS NOT NULL)`),
    check("payments_reversal_has_reason", sql`${t.state} <> 'reversed' OR ${t.reverseReason} IS NOT NULL`),
  ],
);

export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    paymentId: uuid("payment_id").notNull(),
    /** What the money settles: a supplier bill (paid) or a sales invoice / debit note (received). */
    docType: text("doc_type").notNull(),
    docId: uuid("doc_id").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_allocations_doc_idx").on(t.companyId, t.docType, t.docId),
    foreignKey({
      name: "payment_allocations_payment_fk",
      columns: [t.companyId, t.paymentId],
      foreignColumns: [payments.companyId, payments.id],
    }),
    check("payment_allocations_doc_type", sql`${t.docType} IN ('purchase_bill', 'sales_invoice')`),
    check("payment_allocations_amount_positive", sql`${t.amountPaise} > 0`),
  ],
);

/* ------------------------------------------------------------------ Inventory */

/**
 * A job to make a quantity of one item, usually for a sales order line. It holds the plan only
 * (what, how many, for whom). How far it has got is never stored here: material issued, where the
 * work in progress sits, what was scrapped and what is finished are all worked out from the stock
 * moves that carry this order's id.
 */
export const productionOrders = pgTable(
  "production_orders",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** Given when the order is released to the floor. */
    number: text("number"),
    state: productionOrderStateEnum("state").notNull().default("draft"),
    /** What is being made. */
    itemId: uuid("item_id").notNull(),
    /** The bill of materials used; fixed when the order is created. */
    bomId: uuid("bom_id").notNull(),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    /** The customer order this is for, if any. */
    salesOrderId: uuid("sales_order_id"),
    salesOrderLineId: uuid("sales_order_line_id"),
    orderDate: date("order_date", { mode: "string" }).notNull(),
    dueDate: date("due_date", { mode: "string" }).notNull(),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("production_orders_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("production_orders_number_uq").on(t.companyId, t.number).where(sql`${t.number} IS NOT NULL`),
    index("production_orders_sales_line_idx").on(t.companyId, t.salesOrderLineId),
    foreignKey({ name: "production_orders_item_fk", columns: [t.companyId, t.itemId], foreignColumns: [items.companyId, items.id] }),
    foreignKey({ name: "production_orders_bom_fk", columns: [t.companyId, t.bomId], foreignColumns: [boms.companyId, boms.id] }),
    foreignKey({ name: "production_orders_sales_order_fk", columns: [t.companyId, t.salesOrderId], foreignColumns: [salesOrders.companyId, salesOrders.id] }),
    foreignKey({
      name: "production_orders_sales_line_fk",
      columns: [t.companyId, t.salesOrderLineId],
      foreignColumns: [salesOrderLines.companyId, salesOrderLines.id],
    }),
    check("production_orders_qty_positive", sql`${t.qty} > 0`),
    check("production_orders_number_when_released", sql`(${t.state} = 'draft') OR (${t.state} = 'cancelled') OR (${t.number} IS NOT NULL)`),
    check("production_orders_line_needs_order", sql`${t.salesOrderLineId} IS NULL OR ${t.salesOrderId} IS NOT NULL`),
  ],
);

/**
 * A stock document groups stock moves: goods receipt, delivery, transfer or adjustment.
 * It gets its number only when posted, so cancelled drafts never leave gaps in the series.
 * Once done or cancelled it can never change (trigger); corrections are new documents.
 */
export const stockDocuments = pgTable(
  "stock_documents",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    docType: stockDocTypeEnum("doc_type").notNull(),
    number: text("number"),
    state: stockStateEnum("state").notNull().default("draft"),
    docDate: date("doc_date", { mode: "string" }).notNull(),
    partyId: uuid("party_id"),
    /** For deliveries made against a customer order. */
    salesOrderId: uuid("sales_order_id"),
    /** For goods receipts against a purchase order. */
    purchaseOrderId: uuid("purchase_order_id"),
    /** Free text: supplier challan number, vehicle, count sheet, and so on. */
    reference: text("reference"),
    notes: text("notes"),
    createdBy: uuid("created_by").references(() => users.id),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_documents_company_id_uq").on(t.companyId, t.id),
    uniqueIndex("stock_documents_number_uq")
      .on(t.companyId, t.docType, t.number)
      .where(sql`${t.number} IS NOT NULL`),
    foreignKey({
      name: "stock_documents_party_fk",
      columns: [t.companyId, t.partyId],
      foreignColumns: [parties.companyId, parties.id],
    }),
    foreignKey({
      name: "stock_documents_sales_order_fk",
      columns: [t.companyId, t.salesOrderId],
      foreignColumns: [salesOrders.companyId, salesOrders.id],
    }),
    foreignKey({
      name: "stock_documents_purchase_order_fk",
      columns: [t.companyId, t.purchaseOrderId],
      foreignColumns: [purchaseOrders.companyId, purchaseOrders.id],
    }),
    check("stock_documents_number_iff_done", sql`(${t.state} = 'done') = (${t.number} IS NOT NULL)`),
    check("stock_documents_posted_iff_done", sql`(${t.state} = 'done') = (${t.postedAt} IS NOT NULL)`),
  ],
);

/**
 * The stock ledger: one balanced transfer of `qty` of an item from one location to another.
 * On-hand stock is never stored; it is the sum of done moves. `value_paise` is the money value
 * of the move at the time it was posted, so valuation can be audited line by line.
 */
export const stockMoves = pgTable(
  "stock_moves",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    documentId: uuid("document_id").notNull(),
    lineNo: smallint("line_no").notNull(),
    itemId: uuid("item_id").notNull(),
    fromLocationId: uuid("from_location_id").notNull(),
    toLocationId: uuid("to_location_id").notNull(),
    qty: numeric("qty", { precision: 18, scale: 3 }).notNull(),
    /** Rupee cost per unit for inbound moves (e.g. the purchase rate). */
    unitCost: numeric("unit_cost", { precision: 18, scale: 4 }),
    valuePaise: bigint("value_paise", { mode: "number" }),
    /** The order line this delivery serves; how "delivered so far" is worked out. */
    salesOrderLineId: uuid("sales_order_line_id"),
    /** The purchase order line this receipt serves; how "received so far" is worked out. */
    purchaseOrderLineId: uuid("purchase_order_line_id"),
    /** The production order this material belongs to; how an order's progress through the floor is worked out. */
    productionOrderId: uuid("production_order_id"),
    state: stockStateEnum("state").notNull().default("draft"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("stock_moves_document_line_uq").on(t.documentId, t.lineNo),
    index("stock_moves_item_idx").on(t.companyId, t.itemId, t.state),
    index("stock_moves_order_line_idx").on(t.companyId, t.salesOrderLineId),
    index("stock_moves_po_line_idx").on(t.companyId, t.purchaseOrderLineId),
    index("stock_moves_production_order_idx").on(t.companyId, t.productionOrderId),
    foreignKey({
      name: "stock_moves_production_order_fk",
      columns: [t.companyId, t.productionOrderId],
      foreignColumns: [productionOrders.companyId, productionOrders.id],
    }),
    foreignKey({
      name: "stock_moves_purchase_order_line_fk",
      columns: [t.companyId, t.purchaseOrderLineId],
      foreignColumns: [purchaseOrderLines.companyId, purchaseOrderLines.id],
    }),
    foreignKey({
      name: "stock_moves_sales_order_line_fk",
      columns: [t.companyId, t.salesOrderLineId],
      foreignColumns: [salesOrderLines.companyId, salesOrderLines.id],
    }),
    foreignKey({
      name: "stock_moves_document_fk",
      columns: [t.companyId, t.documentId],
      foreignColumns: [stockDocuments.companyId, stockDocuments.id],
    }),
    foreignKey({
      name: "stock_moves_item_fk",
      columns: [t.companyId, t.itemId],
      foreignColumns: [items.companyId, items.id],
    }),
    foreignKey({
      name: "stock_moves_from_fk",
      columns: [t.companyId, t.fromLocationId],
      foreignColumns: [locations.companyId, locations.id],
    }),
    foreignKey({
      name: "stock_moves_to_fk",
      columns: [t.companyId, t.toLocationId],
      foreignColumns: [locations.companyId, locations.id],
    }),
    check("stock_moves_qty_positive", sql`${t.qty} > 0`),
    check("stock_moves_distinct_locations", sql`${t.fromLocationId} <> ${t.toLocationId}`),
    check("stock_moves_value_iff_done", sql`(${t.state} = 'done') = (${t.valuePaise} IS NOT NULL)`),
    check("stock_moves_value_nonneg", sql`${t.valuePaise} IS NULL OR ${t.valuePaise} >= 0`),
    check("stock_moves_cost_nonneg", sql`${t.unitCost} IS NULL OR ${t.unitCost} >= 0`),
  ],
);

/* ------------------------------------------------------------------ Sessions and exports */

/**
 * A login. The browser holds a random token; only its SHA-256 is stored, so a leaked database
 * cannot be used to impersonate anyone. A session ends at `expires_at` or when revoked.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    /** The company the person is working in. */
    activeCompanyId: uuid("active_company_id").references(() => companies.id),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/** One file handed to the accountant for import into Tally. Append-only. */
export const exportBatches = pgTable(
  "export_batches",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    kind: text("kind").notNull(),
    dateFrom: date("date_from", { mode: "string" }).notNull(),
    dateTo: date("date_to", { mode: "string" }).notNull(),
    voucherCount: integer("voucher_count").notNull(),
    fileSha256: text("file_sha256").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [unique("export_batches_company_id_uq").on(t.companyId, t.id), check("export_batches_kind", sql`${t.kind} IN ('tally')`)],
);

/**
 * Which documents went into which batch. A document is exported once; this is how "not yet sent to
 * Tally" is known without touching the posted (immutable) document itself. Append-only.
 */
export const exportedDocuments = pgTable(
  "exported_documents",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    batchId: uuid("batch_id").notNull(),
    docType: text("doc_type").notNull(),
    docId: uuid("doc_id").notNull(),
    voucherNumber: text("voucher_number").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("exported_documents_doc_uq").on(t.companyId, t.docType, t.docId),
    foreignKey({
      name: "exported_documents_batch_fk",
      columns: [t.companyId, t.batchId],
      foreignColumns: [exportBatches.companyId, exportBatches.id],
    }),
    check("exported_documents_doc_type", sql`${t.docType} IN ('sales_invoice', 'purchase_bill', 'payment')`),
  ],
);

export const plantAreaKindEnum = pgEnum("plant_area_kind", ["store", "process", "qc", "finished", "dispatch", "scrap"]);

/**
 * The factory floor as an ordered list of areas (work centres): stores, each process, quality
 * check, finished goods, dispatch, scrap. Each area IS a stock location, so what sits in an area
 * is worked out from stock moves like any other stock; nothing here holds a quantity.
 */
export const plantAreas = pgTable(
  "plant_areas",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    /** The stock location that holds this area's material. One area per location. */
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    kind: plantAreaKindEnum("kind").notNull(),
    /** Position along the floor: material normally flows from lower to higher. */
    sortOrder: integer("sort_order").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique("plant_areas_company_id_uq").on(t.companyId, t.id),
    unique("plant_areas_location_uq").on(t.companyId, t.locationId),
    unique("plant_areas_name_uq").on(t.companyId, t.name),
    index("plant_areas_order_idx").on(t.companyId, t.sortOrder),
    foreignKey({
      name: "plant_areas_location_fk",
      columns: [t.companyId, t.locationId],
      foreignColumns: [locations.companyId, locations.id],
    }),
    check("plant_areas_name_not_blank", sql`length(trim(${t.name})) > 0`),
  ],
);
