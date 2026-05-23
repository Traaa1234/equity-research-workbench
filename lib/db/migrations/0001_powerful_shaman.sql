CREATE TABLE "snapshots" (
	"ticker" text PRIMARY KEY NOT NULL,
	"price" numeric(18, 4),
	"market_cap" numeric(20, 2),
	"week52_high" numeric(18, 4),
	"week52_low" numeric(18, 4),
	"pe" numeric(10, 4),
	"ps" numeric(10, 4),
	"pb" numeric(10, 4),
	"ev_ebitda" numeric(10, 4),
	"peg" numeric(10, 4),
	"as_of" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;