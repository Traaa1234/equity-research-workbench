import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';

// Custom column type for pgvector. Drizzle's pg-core doesn't ship a `vector`
// type yet, so we define one. Stores as JSON array literal '[0.1,0.2,...]',
// which pgvector accepts as input. Reads back as number[].
export const vector = customType<{
  data: number[];
  driverData: string;
  config: { dimensions: number };
}>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 1024})`;
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(raw) {
    return typeof raw === 'string' ? (JSON.parse(raw) as number[]) : (raw as unknown as number[]);
  }
});

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

export const watchlist = pgTable(
  'watchlist',
  {
    // user_id is the Stack Auth user uuid. No FK — Stack Auth users live in
    // an external service. Orphan cleanup happens via webhook in Slice 4.
    userId: uuid('user_id').notNull(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.ticker] }),
    userAddedIdx: index('watchlist_user_added_idx').on(t.userId, t.addedAt)
  })
);

export const notes = pgTable(
  'notes',
  {
    userId: uuid('user_id').notNull(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    body: text('body').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.ticker] })
  })
);

export const refreshRuns = pgTable(
  'refresh_runs',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ok: boolean('ok'),
    sourceUsed: text('source_used'),
    error: text('error')
  },
  (t) => ({
    tickerStartedIdx: index('refresh_runs_ticker_started_idx').on(t.ticker, t.startedAt)
  })
);

export const filings = pgTable(
  'filings',
  {
    accessionNo: text('accession_no').primaryKey(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    cik: text('cik').notNull(),
    formType: text('form_type').notNull(),
    filingDate: date('filing_date').notNull(),
    periodEnd: date('period_end'),
    primaryDocUrl: text('primary_doc_url').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    parsedAt: timestamp('parsed_at', { withTimezone: true }),
    source: text('source').notNull().default('sec_edgar')
  },
  (t) => ({
    tickerDateIdx: index('filings_ticker_date_idx').on(t.ticker, t.filingDate),
    tickerFormDateIdx: index('filings_ticker_form_date_idx').on(t.ticker, t.formType, t.filingDate)
  })
);

// One chunk per (filing, section_key) by design — sections (item_1_business,
// item_7_mdna, etc.) are extracted whole, not sub-chunked. The unique index
// enables idempotent re-ingestion via .onConflictDoNothing(). If Slice 2C
// embeddings require sub-section chunks, drop the unique index and add a
// chunk_index column to make (filing_id, section_key, chunk_index) unique.
export const filingChunks = pgTable(
  'filing_chunks',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    filingId: text('filing_id')
      .notNull()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    sectionKey: text('section_key').notNull(),
    sectionTitle: text('section_title').notNull(),
    text: text('text').notNull(),
    charCount: integer('char_count').notNull(),
    charOffsetStart: integer('char_offset_start'),
    charOffsetEnd: integer('char_offset_end'),
    tables: jsonb('tables').notNull().default(sql`'[]'::jsonb`)
  },
  (t) => ({
    filingSectionUniq: uniqueIndex('filing_chunks_filing_section_uniq').on(t.filingId, t.sectionKey),
    filingIdx: index('filing_chunks_filing_idx').on(t.filingId)
  })
);

export const filingSummaries = pgTable(
  'filing_summaries',
  {
    filingId: text('filing_id')
      .primaryKey()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    summaryText: text('summary_text').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow()
  }
);

export const chunkEmbeddings = pgTable(
  'chunk_embeddings',
  {
    filingId: text('filing_id')
      .notNull()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    sectionKey: text('section_key').notNull(),
    subChunkIndex: integer('sub_chunk_index').notNull(),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    charOffsetStart: integer('char_offset_start'),
    charOffsetEnd: integer('char_offset_end'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }).notNull().defaultNow(),
    model: text('model').notNull()
  },
  (t) => ({
    pk: primaryKey({ columns: [t.filingId, t.sectionKey, t.subChunkIndex] }),
    filingIdx: index('chunk_embeddings_filing_idx').on(t.filingId)
  })
);

export const qaHistory = pgTable(
  'qa_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    scopeType: text('scope_type').notNull(),       // 'watchlist' | 'ticker'
    scopeTicker: text('scope_ticker'),             // nullable; set only when scope_type='ticker'
    query: text('query').notNull(),
    answerText: text('answer_text').notNull(),
    citations: jsonb('citations').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userCreatedIdx: index('qa_history_user_created_idx').on(t.userId, t.createdAt.desc())
  })
);

export const newsArticles = pgTable(
  'news_articles',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker')
      .notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title').notNull(),
    source: text('source').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    sentiment: text('sentiment'),                                       // 'bullish' | 'neutral' | 'bearish' | null
    confidence: numeric('confidence', { precision: 4, scale: 3 }),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
    scoringModel: text('scoring_model'),
    scoringPromptVersion: text('scoring_prompt_version')
  },
  (t) => ({
    tickerUrlUniq: uniqueIndex('news_articles_ticker_url_uniq').on(t.ticker, t.url),
    tickerDateIdx: index('news_articles_ticker_date_idx').on(t.ticker, t.publishedAt.desc())
  })
);

export const insiderTrades = pgTable(
  'insider_trades',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker').notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    insiderName: text('insider_name').notNull(),
    insiderTitle: text('insider_title'),
    isBoardDirector: boolean('is_board_director').notNull().default(false),
    transactionDate: date('transaction_date').notNull(),
    transactionType: text('transaction_type').notNull(),
    shares: numeric('shares', { precision: 20, scale: 4 }).notNull(),
    pricePerShare: numeric('price_per_share', { precision: 20, scale: 6 }),
    transactionValue: numeric('transaction_value', { precision: 20, scale: 2 }),
    sharesOwnedBefore: numeric('shares_owned_before', { precision: 20, scale: 4 }),
    sharesOwnedAfter: numeric('shares_owned_after', { precision: 20, scale: 4 }),
    securityTitle: text('security_title'),
    filingDate: date('filing_date').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    dedupeKey: uniqueIndex('insider_trades_dedupe').on(
      t.ticker, t.filingDate, t.insiderName, t.transactionDate, t.shares, t.transactionType
    ),
    tickerDateIdx: index('insider_trades_ticker_date_idx').on(
      t.ticker, t.transactionDate.desc()
    )
  })
);

export const institutionalHoldings = pgTable(
  'institutional_holdings',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ticker: text('ticker').notNull()
      .references(() => companies.ticker, { onDelete: 'cascade' }),
    investorId: text('investor_id').notNull(),
    investorName: text('investor_name').notNull(),
    reportPeriod: date('report_period').notNull(),
    shares: numeric('shares', { precision: 20, scale: 4 }).notNull(),
    marketValue: numeric('market_value', { precision: 20, scale: 2 }),
    sharesPctOfPortfolio: numeric('shares_pct_of_portfolio', { precision: 10, scale: 6 }),
    sharesPctOfShareholders: numeric('shares_pct_of_shareholders', { precision: 10, scale: 6 }),
    filingDate: date('filing_date').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    dedupeKey: uniqueIndex('institutional_holdings_dedupe').on(
      t.ticker, t.investorId, t.reportPeriod
    ),
    tickerPeriodIdx: index('institutional_holdings_ticker_period_idx').on(
      t.ticker, t.reportPeriod.desc()
    ),
    tickerInvestorIdx: index('institutional_holdings_ticker_investor_idx').on(
      t.ticker, t.investorId, t.reportPeriod.desc()
    )
  })
);
