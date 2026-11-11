CREATE TYPE "public"."bill_state" AS ENUM('draft', 'held', 'matched', 'posted', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_direction" AS ENUM('paid', 'received');--> statement-breakpoint
CREATE TYPE "public"."payment_mode" AS ENUM('bank', 'cash', 'upi', 'cheque', 'card', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('posted', 'reversed');--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"doc_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_payment_doc_uq" UNIQUE("payment_id","doc_type","doc_id"),
	CONSTRAINT "payment_allocations_doc_type" CHECK ("payment_allocations"."doc_type" IN ('purchase_bill', 'sales_invoice')),
	CONSTRAINT "payment_allocations_amount_positive" CHECK ("payment_allocations"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"direction" "payment_direction" NOT NULL,
	"number" text NOT NULL,
	"party_id" uuid NOT NULL,
	"payment_date" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"mode" "payment_mode" NOT NULL,
	"reference" text,
	"notes" text,
	"state" "payment_state" DEFAULT 'posted' NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" uuid,
	"reverse_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "payments_company_direction_number_uq" UNIQUE("company_id","direction","number"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_paise" > 0),
	CONSTRAINT "payments_reversed_iff_timestamp" CHECK (("payments"."state" = 'reversed') = ("payments"."reversed_at" IS NOT NULL)),
	CONSTRAINT "payments_reversal_has_reason" CHECK ("payments"."state" <> 'reversed' OR "payments"."reverse_reason" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "purchase_bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"purchase_order_line_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"gst_rate" numeric(5, 2) NOT NULL,
	"taxable_value_paise" bigint NOT NULL,
	CONSTRAINT "purchase_bill_lines_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_bill_lines_bill_line_uq" UNIQUE("bill_id","line_no"),
	CONSTRAINT "purchase_bill_lines_bill_po_line_uq" UNIQUE("bill_id","purchase_order_line_id"),
	CONSTRAINT "purchase_bill_lines_qty_positive" CHECK ("purchase_bill_lines"."qty" > 0),
	CONSTRAINT "purchase_bill_lines_price_nonneg" CHECK ("purchase_bill_lines"."unit_price" >= 0),
	CONSTRAINT "purchase_bill_lines_discount_range" CHECK ("purchase_bill_lines"."discount_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "purchase_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"state" "bill_state" DEFAULT 'draft' NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_bill_no" text NOT NULL,
	"supplier_bill_key" text NOT NULL,
	"bill_date" date NOT NULL,
	"due_date" date NOT NULL,
	"supplier_gstin_on_bill" text,
	"stated_taxable_paise" bigint NOT NULL,
	"stated_cgst_paise" bigint NOT NULL,
	"stated_sgst_paise" bigint NOT NULL,
	"stated_utgst_paise" bigint NOT NULL,
	"stated_igst_paise" bigint NOT NULL,
	"stated_cess_paise" bigint NOT NULL,
	"stated_round_off_paise" bigint NOT NULL,
	"stated_total_paise" bigint NOT NULL,
	"match_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"matched_at" timestamp with time zone,
	"overridden_by" uuid,
	"override_reason" text,
	"overridden_at" timestamp with time zone,
	"reject_reason" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_bills_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "purchase_bills_number_iff_posted" CHECK (("purchase_bills"."state" = 'posted') = ("purchase_bills"."number" IS NOT NULL)),
	CONSTRAINT "purchase_bills_posted_at_iff_posted" CHECK (("purchase_bills"."state" = 'posted') = ("purchase_bills"."posted_at" IS NOT NULL)),
	CONSTRAINT "purchase_bills_rejection_has_reason" CHECK ("purchase_bills"."state" <> 'rejected' OR "purchase_bills"."reject_reason" IS NOT NULL),
	CONSTRAINT "purchase_bills_override_has_reason" CHECK (("purchase_bills"."overridden_by" IS NULL) = ("purchase_bills"."override_reason" IS NULL)),
	CONSTRAINT "purchase_bills_due_after_bill" CHECK ("purchase_bills"."due_date" >= "purchase_bills"."bill_date")
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bill_rate_tolerance_pct" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bill_qty_tolerance_pct" numeric(5, 2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "bill_amount_tolerance_paise" bigint DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_fk" FOREIGN KEY ("company_id","payment_id") REFERENCES "public"."payments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_party_fk" FOREIGN KEY ("company_id","party_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_bill_fk" FOREIGN KEY ("company_id","bill_id") REFERENCES "public"."purchase_bills"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_po_line_fk" FOREIGN KEY ("company_id","purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bill_lines" ADD CONSTRAINT "purchase_bill_lines_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_overridden_by_users_id_fk" FOREIGN KEY ("overridden_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_order_fk" FOREIGN KEY ("company_id","purchase_order_id") REFERENCES "public"."purchase_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_bills" ADD CONSTRAINT "purchase_bills_supplier_fk" FOREIGN KEY ("company_id","supplier_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_allocations_doc_idx" ON "payment_allocations" USING btree ("company_id","doc_type","doc_id");--> statement-breakpoint
CREATE INDEX "payments_party_idx" ON "payments" USING btree ("company_id","party_id","payment_date");--> statement-breakpoint
CREATE INDEX "purchase_bill_lines_po_line_idx" ON "purchase_bill_lines" USING btree ("company_id","purchase_order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_bills_number_uq" ON "purchase_bills" USING btree ("company_id","number") WHERE "purchase_bills"."number" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_bills_one_per_supplier_bill_uq" ON "purchase_bills" USING btree ("company_id","supplier_id","supplier_bill_key") WHERE "purchase_bills"."state" NOT IN ('rejected', 'cancelled');--> statement-breakpoint
CREATE INDEX "purchase_bills_order_idx" ON "purchase_bills" USING btree ("company_id","purchase_order_id");