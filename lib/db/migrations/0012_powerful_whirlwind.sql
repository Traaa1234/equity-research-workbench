CREATE TABLE "companies_universe" (
	"ticker" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"exchange" text,
	"country" text,
	"sector" text,
	"industry" text,
	"description" text,
	"description_embedding" vector(1024),
	"market_cap" numeric(20, 2),
	"sources" text[],
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cu_description_embedding_hnsw_idx" ON "companies_universe" USING hnsw ("description_embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "cu_country_idx" ON "companies_universe" USING btree ("country");--> statement-breakpoint
CREATE INDEX "cu_exchange_idx" ON "companies_universe" USING btree ("exchange");--> statement-breakpoint
CREATE INDEX "cu_sector_idx" ON "companies_universe" USING btree ("sector");