import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const companies = pgTable('companies', {
  ticker: text('ticker').primaryKey(),
  name: text('name').notNull(),
  cik: text('cik'),
  exchange: text('exchange'),
  sector: text('sector'),
  industry: text('industry'),
  isSeed: boolean('is_seed').notNull().default(false),
  firstIngestedAt: timestamp('first_ingested_at', { withTimezone: true }).notNull().defaultNow(),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  source: text('source').notNull().default('financial_datasets')
});
