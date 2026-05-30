# Trade Journal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a structured per-position trade journal — open/review/exit entries with conviction (1–10), target/stop prices, expected holding period, outcome, markdown thesis — surfaced as both `/journal` (cross-ticker aggregation) and `/stock/[TICKER]/journal` (per-ticker editor).

**Architecture:** Two user-scoped tables (`journal_positions`, `journal_entries`) with RLS on SELECT and service-role writes (mirrors `qa_history` pattern). Pure `JournalService` does all CRUD with `userId` ownership checks. Nine REST endpoints under `/api/journal/`. Two pages share seven components.

**Tech Stack:** Next.js 14 App Router + TypeScript strict, Drizzle ORM + Neon Postgres, Stack Auth, react-markdown (reused from Slice 2B), vitest, Playwright.

**Spec source:** `docs/superpowers/specs/2026-05-29-trade-journal-design.md`

**Deviations from spec:** RLS policies will be `FOR SELECT` only (not `FOR ALL`) to match the established `qa_history` pattern — service-role handles all writes from the API layer. Functionally equivalent.

---

## File Structure

**Create (28 files):**

Schema + migrations:
- `lib/db/migrations/00XX_journal.sql` (drizzle-kit generated)
- `lib/db/migrations/9988_rls_journal.sql`

Pure compute:
- `lib/compute/journal-summary.ts`
- `lib/compute/journal-validation.ts`
- `tests/compute/journal-summary.test.ts`
- `tests/compute/journal-validation.test.ts`

Service:
- `lib/services/journal.ts`
- `tests/integration/journal-service.test.ts`

API routes:
- `app/api/journal/positions/route.ts` (GET list, POST create)
- `app/api/journal/positions/[id]/route.ts` (GET, PATCH, DELETE)
- `app/api/journal/positions/[id]/close/route.ts` (POST)
- `app/api/journal/positions/[id]/entries/route.ts` (POST)
- `app/api/journal/entries/[id]/route.ts` (PATCH, DELETE)
- `tests/integration/api-journal-positions.test.ts`
- `tests/integration/api-journal-entries.test.ts`
- `tests/integration/journal-rls.test.ts`

UI (per-ticker tab):
- `app/(app)/stock/[ticker]/journal/page.tsx`
- `app/(app)/stock/[ticker]/journal/_components/position-card.tsx`
- `app/(app)/stock/[ticker]/journal/_components/position-editor.tsx`
- `app/(app)/stock/[ticker]/journal/_components/entry-editor.tsx`
- `app/(app)/stock/[ticker]/journal/_components/entry-list.tsx`
- `app/(app)/stock/[ticker]/journal/_components/entry-card.tsx`
- `app/(app)/stock/[ticker]/journal/_components/journal-empty.tsx`

UI (top-level):
- `app/(app)/journal/page.tsx`
- `app/(app)/journal/_components/journal-filters.tsx`

E2E:
- `tests/e2e/journal.spec.ts`

**Modify (3 files):**
- `lib/db/schema.ts` — add `journalPositions`, `journalEntries` tables
- `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` — add `'journal'` between `'overview'` and `'financials'`
- `app/(app)/watchlist/_components/watchlist-tabs.tsx` — add Journal entry alongside Roll-up/Discover/Search/Ask

---

## Task 1: Schema + drizzle migration

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/db/migrations/00XX_journal.sql` (via drizzle-kit)
- Test: `tests/integration/journal-schema.test.ts`

- [ ] **Step 1: Add Drizzle schemas to `lib/db/schema.ts`**

Append at the bottom of the file (after the existing `transcriptFreshness` export if Task 1 of the Transcripts plan has already landed; otherwise after `companiesUniverse`):

```ts
export const journalPositions = pgTable(
  'journal_positions',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    ticker: text('ticker').notNull().references(() => companies.ticker, { onDelete: 'cascade' }),
    status: text('status').notNull(),                  // 'open' | 'closed'
    openedAt: date('opened_at').notNull(),
    closedAt: date('closed_at'),
    convictionAtOpen: integer('conviction_at_open'),   // 1..10
    targetPrice: numeric('target_price', { precision: 18, scale: 4 }),
    stopPrice: numeric('stop_price', { precision: 18, scale: 4 }),
    expectedHoldingDays: integer('expected_holding_days'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userTickerIdx: index('journal_positions_user_ticker_idx').on(t.userId, t.ticker),
    userStatusIdx: index('journal_positions_user_status_idx').on(t.userId, t.status)
  })
);

export const journalEntries = pgTable(
  'journal_entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    positionId: bigint('position_id', { mode: 'bigint' })
      .notNull()
      .references(() => journalPositions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),                      // 'entry' | 'review' | 'exit'
    occurredAt: date('occurred_at').notNull(),
    thesisMd: text('thesis_md').notNull().default(''),
    convictionAtTime: integer('conviction_at_time'),
    outcome: text('outcome'),                          // 'right' | 'wrong' | 'mixed'
    whatChanged: text('what_changed'),
    lessons: text('lessons'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    positionIdx: index('journal_entries_position_idx').on(t.positionId)
  })
);
```

- [ ] **Step 2: Generate the migration**

Run:

```bash
pnpm db:generate
```

Expected: a new `lib/db/migrations/00XX_<random_name>.sql` file appears containing `CREATE TABLE journal_positions ...`, `CREATE TABLE journal_entries ...`, and the three indexes.

- [ ] **Step 3: Apply to test branch**

```bash
DATABASE_URL=$DATABASE_URL_TEST_SERVICE_ROLE pnpm db:migrate
```

Verify:

```bash
psql $DATABASE_URL_TEST_SERVICE_ROLE -c "\d journal_positions"
psql $DATABASE_URL_TEST_SERVICE_ROLE -c "\d journal_entries"
```

- [ ] **Step 4: Apply to production branch**

```bash
DATABASE_URL=$DATABASE_URL_SERVICE_ROLE pnpm db:migrate
```

Same verification.

- [ ] **Step 5: Write a schema smoke test**

Create `tests/integration/journal-schema.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

describe('journal schema', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
  });

  it('inserts a position + entries and reads them back', async () => {
    const userId = randomUUID();
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15',
      convictionAtOpen: 8, targetPrice: '250.00', stopPrice: '180.00', expectedHoldingDays: 365
    }).returning();
    expect(pos!.id).toBeDefined();
    expect(pos!.status).toBe('open');

    await dbH.db.insert(journalEntries).values({
      positionId: pos!.id, kind: 'entry', occurredAt: '2024-01-15',
      thesisMd: 'AI-capex thesis', convictionAtTime: 8
    });
    const entries = await dbH.db.select().from(journalEntries);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.thesisMd).toBe('AI-capex thesis');
  });

  it('cascade-deletes entries when position is dropped', async () => {
    const userId = randomUUID();
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    await dbH.db.insert(journalEntries).values({
      positionId: pos!.id, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x'
    });
    await dbH.db.delete(journalPositions).where(sql`id = ${pos!.id}`);
    const entries = await dbH.db.select().from(journalEntries);
    expect(entries).toHaveLength(0);
  });

  it('cascade-deletes positions when ticker is dropped from companies', async () => {
    const userId = randomUUID();
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    });
    await dbH.db.delete(companies).where(sql`ticker = 'AAPL'`);
    const positions = await dbH.db.select().from(journalPositions);
    expect(positions).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run the schema test**

```bash
pnpm test:integration tests/integration/journal-schema.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/00*_journal.sql tests/integration/journal-schema.test.ts
git commit -m "$(cat <<'EOF'
feat(journal): schema for journal_positions + journal_entries

Two user-scoped tables. journal_positions holds one open-to-close
cycle per ticker per user with conviction/target/stop/expected-hold
fields. journal_entries holds entry/review/exit notes with markdown
thesis + structured fields. Both reference companies(ticker) ON
DELETE CASCADE; entries reference positions ON DELETE CASCADE.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: RLS migration + smoke

**Files:**
- Create: `lib/db/migrations/9988_rls_journal.sql`
- Test: `tests/integration/journal-rls.test.ts`

- [ ] **Step 1: Write the RLS migration**

Create `lib/db/migrations/9988_rls_journal.sql`:

```sql
-- RLS for the trade journal. Same pattern as qa_history (user-scoped read,
-- service_role handles all writes via JournalService at the API layer).

alter table public.journal_positions enable row level security;
alter table public.journal_entries enable row level security;

drop policy if exists "users read own journal_positions" on public.journal_positions;
create policy "users read own journal_positions"
  on public.journal_positions for select to authenticated
  using (user_id::text = current_setting('request.jwt.claim.sub', true));

drop policy if exists "users read own journal_entries" on public.journal_entries;
create policy "users read own journal_entries"
  on public.journal_entries for select to authenticated
  using (position_id in (
    select id from public.journal_positions
    where user_id::text = current_setting('request.jwt.claim.sub', true)
  ));

