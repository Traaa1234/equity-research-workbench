CREATE TABLE "notes" (
	"user_id" uuid NOT NULL,
	"ticker" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notes_user_id_ticker_pk" PRIMARY KEY("user_id","ticker")
);
--> statement-breakpoint
CREATE TABLE "refresh_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"ok" boolean,
	"source_used" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "watchlist" (
	"user_id" uuid NOT NULL,
	"ticker" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlist_user_id_ticker_pk" PRIMARY KEY("user_id","ticker")
);
--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_runs" ADD CONSTRAINT "refresh_runs_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist" ADD CONSTRAINT "watchlist_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_runs_ticker_started_idx" ON "refresh_runs" USING btree ("ticker","started_at");--> statement-breakpoint
CREATE INDEX "watchlist_user_added_idx" ON "watchlist" USING btree ("user_id","added_at");