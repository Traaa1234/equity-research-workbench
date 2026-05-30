# Trade Journal — Design Spec

**Date:** 2026-05-29
**Status:** Approved by user; ready for implementation plan.

## Goal

Give the user a structured place to record (a) what they thought when they
opened a position, (b) what they thought during the life of the position,
and (c) what actually happened when they closed it. The journal is
**qualitative** — no shares, no cost basis, no computed P&L. Its value is
the written learning loop that compounds over time: did I hit my target,
did my conviction match the outcome, what surprised me.

## Non-goals

- Numeric position tracking (shares, entry/exit prices, computed P&L) —
  deferred to a future portfolio-tracker slice.
- Tax lot accounting (FIFO/specific identification).
- Currency conversion / FX.
- Position-level alerts (price crossing target or stop).
- LLM-driven periodic thesis reviews — depends on this slice but ships
  separately.
- Exports (CSV, PDF), sharing positions, mobile-optimized editor.

## Architecture

The journal is built around two concepts:

- **Position** — one open-to-close cycle on a ticker. Buy NVDA Jan 2024 →
  Sell NVDA Oct 2024 = one position. Re-opening NVDA in 2025 is a separate
  position.
- **Entry** — a journal note attached to a position. Three kinds: `entry`
  (once, at open), `review` (zero or more, during the life of the position),
  `exit` (once, at close).

```
GET /journal                              ← cross-ticker aggregation
  ├── filter: status, ticker, conviction range, date range
  └── list<PositionCard>

GET /stock/[TICKER]/journal               ← per-ticker view
  ├── "Open positions" section
  ├── "Closed positions" section
  └── editor surfaces (new position, add entry, close position)

Service layer:
  JournalService { listPositions, getPosition, createPosition,
                   updatePosition, closePosition, deletePosition,
                   createEntry, updateEntry, deleteEntry }
  All methods take a userId for ownership verification.

DB:
  journal_positions  (user-scoped)
  journal_entries    (user-scoped via position FK)
  Both RLS-protected with user_id = current_user policy.
```

## Schema

### `journal_positions`

```ts
export const journalPositions = pgTable('journal_positions', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  userId: uuid('user_id').notNull(),
  ticker: text('ticker').notNull().references(() => companies.ticker, { onDelete: 'cascade' }),
  status: text('status').notNull(),                // 'open' | 'closed'
  openedAt: date('opened_at').notNull(),
  closedAt: date('closed_at'),                     // null while status='open'
  convictionAtOpen: integer('conviction_at_open'), // 1..10, nullable
  targetPrice: numeric('target_price', { precision: 18, scale: 4 }),
  stopPrice: numeric('stop_price', { precision: 18, scale: 4 }),
  expectedHoldingDays: integer('expected_holding_days'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  userTickerIdx: index('journal_positions_user_ticker_idx').on(t.userId, t.ticker),
  userStatusIdx: index('journal_positions_user_status_idx').on(t.userId, t.status)
}));
```

**Why `user_id` is a column, not derived from session:** matches the existing
`watchlist` + `notes` + `qa_history` pattern. RLS policies enforce
`user_id = current_setting('request.jwt.claim.sub')`.

**Why `status` is text, not pgEnum:** simpler migrations. Zod validates at
the API layer; CHECK constraints could be added later if needed.

**Why backdating is allowed (`opened_at` is user-supplied):** users will
journal historic positions retroactively. We don't want to force `now()`.

### `journal_entries`

```ts
export const journalEntries = pgTable('journal_entries', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  positionId: bigint('position_id', { mode: 'bigint' })
    .notNull()
    .references(() => journalPositions.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),                    // 'entry' | 'review' | 'exit'
  occurredAt: date('occurred_at').notNull(),
  thesisMd: text('thesis_md').notNull().default(''),
  convictionAtTime: integer('conviction_at_time'),
  outcome: text('outcome'),                        // 'right' | 'wrong' | 'mixed'; exit only
  whatChanged: text('what_changed'),               // markdown; review + exit
  lessons: text('lessons'),                        // markdown; exit only
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (t) => ({
  positionIdx: index('journal_entries_position_idx').on(t.positionId)
}));
```

