CREATE TABLE "news_articles" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticker" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"source" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sentiment" text,
	"confidence" numeric(4, 3),
	"scored_at" timestamp with time zone,
	"scoring_model" text,
	"scoring_prompt_version" text
);
--> statement-breakpoint
ALTER TABLE "news_articles" ADD CONSTRAINT "news_articles_ticker_companies_ticker_fk" FOREIGN KEY ("ticker") REFERENCES "public"."companies"("ticker") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_articles_ticker_url_uniq" ON "news_articles" USING btree ("ticker","url");--> statement-breakpoint
CREATE INDEX "news_articles_ticker_date_idx" ON "news_articles" USING btree ("ticker","published_at" DESC NULLS LAST);