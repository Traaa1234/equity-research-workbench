import {
  bigint,
  boolean,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp
} from 'drizzle-orm/pg-core';

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

export const fundamentals = pgTable(
  'fundamentals',
  {
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    periodEnd: date('period_end').notNull(),
    periodType: text('period_type').notNull(),
    statementType: text('statement_type').notNull(),
    lineItem: text('line_item').notNull(),
    value: numeric('value', { precision: 20, scale: 2 }),
    currency: text('currency').notNull().default('USD'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull()
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.ticker, t.periodEnd, t.periodType, t.statementType, t.lineItem]
    }),
    tickerStatementIdx: index('fundamentals_ticker_stmt_idx').on(
      t.ticker,
      t.statementType,
      t.periodType,
      t.periodEnd
    )
  })
);

export const prices = pgTable(
  'prices',
  {
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    open: numeric('open', { precision: 18, scale: 4 }),
    high: numeric('high', { precision: 18, scale: 4 }),
    low: numeric('low', { precision: 18, scale: 4 }),
    close: numeric('close', { precision: 18, scale: 4 }).notNull(),
    adjClose: numeric('adj_close', { precision: 18, scale: 4 }),
    volume: bigint('volume', { mode: 'bigint' }),
    source: text('source').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.date] })
  })
);

export const earnings = pgTable(
  'earnings',
  {
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    periodEnd: date('period_end').notNull(),
    reportedDate: date('reported_date'),
    epsActual: numeric('eps_actual', { precision: 10, scale: 4 }),
    price1dPct: numeric('price_1d_pct', { precision: 10, scale: 6 }),
    price5dPct: numeric('price_5d_pct', { precision: 10, scale: 6 }),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.periodEnd] })
  })
);