**Why entries are a separate table not a JSONB column on positions:**
entries have their own edit lifecycle (the user adds review entries weeks
apart) and need their own indexes for cross-position aggregations ("show me
all exit entries with `outcome='wrong'`"). JSONB makes that filter slow.

**Why `outcome`/`whatChanged`/`lessons` live on the entry, not the position:**
they're properties of the specific entry that captured the thought, not of
the position globally. The position doesn't have a single "lessons" — each
exit entry does.

**Why `entry` and `exit` are not enforced as exactly-one-per-position:** an
older position the user is backfilling may not have a clean entry, and
allowing multiple `exit` entries lets the user re-open + re-close (corner
case). App-layer Zod can warn but DB doesn't reject.

### RLS

Both tables get user-scoped RLS using the same pattern as `qa_history`:

```sql
alter table public.journal_positions enable row level security;

create policy "user_owns_journal_positions"
  on public.journal_positions
  for all
  to authenticated
  using (user_id = (current_setting('request.jwt.claim.sub'))::uuid)
  with check (user_id = (current_setting('request.jwt.claim.sub'))::uuid);

alter table public.journal_entries enable row level security;

create policy "user_owns_journal_entries"
  on public.journal_entries
  for all
  to authenticated
  using (position_id in (
    select id from public.journal_positions
    where user_id = (current_setting('request.jwt.claim.sub'))::uuid
  ))
  with check (position_id in (
    select id from public.journal_positions
    where user_id = (current_setting('request.jwt.claim.sub'))::uuid
  ));
```

`SELECT`, `INSERT`, `UPDATE`, `DELETE` all gated. Service-role bypasses
(used by the service layer behind authenticated API routes).

## Service + API

### `JournalService` (`lib/services/journal.ts`)

```ts
export interface JournalPosition {
  id: bigint;
  userId: string;
  ticker: string;
  status: 'open' | 'closed';
  openedAt: string;                       // YYYY-MM-DD
  closedAt: string | null;
  convictionAtOpen: number | null;        // 1..10
  targetPrice: number | null;
  stopPrice: number | null;
  expectedHoldingDays: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JournalEntry {
  id: bigint;
  positionId: bigint;
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;
  thesisMd: string;
  convictionAtTime: number | null;
  outcome: 'right' | 'wrong' | 'mixed' | null;
  whatChanged: string | null;
  lessons: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PositionWithEntries extends JournalPosition {
  entries: JournalEntry[];                // ordered by occurredAt ASC
}

export interface NewPositionInput {
  ticker: string;
  openedAt: string;
  convictionAtOpen?: number;
  targetPrice?: number;
  stopPrice?: number;
  expectedHoldingDays?: number;
  // Optional inline first entry
  firstEntry?: { thesisMd: string; convictionAtTime?: number };
}

export interface PositionUpdateInput {
  targetPrice?: number | null;
  stopPrice?: number | null;
  expectedHoldingDays?: number | null;
  convictionAtOpen?: number | null;
}

export interface NewEntryInput {
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;
  thesisMd: string;
  convictionAtTime?: number;
  outcome?: 'right' | 'wrong' | 'mixed';
  whatChanged?: string;
  lessons?: string;
}

export interface EntryUpdateInput {
  thesisMd?: string;
  convictionAtTime?: number | null;
  outcome?: 'right' | 'wrong' | 'mixed' | null;
  whatChanged?: string | null;
  lessons?: string | null;
}

export interface ClosePositionInput {
  closedAt: string;
  exitEntry?: NewEntryInput;              // optional but recommended
}

export interface ListPositionsOpts {
  ticker?: string;
  status?: 'open' | 'closed';
  minConviction?: number;
  limit?: number;
  offset?: number;
}

export class JournalService {
  constructor(private readonly deps: { db: ServiceDb }) {}

  async listPositions(userId: string, opts?: ListPositionsOpts): Promise<JournalPosition[]>;
  async getPosition(userId: string, positionId: bigint): Promise<PositionWithEntries | null>;
  async createPosition(userId: string, input: NewPositionInput): Promise<JournalPosition>;
  async updatePosition(userId: string, positionId: bigint, input: PositionUpdateInput): Promise<JournalPosition>;
  async closePosition(userId: string, positionId: bigint, input: ClosePositionInput): Promise<PositionWithEntries>;
  async deletePosition(userId: string, positionId: bigint): Promise<void>;

  async createEntry(userId: string, positionId: bigint, input: NewEntryInput): Promise<JournalEntry>;
  async updateEntry(userId: string, entryId: bigint, input: EntryUpdateInput): Promise<JournalEntry>;
  async deleteEntry(userId: string, entryId: bigint): Promise<void>;
}
```

Every mutation method takes a `userId` and verifies ownership via a `WHERE
user_id = $1` clause before mutating. The RLS policy is defense-in-depth.

### API routes

All routes auth-gated via Stack Auth + `requireUserId`. Zod validation on
all bodies. Cache headers: `Cache-Control: private, no-store` (mutations
and user-specific data shouldn't be cached).

| Method | Path                                         | Purpose                                  |
|--------|----------------------------------------------|------------------------------------------|
| GET    | `/api/journal/positions`                     | List, with query filter params           |
| POST   | `/api/journal/positions`                     | Create position                          |
| GET    | `/api/journal/positions/[id]`                | Position + entries                       |
| PATCH  | `/api/journal/positions/[id]`                | Update fields                            |
| POST   | `/api/journal/positions/[id]/close`          | Close + optional exit entry              |
| DELETE | `/api/journal/positions/[id]`                | Delete (cascades to entries)             |
| POST   | `/api/journal/positions/[id]/entries`        | Add entry                                |
| PATCH  | `/api/journal/entries/[id]`                  | Update entry                             |
| DELETE | `/api/journal/entries/[id]`                  | Delete entry                             |

Ownership: every route verifies `user_id` matches `requireUserId()` either
by query (`WHERE user_id = $1`) or by RLS-enforced session settings.

## UI

### Route: `/journal/page.tsx`

Cross-ticker aggregation.

- **Top filter bar:** status select (`all` / `open` / `closed`),
  ticker typeahead (sourced from `companies` autocomplete pattern),
  conviction range slider, date range picker
- **Sort dropdown:** newest, oldest, by conviction, by ticker
- **List body:** one `PositionCard` per result
- **Empty state:** "No positions yet — open one from any ticker's Journal tab."
- All filter state lives in URL query params so the page is shareable +
  back-button-friendly (same pattern as Watchlist Rollup sort).

### Route: `/stock/[ticker]/journal/page.tsx`

Per-ticker view.

- **Header:** ticker name + "+ New position" button
- **Open positions section:** list of `PositionCard`s with inline-expand entry list
- **Closed positions section:** collapsible by default
- **Editor surfaces:** modal-style `PositionEditor` for create/close;
  inline `EntryEditor` per position when expanded
- **Empty state:** "No positions on AAPL yet. Add one above."

### Components

1. `position-card.tsx` (server) — used in both list views. Header chip:
   ticker, status badge, dates, conviction chip, days-held counter, preview
   of latest entry thesis (first 120 chars).
2. `position-editor.tsx` (client) — form fields: opened_at date picker,
   target/stop price number inputs, conviction slider (1-10), expected hold
   days, plus an inline first-entry markdown editor for the `entry`-kind.
3. `entry-editor.tsx` (client) — markdown text area + kind-specific fields
   (conviction slider, outcome select for exit, what-changed markdown for
   review + exit, lessons markdown for exit only).
4. `entry-list.tsx` (server) — chronological entries for one position with
   kind badge and date headers.
5. `entry-card.tsx` (server) — one entry rendered with markdown.
6. `journal-filters.tsx` (client) — top-level filter bar with URL-driven
   state.
7. `journal-empty.tsx` (server) — empty states for both surfaces.

### Tab nav

Add `'journal'` to `DashboardTab` union and `TABS` array in
`app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`. Position:
between `'overview'` and `'financials'`. (Rationale: journal is about
*your* relationship to the ticker, so it belongs early in the tab order,
near Overview, rather than back next to Ask.)

Add `/journal` to the top-level watchlist nav alongside the existing
Roll-up / Discover / Search / Ask tabs.

### Markdown rendering

Reuse the existing `react-markdown` setup from the filing-briefing
component (Slice 2B). Sanitize via the same pipeline. Same monospace
table treatment.

## Testing

### Unit tests (`tests/compute/`)

1. **`journal-summary.ts`** pure helper that produces a card summary from
   a position + its latest entry: 6 cases — days held calculation, latest
   entry preview truncation at word boundary, no-entries case, "stale"
   flag when last review is > 90 days, target-vs-current price gap, null
   conviction handling.

2. **Position validation helpers:** target_price / stop_price must be
   positive when supplied; conviction in `[1, 10]`; `opened_at <=
   closed_at`; valid kind/outcome enum values. 8 cases.

### Integration tests (`tests/integration/journal-service.test.ts`)

3. **`JournalService`:** 8 cases
   - Create + list happy path (user A's positions don't show for user B)
   - Update target/stop persists round-trip
   - Close position: status='closed', closed_at persisted, optional exit entry inserted in same transaction
   - Cascade delete: deleting a position removes its entries
   - Filter status='open' excludes closed positions
   - Filter minConviction=8 excludes lower-conviction positions
   - Sort by ticker ASC
   - Update entry mutates only the entry's fields, not the position

### API route tests (`tests/integration/api-journal.test.ts`)

4. **CRUD endpoints:** 10 cases
   - 201 on POST /positions with valid body
   - 200 on GET /positions
   - 200 on GET /positions/[id]
   - 200 on PATCH /positions/[id]
   - 200 on POST /positions/[id]/close
   - 204 on DELETE /positions/[id]
   - 201 on POST /positions/[id]/entries
   - 401 unauthenticated on any endpoint
   - 403 trying to access another user's position (RLS smoke)
   - 400 on invalid Zod body (negative target price, conviction out of range)

### RLS smoke (`tests/integration/journal-rls.test.ts`)

5. **User scoping**: 3 cases — user A can SELECT own rows but not user B's;
   user A cannot UPDATE user B's row; user A cannot SELECT user B's entries
   via the position FK.

### E2E (`tests/e2e/journal.spec.ts`)

6. Authenticated user → /stock/AAPL/journal → "+ New position" → fill in
   ticker + opened_at + thesis_md + conviction slider → save → position
   card appears in Open section → expand inline → add review entry → save
   → entry appears in list → close position with exit entry → position
   moves to Closed section → navigate to /journal → confirm closed
   position appears in cross-ticker view with status badge.

## Error handling

- **Foreign-key violation on bad ticker** (ticker not in `companies`): 400
  with helpful message and a hint to add the ticker via the existing
  add-ticker dialog first.
- **Concurrent edits:** last-write-wins. Response includes `updated_at`;
  client can warn on stale writes by passing `If-Unmodified-Since`-style
  optimistic locking in a follow-up slice.
- **Markdown sanitization:** route the user's thesis through the same
  DOMPurify-equivalent pipeline that the filing-briefing renderer uses.
  No script tags, no event handlers, no on* attributes.
- **Position with no `entry`-kind:** allowed (corner case for backfilled
  positions). UI surfaces a quiet warning chip on the card.
- **Deleting a position the UI is currently displaying:** server returns
  204; client navigates back to the list view.

## Out of scope for v1 (explicit)

- Numeric position tracking (shares, prices, P&L)
- Tax lot accounting
- Currency conversion / FX
- Position-level alerts (price crossing target or stop)
- LLM-driven periodic thesis reviews (separate slice — depends on this one)
- Exports (CSV, PDF)
- Sharing positions with other users
- Mobile-optimized markdown editor
- Markdown autosave (manual save only)
- Position tagging / categories
- Linked positions (e.g., paired trades)
- Reopening a closed position (user creates a new one instead)