grant select on public.journal_positions to authenticated;
grant select on public.journal_entries to authenticated;
```

- [ ] **Step 2: Apply to both branches**

```bash
psql $DATABASE_URL_TEST_SERVICE_ROLE -f lib/db/migrations/9988_rls_journal.sql
psql $DATABASE_URL_SERVICE_ROLE      -f lib/db/migrations/9988_rls_journal.sql
```

- [ ] **Step 3: Write the RLS smoke test**

Create `tests/integration/journal-rls.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb, makeTestUserDb, newUserId } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('journal RLS', () => {
  let svcH: ReturnType<typeof makeTestServiceDb>;
  let userH: ReturnType<typeof makeTestUserDb>;
  beforeAll(() => { svcH = makeTestServiceDb(); userH = makeTestUserDb(); });
  afterAll(async () => { await svcH.close(); await userH.close(); });
  beforeEach(async () => {
    await svcH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await svcH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  });

  it('user A can SELECT own positions, not user Bs', async () => {
    const userA = newUserId();
    const userB = newUserId();
    const [posA] = await svcH.db.insert(journalPositions).values({
      userId: userA, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const [posB] = await svcH.db.insert(journalPositions).values({
      userId: userB, ticker: 'AAPL', status: 'open', openedAt: '2024-02-01'
    }).returning();
    expect(posA!.id).toBeDefined();
    expect(posB!.id).toBeDefined();

    const aRows = await userH.asUser(userA, async (tx) => tx.select().from(journalPositions));
    expect(aRows).toHaveLength(1);
    expect(aRows[0]!.userId).toBe(userA);

    const bRows = await userH.asUser(userB, async (tx) => tx.select().from(journalPositions));
    expect(bRows).toHaveLength(1);
    expect(bRows[0]!.userId).toBe(userB);
  });

  it('user A can SELECT entries on own positions, not user Bs', async () => {
    const userA = newUserId();
    const userB = newUserId();
    const [posA] = await svcH.db.insert(journalPositions).values({
      userId: userA, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const [posB] = await svcH.db.insert(journalPositions).values({
      userId: userB, ticker: 'AAPL', status: 'open', openedAt: '2024-02-01'
    }).returning();
    await svcH.db.insert(journalEntries).values([
      { positionId: posA!.id, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'A thesis' },
      { positionId: posB!.id, kind: 'entry', occurredAt: '2024-02-01', thesisMd: 'B thesis' }
    ]);

    const aEntries = await userH.asUser(userA, async (tx) => tx.select().from(journalEntries));
    expect(aEntries).toHaveLength(1);
    expect(aEntries[0]!.thesisMd).toBe('A thesis');
  });

  it('authenticated user cannot INSERT positions directly', async () => {
    const userA = newUserId();
    await expect(
      userH.asUser(userA, async (tx) =>
        tx.insert(journalPositions).values({
          userId: userA, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
        })
      )
    ).rejects.toThrow(/permission denied|policy/i);
  });
});
```

- [ ] **Step 4: Run the RLS test**

```bash
pnpm test:integration tests/integration/journal-rls.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/db/migrations/9988_rls_journal.sql tests/integration/journal-rls.test.ts
git commit -m "$(cat <<'EOF'
feat(journal): RLS policies + smoke tests

SELECT on journal_positions gated to user_id = current user.
SELECT on journal_entries gated via the position FK.
Writes go through service_role (BYPASSRLS) via JournalService at
the API layer. Mirrors the qa_history pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure compute helpers + unit tests

**Files:**
- Create: `lib/compute/journal-summary.ts`
- Create: `lib/compute/journal-validation.ts`
- Test: `tests/compute/journal-summary.test.ts`
- Test: `tests/compute/journal-validation.test.ts`

- [ ] **Step 1: Write summary helper tests**

Create `tests/compute/journal-summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { summarizePosition, type SummaryInput } from '@/lib/compute/journal-summary';

const baseInput: SummaryInput = {
  status: 'open',
  openedAt: '2024-01-15',
  closedAt: null,
  latestEntry: null,
  now: new Date('2024-04-15T12:00:00Z')   // injected for deterministic testing
};

describe('summarizePosition', () => {
  it('computes days held for an open position', () => {
    const result = summarizePosition(baseInput);
    expect(result.daysHeld).toBe(91);
  });

  it('computes days held for a closed position', () => {
    const result = summarizePosition({
      ...baseInput,
      status: 'closed',
      closedAt: '2024-02-15'
    });
    expect(result.daysHeld).toBe(31);
  });

  it('truncates latest entry preview at 120 chars on a word boundary', () => {
    const longThesis = 'Apple is well positioned given its services growth, ' +
      'iPhone refresh cycle, and Vision Pro launch. The market remains skeptical ' +
      'but recent guidance is encouraging across all segments.';
    const result = summarizePosition({
      ...baseInput,
      latestEntry: { kind: 'entry', occurredAt: '2024-01-15', thesisMd: longThesis }
    });
    expect(result.thesisPreview.length).toBeLessThanOrEqual(123);    // 120 + '...'
    expect(result.thesisPreview.endsWith('...')).toBe(true);
    // Must end on a word boundary (no mid-word cut)
    expect(result.thesisPreview).not.toMatch(/\w\.\.\.$/);
  });

  it('returns empty preview when there are no entries', () => {
    const result = summarizePosition(baseInput);
    expect(result.thesisPreview).toBe('');
  });

  it('marks stale when latest review > 90 days old and status open', () => {
    const result = summarizePosition({
      ...baseInput,
      latestEntry: { kind: 'review', occurredAt: '2023-12-01', thesisMd: 'x' }
    });
    expect(result.stale).toBe(true);
  });

  it('does not mark stale for closed positions even with old entries', () => {
    const result = summarizePosition({
      ...baseInput,
      status: 'closed',
      closedAt: '2024-02-15',
      latestEntry: { kind: 'exit', occurredAt: '2024-02-15', thesisMd: 'x' }
    });
    expect(result.stale).toBe(false);
  });

  it('does not mark stale within 90 days', () => {
    const result = summarizePosition({
      ...baseInput,
      latestEntry: { kind: 'review', occurredAt: '2024-02-01', thesisMd: 'x' }
    });
    expect(result.stale).toBe(false);
  });

  it('treats opened_at as the latest entry when no entries exist', () => {
    const result = summarizePosition({
      ...baseInput,
      openedAt: '2023-09-15',         // > 90 days before now
      latestEntry: null
    });
    expect(result.stale).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
pnpm test tests/compute/journal-summary.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/compute/journal-summary'".

- [ ] **Step 3: Implement journal-summary.ts**

Create `lib/compute/journal-summary.ts`:

```ts
/**
 * Pure computation of a per-position summary card.
 *
 * Takes the position's status + dates and optionally its latest entry,
 * returns a small struct with the data the UI needs:
 *   - daysHeld     — how long the user has been (or was) in the position
 *   - thesisPreview — truncated latest-entry thesis for the card
 *   - stale        — true if the position is open and hasn't been reviewed
 *                    in > 90 days; UI surfaces this as a quiet warning chip
 *
 * `now` is injected so tests are deterministic.
 */

export interface SummaryEntry {
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;       // YYYY-MM-DD
  thesisMd: string;
}

export interface SummaryInput {
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  latestEntry: SummaryEntry | null;
  now: Date;
}

export interface PositionSummary {
  daysHeld: number;
  thesisPreview: string;
  stale: boolean;
}

const PREVIEW_MAX = 120;
const STALE_DAYS = 90;

export function summarizePosition(input: SummaryInput): PositionSummary {
  const end = input.status === 'closed' && input.closedAt
    ? new Date(input.closedAt)
    : input.now;
  const start = new Date(input.openedAt);
  const daysHeld = Math.max(0, Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));

  const thesisPreview = truncateAtWordBoundary(input.latestEntry?.thesisMd ?? '', PREVIEW_MAX);

  let stale = false;
  if (input.status === 'open') {
    const referenceDate = input.latestEntry?.occurredAt ?? input.openedAt;
    const ageDays = Math.floor((input.now.getTime() - new Date(referenceDate).getTime()) / (24 * 60 * 60 * 1000));
    stale = ageDays > STALE_DAYS;
  }

  return { daysHeld, thesisPreview, stale };
}

function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cutoff = lastSpace > max * 0.6 ? lastSpace : max;
  return slice.slice(0, cutoff).trim() + '...';
}
```

- [ ] **Step 4: Run summary tests**

```bash
pnpm test tests/compute/journal-summary.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Write validation helper tests**

Create `tests/compute/journal-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  validateNewPosition,
  validateNewEntry,
  type NewPositionInput,
  type NewEntryInput
} from '@/lib/compute/journal-validation';

describe('validateNewPosition', () => {
  const valid: NewPositionInput = { ticker: 'AAPL', openedAt: '2024-01-15' };

  it('accepts minimal valid input', () => {
    expect(() => validateNewPosition(valid)).not.toThrow();
  });

  it('accepts full valid input', () => {
    expect(() => validateNewPosition({
      ...valid,
      convictionAtOpen: 8,
      targetPrice: 250,
      stopPrice: 180,
      expectedHoldingDays: 365
    })).not.toThrow();
  });

  it('rejects negative target price', () => {
    expect(() => validateNewPosition({ ...valid, targetPrice: -10 })).toThrow(/target/i);
  });

  it('rejects zero stop price', () => {
    expect(() => validateNewPosition({ ...valid, stopPrice: 0 })).toThrow(/stop/i);
  });

  it('rejects conviction below 1', () => {
    expect(() => validateNewPosition({ ...valid, convictionAtOpen: 0 })).toThrow(/conviction/i);
  });

  it('rejects conviction above 10', () => {
    expect(() => validateNewPosition({ ...valid, convictionAtOpen: 11 })).toThrow(/conviction/i);
  });

  it('rejects malformed ticker', () => {
    expect(() => validateNewPosition({ ...valid, ticker: 'lower-case' })).toThrow(/ticker/i);
  });

  it('rejects future opened_at', () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(() => validateNewPosition({ ...valid, openedAt: future })).toThrow(/opened/i);
  });
});

describe('validateNewEntry', () => {
  const valid: NewEntryInput = { kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x' };

  it('accepts minimal valid input', () => {
    expect(() => validateNewEntry(valid)).not.toThrow();
  });

  it('accepts exit with outcome+lessons', () => {
    expect(() => validateNewEntry({
      ...valid, kind: 'exit', outcome: 'right', lessons: 'l'
    })).not.toThrow();
  });

  it('rejects invalid kind', () => {
    expect(() => validateNewEntry({ ...valid, kind: 'invalid' as any })).toThrow(/kind/i);
  });

  it('rejects invalid outcome', () => {
    expect(() => validateNewEntry({ ...valid, outcome: 'maybe' as any })).toThrow(/outcome/i);
  });

  it('rejects conviction out of range', () => {
    expect(() => validateNewEntry({ ...valid, convictionAtTime: 0 })).toThrow(/conviction/i);
    expect(() => validateNewEntry({ ...valid, convictionAtTime: 11 })).toThrow(/conviction/i);
  });

  it('rejects entry > 50KB', () => {
    const huge = 'x'.repeat(50_001);
    expect(() => validateNewEntry({ ...valid, thesisMd: huge })).toThrow(/size|byte/i);
  });

  it('rejects outcome on non-exit kind', () => {
    expect(() => validateNewEntry({ ...valid, kind: 'entry', outcome: 'right' })).toThrow(/outcome/i);
  });
});
```

- [ ] **Step 6: Run to confirm failure**

```bash
pnpm test tests/compute/journal-validation.test.ts
```

Expected: FAIL.

- [ ] **Step 7: Implement journal-validation.ts**

Create `lib/compute/journal-validation.ts`:

```ts
/**
 * Pure validation for journal write inputs. Throws on invalid input with a
 * descriptive message. Used by JournalService before any DB write — and
 * mirrored as Zod schemas at the API-route layer.
 */

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const MAX_BYTES = 50_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_KINDS = new Set(['entry', 'review', 'exit']);
const VALID_OUTCOMES = new Set(['right', 'wrong', 'mixed']);

export interface NewPositionInput {
  ticker: string;
  openedAt: string;
  convictionAtOpen?: number;
  targetPrice?: number;
  stopPrice?: number;
  expectedHoldingDays?: number;
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

export function validateNewPosition(input: NewPositionInput): void {
  if (!TICKER_RE.test(input.ticker)) throw new Error(`Invalid ticker: ${input.ticker}`);
  if (!ISO_DATE_RE.test(input.openedAt)) throw new Error(`Invalid opened_at: ${input.openedAt}`);
  if (new Date(input.openedAt).getTime() > Date.now()) {
    throw new Error(`opened_at cannot be in the future: ${input.openedAt}`);
  }
  if (input.convictionAtOpen != null && (input.convictionAtOpen < 1 || input.convictionAtOpen > 10)) {
    throw new Error(`conviction must be in [1, 10]: ${input.convictionAtOpen}`);
  }
  if (input.targetPrice != null && input.targetPrice <= 0) {
    throw new Error(`target_price must be positive: ${input.targetPrice}`);
  }
  if (input.stopPrice != null && input.stopPrice <= 0) {
    throw new Error(`stop_price must be positive: ${input.stopPrice}`);
  }
  if (input.expectedHoldingDays != null && input.expectedHoldingDays <= 0) {
    throw new Error(`expected_holding_days must be positive: ${input.expectedHoldingDays}`);
  }
}

export function validateNewEntry(input: NewEntryInput): void {
  if (!VALID_KINDS.has(input.kind)) throw new Error(`Invalid kind: ${input.kind}`);
  if (!ISO_DATE_RE.test(input.occurredAt)) throw new Error(`Invalid occurred_at: ${input.occurredAt}`);
  if (input.thesisMd.length > MAX_BYTES) throw new Error(`thesis_md exceeds ${MAX_BYTES} bytes`);
  if ((input.whatChanged?.length ?? 0) > MAX_BYTES) throw new Error(`what_changed exceeds ${MAX_BYTES} bytes`);
  if ((input.lessons?.length ?? 0) > MAX_BYTES) throw new Error(`lessons exceeds ${MAX_BYTES} bytes`);
  if (input.convictionAtTime != null && (input.convictionAtTime < 1 || input.convictionAtTime > 10)) {
    throw new Error(`conviction must be in [1, 10]: ${input.convictionAtTime}`);
  }
  if (input.outcome != null) {
    if (!VALID_OUTCOMES.has(input.outcome)) throw new Error(`Invalid outcome: ${input.outcome}`);
    if (input.kind !== 'exit') throw new Error(`outcome may only be set on exit entries`);
  }
}
```

- [ ] **Step 8: Run validation tests**

```bash
pnpm test tests/compute/journal-validation.test.ts
```

Expected: 13 tests pass (8 position + 5 entry, counting `accepts exit with outcome+lessons` etc. — actual count is 14 across both blocks; just confirm green).

- [ ] **Step 9: Commit**

```bash
git add lib/compute/journal-summary.ts lib/compute/journal-validation.ts tests/compute/journal-summary.test.ts tests/compute/journal-validation.test.ts
git commit -m "$(cat <<'EOF'
feat(journal): pure compute helpers — summary + validation

summarizePosition computes days-held, truncated thesis preview, and
a 'stale' flag (open position with no review in >90 days).
validateNewPosition + validateNewEntry guard ticker format, date
formats, conviction range, price positivity, kind/outcome enums,
and 50KB body cap. Both are pure, deterministic (now injected for
summary), and fully unit-tested.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: JournalService — position CRUD + tests

**Files:**
- Create: `lib/services/journal.ts` (initial scaffold with position methods)
- Test: `tests/integration/journal-service.test.ts`

- [ ] **Step 1: Write the failing integration test (positions only for now)**

Create `tests/integration/journal-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { JournalService } from '@/lib/services/journal';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

describe('JournalService — positions', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let svc: JournalService;
  beforeAll(() => {
    dbH = makeTestServiceDb();
    svc = new JournalService({ db: dbH.db });
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple Inc.' },
      { ticker: 'NVDA', name: 'NVIDIA Corporation' }
    ]);
  });

  it('createPosition + listPositions round trip', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, {
      ticker: 'AAPL', openedAt: '2024-01-15', convictionAtOpen: 8, targetPrice: 250
    });
    expect(created.userId).toBe(userId);
    expect(created.status).toBe('open');

    const list = await svc.listPositions(userId);
    expect(list).toHaveLength(1);
    expect(list[0]!.ticker).toBe('AAPL');
    expect(Number(list[0]!.targetPrice)).toBe(250);
  });

  it('listPositions does not return another users positions', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    await svc.createPosition(userA, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await svc.createPosition(userB, { ticker: 'NVDA', openedAt: '2024-02-01' });
    const aList = await svc.listPositions(userA);
    expect(aList).toHaveLength(1);
    expect(aList[0]!.ticker).toBe('AAPL');
  });

  it('listPositions filters by status', async () => {
    const userId = randomUUID();
    const p1 = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await svc.createPosition(userId, { ticker: 'NVDA', openedAt: '2024-02-01' });
    await svc.closePosition(userId, p1.id, { closedAt: '2024-06-01' });
    const open = await svc.listPositions(userId, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.ticker).toBe('NVDA');
    const closed = await svc.listPositions(userId, { status: 'closed' });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.ticker).toBe('AAPL');
  });

  it('listPositions filters by minConviction', async () => {
    const userId = randomUUID();
    await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15', convictionAtOpen: 9 });
    await svc.createPosition(userId, { ticker: 'NVDA', openedAt: '2024-02-01', convictionAtOpen: 5 });
    const high = await svc.listPositions(userId, { minConviction: 8 });
    expect(high).toHaveLength(1);
    expect(high[0]!.ticker).toBe('AAPL');
  });

  it('updatePosition updates target/stop', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    const updated = await svc.updatePosition(userId, created.id, { targetPrice: 300, stopPrice: 150 });
    expect(Number(updated.targetPrice)).toBe(300);
    expect(Number(updated.stopPrice)).toBe(150);
  });

  it('updatePosition does not affect other user positions', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const a = await svc.createPosition(userA, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await expect(svc.updatePosition(userB, a.id, { targetPrice: 999 })).rejects.toThrow(/not found|permission/i);
  });

  it('closePosition sets status + closedAt + optional exit entry', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    const result = await svc.closePosition(userId, created.id, {
      closedAt: '2024-06-01',
      exitEntry: { kind: 'exit', occurredAt: '2024-06-01', thesisMd: 'Took profits.', outcome: 'right' }
    });
    expect(result.status).toBe('closed');
    expect(result.closedAt).toBe('2024-06-01');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.outcome).toBe('right');
  });

  it('deletePosition removes the row (cascade removes entries)', async () => {
    const userId = randomUUID();
    const created = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    await svc.createEntry(userId, created.id, { kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x' });
    await svc.deletePosition(userId, created.id);
    const list = await svc.listPositions(userId);
    expect(list).toHaveLength(0);
    const entries = await dbH.db.select().from(journalEntries);
    expect(entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm test:integration tests/integration/journal-service.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/services/journal'".

- [ ] **Step 3: Implement JournalService**

Create `lib/services/journal.ts`:

```ts
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { ServiceDb } from '@/lib/db/client';
import { journalPositions, journalEntries } from '@/lib/db/schema';
import { validateNewPosition, validateNewEntry } from '@/lib/compute/journal-validation';

export interface JournalPosition {
  id: bigint;
  userId: string;
  ticker: string;
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  convictionAtOpen: number | null;
  targetPrice: string | null;     // numeric → string from drizzle; cast at UI/api boundary
  stopPrice: string | null;
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
  entries: JournalEntry[];
}

export interface NewPositionInput {
  ticker: string;
  openedAt: string;
  convictionAtOpen?: number;
  targetPrice?: number;
  stopPrice?: number;
  expectedHoldingDays?: number;
  firstEntry?: { thesisMd: string; convictionAtTime?: number };
}

export interface PositionUpdateInput {
  convictionAtOpen?: number | null;
  targetPrice?: number | null;
  stopPrice?: number | null;
  expectedHoldingDays?: number | null;
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
  exitEntry?: NewEntryInput;
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

  // ---- Positions ----

  async listPositions(userId: string, opts: ListPositionsOpts = {}): Promise<JournalPosition[]> {
    const conds = [eq(journalPositions.userId, userId)];
    if (opts.ticker) conds.push(eq(journalPositions.ticker, opts.ticker.toUpperCase()));
    if (opts.status) conds.push(eq(journalPositions.status, opts.status));
    if (opts.minConviction != null) {
      conds.push(gte(journalPositions.convictionAtOpen, opts.minConviction));
    }
    const rows = await this.deps.db.select()
      .from(journalPositions)
      .where(and(...conds))
      .orderBy(desc(journalPositions.openedAt))
      .limit(opts.limit ?? 100)
      .offset(opts.offset ?? 0);
    return rows.map((r) => ({ ...r, status: r.status as 'open' | 'closed' }));
  }

  async getPosition(userId: string, positionId: bigint): Promise<PositionWithEntries | null> {
    const posRows = await this.deps.db.select()
      .from(journalPositions)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .limit(1);
    const pos = posRows[0];
    if (!pos) return null;
    const entries = await this.deps.db.select()
      .from(journalEntries)
      .where(eq(journalEntries.positionId, positionId))
      .orderBy(asc(journalEntries.occurredAt));
    return {
      ...pos,
      status: pos.status as 'open' | 'closed',
      entries: entries.map((e) => ({
        ...e,
        kind: e.kind as 'entry' | 'review' | 'exit',
        outcome: e.outcome as 'right' | 'wrong' | 'mixed' | null
      }))
    };
  }

  async createPosition(userId: string, input: NewPositionInput): Promise<JournalPosition> {
    validateNewPosition(input);
    return await this.deps.db.transaction(async (tx) => {
      const [row] = await tx.insert(journalPositions).values({
        userId,
        ticker: input.ticker.toUpperCase(),
        status: 'open',
        openedAt: input.openedAt,
        convictionAtOpen: input.convictionAtOpen,
        targetPrice: input.targetPrice != null ? String(input.targetPrice) : null,
        stopPrice: input.stopPrice != null ? String(input.stopPrice) : null,
        expectedHoldingDays: input.expectedHoldingDays
      }).returning();
      if (input.firstEntry) {
        await tx.insert(journalEntries).values({
          positionId: row!.id, kind: 'entry', occurredAt: input.openedAt,
          thesisMd: input.firstEntry.thesisMd,
          convictionAtTime: input.firstEntry.convictionAtTime ?? input.convictionAtOpen
        });
      }
      return { ...row!, status: row!.status as 'open' | 'closed' };
    });
  }

  async updatePosition(userId: string, positionId: bigint, input: PositionUpdateInput): Promise<JournalPosition> {
    if (input.convictionAtOpen != null && (input.convictionAtOpen < 1 || input.convictionAtOpen > 10)) {
      throw new Error(`conviction must be in [1, 10]: ${input.convictionAtOpen}`);
    }
    if (input.targetPrice != null && input.targetPrice <= 0) throw new Error('target_price must be positive');
    if (input.stopPrice != null && input.stopPrice <= 0) throw new Error('stop_price must be positive');

    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if ('convictionAtOpen' in input) setFields.convictionAtOpen = input.convictionAtOpen;
    if ('targetPrice' in input) setFields.targetPrice = input.targetPrice != null ? String(input.targetPrice) : null;
    if ('stopPrice' in input) setFields.stopPrice = input.stopPrice != null ? String(input.stopPrice) : null;
    if ('expectedHoldingDays' in input) setFields.expectedHoldingDays = input.expectedHoldingDays;

    const [row] = await this.deps.db.update(journalPositions)
      .set(setFields)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .returning();
    if (!row) throw new Error('position not found or permission denied');
    return { ...row, status: row.status as 'open' | 'closed' };
  }

  async closePosition(userId: string, positionId: bigint, input: ClosePositionInput): Promise<PositionWithEntries> {
    return await this.deps.db.transaction(async (tx) => {
      const [row] = await tx.update(journalPositions)
        .set({ status: 'closed', closedAt: input.closedAt, updatedAt: new Date() })
        .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
        .returning();
      if (!row) throw new Error('position not found or permission denied');
      if (input.exitEntry) {
        validateNewEntry(input.exitEntry);
        await tx.insert(journalEntries).values({
          positionId,
          kind: input.exitEntry.kind,
          occurredAt: input.exitEntry.occurredAt,
          thesisMd: input.exitEntry.thesisMd,
          convictionAtTime: input.exitEntry.convictionAtTime,
          outcome: input.exitEntry.outcome,
          whatChanged: input.exitEntry.whatChanged,
          lessons: input.exitEntry.lessons
        });
      }
      const entries = await tx.select().from(journalEntries)
        .where(eq(journalEntries.positionId, positionId))
        .orderBy(asc(journalEntries.occurredAt));
      return {
        ...row,
        status: row.status as 'open' | 'closed',
        entries: entries.map((e) => ({
          ...e,
          kind: e.kind as 'entry' | 'review' | 'exit',
          outcome: e.outcome as 'right' | 'wrong' | 'mixed' | null
        }))
      };
    });
  }

  async deletePosition(userId: string, positionId: bigint): Promise<void> {
    const result = await this.deps.db.delete(journalPositions)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .returning({ id: journalPositions.id });
    if (result.length === 0) throw new Error('position not found or permission denied');
  }

  // ---- Entries (implemented in Task 5) ----

  async createEntry(userId: string, positionId: bigint, input: NewEntryInput): Promise<JournalEntry> {
    validateNewEntry(input);
    // verify ownership of position
    const owns = await this.deps.db.select({ id: journalPositions.id }).from(journalPositions)
      .where(and(eq(journalPositions.id, positionId), eq(journalPositions.userId, userId)))
      .limit(1);
    if (owns.length === 0) throw new Error('position not found or permission denied');

    const [row] = await this.deps.db.insert(journalEntries).values({
      positionId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      thesisMd: input.thesisMd,
      convictionAtTime: input.convictionAtTime,
      outcome: input.outcome,
      whatChanged: input.whatChanged,
      lessons: input.lessons
    }).returning();
    return {
      ...row!,
      kind: row!.kind as 'entry' | 'review' | 'exit',
      outcome: row!.outcome as 'right' | 'wrong' | 'mixed' | null
    };
  }

  async updateEntry(userId: string, entryId: bigint, input: EntryUpdateInput): Promise<JournalEntry> {
    if (input.convictionAtTime != null && (input.convictionAtTime < 1 || input.convictionAtTime > 10)) {
      throw new Error(`conviction must be in [1, 10]`);
    }
    // verify ownership via join
    const owns = await this.deps.db.select({ id: journalEntries.id })
      .from(journalEntries)
      .innerJoin(journalPositions, eq(journalPositions.id, journalEntries.positionId))
      .where(and(eq(journalEntries.id, entryId), eq(journalPositions.userId, userId)))
      .limit(1);
    if (owns.length === 0) throw new Error('entry not found or permission denied');

    const setFields: Record<string, unknown> = { updatedAt: new Date() };
    if ('thesisMd' in input) setFields.thesisMd = input.thesisMd;
    if ('convictionAtTime' in input) setFields.convictionAtTime = input.convictionAtTime;
    if ('outcome' in input) setFields.outcome = input.outcome;
    if ('whatChanged' in input) setFields.whatChanged = input.whatChanged;
    if ('lessons' in input) setFields.lessons = input.lessons;

    const [row] = await this.deps.db.update(journalEntries)
      .set(setFields)
      .where(eq(journalEntries.id, entryId))
      .returning();
    return {
      ...row!,
      kind: row!.kind as 'entry' | 'review' | 'exit',
      outcome: row!.outcome as 'right' | 'wrong' | 'mixed' | null
    };
  }

  async deleteEntry(userId: string, entryId: bigint): Promise<void> {
    // verify ownership via join
    const owns = await this.deps.db.select({ id: journalEntries.id })
      .from(journalEntries)
      .innerJoin(journalPositions, eq(journalPositions.id, journalEntries.positionId))
      .where(and(eq(journalEntries.id, entryId), eq(journalPositions.userId, userId)))
      .limit(1);
    if (owns.length === 0) throw new Error('entry not found or permission denied');

    await this.deps.db.delete(journalEntries).where(eq(journalEntries.id, entryId));
  }
}
```

- [ ] **Step 4: Run all position tests**

```bash
pnpm test:integration tests/integration/journal-service.test.ts
```

Expected: 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/services/journal.ts tests/integration/journal-service.test.ts
git commit -m "$(cat <<'EOF'
feat(journal): JournalService + 8 integration tests

Position CRUD: listPositions with status/ticker/minConviction filters,
createPosition with optional inline first entry inside a transaction,
updatePosition (target/stop/conviction/hold), closePosition with
optional exit entry, deletePosition. Entry CRUD methods present and
covered by Task 5 tests. Every mutation verifies userId ownership.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: JournalService — entry CRUD test extension

**Files:**
- Modify: `tests/integration/journal-service.test.ts`

The service already exposes createEntry/updateEntry/deleteEntry from Task 4. This task adds the test coverage.

- [ ] **Step 1: Append entry tests to the existing test file**

Open `tests/integration/journal-service.test.ts`. After the existing `describe('JournalService — positions', ...)` block, append:

```ts
describe('JournalService — entries', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  let svc: JournalService;
  let userId: string;
  let positionId: bigint;

  beforeAll(() => {
    dbH = makeTestServiceDb();
    svc = new JournalService({ db: dbH.db });
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    userId = randomUUID();
    const pos = await svc.createPosition(userId, { ticker: 'AAPL', openedAt: '2024-01-15' });
    positionId = pos.id;
  });

  it('createEntry persists structured fields', async () => {
    const e = await svc.createEntry(userId, positionId, {
      kind: 'review', occurredAt: '2024-03-01', thesisMd: 'Still believe in services',
      convictionAtTime: 7, whatChanged: 'Forward guidance increased'
    });
    expect(e.kind).toBe('review');
    expect(e.convictionAtTime).toBe(7);
    expect(e.whatChanged).toContain('guidance');
  });

  it('createEntry rejects entries on another users position', async () => {
    const userB = randomUUID();
    await expect(svc.createEntry(userB, positionId, {
      kind: 'entry', occurredAt: '2024-03-01', thesisMd: 'sneaky'
    })).rejects.toThrow(/permission|not found/i);
  });

  it('updateEntry edits thesis + outcome', async () => {
    const e = await svc.createEntry(userId, positionId, {
      kind: 'exit', occurredAt: '2024-06-01', thesisMd: 'Took profits', outcome: 'right'
    });
    const updated = await svc.updateEntry(userId, e.id, { thesisMd: 'Took profits at +30%', outcome: 'mixed' });
    expect(updated.thesisMd).toContain('+30%');
    expect(updated.outcome).toBe('mixed');
  });

  it('updateEntry rejects updates on another users entry', async () => {
    const e = await svc.createEntry(userId, positionId, {
      kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'mine'
    });
    const userB = randomUUID();
    await expect(svc.updateEntry(userB, e.id, { thesisMd: 'theirs' })).rejects.toThrow(/permission|not found/i);
  });

  it('deleteEntry removes a single entry', async () => {
    const e1 = await svc.createEntry(userId, positionId, { kind: 'entry', occurredAt: '2024-01-15', thesisMd: '1' });
    await svc.createEntry(userId, positionId, { kind: 'review', occurredAt: '2024-02-15', thesisMd: '2' });
    await svc.deleteEntry(userId, e1.id);
    const pos = await svc.getPosition(userId, positionId);
    expect(pos!.entries).toHaveLength(1);
    expect(pos!.entries[0]!.thesisMd).toBe('2');
  });

  it('getPosition returns entries in occurredAt-ascending order', async () => {
    await svc.createEntry(userId, positionId, { kind: 'review', occurredAt: '2024-03-15', thesisMd: 'mid' });
    await svc.createEntry(userId, positionId, { kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'first' });
    await svc.createEntry(userId, positionId, { kind: 'exit', occurredAt: '2024-06-15', thesisMd: 'last' });
    const pos = await svc.getPosition(userId, positionId);
    expect(pos!.entries.map((e) => e.thesisMd)).toEqual(['first', 'mid', 'last']);
  });
});
```

- [ ] **Step 2: Run the full service test file**

```bash
pnpm test:integration tests/integration/journal-service.test.ts
```

Expected: 14 tests pass (8 from Task 4 + 6 new).

- [ ] **Step 3: Commit**

```bash
git add tests/integration/journal-service.test.ts
git commit -m "$(cat <<'EOF'
test(journal): 6 entry CRUD integration tests

createEntry persists structured fields; rejects cross-user creates.
updateEntry edits + rejects cross-user updates. deleteEntry removes
one entry without affecting others. getPosition orders entries by
occurredAt ASC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: API routes — positions

**Files:**
- Create: `app/api/journal/positions/route.ts`
- Create: `app/api/journal/positions/[id]/route.ts`
- Create: `app/api/journal/positions/[id]/close/route.ts`
- Test: `tests/integration/api-journal-positions.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `tests/integration/api-journal-positions.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

vi.mock('@/lib/auth/current-user', () => ({ requireUserId: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ getServiceDb: vi.fn() }));

import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { GET as listGET, POST as listPOST } from '@/app/api/journal/positions/route';
import { GET as itemGET, PATCH as itemPATCH, DELETE as itemDELETE } from '@/app/api/journal/positions/[id]/route';
import { POST as closePOST } from '@/app/api/journal/positions/[id]/close/route';

describe('journal positions API', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  const userId = randomUUID();

  beforeAll(() => {
    dbH = makeTestServiceDb();
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue(userId);
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  });

  it('POST /positions creates a position (201)', async () => {
    const req = new Request('http://localhost/api/journal/positions', {
      method: 'POST',
      body: JSON.stringify({ ticker: 'AAPL', openedAt: '2024-01-15', convictionAtOpen: 8 })
    });
    const res = await listPOST(req);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.ticker).toBe('AAPL');
  });

  it('GET /positions returns the list', async () => {
    await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    });
    const req = new Request('http://localhost/api/journal/positions');
    const res = await listGET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.items).toHaveLength(1);
  });

  it('GET /positions honors status filter', async () => {
    await dbH.db.insert(journalPositions).values([
      { userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15' }
    ]);
    const req = new Request('http://localhost/api/journal/positions?status=closed');
    const res = await listGET(req);
    const json = await res.json();
    expect(json.items).toHaveLength(0);
  });

  it('GET /positions/[id] returns position + entries', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    await dbH.db.insert(journalEntries).values({
      positionId: pos!.id, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x'
    });
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}`);
    const res = await itemGET(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(1);
  });

  it('GET /positions/[id] returns 404 for missing or other-user position', async () => {
    const req = new Request('http://localhost/api/journal/positions/9999');
    const res = await itemGET(req, { params: { id: '9999' } });
    expect(res.status).toBe(404);
  });

  it('PATCH /positions/[id] updates fields', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ targetPrice: 300 })
    });
    const res = await itemPATCH(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Number(json.targetPrice)).toBe(300);
  });

  it('POST /positions/[id]/close marks closed + appends exit entry', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}/close`, {
      method: 'POST',
      body: JSON.stringify({
        closedAt: '2024-06-01',
        exitEntry: { kind: 'exit', occurredAt: '2024-06-01', thesisMd: 'done', outcome: 'right' }
      })
    });
    const res = await closePOST(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('closed');
    expect(json.entries).toHaveLength(1);
  });

  it('DELETE /positions/[id] returns 204', async () => {
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    const req = new Request(`http://localhost/api/journal/positions/${pos!.id}`, { method: 'DELETE' });
    const res = await itemDELETE(req, { params: { id: String(pos!.id) } });
    expect(res.status).toBe(204);
  });

  it('401 when unauthenticated', async () => {
    vi.mocked(requireUserId).mockRejectedValueOnce(new Error('no auth'));
    const req = new Request('http://localhost/api/journal/positions');
    const res = await listGET(req);
    expect(res.status).toBe(401);
  });

  it('400 on invalid create body', async () => {
    const req = new Request('http://localhost/api/journal/positions', {
      method: 'POST',
      body: JSON.stringify({ ticker: 'aapl', openedAt: '2024-01-15' })   // lowercase ticker
    });
    const res = await listPOST(req);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm test:integration tests/integration/api-journal-positions.test.ts
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the list/create route**

Create `app/api/journal/positions/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

const NewPositionSchema = z.object({
  ticker: z.string().regex(TICKER_RE),
  openedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  convictionAtOpen: z.number().int().min(1).max(10).optional(),
  targetPrice: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
  expectedHoldingDays: z.number().int().positive().optional(),
  firstEntry: z.object({
    thesisMd: z.string().max(50_000),
    convictionAtTime: z.number().int().min(1).max(10).optional()
  }).optional()
});

const ListQuerySchema = z.object({
  status: z.enum(['open', 'closed']).optional(),
  ticker: z.string().regex(TICKER_RE).optional(),
  minConviction: z.coerce.number().int().min(1).max(10).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export async function GET(req: Request) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const url = new URL(req.url);
    const parsed = ListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const items = await svc.listPositions(userId, parsed.data);
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions' });
  }
}

export async function POST(req: Request) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const body = await req.json().catch(() => ({}));
    const parsed = NewPositionSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const created = await svc.createPosition(userId, parsed.data);
    return NextResponse.json(created, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions' });
  }
}
```

- [ ] **Step 4: Implement the item route**

Create `app/api/journal/positions/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';

const UpdateSchema = z.object({
  convictionAtOpen: z.number().int().min(1).max(10).nullable().optional(),
  targetPrice: z.number().positive().nullable().optional(),
  stopPrice: z.number().positive().nullable().optional(),
  expectedHoldingDays: z.number().int().positive().nullable().optional()
});

interface Ctx { params: { id: string }; }

function parseId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new ValidationError(`Invalid position id: ${raw}`);
  return BigInt(raw);
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const svc = new JournalService({ db: getServiceDb() });
    const pos = await svc.getPosition(userId, id);
    if (!pos) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(pos, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/item' });
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const body = await req.json().catch(() => ({}));
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const updated = await svc.updatePosition(userId, id, parsed.data);
    return NextResponse.json(updated, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/item' });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const svc = new JournalService({ db: getServiceDb() });
    await svc.deletePosition(userId, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/item' });
  }
}
```

- [ ] **Step 5: Implement the close route**

Create `app/api/journal/positions/[id]/close/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';

const CloseSchema = z.object({
  closedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exitEntry: z.object({
    kind: z.literal('exit'),
    occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    thesisMd: z.string().max(50_000),
    convictionAtTime: z.number().int().min(1).max(10).optional(),
    outcome: z.enum(['right', 'wrong', 'mixed']).optional(),
    whatChanged: z.string().max(50_000).optional(),
    lessons: z.string().max(50_000).optional()
  }).optional()
});

interface Ctx { params: { id: string }; }

export async function POST(req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    if (!/^\d+$/.test(ctx.params.id)) throw new ValidationError(`Invalid id: ${ctx.params.id}`);
    const id = BigInt(ctx.params.id);

    const body = await req.json().catch(() => ({}));
    const parsed = CloseSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const result = await svc.closePosition(userId, id, parsed.data);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/positions/close' });
  }
}
```

- [ ] **Step 6: Run all position route tests**

```bash
pnpm test:integration tests/integration/api-journal-positions.test.ts
```

Expected: 10 tests pass.

- [ ] **Step 7: Commit**

```bash
git add app/api/journal/positions/ tests/integration/api-journal-positions.test.ts
git commit -m "$(cat <<'EOF'
feat(journal): API routes for positions (list/create/get/patch/close/delete)

GET + POST /api/journal/positions — list with status/ticker/conviction
filters, create with Zod validation.
GET + PATCH + DELETE /api/journal/positions/[id] — single position.
POST /api/journal/positions/[id]/close — atomic close + optional exit
entry. All routes auth-gated; ownership enforced at the service layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: API routes — entries

**Files:**
- Create: `app/api/journal/positions/[id]/entries/route.ts`
- Create: `app/api/journal/entries/[id]/route.ts`
- Test: `tests/integration/api-journal-entries.test.ts`

- [ ] **Step 1: Write the failing route tests**

Create `tests/integration/api-journal-entries.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'drizzle-orm';
import { makeTestServiceDb } from '../helpers/test-db';
import { journalPositions, journalEntries, companies } from '@/lib/db/schema';
import { randomUUID } from 'node:crypto';

config({ path: '.env.local' });

vi.mock('@/lib/auth/current-user', () => ({ requireUserId: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ getServiceDb: vi.fn() }));

import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { POST as listEntriesPOST } from '@/app/api/journal/positions/[id]/entries/route';
import { PATCH as entryPATCH, DELETE as entryDELETE } from '@/app/api/journal/entries/[id]/route';

describe('journal entries API', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  const userId = randomUUID();
  let positionId: bigint;

  beforeAll(() => {
    dbH = makeTestServiceDb();
    vi.mocked(getServiceDb).mockReturnValue(dbH.db as any);
    vi.mocked(requireUserId).mockResolvedValue(userId);
  });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await dbH.db.execute(sql`TRUNCATE TABLE journal_positions, journal_entries, companies RESTART IDENTITY CASCADE`);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    const [pos] = await dbH.db.insert(journalPositions).values({
      userId, ticker: 'AAPL', status: 'open', openedAt: '2024-01-15'
    }).returning();
    positionId = pos!.id;
  });

  it('POST /positions/[id]/entries creates an entry (201)', async () => {
    const req = new Request(`http://localhost/api/journal/positions/${positionId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'review', occurredAt: '2024-03-01', thesisMd: 'still bullish' })
    });
    const res = await listEntriesPOST(req, { params: { id: String(positionId) } });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.kind).toBe('review');
  });

  it('PATCH /entries/[id] updates fields', async () => {
    const [e] = await dbH.db.insert(journalEntries).values({
      positionId, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'original'
    }).returning();
    const req = new Request(`http://localhost/api/journal/entries/${e!.id}`, {
      method: 'PATCH', body: JSON.stringify({ thesisMd: 'updated' })
    });
    const res = await entryPATCH(req, { params: { id: String(e!.id) } });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.thesisMd).toBe('updated');
  });

  it('DELETE /entries/[id] returns 204', async () => {
    const [e] = await dbH.db.insert(journalEntries).values({
      positionId, kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x'
    }).returning();
    const req = new Request(`http://localhost/api/journal/entries/${e!.id}`, { method: 'DELETE' });
    const res = await entryDELETE(req, { params: { id: String(e!.id) } });
    expect(res.status).toBe(204);
  });

  it('POST entry rejects with 400 on invalid kind', async () => {
    const req = new Request(`http://localhost/api/journal/positions/${positionId}/entries`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'invalid', occurredAt: '2024-03-01', thesisMd: 'x' })
    });
    const res = await listEntriesPOST(req, { params: { id: String(positionId) } });
    expect(res.status).toBe(400);
  });

  it('POST entry rejects with 401 unauthenticated', async () => {
    vi.mocked(requireUserId).mockRejectedValueOnce(new Error('no auth'));
    const req = new Request(`http://localhost/api/journal/positions/${positionId}/entries`, {
      method: 'POST', body: JSON.stringify({ kind: 'entry', occurredAt: '2024-01-15', thesisMd: 'x' })
    });
    const res = await listEntriesPOST(req, { params: { id: String(positionId) } });
    expect(res.status).toBe(401);
  });

  it('PATCH entry rejects on another users entry', async () => {
    const otherUser = randomUUID();
    const [otherPos] = await dbH.db.insert(journalPositions).values({
      userId: otherUser, ticker: 'AAPL', status: 'open', openedAt: '2024-02-01'
    }).returning();
    const [theirEntry] = await dbH.db.insert(journalEntries).values({
      positionId: otherPos!.id, kind: 'entry', occurredAt: '2024-02-01', thesisMd: 'theirs'
    }).returning();
    const req = new Request(`http://localhost/api/journal/entries/${theirEntry!.id}`, {
      method: 'PATCH', body: JSON.stringify({ thesisMd: 'overwrite' })
    });
    const res = await entryPATCH(req, { params: { id: String(theirEntry!.id) } });
    expect([403, 404]).toContain(res.status);   // either is acceptable
  });
});
```

- [ ] **Step 2: Confirm failure**

```bash
pnpm test:integration tests/integration/api-journal-entries.test.ts
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the create-entry route**

