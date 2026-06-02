CREATE TABLE "journal_entries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"position_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" date NOT NULL,
	"thesis_md" text DEFAULT '' NOT NULL,
	"conviction_at_time" integer,
	"outcome" text,
	"what_changed" text,
	"lessons" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_positions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ticker" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" date NOT NULL,
	"closed_at" date,
	"conviction_at_open" integer,
	"target_price" numeric(18, 4),
	"stop_price" numeric(18, 4),
	"expected_holding_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_position_id_journal_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."journal_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_positions" ADD CONSTRAINT "journal_positions_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_position_idx" ON "journal_entries" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX "journal_positions_user_ticker_idx" ON "journal_positions" USING btree ("user_id","ticker");--> statement-breakpoint
CREATE INDEX "journal_positions_user_status_idx" ON "journal_positions" USING btree ("user_id","status");