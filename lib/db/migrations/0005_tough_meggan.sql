CREATE TABLE "filing_summaries" (
	"filing_id" text PRIMARY KEY NOT NULL,
	"summary_text" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "filing_summaries" ADD CONSTRAINT "filing_summaries_filing_id_filings_accession_no_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("accession_no") ON DELETE cascade ON UPDATE no action;