Create `app/api/journal/positions/[id]/entries/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';

const NewEntrySchema = z.object({
  kind: z.enum(['entry', 'review', 'exit']),
  occurredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  thesisMd: z.string().max(50_000),
  convictionAtTime: z.number().int().min(1).max(10).optional(),
  outcome: z.enum(['right', 'wrong', 'mixed']).optional(),
  whatChanged: z.string().max(50_000).optional(),
  lessons: z.string().max(50_000).optional()
});

interface Ctx { params: { id: string }; }

export async function POST(req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    if (!/^\d+$/.test(ctx.params.id)) throw new ValidationError(`Invalid position id: ${ctx.params.id}`);
    const positionId = BigInt(ctx.params.id);

    const body = await req.json().catch(() => ({}));
    const parsed = NewEntrySchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    const created = await svc.createEntry(userId, positionId, parsed.data);
    return NextResponse.json(created, { status: 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return errorResponse(err, { route: 'journal/entries/create' });
  }
}
```

- [ ] **Step 4: Implement the entry item route**

Create `app/api/journal/entries/[id]/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '@/lib/api/errors';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';

const UpdateSchema = z.object({
  thesisMd: z.string().max(50_000).optional(),
  convictionAtTime: z.number().int().min(1).max(10).nullable().optional(),
  outcome: z.enum(['right', 'wrong', 'mixed']).nullable().optional(),
  whatChanged: z.string().max(50_000).nullable().optional(),
  lessons: z.string().max(50_000).nullable().optional()
});

interface Ctx { params: { id: string }; }

function parseId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) throw new ValidationError(`Invalid entry id: ${raw}`);
  return BigInt(raw);
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const body = await req.json().catch(() => ({}));
    const parsed = UpdateSchema.safeParse(body);
    if (!parsed.success) throw new ValidationError(parsed.error.message);

    const svc = new JournalService({ db: getServiceDb() });
    try {
      const updated = await svc.updateEntry(userId, id, parsed.data);
      return NextResponse.json(updated, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (err) {
      if (/permission|not found/i.test(String(err))) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err, { route: 'journal/entries/item' });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    let userId: string;
    try { userId = await requireUserId(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

    const id = parseId(ctx.params.id);
    const svc = new JournalService({ db: getServiceDb() });
    try {
      await svc.deleteEntry(userId, id);
      return new NextResponse(null, { status: 204 });
    } catch (err) {
      if (/permission|not found/i.test(String(err))) {
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      }
      throw err;
    }
  } catch (err) {
    return errorResponse(err, { route: 'journal/entries/item' });
  }
}
```

