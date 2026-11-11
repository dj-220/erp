CREATE TYPE "public"."sales_invoice_kind" AS ENUM('tax_invoice', 'credit_note', 'debit_note');--> statement-breakpoint
CREATE TYPE "public"."sales_invoice_state" AS ENUM('draft', 'posted', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sales_order_state" AS ENUM('draft', 'confirmed', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "sales_invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"hsn_sac" text NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"taxable_value_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"utgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"sales_order_line_id" uuid,
	"original_line_id" uuid,
	CONSTRAINT "sales_invoice_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sales_invoice_lines_invoice_line_uq" UNIQUE("invoice_id","line_no"),
	CONSTRAINT "sales_invoice_lines_qty_positive" CHECK ("sales_invoice_lines"."qty" > 0),
	CONSTRAINT "sales_invoice_lines_hsn_shape" CHECK ("sales_invoice_lines"."hsn_sac" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$')
);
--> statement-breakpoint
CREATE TABLE "sales_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "sales_invoice_kind" NOT NULL,
	"number" text,
	"state" "sales_invoice_state" DEFAULT 'draft' NOT NULL,
	"invoice_date" date NOT NULL,
	"due_date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"sales_order_id" uuid,
	"original_invoice_id" uuid,
	"reason" text,
	"supplier_gstin" text,
	"supplier_state_code" char(2) NOT NULL,
	"place_of_supply_state_code" char(2) NOT NULL,
	"customer_name" text NOT NULL,
	"customer_gstin" text,
	"customer_state_code" char(2) NOT NULL,
	"supply_kind" text NOT NULL,
	"taxable_value_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"utgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_invoices_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sales_invoices_number_iff_posted" CHECK (("sales_invoices"."state" = 'posted') = ("sales_invoices"."number" IS NOT NULL)),
	CONSTRAINT "sales_invoices_posted_at_iff_posted" CHECK (("sales_invoices"."state" = 'posted') = ("sales_invoices"."posted_at" IS NOT NULL)),
	CONSTRAINT "sales_invoices_note_has_original" CHECK (("sales_invoices"."kind" = 'tax_invoice') = ("sales_invoices"."original_invoice_id" IS NULL)),
	CONSTRAINT "sales_invoices_supply_kind" CHECK ("sales_invoices"."supply_kind" IN ('intra', 'inter')),
	CONSTRAINT "sales_invoices_due_after_invoice" CHECK ("sales_invoices"."due_date" >= "sales_invoices"."invoice_date"),
	CONSTRAINT "sales_invoices_total_adds_up" CHECK ("sales_invoices"."taxable_value_paise" + "sales_invoices"."cgst_paise" + "sales_invoices"."sgst_paise" + "sales_invoices"."utgst_paise" + "sales_invoices"."igst_paise" + "sales_invoices"."cess_paise" + "sales_invoices"."round_off_paise" = "sales_invoices"."total_paise")
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"description" text,
	"hsn_sac" text,
	"qty" numeric(18, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	CONSTRAINT "sales_order_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sales_order_lines_order_line_uq" UNIQUE("order_id","line_no"),
	CONSTRAINT "sales_order_lines_qty_positive" CHECK ("sales_order_lines"."qty" > 0),
	CONSTRAINT "sales_order_lines_price_nonneg" CHECK ("sales_order_lines"."unit_price" >= 0),
	CONSTRAINT "sales_order_lines_discount_range" CHECK ("sales_order_lines"."discount_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"state" "sales_order_state" DEFAULT 'draft' NOT NULL,
	"order_date" date NOT NULL,
	"promised_date" date NOT NULL,
	"customer_id" uuid NOT NULL,
	"customer_po_ref" text,
	"ship_to_state_code" char(2) NOT NULL,
	"notes" text,
	"created_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "sales_orders_draft_has_no_number" CHECK ("sales_orders"."state" <> 'draft' OR "sales_orders"."number" IS NULL),
	CONSTRAINT "sales_orders_confirmed_has_number" CHECK ("sales_orders"."state" NOT IN ('confirmed', 'closed') OR "sales_orders"."number" IS NOT NULL),
	CONSTRAINT "sales_orders_promise_after_order" CHECK ("sales_orders"."promised_date" >= "sales_orders"."order_date")
);
--> statement-breakpoint
ALTER TABLE "stock_documents" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD COLUMN "sales_order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_invoice_fk" FOREIGN KEY ("company_id","invoice_id") REFERENCES "public"."sales_invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_order_line_fk" FOREIGN KEY ("company_id","sales_order_line_id") REFERENCES "public"."sales_order_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoice_lines" ADD CONSTRAINT "sales_invoice_lines_original_fk" FOREIGN KEY ("company_id","original_line_id") REFERENCES "public"."sales_invoice_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_order_fk" FOREIGN KEY ("company_id","sales_order_id") REFERENCES "public"."sales_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_original_fk" FOREIGN KEY ("company_id","original_invoice_id") REFERENCES "public"."sales_invoices"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."sales_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_fk" FOREIGN KEY ("company_id","customer_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_invoice_lines_order_line_idx" ON "sales_invoice_lines" USING btree ("company_id","sales_order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_invoices_number_uq" ON "sales_invoices" USING btree ("company_id","kind","number") WHERE "sales_invoices"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sales_invoices_order_idx" ON "sales_invoices" USING btree ("company_id","sales_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_number_uq" ON "sales_orders" USING btree ("company_id","number") WHERE "sales_orders"."number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_sales_order_fk" FOREIGN KEY ("company_id","sales_order_id") REFERENCES "public"."sales_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_sales_order_line_fk" FOREIGN KEY ("company_id","sales_order_line_id") REFERENCES "public"."sales_order_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_moves_order_line_idx" ON "stock_moves" USING btree ("company_id","sales_order_line_id");