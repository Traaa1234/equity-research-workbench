CREATE TABLE "macro_freshness" (
	"series_id" text PRIMARY KEY NOT NULL,
	"last_fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_obs_date" date,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "macro_series" (
	"series_id" text NOT NULL,
	"obs_date" date NOT NULL,
	"value" numeric(20, 6) NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "macro_series_series_id_obs_date_pk" PRIMARY KEY("series_id","obs_date")
);
--> statement-breakpoint
CREATE INDEX "macro_series_series_idx" ON "macro_series" USING btree ("series_id","obs_date");