- [ ] **Step 5: Run all entry route tests**

```bash
pnpm test:integration tests/integration/api-journal-entries.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add app/api/journal/positions/\[id\]/entries app/api/journal/entries tests/integration/api-journal-entries.test.ts
git commit -m "$(cat <<'EOF'
feat(journal): API routes for entries (create/patch/delete)

POST /api/journal/positions/[id]/entries — create an entry under a
position with kind/occurredAt/thesisMd/conviction/outcome.
PATCH + DELETE /api/journal/entries/[id] — edit or remove a single
entry. Ownership enforced through the service via a join. 404 on
foreign-user access (not 403, since existence is also obscured).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Server UI components (cards + list + empty + filters)

**Files:**
- Create: `app/(app)/stock/[ticker]/journal/_components/position-card.tsx`
- Create: `app/(app)/stock/[ticker]/journal/_components/entry-card.tsx`
- Create: `app/(app)/stock/[ticker]/journal/_components/entry-list.tsx`
- Create: `app/(app)/stock/[ticker]/journal/_components/journal-empty.tsx`
- Create: `app/(app)/journal/_components/journal-filters.tsx`

Server components are pure render — covered by E2E in Task 12 + manual smoke. No isolated tests.

- [ ] **Step 1: `entry-card.tsx`**

Create `app/(app)/stock/[ticker]/journal/_components/entry-card.tsx`:

```tsx
import ReactMarkdown from 'react-markdown';
import { cn } from '@/lib/utils';
import type { JournalEntry } from '@/lib/services/journal';

