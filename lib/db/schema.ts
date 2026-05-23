import { boolean, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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

export const snapshots = pgTable('snapshots', {
  ticker: text('ticker')
    .primaryKey()
    .references(() => companies.ticker, { onDelete: 'cascade' }),
  price: numeric('price', { precision: 18, scale: 4 }),
  marketCap: numeric('market_cap', { precision: 20, scale: 2 }),
  week52High: numeric('week52_high', { precision: 18, scale: 4 }),
  week52Low: numeric('week52_low', { precision: 18, scale: 4 }),
  pe: numeric('pe', { precision: 10, scale: 4 }),
  ps: numeric('ps', { precision: 10, scale: 4 }),
  pb: numeric('pb', { precision: 10, scale: 4 }),
  evEbitda: numeric('ev_ebitda', { precision: 10, scale: 4 }),
  peg: numeric('peg', { precision: 10, scale: 4 }),
  asOf: timestamp('as_of', { withTimezone: true }).notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull()
});
