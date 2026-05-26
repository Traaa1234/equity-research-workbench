CREATE TABLE "chunk_embeddings" (
	"filing_id" text NOT NULL,
	"section_key" text NOT NULL,
	"sub_chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"char_offset_start" integer,
	"char_offset_end" integer,
	"embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model" text NOT NULL,
	CONSTRAINT "chunk_embeddings_filing_id_section_key_sub_chunk_index_pk" PRIMARY KEY("filing_id","section_key","sub_chunk_index")
);
--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_filing_id_filings_accession_no_fk" FOREIGN KEY ("filing_id") REFERENCES "public"."filings"("accession_no") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_filing_idx" ON "chunk_embeddings" USING btree ("filing_id");