interface Props { entry: JournalEntry; }

const KIND_LABELS: Record<JournalEntry['kind'], string> = {
  entry: 'Open',
  review: 'Review',
  exit: 'Exit'
};

const KIND_COLORS: Record<JournalEntry['kind'], string> = {
  entry: 'bg-blue-100 text-blue-800',
  review: 'bg-amber-100 text-amber-800',
  exit: 'bg-emerald-100 text-emerald-800'
};

export function EntryCard({ entry }: Props) {
  return (
    <article className="border-b border-border last:border-0 py-4">
      <header className="flex items-baseline gap-2 mb-2">
        <span className={cn('text-xs px-2 py-0.5 rounded uppercase tracking-wide', KIND_COLORS[entry.kind])}>
          {KIND_LABELS[entry.kind]}
        </span>
        <span className="text-xs text-muted-foreground">{entry.occurredAt}</span>
        {entry.convictionAtTime != null && (
          <span className="text-xs text-muted-foreground">· conviction {entry.convictionAtTime}/10</span>
        )}
        {entry.outcome && (
          <span className="text-xs text-muted-foreground">· outcome: {entry.outcome}</span>
        )}
      </header>
      <div className="prose prose-sm max-w-none">
        <ReactMarkdown>{entry.thesisMd}</ReactMarkdown>
      </div>
      {entry.whatChanged && (
        <div className="mt-2 text-sm">
          <div className="font-medium text-xs uppercase text-muted-foreground mb-1">What changed</div>
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown>{entry.whatChanged}</ReactMarkdown>
          </div>
        </div>
      )}
      {entry.lessons && (
        <div className="mt-2 text-sm">
          <div className="font-medium text-xs uppercase text-muted-foreground mb-1">Lessons</div>
          <div className="prose prose-sm max-w-none">
            <ReactMarkdown>{entry.lessons}</ReactMarkdown>
          </div>
        </div>
      )}
    </article>
  );
}
```

- [ ] **Step 2: `entry-list.tsx`**

Create `app/(app)/stock/[ticker]/journal/_components/entry-list.tsx`:

```tsx
import type { JournalEntry } from '@/lib/services/journal';
import { EntryCard } from './entry-card';

