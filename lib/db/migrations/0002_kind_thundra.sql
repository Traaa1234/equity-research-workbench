CREATE TABLE "earnings" (
	"ticker" text NOT NULL,
	"period_end" date NOT NULL,
	"reported_date" date,
	"eps_actual" numeric(10, 4),
	"price_1d_pct" numeric(10, 6),
	"price_5d_pct" numeric(10, 6),
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "earnings_ticker_period_end_pk" PRIMARY KEY("ticker","period_end")
);
--> statement-breakpoint
CREATE TABLE "fundamentals" (
	"ticker" text NOT NULL,
	"period_end" date NOT NULL,
	"period_type" text NOT NULL,
	"statement_type" text NOT NULL,
	"line_item" text NOT NULL,
	"value" numeric(20, 2),
	"currency" text DEFAULT 'USD' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	CONSTRAINT "fundamentals_ticker_period_end_period_type_statement_type_line_item_pk" PRIMARY KEY("ticker","period_end","period_type","statement_type","line_item")
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"ticker" text NOT NULL,
	"date" date NOT NULL,
	"open" numeric(18, 4),
	"high" numeric(18, 4),
	"low" numeric(18, 4),
	"close" numeric(18, 4) NOT NULL,
	"adj_close" numeric(18, 4),
	"volume" bigint,
	"source" text NOT NULL,
	CONSTRAINT "prices_ticker_date_pk" PRIMARY KEY("ticker","date")
);
--> statement-breakpoint
ALTER TABLE "earnings" ADD CONSTRAINT "earnings_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamentals" ADD CONSTRAINT "fundamentals_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prices" ADD CONSTRAINT "prices_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fundamentals_ticker_stmt_idx" ON "fundamentals" USING btree ("ticker","statement_type","period_type","period_end");