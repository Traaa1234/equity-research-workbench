CREATE TABLE "filing_chunks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"filing_id" text NOT NULL,
	"section_key" text NOT NULL,
	"section_title" text NOT NULL,
	"text" text NOT NULL,
	"char_count" integer NOT NULL,
	"char_offset_start" integer,
	"char_offset_end" integer
);
--> statement-breakpoint
CREATE TABLE "filings" (
	"accession_no" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"cik" text NOT NULL,
	"form_type" text NOT NULL,
	"filing_date" date NOT NULL,
	"period_end" date,
	"primary_doc_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone,
	"source" text DEFAULT 'sec_edgar' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "filing_chunks" ADD CONSTRAINT "filing_chunks_filing_id_filings_accession_no_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("accession_no") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filings" ADD CONSTRAINT "filings_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "filing_chunks_filing_section_uniq" ON "filing_chunks" USING btree ("filing_id","section_key");--> statement-breakpoint
CREATE INDEX "filing_chunks_filing_idx" ON "filing_chunks" USING btree ("filing_id");--> statement-breakpoint
CREATE INDEX "filings_ticker_date_idx" ON "filings" USING btree ("ticker","filing_date");--> statement-breakpoint
CREATE INDEX "filings_ticker_form_date_idx" ON "filings" USING btree ("ticker","form_type","filing_date");