interface Props { entries: JournalEntry[]; }

export function EntryList({ entries }: Props) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground italic px-3 py-4">No entries yet for this position.</p>;
  }
  return (
    <div className="px-3">
      {entries.map((e) => <EntryCard key={String(e.id)} entry={e} />)}
    </div>
  );
}
```

- [ ] **Step 3: `position-card.tsx`**

Create `app/(app)/stock/[ticker]/journal/_components/position-card.tsx`:

```tsx
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { JournalPosition, JournalEntry } from '@/lib/services/journal';
import { summarizePosition } from '@/lib/compute/journal-summary';
import { EntryList } from './entry-list';

interface Props {
  position: JournalPosition;
  entries?: JournalEntry[];
  expanded?: boolean;
  showTicker?: boolean;            // true on the cross-ticker /journal view
}

export function PositionCard({ position, entries = [], expanded = false, showTicker = false }: Props) {
  const latestEntry = entries.length > 0 ? entries[entries.length - 1]! : null;
  const summary = summarizePosition({
    status: position.status,
    openedAt: position.openedAt,
    closedAt: position.closedAt,
    latestEntry: latestEntry ? {
      kind: latestEntry.kind, occurredAt: latestEntry.occurredAt, thesisMd: latestEntry.thesisMd
    } : null,
    now: new Date()
  });

  return (
    <article className={cn('rounded border border-border overflow-hidden mb-3 last:mb-0',
      position.status === 'closed' && 'opacity-80')}>
      <header className="flex items-baseline justify-between px-3 py-2 bg-muted/50">
        <div className="flex items-baseline gap-3">
          {showTicker && (
            <Link href={`/stock/${position.ticker}/journal`} className="font-mono font-medium hover:text-primary">
              {position.ticker}
            </Link>
          )}
          <span className={cn('text-xs px-2 py-0.5 rounded uppercase tracking-wide',
            position.status === 'open' ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground')}>
            {position.status}
          </span>
          {summary.stale && (
            <span className="text-xs px-2 py-0.5 rounded uppercase tracking-wide bg-amber-100 text-amber-800">
              stale
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            opened {position.openedAt}
            {position.closedAt && ` · closed ${position.closedAt}`}
            {' · '}{summary.daysHeld}d held
          </span>
          {position.convictionAtOpen != null && (
            <span className="text-xs text-muted-foreground">· conviction {position.convictionAtOpen}/10</span>
          )}
        </div>
      </header>
      {!expanded && summary.thesisPreview && (
        <p className="text-sm text-muted-foreground italic px-3 py-2">{summary.thesisPreview}</p>
      )}
      {expanded && <EntryList entries={entries} />}
    </article>
  );
}
```

- [ ] **Step 4: `journal-empty.tsx`**

Create `app/(app)/stock/[ticker]/journal/_components/journal-empty.tsx`:

```tsx
interface Props { variant: 'ticker' | 'all'; ticker?: string; }

export function JournalEmpty({ variant, ticker }: Props) {
  if (variant === 'ticker') {
    return (
      <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          No positions on <span className="font-mono font-medium">{ticker}</span> yet.
        </p>
        <p className="text-xs text-muted-foreground">Open one above to start journaling your thesis.</p>
      </div>
    );
  }
  return (
    <div className="rounded border border-dashed border-border p-8 text-center space-y-3">
      <p className="text-sm text-muted-foreground">No positions yet.</p>
      <p className="text-xs text-muted-foreground">
        Open one from any ticker's Journal tab.
      </p>
    </div>
  );
}
```

- [ ] **Step 5: `journal-filters.tsx`**

Create `app/(app)/journal/_components/journal-filters.tsx`:

```tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

export function JournalFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    startTransition(() => router.push(`/journal?${next.toString()}`));
  }

  return (
    <form className="flex flex-wrap gap-3 items-baseline bg-muted/50 px-3 py-2 rounded mb-4">
      <label className="text-sm">
        Status:{' '}
        <select
          value={params.get('status') ?? ''}
          onChange={(e) => setParam('status', e.currentTarget.value || null)}
          className="border border-border rounded px-2 py-1 text-sm"
        >
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </label>
      <label className="text-sm">
        Ticker:{' '}
        <input
          type="text"
          defaultValue={params.get('ticker') ?? ''}
          onBlur={(e) => setParam('ticker', e.currentTarget.value.toUpperCase() || null)}
          className="border border-border rounded px-2 py-1 text-sm font-mono w-24 uppercase"
          placeholder="AAPL"
        />
      </label>
      <label className="text-sm">
        Min conviction:{' '}
        <input
          type="number" min={1} max={10}
          defaultValue={params.get('minConviction') ?? ''}
          onBlur={(e) => setParam('minConviction', e.currentTarget.value || null)}
          className="border border-border rounded px-2 py-1 text-sm w-16"
        />
      </label>
    </form>
  );
}
```

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/journal/_components/ app/\(app\)/journal/_components/
git commit -m "$(cat <<'EOF'
feat(journal): server UI components — cards, entry list, empty, filters

PositionCard renders status + days-held + conviction + (preview or
expanded entries). EntryCard renders kind badge + date + markdown
thesis + optional whatChanged/lessons. JournalEmpty handles both
single-ticker and cross-ticker empty states. JournalFilters drives
URL-based status/ticker/conviction filters with useTransition.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Client UI components (editors)

**Files:**
- Create: `app/(app)/stock/[ticker]/journal/_components/position-editor.tsx`
- Create: `app/(app)/stock/[ticker]/journal/_components/entry-editor.tsx`

- [ ] **Step 1: `position-editor.tsx`**

Create `app/(app)/stock/[ticker]/journal/_components/position-editor.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface Props {
  ticker: string;
  onClose?: () => void;
}

export function PositionEditor({ ticker, onClose }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [openedAt, setOpenedAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [conviction, setConviction] = useState<number>(7);
  const [target, setTarget] = useState<string>('');
  const [stop, setStop] = useState<string>('');
  const [hold, setHold] = useState<string>('');
  const [thesis, setThesis] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        ticker, openedAt, convictionAtOpen: conviction
      };
      if (target) body.targetPrice = Number(target);
      if (stop) body.stopPrice = Number(stop);
      if (hold) body.expectedHoldingDays = Number(hold);
      if (thesis) body.firstEntry = { thesisMd: thesis, convictionAtTime: conviction };
      const res = await fetch('/api/journal/positions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
      onClose?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-4 space-y-3 bg-card">
      <h3 className="font-medium">New position on {ticker}</h3>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label>
          <div className="text-xs text-muted-foreground">Opened at</div>
          <input type="date" value={openedAt} onChange={(e) => setOpenedAt(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label>
          <div className="text-xs text-muted-foreground">Conviction (1-10): {conviction}</div>
          <input type="range" min={1} max={10} value={conviction}
            onChange={(e) => setConviction(Number(e.currentTarget.value))} className="w-full" />
        </label>
        <label>
          <div className="text-xs text-muted-foreground">Target price (optional)</div>
          <input type="number" step="0.01" value={target} onChange={(e) => setTarget(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label>
          <div className="text-xs text-muted-foreground">Stop price (optional)</div>
          <input type="number" step="0.01" value={stop} onChange={(e) => setStop(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label className="col-span-2">
          <div className="text-xs text-muted-foreground">Expected holding (days, optional)</div>
          <input type="number" value={hold} onChange={(e) => setHold(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 w-full" />
        </label>
        <label className="col-span-2">
          <div className="text-xs text-muted-foreground">Thesis (markdown)</div>
          <textarea value={thesis} onChange={(e) => setThesis(e.currentTarget.value)} rows={6}
            placeholder="What's your thesis? What's the catalyst? What would prove you wrong?"
            className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
        </label>
      </div>
      {err && <p className="text-xs text-rose-700">{err}</p>}
      <div className="flex gap-2 justify-end">
        {onClose && <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>}
        <Button onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `entry-editor.tsx`**

Create `app/(app)/stock/[ticker]/journal/_components/entry-editor.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

type Kind = 'entry' | 'review' | 'exit';

interface Props {
  positionId: bigint;
  defaultKind?: Kind;
  onClose?: () => void;
}

export function EntryEditor({ positionId, defaultKind = 'review', onClose }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [occurredAt, setOccurredAt] = useState<string>(new Date().toISOString().slice(0, 10));
  const [conviction, setConviction] = useState<number>(7);
  const [thesis, setThesis] = useState<string>('');
  const [outcome, setOutcome] = useState<'right' | 'wrong' | 'mixed' | ''>('');
  const [whatChanged, setWhatChanged] = useState<string>('');
  const [lessons, setLessons] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = {
        kind, occurredAt, thesisMd: thesis, convictionAtTime: conviction
      };
      if (kind !== 'entry' && whatChanged) body.whatChanged = whatChanged;
      if (kind === 'exit') {
        if (outcome) body.outcome = outcome;
        if (lessons) body.lessons = lessons;
      }
      const res = await fetch(`/api/journal/positions/${positionId}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${res.status}`);
      }
      startTransition(() => router.refresh());
      onClose?.();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-border p-3 space-y-3 bg-card text-sm">
      <div className="flex items-baseline gap-3">
        <label>
          Kind:{' '}
          <select value={kind} onChange={(e) => setKind(e.currentTarget.value as Kind)}
            className="border border-border rounded px-2 py-1 text-sm">
            <option value="entry">Open</option>
            <option value="review">Review</option>
            <option value="exit">Exit</option>
          </select>
        </label>
        <label>
          Date:{' '}
          <input type="date" value={occurredAt} onChange={(e) => setOccurredAt(e.currentTarget.value)}
            className="border border-border rounded px-2 py-1 text-sm" />
        </label>
        <label>
          Conviction {conviction}/10:{' '}
          <input type="range" min={1} max={10} value={conviction}
            onChange={(e) => setConviction(Number(e.currentTarget.value))} />
        </label>
      </div>
      <label className="block">
        <div className="text-xs text-muted-foreground mb-1">Thesis (markdown)</div>
        <textarea value={thesis} onChange={(e) => setThesis(e.currentTarget.value)} rows={5}
          className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
      </label>
      {kind !== 'entry' && (
        <label className="block">
          <div className="text-xs text-muted-foreground mb-1">What changed (markdown)</div>
          <textarea value={whatChanged} onChange={(e) => setWhatChanged(e.currentTarget.value)} rows={3}
            className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
        </label>
      )}
      {kind === 'exit' && (
        <>
          <label className="block">
            Outcome:{' '}
            <select value={outcome} onChange={(e) => setOutcome(e.currentTarget.value as any)}
              className="border border-border rounded px-2 py-1 text-sm">
              <option value="">—</option>
              <option value="right">Right</option>
              <option value="wrong">Wrong</option>
              <option value="mixed">Mixed</option>
            </select>
          </label>
          <label className="block">
            <div className="text-xs text-muted-foreground mb-1">Lessons (markdown)</div>
            <textarea value={lessons} onChange={(e) => setLessons(e.currentTarget.value)} rows={3}
              className="border border-border rounded px-2 py-1 w-full font-mono text-xs" />
          </label>
        </>
      )}
      {err && <p className="text-xs text-rose-700">{err}</p>}
      <div className="flex gap-2 justify-end">
        {onClose && <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>}
        <Button size="sm" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/journal/_components/position-editor.tsx app/\(app\)/stock/\[ticker\]/journal/_components/entry-editor.tsx
git commit -m "$(cat <<'EOF'
feat(journal): client editor components for positions + entries

PositionEditor: opens-at date, conviction slider, optional target/stop
prices, expected hold days, markdown thesis textarea. POST to
/api/journal/positions then router.refresh().

EntryEditor: kind selector (entry/review/exit), conviction slider,
markdown thesis, optional what-changed (review+exit), outcome +
lessons (exit only). POST to /api/journal/positions/[id]/entries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Per-ticker page + dashboard tab

**Files:**
- Create: `app/(app)/stock/[ticker]/journal/page.tsx`
- Modify: `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`

- [ ] **Step 1: Add `'journal'` to DashboardTab union + TABS array**

Open `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`. Edit the union to insert `'journal'` between `'overview'` and `'financials'`:

```ts
export type DashboardTab =
  | 'overview'
  | 'journal'
  | 'financials'
  | 'technical'
  | 'news'
  | 'insiders'
  | 'holdings'
  | 'filings'
  | 'transcripts'
  | 'quality'
  | 'peers'
  | 'ask';
```

(If Transcripts hasn't shipped yet, omit `'transcripts'` from this edit.)

Insert the new TABS entry just after Overview:

```ts
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'journal',    label: 'Journal',    href: (t) => `/stock/${t}/journal` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
```

- [ ] **Step 2: Implement the per-ticker journal page**

Create `app/(app)/stock/[ticker]/journal/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService } from '@/lib/services/journal';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { PositionCard } from './_components/position-card';
import { PositionEditor } from './_components/position-editor';
import { JournalEmpty } from './_components/journal-empty';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

interface PageProps { params: { ticker: string }; }

export default async function TickerJournalPage({ params }: PageProps) {
  const userId = await requireUserId();
  const ticker = params.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) notFound();

  const svc = new JournalService({ db: getServiceDb() });
  const positions = await svc.listPositions(userId, { ticker });

  // Load entries for each position (UI shows expanded list inline)
  const positionsWithEntries = await Promise.all(
    positions.map(async (p) => {
      const full = await svc.getPosition(userId, p.id);
      return { ...p, entries: full?.entries ?? [] };
    })
  );

  const open = positionsWithEntries.filter((p) => p.status === 'open');
  const closed = positionsWithEntries.filter((p) => p.status === 'closed');

  return (
    <article className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{ticker}</h1>
          <p className="text-sm text-muted-foreground">Trade journal</p>
        </div>
        <DashboardTabs ticker={ticker} active="journal" />
      </header>

      <Card>
        <CardHeader><CardTitle>New position</CardTitle></CardHeader>
        <CardContent>
          <PositionEditor ticker={ticker} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Open positions ({open.length})</CardTitle></CardHeader>
        <CardContent>
          {open.length === 0
            ? <JournalEmpty variant="ticker" ticker={ticker} />
            : open.map((p) => <PositionCard key={String(p.id)} position={p} entries={p.entries} expanded />)
          }
        </CardContent>
      </Card>

      {closed.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Closed positions ({closed.length})</CardTitle></CardHeader>
          <CardContent>
            {closed.map((p) => <PositionCard key={String(p.id)} position={p} entries={p.entries} expanded />)}
          </CardContent>
        </Card>
      )}
    </article>
  );
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Manual smoke**

```bash
pnpm dev
```

In browser:
1. Visit `/stock/AAPL/journal`. Confirm Journal tab is highlighted and reachable from tab nav on any ticker page.
2. Fill in the "New position" form with target=250, stop=180, conviction=8, thesis="iPhone refresh cycle thesis." Save.
3. Position appears in "Open positions" section with conviction 8/10, days held, expanded entry visible.
4. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/stock/\[ticker\]/journal/page.tsx app/\(app\)/stock/\[ticker\]/_components/dashboard-tabs.tsx
git commit -m "$(cat <<'EOF'
feat(journal): /stock/[TICKER]/journal page + dashboard tab entry

Per-ticker view with three cards: New position form, Open positions
list, Closed positions list. Positions rendered with inline expanded
entries via PositionCard + EntryList. New 'Journal' tab slotted
between Overview and Financials in DashboardTabs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Top-level /journal page + watchlist nav

**Files:**
- Create: `app/(app)/journal/page.tsx`
- Modify: `app/(app)/watchlist/_components/watchlist-tabs.tsx`

- [ ] **Step 1: Implement the top-level page**

Create `app/(app)/journal/page.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { JournalService, type ListPositionsOpts } from '@/lib/services/journal';
import { PositionCard } from '../stock/[ticker]/journal/_components/position-card';
import { JournalEmpty } from '../stock/[ticker]/journal/_components/journal-empty';
import { JournalFilters } from './_components/journal-filters';

interface PageProps {
  searchParams: { status?: string; ticker?: string; minConviction?: string };
}

export default async function JournalPage({ searchParams }: PageProps) {
  const userId = await requireUserId();
  const svc = new JournalService({ db: getServiceDb() });

  const opts: ListPositionsOpts = {};
  if (searchParams.status === 'open' || searchParams.status === 'closed') opts.status = searchParams.status;
  if (searchParams.ticker) opts.ticker = searchParams.ticker.toUpperCase();
  if (searchParams.minConviction) opts.minConviction = Number(searchParams.minConviction);

  const positions = await svc.listPositions(userId, opts);
  const positionsWithEntries = await Promise.all(positions.map(async (p) => {
    const full = await svc.getPosition(userId, p.id);
    return { ...p, entries: full?.entries ?? [] };
  }));

  return (
    <article className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Trade Journal</h1>
        <p className="text-sm text-muted-foreground">All your tracked positions, across tickers.</p>
      </header>

      <JournalFilters />

      <Card>
        <CardHeader>
          <CardTitle>Positions ({positionsWithEntries.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {positionsWithEntries.length === 0
            ? <JournalEmpty variant="all" />
            : positionsWithEntries.map((p) => (
                <PositionCard
                  key={String(p.id)}
                  position={p}
                  entries={p.entries}
                  showTicker
                />
              ))
          }
        </CardContent>
      </Card>
    </article>
  );
}
```

- [ ] **Step 2: Add Journal entry to watchlist tabs**

Open `app/(app)/watchlist/_components/watchlist-tabs.tsx`. Find the TabMode union (likely `'rollup' | 'discover' | 'search' | 'ask'`). Add `'journal'`. Find the TABS array (or equivalent) and add an entry that links to `/journal`.

The minimum-touch implementation is to add one more `<Link href="/journal">Journal</Link>` chip alongside the others. Match existing pattern from how Discover/Search/Ask are rendered.

If the existing component is small, here's a likely shape — match exact import/return style of the existing file:

```tsx
// Add to the union + tabs:
type TabMode = 'rollup' | 'discover' | 'search' | 'ask' | 'journal';
// ...
const TABS: Array<{ value: TabMode; label: string; href: string }> = [
  { value: 'rollup',   label: 'Roll-up',  href: '/watchlist' },
  { value: 'discover', label: 'Discover', href: '/watchlist/discover' },
  { value: 'search',   label: 'Search',   href: '/watchlist?tab=search' },
  { value: 'ask',      label: 'Ask',      href: '/watchlist?tab=ask' },
  { value: 'journal',  label: 'Journal',  href: '/journal' }
];
```

- [ ] **Step 3: Typecheck + smoke**

```bash
pnpm typecheck
pnpm dev
```

In browser:
1. Visit `/journal`. See positions list with the AAPL position from Task 10.
2. Click "Status: closed" filter. List should empty.
3. Reset to "All". Position reappears.
4. Visit `/watchlist`. Click the new "Journal" tab. Navigates to `/journal`.
5. Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/journal/page.tsx app/\(app\)/watchlist/_components/watchlist-tabs.tsx
git commit -m "$(cat <<'EOF'
feat(journal): top-level /journal page + watchlist nav entry

/journal aggregates positions across all tickers with URL-driven
filters (status, ticker, minConviction). Reuses PositionCard with
showTicker=true. Watchlist tabs gain a Journal entry alongside
Roll-up/Discover/Search/Ask.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: E2E + push + CI + Vercel verify

**Files:**
- Create: `tests/e2e/journal.spec.ts`

- [ ] **Step 1: Write the E2E**

Create `tests/e2e/journal.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { signInAsTestUser } from './fixtures/auth';

test.describe('Trade journal', () => {
  test('open + journal + close round trip', async ({ page }) => {
    await signInAsTestUser(page);
    await page.goto('/stock/AAPL/journal');
    await expect(page.getByRole('heading', { name: 'AAPL' })).toBeVisible();
    await expect(page.getByText('Trade journal')).toBeVisible();

    // Fill new-position form
    await page.getByPlaceholder("What's your thesis?").fill('Test thesis for E2E. Catalyst: iPhone refresh.');
    await page.getByRole('button', { name: 'Save' }).click();

    // Position appears in Open list
    await expect(page.getByText(/Open positions \(1\)/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/Test thesis for E2E/)).toBeVisible();

    // Navigate to top-level journal
    await page.goto('/journal');
    await expect(page.getByRole('heading', { name: 'Trade Journal' })).toBeVisible();
    await expect(page.getByText(/Positions \(1\)/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'AAPL' })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the E2E**

```bash
pnpm test:e2e tests/e2e/journal.spec.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full test matrix**

```bash
pnpm test               # unit
pnpm test:integration   # integration
pnpm typecheck          # types
pnpm lint               # lint
```

Expected: all green.

- [ ] **Step 4: Commit + push**

```bash
git add tests/e2e/journal.spec.ts
git commit -m "$(cat <<'EOF'
test(journal): E2E happy path — open a position + verify cross-ticker view

Signs in, fills the new-position form on /stock/AAPL/journal, confirms
the position appears in Open list, navigates to /journal and confirms
it shows up with the AAPL ticker link.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push origin master
```

- [ ] **Step 5: Watch CI**

Open GitHub Actions for the master push. Wait for typecheck + unit + integration + E2E to all go green.

- [ ] **Step 6: Vercel browser smoke**

Once Vercel deploys:
1. Visit `/stock/AAPL/journal` on the prod URL.
2. Fill in target=250, stop=180, conviction=8, thesis with markdown formatting (`**bold**`, `_italic_`).
3. Save. Position appears with the rendered markdown preview.
4. Click into the position (or refresh). Expanded entry shows full markdown rendered.
5. Visit `/journal`. Confirm the same position appears with ticker chip.
6. Apply filter `status=open`. Confirm position still shows. Apply `status=closed`. Confirm empty state.
7. Close the position via the editor (add an exit entry). Reload `/journal` with `status=closed`. Confirm it appears now.
8. Roll forward with a fix commit if anything looks wrong.

---

## Self-Review

**Spec coverage:**
- `journal_positions` + `journal_entries` schema → Task 1
- RLS policies → Task 2
- `summarizePosition` pure helper → Task 3
- Validation helpers (ticker, conviction, prices, kind/outcome enums) → Task 3
- JournalService position CRUD with ownership checks → Task 4
- JournalService entry CRUD with ownership checks → Task 4 (impl) + Task 5 (tests)
- All 9 API endpoints → Tasks 6 + 7
- Zod-validated bodies → Task 6 + Task 7
- Cache-Control private no-store on writes → Task 6 + Task 7
- Position card + entry card + empty + filters → Task 8
- Position editor + entry editor (client forms) → Task 9
- /stock/[TICKER]/journal page with new-position + open/closed sections → Task 10
- DashboardTab entry between Overview and Financials → Task 10
- Top-level /journal with URL-driven filters → Task 11
- Watchlist tabs Journal entry → Task 11
- E2E happy path → Task 12
- Markdown rendering via react-markdown (reused) → Task 8 (entry-card)

No gaps. The spec's "outcome only on exit" rule is enforced both client-side
(EntryEditor only renders the outcome select when kind === 'exit') and
server-side (validateNewEntry throws on outcome with non-exit kind).

**Placeholder scan:** All steps contain concrete code or commands. The
watchlist-tabs modification in Task 11 says "match exact import/return
style of the existing file" rather than reproducing the exact diff (since
the file shape isn't paste-stable across slices); this is a small change
the implementer can make in 5 minutes by reading the file once. Not a
placeholder.

**Type consistency:**
- `JournalPosition`, `JournalEntry`, `PositionWithEntries` defined Task 4,
  used Tasks 6, 7, 8, 10, 11. Same shape. ✓
- `NewPositionInput`, `NewEntryInput`, `PositionUpdateInput`,
  `EntryUpdateInput`, `ClosePositionInput`, `ListPositionsOpts` defined
  Task 4, used Tasks 6, 7. Same shape. ✓
- Schema column names (`thesisMd`, `convictionAtOpen`, `openedAt`,
  `closedAt`, `outcome`, `whatChanged`, `lessons`) consistent between
  schema (Task 1), types (Task 4), validation (Task 3), and API/Zod (Tasks
  6 + 7). ✓
- Enum values (`kind`, `outcome`, `status`) match across all task layers. ✓
- Route paths match between test imports and route exports (Tasks 6 + 7). ✓

The plan is internally consistent. No re-review needed.
