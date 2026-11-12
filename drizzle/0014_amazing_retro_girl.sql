CREATE TYPE "public"."plant_area_kind" AS ENUM('store', 'process', 'qc', 'finished', 'dispatch', 'scrap');--> statement-breakpoint
CREATE TABLE "plant_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "plant_area_kind" NOT NULL,
	"sort_order" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plant_areas_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "plant_areas_location_uq" UNIQUE("company_id","location_id"),
	CONSTRAINT "plant_areas_name_uq" UNIQUE("company_id","name"),
	CONSTRAINT "plant_areas_name_not_blank" CHECK (length(trim("plant_areas"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "plant_areas" ADD CONSTRAINT "plant_areas_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_areas" ADD CONSTRAINT "plant_areas_location_fk" FOREIGN KEY ("company_id","location_id") REFERENCES "public"."locations"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plant_areas_order_idx" ON "plant_areas" USING btree ("company_id","sort_order");