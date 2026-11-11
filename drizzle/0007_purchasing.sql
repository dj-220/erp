CREATE TYPE "public"."approval_state" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."purchase_order_state" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'sent', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."purchase_request_state" AS ENUM('draft', 'submitted', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"requested_by" uuid NOT NULL,
	"assigned_to" uuid,
	"state" "approval_state" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"comment" text,
	"is_auto" boolean DEFAULT false NOT NULL,
	"escalation_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_requests_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "approval_requests_doc_type" CHECK ("approval_requests"."doc_type" IN ('purchase_order')),
	CONSTRAINT "approval_requests_amount_nonneg" CHECK ("approval_requests"."amount_paise" >= 0),
	CONSTRAINT "approval_requests_decided_iff_not_pending" CHECK (("approval_requests"."state" IN ('approved', 'rejected')) = ("approval_requests"."decided_at" IS NOT NULL)),
	CONSTRAINT "approval_requests_pending_has_assignee" CHECK ("approval_requests"."state" <> 'pending' OR "approval_requests"."assigned_to" IS NOT NULL),
	CONSTRAINT "approval_requests_rejection_has_reason" CHECK ("approval_requests"."state" <> 'rejected' OR "approval_requests"."comment" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
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
	"taxable_value_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"utgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"purchase_request_line_id" uuid,
	CONSTRAINT "purchase_order_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_order_lines_order_line_uq" UNIQUE("order_id","line_no"),
	CONSTRAINT "purchase_order_lines_qty_positive" CHECK ("purchase_order_lines"."qty" > 0),
	CONSTRAINT "purchase_order_lines_price_nonneg" CHECK ("purchase_order_lines"."unit_price" >= 0),
	CONSTRAINT "purchase_order_lines_discount_range" CHECK ("purchase_order_lines"."discount_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"state" "purchase_order_state" DEFAULT 'draft' NOT NULL,
	"order_date" date NOT NULL,
	"expected_date" date NOT NULL,
	"supplier_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"supplier_ref" text,
	"notes" text,
	"supplier_name" text NOT NULL,
	"supplier_gstin" text,
	"supplier_state_code" char(2) NOT NULL,
	"place_of_supply_state_code" char(2) NOT NULL,
	"supply_kind" text NOT NULL,
	"taxable_value_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"utgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"created_by" uuid NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_orders_draft_has_no_number" CHECK ("purchase_orders"."state" <> 'draft' OR "purchase_orders"."number" IS NULL),
	CONSTRAINT "purchase_orders_submitted_has_number" CHECK ("purchase_orders"."state" NOT IN ('pending_approval', 'approved', 'rejected', 'sent', 'closed') OR "purchase_orders"."number" IS NOT NULL),
	CONSTRAINT "purchase_orders_supply_kind" CHECK ("purchase_orders"."supply_kind" IN ('intra', 'inter')),
	CONSTRAINT "purchase_orders_expected_after_order" CHECK ("purchase_orders"."expected_date" >= "purchase_orders"."order_date"),
	CONSTRAINT "purchase_orders_total_adds_up" CHECK ("purchase_orders"."taxable_value_paise" + "purchase_orders"."cgst_paise" + "purchase_orders"."sgst_paise" + "purchase_orders"."utgst_paise" + "purchase_orders"."igst_paise" + "purchase_orders"."cess_paise" + "purchase_orders"."round_off_paise" = "purchase_orders"."total_paise")
);
--> statement-breakpoint
CREATE TABLE "purchase_request_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"preferred_supplier_id" uuid,
	"note" text,
	CONSTRAINT "purchase_request_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_request_lines_request_line_uq" UNIQUE("request_id","line_no"),
	CONSTRAINT "purchase_request_lines_qty_positive" CHECK ("purchase_request_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "purchase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"state" "purchase_request_state" DEFAULT 'draft' NOT NULL,
	"request_date" date NOT NULL,
	"needed_by" date NOT NULL,
	"requested_by" uuid NOT NULL,
	"notes" text,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_requests_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_requests_draft_has_no_number" CHECK ("purchase_requests"."state" <> 'draft' OR "purchase_requests"."number" IS NULL),
	CONSTRAINT "purchase_requests_submitted_has_number" CHECK ("purchase_requests"."state" NOT IN ('submitted', 'closed') OR "purchase_requests"."number" IS NOT NULL),
	CONSTRAINT "purchase_requests_needed_after_request" CHECK ("purchase_requests"."needed_by" >= "purchase_requests"."request_date")
);
--> statement-breakpoint
ALTER TABLE "stock_documents" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD COLUMN "purchase_order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("company_id","order_id") REFERENCES "public"."purchase_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_request_line_fk" FOREIGN KEY ("company_id","purchase_request_line_id") REFERENCES "public"."purchase_request_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("company_id","supplier_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_request_fk" FOREIGN KEY ("company_id","request_id") REFERENCES "public"."purchase_requests"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_request_lines" ADD CONSTRAINT "purchase_request_lines_supplier_fk" FOREIGN KEY ("company_id","preferred_supplier_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_one_pending_uq" ON "approval_requests" USING btree ("company_id","doc_type","doc_id") WHERE "approval_requests"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_doc_idx" ON "approval_requests" USING btree ("company_id","doc_type","doc_id");--> statement-breakpoint
CREATE INDEX "purchase_order_lines_request_line_idx" ON "purchase_order_lines" USING btree ("company_id","purchase_request_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_number_uq" ON "purchase_orders" USING btree ("company_id","number") WHERE "purchase_orders"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_requests_number_uq" ON "purchase_requests" USING btree ("company_id","number") WHERE "purchase_requests"."number" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_purchase_order_fk" FOREIGN KEY ("company_id","purchase_order_id") REFERENCES "public"."purchase_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_purchase_order_line_fk" FOREIGN KEY ("company_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_moves_po_line_idx" ON "stock_moves" USING btree ("company_id","purchase_order_line_id");