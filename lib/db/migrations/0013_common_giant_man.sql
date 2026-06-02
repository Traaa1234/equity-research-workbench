CREATE TABLE "transcript_chunks" (
	"transcript_id" text NOT NULL,
	"section_index" integer NOT NULL,
	"section_kind" text NOT NULL,
	"speaker" text NOT NULL,
	"role" text,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	CONSTRAINT "transcript_chunks_transcript_id_section_index_pk" PRIMARY KEY("transcript_id","section_index")
);
--> statement-breakpoint
CREATE TABLE "transcript_freshness" (
	"ticker" text PRIMARY KEY NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_url_seen" text
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"fiscal_quarter" integer NOT NULL,
	"call_date" date NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_freshness" ADD CONSTRAINT "transcript_freshness_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_chunks_transcript_idx" ON "transcript_chunks" USING btree ("transcript_id");--> statement-breakpoint
CREATE INDEX "transcript_chunks_embedding_hnsw_idx" ON "transcript_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "transcripts_ticker_date_idx" ON "transcripts" USING btree ("ticker","call_date");