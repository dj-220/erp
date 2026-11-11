CREATE TYPE "public"."stock_doc_type" AS ENUM('goods_receipt', 'delivery', 'transfer', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."stock_state" AS ENUM('draft', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"doc_type" "stock_doc_type" NOT NULL,
	"number" text,
	"state" "stock_state" DEFAULT 'draft' NOT NULL,
	"doc_date" date NOT NULL,
	"party_id" uuid,
	"reference" text,
	"notes" text,
	"created_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_documents_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "stock_documents_number_iff_done" CHECK (("stock_documents"."state" = 'done') = ("stock_documents"."number" IS NOT NULL)),
	CONSTRAINT "stock_documents_posted_iff_done" CHECK (("stock_documents"."state" = 'done') = ("stock_documents"."posted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "stock_moves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"item_id" uuid NOT NULL,
	"from_location_id" uuid NOT NULL,
	"to_location_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"unit_cost" numeric(18, 4),
	"value_paise" bigint,
	"state" "stock_state" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_moves_document_line_uq" UNIQUE("document_id","line_no"),
	CONSTRAINT "stock_moves_qty_positive" CHECK ("stock_moves"."qty" > 0),
	CONSTRAINT "stock_moves_distinct_locations" CHECK ("stock_moves"."from_location_id" <> "stock_moves"."to_location_id"),
	CONSTRAINT "stock_moves_value_iff_done" CHECK (("stock_moves"."state" = 'done') = ("stock_moves"."value_paise" IS NOT NULL)),
	CONSTRAINT "stock_moves_value_nonneg" CHECK ("stock_moves"."value_paise" IS NULL OR "stock_moves"."value_paise" >= 0),
	CONSTRAINT "stock_moves_cost_nonneg" CHECK ("stock_moves"."unit_cost" IS NULL OR "stock_moves"."unit_cost" >= 0)
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "allow_negative_stock" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_party_fk" FOREIGN KEY ("company_id","party_id") REFERENCES "public"."parties"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_document_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."stock_documents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_from_fk" FOREIGN KEY ("company_id","from_location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_to_fk" FOREIGN KEY ("company_id","to_location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_number_uq" ON "stock_documents" USING btree ("company_id","doc_type","number") WHERE "stock_documents"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "stock_moves_item_idx" ON "stock_moves" USING btree ("company_id","item_id","state");