CREATE TABLE "qa_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_ticker" text,
	"query" text NOT NULL,
	"answer_text" text NOT NULL,
	"citations" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "qa_history_user_created_idx" ON "qa_history" USING btree ("user_id","created_at" DESC NULLS LAST);