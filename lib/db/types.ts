import type {
  companies,
  snapshots,
  fundamentals,
  prices,
  earnings,
  watchlist,
  notes,
  refreshRuns,
  filings,
  filingChunks
} from './schema';

export type Company       = typeof companies.$inferSelect;
export type NewCompany    = typeof companies.$inferInsert;
export type Snapshot      = typeof snapshots.$inferSelect;
export type NewSnapshot   = typeof snapshots.$inferInsert;
export type Fundamental   = typeof fundamentals.$inferSelect;
export type NewFundamental= typeof fundamentals.$inferInsert;
export type Price         = typeof prices.$inferSelect;
export type NewPrice      = typeof prices.$inferInsert;
export type Earning       = typeof earnings.$inferSelect;
export type NewEarning    = typeof earnings.$inferInsert;
export type WatchlistRow  = typeof watchlist.$inferSelect;
export type NewWatchlist  = typeof watchlist.$inferInsert;
export type Note          = typeof notes.$inferSelect;
export type NewNote       = typeof notes.$inferInsert;
export type RefreshRun    = typeof refreshRuns.$inferSelect;
export type NewRefreshRun = typeof refreshRuns.$inferInsert;
export type Filing        = typeof filings.$inferSelect;
export type NewFiling     = typeof filings.$inferInsert;
export type FilingChunk   = typeof filingChunks.$inferSelect;
export type NewFilingChunk = typeof filingChunks.$inferInsert;
