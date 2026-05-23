CREATE TABLE "companies" (
	"ticker" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cik" text,
	"exchange" text,
	"sector" text,
	"industry" text,
	"is_seed" boolean DEFAULT false NOT NULL,
	"first_ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"source" text DEFAULT 'financial_datasets' NOT NULL
);
