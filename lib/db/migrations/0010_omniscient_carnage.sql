CREATE TABLE "insider_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"insider_name" text NOT NULL,
	"insider_title" text,
	"is_board_director" boolean DEFAULT false NOT NULL,
	"transaction_date" date NOT NULL,
	"transaction_type" text NOT NULL,
	"shares" numeric(20, 4) NOT NULL,
	"price_per_share" numeric(20, 6),
	"transaction_value" numeric(20, 2),
	"shares_owned_before" numeric(20, 4),
	"shares_owned_after" numeric(20, 4),
	"security_title" text,
	"filing_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "insider_trades" ADD CONSTRAINT "insider_trades_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "insider_trades_dedupe" ON "insider_trades" USING btree ("ticker","filing_date","insider_name","transaction_date","shares","transaction_type");--> statement-breakpoint
CREATE INDEX "insider_trades_ticker_date_idx" ON "insider_trades" USING btree ("ticker","transaction_date" DESC NULLS LAST);