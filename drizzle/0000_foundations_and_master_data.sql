CREATE TYPE "public"."gst_registration" AS ENUM('regular', 'composition', 'unregistered', 'consumer', 'sez', 'overseas');--> statement-breakpoint
CREATE TYPE "public"."item_kind" AS ENUM('raw_material', 'semi_finished', 'finished', 'trading', 'consumable', 'service');--> statement-breakpoint
CREATE TYPE "public"."location_kind" AS ENUM('internal', 'supplier', 'customer', 'production', 'adjustment', 'transit');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('customer', 'supplier', 'both');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'admin', 'accountant', 'purchase', 'sales', 'stores', 'viewer');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"company_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bom_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bom_id" uuid NOT NULL,
	"component_item_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"scrap_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "bom_lines_bom_component_uq" UNIQUE("bom_id","component_item_id"),
	CONSTRAINT "bom_lines_qty_positive" CHECK ("bom_lines"."qty" > 0),
	CONSTRAINT "bom_lines_scrap_range" CHECK ("bom_lines"."scrap_pct" >= 0 AND "bom_lines"."scrap_pct" < 100)
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"output_qty" numeric(18, 3) DEFAULT '1' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boms_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "boms_company_item_version_uq" UNIQUE("company_id","item_id","version"),
	CONSTRAINT "boms_output_positive" CHECK ("boms"."output_qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"trade_name" text,
	"gstin" text,
	"pan" text,
	"state_code" char(2) NOT NULL,
	"address_line" text,
	"city" text,
	"pincode" text,
	"phone" text,
	"email" text,
	"tally_company_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_gstin_shape" CHECK ("companies"."gstin" IS NULL OR "companies"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "companies_gstin_matches_state" CHECK ("companies"."gstin" IS NULL OR left("companies"."gstin", 2) = "companies"."state_code")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"kind" "item_kind" NOT NULL,
	"hsn_sac" text,
	"gst_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"uom_id" uuid NOT NULL,
	"sales_price" numeric(18, 4),
	"purchase_price" numeric(18, 4),
	"track_batch" boolean DEFAULT false NOT NULL,
	"reorder_level" numeric(18, 3) DEFAULT '0' NOT NULL,
	"reorder_qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"tally_item_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "items_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "items_company_sku_uq" UNIQUE("company_id","sku"),
	CONSTRAINT "items_hsn_shape" CHECK ("items"."hsn_sac" IS NULL OR "items"."hsn_sac" ~ '^([0-9]{4}|[0-9]{6}|[0-9]{8})$'),
	CONSTRAINT "items_rate_range" CHECK ("items"."gst_rate" BETWEEN 0 AND 100),
	CONSTRAINT "items_reorder_nonneg" CHECK ("items"."reorder_level" >= 0 AND "items"."reorder_qty" >= 0)
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"name" text NOT NULL,
	"kind" "location_kind" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "locations_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "locations_company_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "locations_internal_has_warehouse" CHECK ("locations"."kind" <> 'internal' OR "locations"."warehouse_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"approval_limit_paise" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_company_user_uq" UNIQUE("company_id","user_id"),
	CONSTRAINT "memberships_limit_nonneg" CHECK ("memberships"."approval_limit_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "number_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" text NOT NULL,
	"fy" text NOT NULL,
	"prefix" text NOT NULL,
	"padding" smallint DEFAULT 5 NOT NULL,
	"next_serial" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "number_series_company_doc_fy_uq" UNIQUE("company_id","doc_type","fy"),
	CONSTRAINT "number_series_next_positive" CHECK ("number_series"."next_serial" >= 1)
);
--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" "party_kind" NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"gstin" text,
	"pan" text,
	"registration_type" "gst_registration" NOT NULL,
	"state_code" char(2) NOT NULL,
	"address_line" text,
	"city" text,
	"pincode" text,
	"email" text,
	"phone" text,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"is_msme" boolean DEFAULT false NOT NULL,
	"udyam_no" text,
	"tally_ledger_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "parties_gstin_shape" CHECK ("parties"."gstin" IS NULL OR "parties"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "parties_gstin_matches_state" CHECK ("parties"."gstin" IS NULL OR left("parties"."gstin", 2) = "parties"."state_code"),
	CONSTRAINT "parties_credit_days_nonneg" CHECK ("parties"."credit_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "uoms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"uqc" text NOT NULL,
	"decimals" smallint DEFAULT 3 NOT NULL,
	CONSTRAINT "uoms_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "uoms_company_code_uq" UNIQUE("company_id","code"),
	CONSTRAINT "uoms_decimals_range" CHECK ("uoms"."decimals" BETWEEN 0 AND 6)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lower" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"state_code" char(2) NOT NULL,
	"address_line" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "warehouses_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "warehouses_company_code_uq" UNIQUE("company_id","code")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_fk" FOREIGN KEY ("company_id","bom_id") REFERENCES "public"."boms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_component_fk" FOREIGN KEY ("company_id","component_item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_uom_fk" FOREIGN KEY ("company_id","uom_id") REFERENCES "public"."uoms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_warehouse_fk" FOREIGN KEY ("company_id","warehouse_id") REFERENCES "public"."warehouses"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_series" ADD CONSTRAINT "number_series_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_gstin_uq" ON "companies" USING btree ("gstin") WHERE "companies"."gstin" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "parties_company_gstin_uq" ON "parties" USING btree ("company_id","gstin") WHERE "parties"."gstin" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");