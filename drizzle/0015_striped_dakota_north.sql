CREATE TYPE "public"."production_order_state" AS ENUM('draft', 'released', 'closed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."stock_doc_type" ADD VALUE 'production';--> statement-breakpoint
CREATE TABLE "production_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text,
	"state" "production_order_state" DEFAULT 'draft' NOT NULL,
	"item_id" uuid NOT NULL,
	"bom_id" uuid NOT NULL,
	"qty" numeric(18, 3) NOT NULL,
	"sales_order_id" uuid,
	"sales_order_line_id" uuid,
	"order_date" date NOT NULL,
	"due_date" date NOT NULL,
	"notes" text,
	"created_by" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "production_orders_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "production_orders_qty_positive" CHECK ("production_orders"."qty" > 0),
	CONSTRAINT "production_orders_number_when_released" CHECK (("production_orders"."state" = 'draft') OR ("production_orders"."state" = 'cancelled') OR ("production_orders"."number" IS NOT NULL)),
	CONSTRAINT "production_orders_line_needs_order" CHECK ("production_orders"."sales_order_line_id" IS NULL OR "production_orders"."sales_order_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "stock_moves" ADD COLUMN "production_order_id" uuid;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_item_fk" FOREIGN KEY ("company_id","item_id") REFERENCES "public"."items"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_bom_fk" FOREIGN KEY ("company_id","bom_id") REFERENCES "public"."boms"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_sales_order_fk" FOREIGN KEY ("company_id","sales_order_id") REFERENCES "public"."sales_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "production_orders" ADD CONSTRAINT "production_orders_sales_line_fk" FOREIGN KEY ("company_id","sales_order_line_id") REFERENCES "public"."sales_order_lines"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "production_orders_number_uq" ON "production_orders" USING btree ("company_id","number") WHERE "production_orders"."number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "production_orders_sales_line_idx" ON "production_orders" USING btree ("company_id","sales_order_line_id");--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_production_order_fk" FOREIGN KEY ("company_id","production_order_id") REFERENCES "public"."production_orders"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_moves_production_order_idx" ON "stock_moves" USING btree ("company_id","production_order_id");