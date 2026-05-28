CREATE TABLE "institutional_holdings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"investor_id" text NOT NULL,
	"investor_name" text NOT NULL,
	"report_period" date NOT NULL,
	"shares" numeric(20, 4) NOT NULL,
	"market_value" numeric(20, 2),
	"shares_pct_of_portfolio" numeric(10, 6),
	"shares_pct_of_shareholders" numeric(10, 6),
	"filing_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "institutional_holdings" ADD CONSTRAINT "institutional_holdings_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "institutional_holdings_dedupe" ON "institutional_holdings" USING btree ("ticker","investor_id","report_period");--> statement-breakpoint
CREATE INDEX "institutional_holdings_ticker_period_idx" ON "institutional_holdings" USING btree ("ticker","report_period" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "institutional_holdings_ticker_investor_idx" ON "institutional_holdings" USING btree ("ticker","investor_id","report_period" DESC NULLS LAST);