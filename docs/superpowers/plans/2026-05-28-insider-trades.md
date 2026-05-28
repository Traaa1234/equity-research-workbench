# Insider Trades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship SEC Form 4 insider trades — an Overview card showing 90-day net activity + a dedicated `/stock/[ticker]/insiders` tab with full transaction list, aggregation panel, and cluster-buy detection.

**Architecture:** DB-cached transaction rows fetched from Financial Datasets `/insider-trades/`. Pure-functional aggregate compute over the rows. Server components for both surfaces. Manual refresh button — no cron, no LLM. Matches the Slice 5B (News) pattern.

**Tech Stack:** Next.js 14, TypeScript strict, Drizzle ORM, Postgres/Neon, Vitest, Tailwind/shadcn.

**Spec:** `docs/superpowers/specs/2026-05-28-insider-trades-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/db/schema.ts` | Modify | Add `insiderTrades` table |
| `lib/db/migrations/<auto>.sql` | Create (drizzle-kit) | DDL |
| `lib/db/migrations/9993_rls_insider_trades.sql` | Create | RLS policy |
| `lib/providers/types.ts` | Modify | Add `InsiderTradeMeta` |
| `lib/providers/financial-datasets.ts` | Modify | Add `insiderTrades()` |
| `lib/providers/__fixtures__/fd-insider-trades-aapl.json` | Create | Sample FD response |
| `lib/compute/insider-aggregate.ts` | Create | Pure `computeInsiderAggregate` + classification |
| `lib/services/insiders.ts` | Create | `InsidersService` |
| `app/api/tickers/[symbol]/insiders/route.ts` | Create | GET + POST |
| `scripts/try-insiders.ts` | Create | `pnpm try-insiders <TICKER>` |
| `app/(app)/stock/[ticker]/_components/insider-card.tsx` | Create | Overview card |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Load + render `<InsiderCard>` |
| `app/(app)/stock/[ticker]/insiders/page.tsx` | Create | Server component |
| `app/(app)/stock/[ticker]/insiders/_components/insiders-view.tsx` | Create | Client wrapper |
| `app/(app)/stock/[ticker]/insiders/_components/insider-aggregate-panel.tsx` | Create | Summary block |
| `app/(app)/stock/[ticker]/insiders/_components/insider-transaction-row.tsx` | Create | Single-row component |
| `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` | Modify | Add `'insiders'` tab |
| `tests/compute/insider-aggregate.test.ts` | Create | 6 unit tests |
| `tests/providers/financial-datasets.test.ts` | Modify | Add `insiderTrades()` tests |
| `tests/integration/insiders-service.test.ts` | Create | Service integration |
| `tests/integration/api-tickers-insiders.test.ts` | Create | API routes |
| `tests/integration/insider-trades-rls.test.ts` | Create | RLS smoke |
| `package.json` | Modify | Add `try-insiders` script |

---

## Task 1: Schema — `insider_trades` table + RLS

**Files:**
- Modify: `lib/db/schema.ts`
- Generate: `lib/db/migrations/<auto>.sql` via drizzle-kit
- Create: `lib/db/migrations/9993_rls_insider_trades.sql`

**CRITICAL:** Apply via `_apply.ts` — never `drizzle-kit push --force`.

- [ ] **Step 1.1: Add Drizzle table definition**

Edit `lib/db/schema.ts`. Append after the existing `newsArticles` table:

```ts
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
```

- [ ] **Step 1.2: Generate the Drizzle migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm exec drizzle-kit generate
```

Expected: a new file `lib/db/migrations/00XX_<random>.sql` containing `CREATE TABLE "insider_trades"` and the two indexes. Note the filename for Step 1.4.

- [ ] **Step 1.3: Write the RLS migration**

Create `lib/db/migrations/9993_rls_insider_trades.sql`:

```sql
-- RLS for insider trades: authenticated users read, service role writes.
ALTER TABLE public.insider_trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read insider_trades" ON public.insider_trades;
CREATE POLICY "authenticated read insider_trades"
  ON public.insider_trades FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.insider_trades TO authenticated;
```

- [ ] **Step 1.4: Apply both migrations to both Neon branches**

Substitute the actual drizzle-generated filename from Step 1.2:

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/<auto-filename>
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/<auto-filename>
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9993_rls_insider_trades.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9993_rls_insider_trades.sql
```

All four should print `Applied ... OK`.

- [ ] **Step 1.5: Verify table + RLS on both branches**

```bash
pnpm exec tsx -e "
import { config } from 'dotenv'; config({ path: '.env.local' });
import postgres from 'postgres';
for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
] as const) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const cols = await sql\`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'insider_trades' ORDER BY ordinal_position\`;
  console.log(\`\\n\${label.toUpperCase()} insider_trades columns (\${cols.length}):\`);
  for (const c of cols) console.log(\`  \${c.column_name}\`);
  const pols = await sql\`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'insider_trades'\`;
  console.log(\`  policies: \${pols.length}\`);
  for (const p of pols) console.log(\`    \${p.policyname}\`);
  await sql.end();
}
process.exit(0);
"
```

Expected: 15 columns + 1 policy `authenticated read insider_trades` on both branches.

- [ ] **Step 1.6: Verify drizzle is in sync**

```bash
pnpm exec drizzle-kit generate
```

Expected: `No schema changes, nothing to migrate 😴`.

- [ ] **Step 1.7: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations/
git commit -m "feat(schema): insider_trades table + RLS for insider trades slice

Applied via _apply.ts to both prod + test Neon branches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: FD provider — `insiderTrades()` method

**Files:**
- Modify: `lib/providers/types.ts` (add `InsiderTradeMeta`)
- Modify: `lib/providers/financial-datasets.ts` (add `insiderTrades()`)
- Create: `lib/providers/__fixtures__/fd-insider-trades-aapl.json`
- Modify: `tests/providers/financial-datasets.test.ts` (add tests)

- [ ] **Step 2.1: Add `InsiderTradeMeta` to `lib/providers/types.ts`**

Append to the end of the file:

```ts
// Insider trade transaction as returned by Financial Datasets /insider-trades/ endpoint.
// Field names use snake_case to match the API wire format.
export interface InsiderTradeMeta {
  ticker: string;
  issuer: string;
  name: string;
  title: string | null;
  is_board_director: boolean;
  transaction_date: string;          // ISO YYYY-MM-DD
  transaction_type: string;          // 'Open market sale', 'Open market purchase', 'Award', etc.
  transaction_shares: number;
  transaction_price_per_share: number | null;
  transaction_value: number | null;
  shares_owned_before_transaction: number | null;
  shares_owned_after_transaction: number | null;
  security_title: string | null;
  filing_date: string;
}
```

- [ ] **Step 2.2: Create the FD insider trades fixture**

Create `lib/providers/__fixtures__/fd-insider-trades-aapl.json`:

```json
{
  "insider_trades": [
    {
      "ticker": "AAPL",
      "issuer": "Apple Inc.",
      "name": "Ben Borders",
      "title": "Principal Accounting Officer",
      "is_board_director": false,
      "transaction_date": "2026-05-08",
      "transaction_type": "Open market sale",
      "transaction_shares": 1274,
      "transaction_price_per_share": 290,
      "transaction_value": 369460,
      "shares_owned_before_transaction": 39987,
      "shares_owned_after_transaction": 38713,
      "security_title": "Common Stock",
      "filing_date": "2026-05-08"
    },
    {
      "ticker": "AAPL",
      "issuer": "Apple Inc.",
      "name": "Arthur D Levinson",
      "title": null,
      "is_board_director": true,
      "transaction_date": "2026-05-06",
      "transaction_type": "Open market sale",
      "transaction_shares": 149527,
      "transaction_price_per_share": 284.57,
      "transaction_value": 42550898.39,
      "shares_owned_before_transaction": 4069576,
      "shares_owned_after_transaction": 3920049,
      "security_title": "Common Stock",
      "filing_date": "2026-05-06"
    },
    {
      "ticker": "AAPL",
      "issuer": "Apple Inc.",
      "name": "Tim Cook",
      "title": "CEO",
      "is_board_director": true,
      "transaction_date": "2026-02-15",
      "transaction_type": "Award",
      "transaction_shares": 100000,
      "transaction_price_per_share": null,
      "transaction_value": null,
      "shares_owned_before_transaction": 3220000,
      "shares_owned_after_transaction": 3320000,
      "security_title": "Common Stock",
      "filing_date": "2026-02-15"
    }
  ]
}
```

- [ ] **Step 2.3: Write the failing tests FIRST**

Append to `tests/providers/financial-datasets.test.ts` inside the existing `describe('FinancialDatasetsProvider', ...)` block:

```ts
  describe('.insiderTrades()', () => {
    it('returns InsiderTradeMeta[] from /insider-trades/ endpoint', async () => {
      const fix = loadFixture('fd-insider-trades-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProvider(fetchMock);

      const result = await provider.insiderTrades('AAPL');

      expect(fetchMock).toHaveBeenCalledOnce();
      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('/insider-trades/?ticker=AAPL');
      expect(calledUrl).toContain('limit=500');
      expect(result).toHaveLength(3);
      expect(result[0]!.name).toBe('Ben Borders');
      expect(result[2]!.transaction_type).toBe('Award');
    });

    it('passes limit + date filters when provided', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ insider_trades: [] }));
      const provider = makeProvider(fetchMock);
      await provider.insiderTrades('AAPL', { limit: 100, filingDateGte: '2026-01-01', filingDateLte: '2026-05-01' });
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain('limit=100');
      expect(url).toContain('filing_date_gte=2026-01-01');
      expect(url).toContain('filing_date_lte=2026-05-01');
    });

    it('returns empty array when missing insider_trades field', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
      const provider = makeProvider(fetchMock);
      const result = await provider.insiderTrades('UNKNOWN');
      expect(result).toEqual([]);
    });

    it('maps 404 to NotFoundError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      const provider = makeProvider(fetchMock);
      await expect(provider.insiderTrades('AAPL')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('maps 429 to RateLimitError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429 }));
      const provider = makeProvider(fetchMock);
      await expect(provider.insiderTrades('AAPL')).rejects.toBeInstanceOf(RateLimitError);
    });
  });
```

- [ ] **Step 2.4: Run the test — confirm 5 fail**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test -- tests/providers/financial-datasets.test.ts
```

Expected: 5 new tests fail with undefined `insiderTrades` method.

- [ ] **Step 2.5: Implement `insiderTrades()` in `lib/providers/financial-datasets.ts`**

At the top, extend the existing import from `'./types'` to include `InsiderTradeMeta`.

Add the method to `FinancialDatasetsProvider` class (place it after `news()` or at the end of the class):

```ts
  async insiderTrades(
    ticker: string,
    opts: { limit?: number; filingDateGte?: string; filingDateLte?: string } = {}
  ): Promise<InsiderTradeMeta[]> {
    const params = new URLSearchParams({ ticker: ticker.toUpperCase() });
    params.set('limit', String(opts.limit ?? 500));
    if (opts.filingDateGte) params.set('filing_date_gte', opts.filingDateGte);
    if (opts.filingDateLte) params.set('filing_date_lte', opts.filingDateLte);
    const out = await this.request<{ insider_trades?: InsiderTradeMeta[] }>(
      `/insider-trades/?${params.toString()}`
    );
    return out.insider_trades ?? [];
  }
```

- [ ] **Step 2.6: Run the test — confirm all pass**

```bash
pnpm test -- tests/providers/financial-datasets.test.ts
```

Expected: all existing + 5 new tests pass.

- [ ] **Step 2.7: Commit**

```bash
git add lib/providers/types.ts lib/providers/financial-datasets.ts \
        lib/providers/__fixtures__/fd-insider-trades-aapl.json \
        tests/providers/financial-datasets.test.ts
git commit -m "feat(providers): FD insiderTrades() method + fixture + 5 unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure compute — `computeInsiderAggregate`

**Files:**
- Create: `lib/compute/insider-aggregate.ts`
- Create: `tests/compute/insider-aggregate.test.ts`

- [ ] **Step 3.1: Write the failing tests FIRST**

Create `tests/compute/insider-aggregate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  computeInsiderAggregate,
  classifyTransaction,
  type InsiderTradeRow
} from '@/lib/compute/insider-aggregate';

function row(
  name: string,
  date: string,
  type: string,
  shares: number,
  value: number | null = null
): InsiderTradeRow {
  return {
    insiderName: name,
    insiderTitle: null,
    transactionDate: date,
    transactionType: type,
    shares,
    transactionValue: value
  };
}

describe('classifyTransaction', () => {
  it('classifies open-market purchase as buy', () => {
    expect(classifyTransaction('Open market purchase')).toBe('buy');
  });
  it('classifies open-market sale as sell', () => {
    expect(classifyTransaction('Open market sale')).toBe('sell');
  });
  it('classifies award as award', () => {
    expect(classifyTransaction('Award')).toBe('award');
    expect(classifyTransaction('Stock Grant')).toBe('award');
  });
  it('classifies option exercise as exercise', () => {
    expect(classifyTransaction('Exercise of options')).toBe('exercise');
  });
  it('classifies unknown as other', () => {
    expect(classifyTransaction('Gift')).toBe('other');
    expect(classifyTransaction('Conversion')).toBe('other');
  });
  it('is case insensitive', () => {
    expect(classifyTransaction('OPEN MARKET PURCHASE')).toBe('buy');
    expect(classifyTransaction('open market sale')).toBe('sell');
  });
});

describe('computeInsiderAggregate', () => {
  const asOf = new Date('2026-05-31');

  it('returns positive net for all-buy fixture', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),
      row('Alice', '2026-05-15', 'Open market purchase', 200, 20000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(300);
    expect(agg.netDollarValue).toBe(30000);
    expect(agg.buyCount).toBe(2);
    expect(agg.sellCount).toBe(0);
    expect(agg.uniqueBuyers).toBe(1);
    expect(agg.uniqueSellers).toBe(0);
    expect(agg.hasClusterBuy).toBe(false);   // single buyer = no cluster
    expect(agg.largestBuy?.valueUsd).toBe(20000);
  });

  it('returns negative net for all-sell fixture', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market sale', 100, 10000),
      row('Bob',   '2026-05-15', 'Open market sale', 200, 20000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(-300);
    expect(agg.netDollarValue).toBe(-30000);
    expect(agg.sellCount).toBe(2);
    expect(agg.uniqueSellers).toBe(2);
    expect(agg.largestSell?.name).toBe('Bob');
  });

  it('detects cluster buy when 2+ distinct buyers within 30 days', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),
      row('Bob',   '2026-05-10', 'Open market purchase', 150, 15000),
      row('Carol', '2026-05-05', 'Open market purchase', 200, 20000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.hasClusterBuy).toBe(true);
    expect(agg.clusterBuyDates.length).toBeGreaterThan(0);
    expect(agg.uniqueBuyers).toBe(3);
  });

  it('treats compensation (awards + exercises) as not contributing to aggregate', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Award', 100000, null),
      row('Alice', '2026-05-15', 'Exercise of options', 50000, 5000000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(0);
    expect(agg.netDollarValue).toBe(0);
    expect(agg.buyCount).toBe(0);
    expect(agg.sellCount).toBe(0);
    expect(agg.hasClusterBuy).toBe(false);
  });

  it('respects the window — old transactions excluded', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),  // in window
      row('Bob',   '2025-01-01', 'Open market purchase', 9999, 999999) // out of window
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.netShares).toBe(100);
    expect(agg.buyCount).toBe(1);
    expect(agg.uniqueBuyers).toBe(1);
  });

  it('extracts largest buy and largest sell separately', () => {
    const rows: InsiderTradeRow[] = [
      row('Alice', '2026-05-20', 'Open market purchase', 100, 10000),
      row('Bob',   '2026-05-15', 'Open market purchase', 500, 50000),
      row('Carol', '2026-05-10', 'Open market sale',     300, 30000),
      row('Dave',  '2026-05-05', 'Open market sale',     800, 80000)
    ];
    const agg = computeInsiderAggregate(rows, 90, asOf);
    expect(agg.largestBuy?.name).toBe('Bob');
    expect(agg.largestBuy?.valueUsd).toBe(50000);
    expect(agg.largestSell?.name).toBe('Dave');
    expect(agg.largestSell?.valueUsd).toBe(80000);
  });

  it('returns zeros + nulls when no rows in window', () => {
    const agg = computeInsiderAggregate([], 90, asOf);
    expect(agg.netShares).toBe(0);
    expect(agg.netDollarValue).toBe(0);
    expect(agg.buyCount).toBe(0);
    expect(agg.sellCount).toBe(0);
    expect(agg.largestBuy).toBeNull();
    expect(agg.largestSell).toBeNull();
    expect(agg.lastTransactionDate).toBeNull();
    expect(agg.hasClusterBuy).toBe(false);
  });
});
```

- [ ] **Step 3.2: Run the test — confirm 13 fail**

```bash
pnpm test -- tests/compute/insider-aggregate.test.ts
```

Expected: 13 tests fail with `Cannot find module '@/lib/compute/insider-aggregate'`.

- [ ] **Step 3.3: Implement `computeInsiderAggregate` + `classifyTransaction`**

Create `lib/compute/insider-aggregate.ts`:

```ts
/**
 * Pure compute over SEC Form 4 insider transactions. No DB, no network.
 *
 * Classification rules: open-market purchases and sales are the only
 * "conviction signals." Awards, option exercises, and other transaction
 * types are compensation/admin and excluded from headline metrics —
 * they still appear in the full transaction list (UI handles glyphs).
 *
 * Cluster-buy detection follows the Lakonishok-Lee (2001) convention:
 * 2+ distinct insiders making open-market purchases within a rolling
 * 30-day window is a strong directional signal.
 */

export type TransactionClass = 'buy' | 'sell' | 'award' | 'exercise' | 'other';

export interface InsiderTradeRow {
  insiderName: string;
  insiderTitle: string | null;
  transactionDate: string;     // ISO YYYY-MM-DD
  transactionType: string;
  shares: number;
  transactionValue: number | null;
}

export interface InsiderAggregate {
  windowDays: number;
  netShares: number;
  netDollarValue: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  largestBuy: { name: string; date: string; valueUsd: number } | null;
  largestSell: { name: string; date: string; valueUsd: number } | null;
  hasClusterBuy: boolean;
  clusterBuyDates: string[];
  lastTransactionDate: string | null;
}

/**
 * Classify a transaction type string into one of 5 buckets.
 * Case-insensitive substring match — handles FD's various phrasings.
 */
export function classifyTransaction(type: string): TransactionClass {
  const t = type.toLowerCase();
  if (t.includes('open market purchase') || t.includes('open market buy')) return 'buy';
  if (t.includes('open market sale') || t.includes('open market sell')) return 'sell';
  if (t.includes('award') || t.includes('grant')) return 'award';
  if (t.includes('exercise')) return 'exercise';
  return 'other';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute aggregate over rows. `rows` must be sorted newest-first.
 * `asOf` defaults to now; pass a fixed Date in tests for determinism.
 */
export function computeInsiderAggregate(
  rows: InsiderTradeRow[],
  windowDays = 90,
  asOf: Date = new Date()
): InsiderAggregate {
  const cutoffMs = asOf.getTime() - windowDays * DAY_MS;
  const inWindow = rows.filter((r) => {
    const ms = Date.parse(r.transactionDate + 'T00:00:00Z');
    return Number.isFinite(ms) && ms >= cutoffMs;
  });

  const buys = inWindow.filter((r) => classifyTransaction(r.transactionType) === 'buy');
  const sells = inWindow.filter((r) => classifyTransaction(r.transactionType) === 'sell');

  const buyShares = buys.reduce((s, r) => s + r.shares, 0);
  const sellShares = sells.reduce((s, r) => s + r.shares, 0);
  const buyValue = buys.reduce((s, r) => s + (r.transactionValue ?? 0), 0);
  const sellValue = sells.reduce((s, r) => s + (r.transactionValue ?? 0), 0);

  const uniqueBuyers = new Set(buys.map((r) => r.insiderName)).size;
  const uniqueSellers = new Set(sells.map((r) => r.insiderName)).size;

  function largest(arr: InsiderTradeRow[]): { name: string; date: string; valueUsd: number } | null {
    let best: InsiderTradeRow | null = null;
    for (const r of arr) {
      const v = r.transactionValue ?? 0;
      const bestV = best?.transactionValue ?? 0;
      if (best === null || v > bestV) best = r;
    }
    if (!best) return null;
    return {
      name: best.insiderName,
      date: best.transactionDate,
      valueUsd: best.transactionValue ?? 0
    };
  }

  // Cluster-buy detection: for each buy, look at all buys within +/- 30 days.
  // If the union of distinct names (including the anchor) is >= 2, mark a cluster
  // starting at that anchor's date. Then dedupe overlapping clusters by keeping
  // the earliest anchor per 30-day stretch.
  const clusterBuyDates: string[] = [];
  const buysAsc = [...buys].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  let lastEmittedDate: string | null = null;
  for (let i = 0; i < buysAsc.length; i++) {
    const anchor = buysAsc[i]!;
    if (lastEmittedDate && daysBetween(anchor.transactionDate, lastEmittedDate) < 30) continue;
    const anchorMs = Date.parse(anchor.transactionDate + 'T00:00:00Z');
    const windowEnd = anchorMs + 30 * DAY_MS;
    const namesInWindow = new Set<string>();
    for (let j = i; j < buysAsc.length; j++) {
      const next = buysAsc[j]!;
      const nextMs = Date.parse(next.transactionDate + 'T00:00:00Z');
      if (nextMs > windowEnd) break;
      namesInWindow.add(next.insiderName);
    }
    if (namesInWindow.size >= 2) {
      clusterBuyDates.push(anchor.transactionDate);
      lastEmittedDate = anchor.transactionDate;
    }
  }

  const lastTransactionDate = inWindow.length > 0
    ? inWindow.map((r) => r.transactionDate).sort().pop()!
    : null;

  return {
    windowDays,
    netShares: buyShares - sellShares,
    netDollarValue: buyValue - sellValue,
    buyCount: buys.length,
    sellCount: sells.length,
    uniqueBuyers,
    uniqueSellers,
    largestBuy: largest(buys),
    largestSell: largest(sells),
    hasClusterBuy: clusterBuyDates.length > 0,
    clusterBuyDates,
    lastTransactionDate
  };
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(
    Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')
  );
  return ms / DAY_MS;
}
```

- [ ] **Step 3.4: Run the test — confirm all pass**

```bash
pnpm test -- tests/compute/insider-aggregate.test.ts
```

Expected: all 13 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add lib/compute/insider-aggregate.ts tests/compute/insider-aggregate.test.ts
git commit -m "feat(compute): pure insider aggregate + cluster-buy detection

classifyTransaction + computeInsiderAggregate over InsiderTradeRow[].
Open-market filter for conviction signal; awards/exercises excluded from
net buy/sell. Cluster-buy detection per Lakonishok-Lee (2001):
2+ distinct insiders within 30-day rolling window. 13 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `InsidersService` + integration tests

**Files:**
- Create: `lib/services/insiders.ts`
- Create: `tests/integration/insiders-service.test.ts`

- [ ] **Step 4.1: Write the failing integration tests FIRST**

Create `tests/integration/insiders-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, insiderTrades, refreshRuns } from '@/lib/db/schema';
import { InsidersService } from '@/lib/services/insiders';
import type { InsiderTradeMeta } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockFdProvider(trades: InsiderTradeMeta[]) {
  return {
    insiderTrades: vi.fn().mockResolvedValue(trades)
  };
}

const SAMPLE_TRADES: InsiderTradeMeta[] = [
  {
    ticker: 'AAPL', issuer: 'Apple Inc.', name: 'Alice',
    title: 'CFO', is_board_director: false,
    transaction_date: '2026-05-20', transaction_type: 'Open market purchase',
    transaction_shares: 1000, transaction_price_per_share: 290, transaction_value: 290000,
    shares_owned_before_transaction: 5000, shares_owned_after_transaction: 6000,
    security_title: 'Common Stock', filing_date: '2026-05-21'
  },
  {
    ticker: 'AAPL', issuer: 'Apple Inc.', name: 'Bob',
    title: null, is_board_director: true,
    transaction_date: '2026-05-15', transaction_type: 'Open market sale',
    transaction_shares: 500, transaction_price_per_share: 285, transaction_value: 142500,
    shares_owned_before_transaction: 10000, shares_owned_after_transaction: 9500,
    security_title: 'Common Stock', filing_date: '2026-05-16'
  }
];

describe('InsidersService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.', cik: null });
  });

  it('refresh: fetches, inserts, writes refresh_run', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    const summary = await svc.refresh('AAPL');

    expect(summary.fetched).toBe(2);
    expect(summary.newRows).toBe(2);

    const rows = await dbH.db.select().from(insiderTrades).where(eq(insiderTrades.ticker, 'AAPL'));
    expect(rows).toHaveLength(2);

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(true);
    expect(runs[0]!.kind).toBe('insiders');
  });

  it('refresh: idempotent — second call dedupes by composite key', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    const second = await svc.refresh('AAPL');

    expect(second.newRows).toBe(0);

    const rows = await dbH.db.select().from(insiderTrades).where(eq(insiderTrades.ticker, 'AAPL'));
    expect(rows).toHaveLength(2);
  });

  it('refresh: records ok=false when FD throws', async () => {
    const fd = { insiderTrades: vi.fn().mockRejectedValue(new Error('FD down')) };
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await expect(svc.refresh('AAPL')).rejects.toThrow();

    const runs = await dbH.db.select().from(refreshRuns).where(eq(refreshRuns.ticker, 'AAPL'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ok).toBe(false);
  });

  it('getList: returns newest first, limit honored', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    const list = await svc.getList('AAPL', 1);

    expect(list).toHaveLength(1);
    expect(list[0]!.transactionDate).toBe('2026-05-20');   // newest
  });

  it('getAggregate: delegates to pure compute over DB rows', async () => {
    const fd = mockFdProvider(SAMPLE_TRADES);
    const svc = new InsidersService({ db: dbH.db, fdProvider: fd as any });

    await svc.refresh('AAPL');
    // The 2 sample trades are within the last 90 days of the test execution time,
    // so they should appear in the aggregate. (Tests run with real Date.now;
    // the dates are 2026-05-15/20, which should be within 90 days as of test run.)
    const agg = await svc.getAggregate('AAPL', 999);   // huge window to be safe

    expect(agg.buyCount).toBe(1);
    expect(agg.sellCount).toBe(1);
    expect(agg.uniqueBuyers).toBe(1);
    expect(agg.uniqueSellers).toBe(1);
  });
});
```

- [ ] **Step 4.2: Run the test — confirm all fail**

```bash
pnpm test:integration -- insiders-service
```

Expected: 5 tests fail with `Cannot find module '@/lib/services/insiders'`.

- [ ] **Step 4.3: Implement `InsidersService`**

Create `lib/services/insiders.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import { insiderTrades, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { InsiderTradeMeta } from '@/lib/providers/types';
import {
  computeInsiderAggregate,
  type InsiderAggregate,
  type InsiderTradeRow
} from '@/lib/compute/insider-aggregate';
import { logger } from '@/lib/logger';

interface FdInsidersProvider {
  insiderTrades(ticker: string, opts?: { limit?: number }): Promise<InsiderTradeMeta[]>;
}

interface Deps {
  db: ServiceDb;
  fdProvider: FdInsidersProvider;
}

export interface InsiderTrade {
  id: string;
  ticker: string;
  insiderName: string;
  insiderTitle: string | null;
  isBoardDirector: boolean;
  transactionDate: string;
  transactionType: string;
  shares: number;
  pricePerShare: number | null;
  transactionValue: number | null;
  sharesOwnedBefore: number | null;
  sharesOwnedAfter: number | null;
  securityTitle: string | null;
  filingDate: string;
}

export interface InsiderRefreshSummary {
  ticker: string;
  fetched: number;
  newRows: number;
  durationMs: number;
}

const REFRESH_FETCH_LIMIT = 500;

export class InsidersService {
  constructor(private readonly deps: Deps) {}

  async getList(ticker: string, limit = 100): Promise<InsiderTrade[]> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select()
      .from(insiderTrades)
      .where(eq(insiderTrades.ticker, t))
      .orderBy(desc(insiderTrades.transactionDate))
      .limit(limit);
    return rows.map((r) => ({
      id: String(r.id),
      ticker: r.ticker,
      insiderName: r.insiderName,
      insiderTitle: r.insiderTitle,
      isBoardDirector: r.isBoardDirector,
      transactionDate: r.transactionDate,
      transactionType: r.transactionType,
      shares: Number(r.shares),
      pricePerShare: r.pricePerShare == null ? null : Number(r.pricePerShare),
      transactionValue: r.transactionValue == null ? null : Number(r.transactionValue),
      sharesOwnedBefore: r.sharesOwnedBefore == null ? null : Number(r.sharesOwnedBefore),
      sharesOwnedAfter: r.sharesOwnedAfter == null ? null : Number(r.sharesOwnedAfter),
      securityTitle: r.securityTitle,
      filingDate: r.filingDate
    }));
  }

  async getAggregate(ticker: string, windowDays = 90): Promise<InsiderAggregate> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        insiderName: insiderTrades.insiderName,
        insiderTitle: insiderTrades.insiderTitle,
        transactionDate: insiderTrades.transactionDate,
        transactionType: insiderTrades.transactionType,
        shares: insiderTrades.shares,
        transactionValue: insiderTrades.transactionValue
      })
      .from(insiderTrades)
      .where(eq(insiderTrades.ticker, t))
      .orderBy(desc(insiderTrades.transactionDate));

    const computeRows: InsiderTradeRow[] = rows.map((r) => ({
      insiderName: r.insiderName,
      insiderTitle: r.insiderTitle,
      transactionDate: r.transactionDate,
      transactionType: r.transactionType,
      shares: Number(r.shares),
      transactionValue: r.transactionValue == null ? null : Number(r.transactionValue)
    }));

    return computeInsiderAggregate(computeRows, windowDays);
  }

  async refresh(ticker: string): Promise<InsiderRefreshSummary> {
    const t = ticker.toUpperCase();
    const started = Date.now();
    const startedAt = new Date(started);
    let fetched = 0;
    let newRows = 0;

    try {
      const trades = await this.deps.fdProvider.insiderTrades(t, { limit: REFRESH_FETCH_LIMIT });
      fetched = trades.length;

      if (trades.length > 0) {
        const beforeRows = await this.deps.db
          .select({ id: insiderTrades.id })
          .from(insiderTrades)
          .where(eq(insiderTrades.ticker, t));
        const beforeCount = beforeRows.length;

        await this.deps.db
          .insert(insiderTrades)
          .values(
            trades.map((meta) => ({
              ticker: t,
              insiderName: meta.name,
              insiderTitle: meta.title,
              isBoardDirector: meta.is_board_director,
              transactionDate: meta.transaction_date,
              transactionType: meta.transaction_type,
              shares: String(meta.transaction_shares),
              pricePerShare: meta.transaction_price_per_share == null
                ? null
                : String(meta.transaction_price_per_share),
              transactionValue: meta.transaction_value == null
                ? null
                : String(meta.transaction_value),
              sharesOwnedBefore: meta.shares_owned_before_transaction == null
                ? null
                : String(meta.shares_owned_before_transaction),
              sharesOwnedAfter: meta.shares_owned_after_transaction == null
                ? null
                : String(meta.shares_owned_after_transaction),
              securityTitle: meta.security_title,
              filingDate: meta.filing_date
            }))
          )
          .onConflictDoNothing();

        const afterRows = await this.deps.db
          .select({ id: insiderTrades.id })
          .from(insiderTrades)
          .where(eq(insiderTrades.ticker, t));
        newRows = afterRows.length - beforeCount;
      }

      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'insiders',
        startedAt,
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'financial_datasets'
      });

      return { ticker: t, fetched, newRows, durationMs: Date.now() - started };
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: t,
        kind: 'insiders',
        startedAt,
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'financial_datasets',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ ticker: t, err: String(err) }, 'insiders.refresh failed');
      throw err;
    }
  }
}
```

- [ ] **Step 4.4: Run the test — confirm all 5 pass**

```bash
pnpm test:integration -- insiders-service
```

Expected: 5 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add lib/services/insiders.ts tests/integration/insiders-service.test.ts
git commit -m "feat(services): InsidersService (refresh/getList/getAggregate)

Dedupe via composite unique index. Records refresh_runs per call.
getAggregate delegates to pure compute over DB rows. 5 integration tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: API routes + try-insiders + RLS smoke

**Files:**
- Create: `app/api/tickers/[symbol]/insiders/route.ts`
- Create: `scripts/try-insiders.ts`
- Modify: `package.json`
- Create: `tests/integration/api-tickers-insiders.test.ts`
- Create: `tests/integration/insider-trades-rls.test.ts`

- [ ] **Step 5.1: Write the route**

Create `app/api/tickers/[symbol]/insiders/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const RATE_LIMIT_PER_MIN = 10;

interface RouteContext { params: { symbol: string }; }

let svc: InsidersService | null = null;
function service(): InsidersService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new InsidersService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY })
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:insiders-refresh:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_MIN) return false;
  await redis.set(key, cur + 1, 60);
  return true;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const svc_ = service();
    const [transactions, aggregate] = await Promise.all([
      svc_.getList(symbol),
      svc_.getAggregate(symbol)
    ]);
    return ok({ transactions, aggregate });
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/insiders GET' });
  }
}

export async function POST(_req: Request, ctx: RouteContext) {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
    }
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const summary = await service().refresh(symbol);
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/insiders POST' });
  }
}
```

- [ ] **Step 5.2: Write the API integration tests**

Create `tests/integration/api-tickers-insiders.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('/api/tickers/[symbol]/insiders', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({
      getServiceDb: () => dbH.db
    }));
    vi.doMock('@/lib/providers/financial-datasets', () => ({
      FinancialDatasetsProvider: class {
        insiderTrades = vi.fn().mockResolvedValue([
          {
            ticker: 'AAPL', issuer: 'Apple Inc.', name: 'Alice',
            title: 'CFO', is_board_director: false,
            transaction_date: '2026-05-20', transaction_type: 'Open market purchase',
            transaction_shares: 1000, transaction_price_per_share: 290, transaction_value: 290000,
            shares_owned_before_transaction: 5000, shares_owned_after_transaction: 6000,
            security_title: 'Common Stock', filing_date: '2026-05-21'
          }
        ]);
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 0,
        set: async () => undefined
      })
    }));
  });

  it('GET returns empty list + zero aggregate when no transactions', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/insiders'),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions).toEqual([]);
    expect(body.aggregate.buyCount).toBe(0);
    expect(body.aggregate.sellCount).toBe(0);
  });

  it('POST refresh inserts transactions + returns summary', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await POST(
      new Request('http://test.local/api/tickers/AAPL/insiders', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticker).toBe('AAPL');
    expect(body.fetched).toBe(1);
    expect(body.newRows).toBe(1);
  });

  it('GET after POST returns the inserted transaction', async () => {
    const { POST, GET } = await import('@/app/api/tickers/[symbol]/insiders/route');
    await POST(
      new Request('http://test.local/api/tickers/AAPL/insiders', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    const res = await GET(
      new Request('http://test.local/api/tickers/AAPL/insiders'),
      { params: { symbol: 'AAPL' } }
    );
    const body = await res.json();
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].insiderName).toBe('Alice');
  });

  it('GET returns 400 for invalid ticker', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await GET(
      new Request('http://test.local/api/tickers/x/insiders'),
      { params: { symbol: 'lowercase' } }
    );
    expect(res.status).toBe(400);
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({
        get: async () => 999,
        set: async () => undefined
      })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/tickers/[symbol]/insiders/route');
    const res = await POST(
      new Request('http://test.local/api/tickers/AAPL/insiders', { method: 'POST' }),
      { params: { symbol: 'AAPL' } }
    );
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 5.3: Write the RLS smoke test**

Create `tests/integration/insider-trades-rls.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, insiderTrades } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: insider_trades', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(insiderTrades).values({
      ticker: 'AAPL',
      insiderName: 'Alice',
      transactionDate: '2026-05-20',
      transactionType: 'Open market purchase',
      shares: '1000',
      filingDate: '2026-05-21'
    });
  });

  it('authenticated role can SELECT insider_trades', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(insiderTrades);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into insider_trades', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) => {
        await tx.insert(insiderTrades).values({
          ticker: 'AAPL',
          insiderName: 'Eve',
          transactionDate: '2026-05-22',
          transactionType: 'Open market sale',
          shares: '500',
          filingDate: '2026-05-22'
        });
      })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5.4: Create the try-insiders script**

Create `scripts/try-insiders.ts`:

```ts
#!/usr/bin/env tsx
/**
 * Smoke: pull insider trades for a ticker, print summary + recent rows.
 * Usage: pnpm try-insiders <TICKER>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker)) {
    console.error('Usage: pnpm try-insiders <TICKER>');
    process.exit(2);
  }

  const env = loadServerEnv();
  const db = getServiceDb();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const svc = new InsidersService({ db, fdProvider: fd });

  console.log(`Refreshing insider trades for ${ticker}...`);
  const t0 = Date.now();
  const summary = await svc.refresh(ticker);
  console.log(`  fetched: ${summary.fetched}, new: ${summary.newRows} (${Date.now() - t0}ms)\n`);

  const agg = await svc.getAggregate(ticker, 90);
  console.log(`90-day aggregate:`);
  console.log(`  net shares:   ${agg.netShares.toLocaleString()}`);
  console.log(`  net dollar:   $${agg.netDollarValue.toLocaleString()}`);
  console.log(`  buys:         ${agg.buyCount} txns / ${agg.uniqueBuyers} unique insiders`);
  console.log(`  sells:        ${agg.sellCount} txns / ${agg.uniqueSellers} unique insiders`);
  console.log(`  cluster buy:  ${agg.hasClusterBuy ? 'YES (' + agg.clusterBuyDates.join(', ') + ')' : 'no'}`);
  if (agg.largestBuy)  console.log(`  largest buy:  ${agg.largestBuy.name} ${agg.largestBuy.date} $${agg.largestBuy.valueUsd.toLocaleString()}`);
  if (agg.largestSell) console.log(`  largest sell: ${agg.largestSell.name} ${agg.largestSell.date} $${agg.largestSell.valueUsd.toLocaleString()}`);

  const list = await svc.getList(ticker, 10);
  console.log(`\nRecent 10 transactions:`);
  for (const t of list) {
    const v = t.transactionValue == null ? '—' : `$${t.transactionValue.toLocaleString()}`;
    console.log(`  ${t.transactionDate} ${t.transactionType.padEnd(28)} ${t.insiderName.padEnd(28)} ${t.shares.toLocaleString().padStart(12)} sh   ${v}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('try-insiders failed:', err);
  process.exit(1);
});
```

- [ ] **Step 5.5: Add `try-insiders` script to package.json**

Edit `package.json`, in the `scripts` block, add alongside the other `try-*` and `refresh-*` entries:

```json
"try-insiders": "tsx scripts/try-insiders.ts"
```

- [ ] **Step 5.6: Run all the new integration tests**

```bash
pnpm test:integration -- insiders
```

Expected: all NewsService tests + Insiders service (T4) + 5 API tests + 2 RLS tests pass.

- [ ] **Step 5.7: Commit**

```bash
git add app/api/tickers/\[symbol\]/insiders/route.ts \
        scripts/try-insiders.ts \
        package.json \
        tests/integration/api-tickers-insiders.test.ts \
        tests/integration/insider-trades-rls.test.ts
git commit -m "feat(api): insiders GET + POST routes + try-insiders smoke + RLS test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: UI components

**Files:**
- Create: `app/(app)/stock/[ticker]/_components/insider-card.tsx`
- Create: `app/(app)/stock/[ticker]/insiders/_components/insider-aggregate-panel.tsx`
- Create: `app/(app)/stock/[ticker]/insiders/_components/insider-transaction-row.tsx`
- Create: `app/(app)/stock/[ticker]/insiders/_components/insiders-view.tsx`

- [ ] **Step 6.1: Create the Overview card**

Create `app/(app)/stock/[ticker]/_components/insider-card.tsx`:

```tsx
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InsiderAggregate } from '@/lib/compute/insider-aggregate';

interface Props {
  ticker: string;
  aggregate: InsiderAggregate;
  hasAnyData: boolean;
}

function fmtShares(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M sh`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k sh`;
  return `${n.toLocaleString()} sh`;
}

function fmtDollars(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

export function InsiderCard({ ticker, aggregate, hasAnyData }: Props) {
  if (!hasAnyData) {
    return (
      <Card>
        <CardHeader><CardTitle>Insider activity</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No insider data fetched yet.{' '}
            <Link href={`/stock/${ticker}/insiders`} className="text-primary hover:underline">
              Visit the Insiders tab
            </Link>{' '}
            to refresh.
          </p>
        </CardContent>
      </Card>
    );
  }

  const netSign = aggregate.netShares > 0 ? 'text-green-600' : aggregate.netShares < 0 ? 'text-red-600' : '';
  const netPrefix = aggregate.netShares > 0 ? '+' : '';

  if (aggregate.buyCount === 0 && aggregate.sellCount === 0) {
    return (
      <Card>
        <CardHeader><CardTitle>Insider activity</CardTitle></CardHeader>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground">No open-market activity in the last 90 days.</p>
          {aggregate.lastTransactionDate && (
            <p className="text-xs text-muted-foreground">
              Last filing: <span className="font-mono">{aggregate.lastTransactionDate}</span>
            </p>
          )}
          <div className="pt-2 text-right">
            <Link href={`/stock/${ticker}/insiders`} className="text-xs text-primary hover:underline">
              See full list →
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Insider activity</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">90-day net</span>
          <span className={`font-mono tabular-nums ${netSign}`}>
            {netPrefix}{fmtShares(aggregate.netShares)}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <span className="text-muted-foreground">≈</span>
          <span className={`font-mono tabular-nums ${netSign}`}>
            {netPrefix}{fmtDollars(aggregate.netDollarValue)}
          </span>
        </div>
        <div className="text-xs text-muted-foreground pt-1">
          <span className="text-green-600 font-medium">{aggregate.uniqueBuyers}</span> buyers · {' '}
          <span className="text-red-600 font-medium">{aggregate.uniqueSellers}</span> sellers
        </div>
        {aggregate.hasClusterBuy && (
          <div className="text-xs text-green-700 font-medium">
            ⚡ Cluster buy detected
          </div>
        )}
        {aggregate.lastTransactionDate && (
          <div className="text-xs text-muted-foreground">
            Last trade: <span className="font-mono">{aggregate.lastTransactionDate}</span>
          </div>
        )}
        <div className="pt-2 text-right">
          <Link href={`/stock/${ticker}/insiders`} className="text-xs text-primary hover:underline">
            See full list →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 6.2: Create the aggregate panel**

Create `app/(app)/stock/[ticker]/insiders/_components/insider-aggregate-panel.tsx`:

```tsx
import type { InsiderAggregate } from '@/lib/compute/insider-aggregate';

interface Props {
  aggregate: InsiderAggregate;
}

function fmtDollars(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

export function InsiderAggregatePanel({ aggregate }: Props) {
  if (aggregate.buyCount === 0 && aggregate.sellCount === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{aggregate.windowDays}-day summary</h2>
        <p className="text-sm text-muted-foreground">
          No open-market transactions in the window. Awards and option exercises (if any)
          are shown in the transaction list below.
        </p>
      </section>
    );
  }

  const netSign = aggregate.netShares > 0
    ? 'text-green-600'
    : aggregate.netShares < 0
      ? 'text-red-600'
      : '';
  const netPrefix = aggregate.netShares > 0 ? '+' : '';

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{aggregate.windowDays}-day summary</h2>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <span className="text-muted-foreground">Net shares</span>
        <span className={`font-mono tabular-nums ${netSign}`}>
          {netPrefix}{aggregate.netShares.toLocaleString()} ({netPrefix}{fmtDollars(aggregate.netDollarValue)})
        </span>
        <span className="text-muted-foreground">Open-market buys</span>
        <span>{aggregate.buyCount} txns across {aggregate.uniqueBuyers} insiders</span>
        <span className="text-muted-foreground">Open-market sells</span>
        <span>{aggregate.sellCount} txns across {aggregate.uniqueSellers} insiders</span>
        {aggregate.largestBuy && (
          <>
            <span className="text-muted-foreground">Largest buy</span>
            <span className="font-mono text-xs">
              {aggregate.largestBuy.name} · {aggregate.largestBuy.date} · {fmtDollars(aggregate.largestBuy.valueUsd)}
            </span>
          </>
        )}
        {aggregate.largestSell && (
          <>
            <span className="text-muted-foreground">Largest sell</span>
            <span className="font-mono text-xs">
              {aggregate.largestSell.name} · {aggregate.largestSell.date} · {fmtDollars(aggregate.largestSell.valueUsd)}
            </span>
          </>
        )}
      </div>

      {aggregate.hasClusterBuy && (
        <div className="rounded border border-green-700/30 bg-green-700/10 p-3 text-sm">
          <div className="font-medium text-green-700">⚡ Cluster buy detected</div>
          <div className="text-xs text-muted-foreground mt-1">
            Multiple insiders made open-market purchases within a 30-day window starting on{' '}
            {aggregate.clusterBuyDates.join(', ')}. Classic high-conviction signal.
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 6.3: Create the transaction row**

Create `app/(app)/stock/[ticker]/insiders/_components/insider-transaction-row.tsx`:

```tsx
import { classifyTransaction, type TransactionClass } from '@/lib/compute/insider-aggregate';
import type { InsiderTrade } from '@/lib/services/insiders';

const GLYPHS: Record<TransactionClass, { symbol: string; color: string; label: string }> = {
  buy:      { symbol: '●', color: 'text-green-600',         label: 'BUY' },
  sell:     { symbol: '●', color: 'text-red-600',           label: 'SELL' },
  award:    { symbol: '◆', color: 'text-muted-foreground',  label: 'AWARD' },
  exercise: { symbol: '⬢', color: 'text-amber-600',         label: 'EXERCISE' },
  other:    { symbol: '○', color: 'text-muted-foreground',  label: 'OTHER' }
};

function fmtDollars(n: number | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

function fmtPrice(n: number | null): string {
  if (n == null) return '—';
  return `$${n.toFixed(2)}`;
}

export function InsiderTransactionRow({ trade }: { trade: InsiderTrade }) {
  const cls = classifyTransaction(trade.transactionType);
  const glyph = GLYPHS[cls];
  const titlePart = trade.insiderTitle
    ? trade.insiderTitle
    : trade.isBoardDirector
      ? 'Director'
      : '';

  return (
    <li className="grid grid-cols-12 items-baseline gap-3 border-b border-border py-2 text-sm last:border-0">
      <span className={`col-span-1 ${glyph.color} font-medium text-xs`}>
        {glyph.symbol} {glyph.label}
      </span>
      <span className="col-span-2 font-mono text-xs tabular-nums text-muted-foreground">
        {trade.transactionDate}
      </span>
      <span className="col-span-4 truncate">
        {trade.insiderName}
        {titlePart && <span className="text-muted-foreground"> ({titlePart})</span>}
      </span>
      <span className="col-span-2 text-right font-mono tabular-nums">
        {trade.shares.toLocaleString()} sh
      </span>
      <span className="col-span-1 text-right font-mono tabular-nums text-muted-foreground">
        {fmtPrice(trade.pricePerShare)}
      </span>
      <span className="col-span-2 text-right font-mono tabular-nums">
        {fmtDollars(trade.transactionValue)}
      </span>
    </li>
  );
}
```

- [ ] **Step 6.4: Create the view wrapper**

Create `app/(app)/stock/[ticker]/insiders/_components/insiders-view.tsx`:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { classifyTransaction, type InsiderAggregate, type TransactionClass } from '@/lib/compute/insider-aggregate';
import type { InsiderTrade } from '@/lib/services/insiders';
import { InsiderAggregatePanel } from './insider-aggregate-panel';
import { InsiderTransactionRow } from './insider-transaction-row';

type FilterMode = 'all' | 'buys-and-sells' | 'buys' | 'sells' | 'no-comp';

interface Props {
  ticker: string;
  transactions: InsiderTrade[];
  aggregate: InsiderAggregate;
}

const FILTERS: Array<{ value: FilterMode; label: string }> = [
  { value: 'buys-and-sells', label: 'Buys & sells only' },
  { value: 'all',            label: 'All transactions' },
  { value: 'buys',           label: 'Buys only' },
  { value: 'sells',          label: 'Sells only' },
  { value: 'no-comp',        label: 'Excludes compensation' }
];

function matches(cls: TransactionClass, mode: FilterMode): boolean {
  switch (mode) {
    case 'all':            return true;
    case 'buys-and-sells': return cls === 'buy' || cls === 'sell';
    case 'buys':           return cls === 'buy';
    case 'sells':          return cls === 'sell';
    case 'no-comp':        return cls !== 'award';
  }
}

export function InsidersView({ ticker, transactions, aggregate }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('buys-and-sells');

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tickers/${ticker}/insiders`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 429) setError('Refreshing too quickly — try again in a minute.');
        else {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Refresh failed (HTTP ${res.status})`);
        }
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }

  const filtered = transactions.filter((t) => matches(classifyTransaction(t.transactionType), filter));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <InsiderAggregatePanel aggregate={aggregate} />
        <Button onClick={refresh} disabled={refreshing || isPending}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-medium">All transactions</h3>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterMode)}
            className="text-xs rounded border border-border bg-background px-2 py-1"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {transactions.length === 0
              ? 'No transactions fetched yet. Click Refresh to pull from SEC Form 4 filings.'
              : 'No transactions match the current filter.'}
          </p>
        ) : (
          <ul className="space-y-0">
            {filtered.map((t) => (
              <InsiderTransactionRow key={t.id} trade={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 6.5: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: clean.

- [ ] **Step 6.6: Commit**

```bash
git add "app/(app)/stock/[ticker]/_components/insider-card.tsx" \
        "app/(app)/stock/[ticker]/insiders/_components/"
git commit -m "feat(insiders): InsiderCard + AggregatePanel + TransactionRow + InsidersView

InsiderCard: Overview compact summary with 90-day net + cluster badge.
AggregatePanel: full breakdown + largest buy/sell + cluster callout box.
TransactionRow: glyph-classified row (BUY/SELL/AWARD/EXERCISE/OTHER).
InsidersView: client wrapper with refresh button + filter dropdown.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Insiders page + Overview integration + tab nav

**Files:**
- Create: `app/(app)/stock/[ticker]/insiders/page.tsx`
- Modify: `app/(app)/stock/[ticker]/page.tsx` (add InsiderCard to grid)
- Modify: `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` (add 'insiders' tab)

- [ ] **Step 7.1: Create the insiders server page**

Create `app/(app)/stock/[ticker]/insiders/page.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { loadServerEnv } from '@/lib/env';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { InsidersView } from './_components/insiders-view';

interface PageProps {
  params: { ticker: string };
}

export default async function InsidersPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const env = loadServerEnv();
  const svc = new InsidersService({
    db: getServiceDb(),
    fdProvider: new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY })
  });

  const [transactions, aggregate] = await Promise.all([
    svc.getList(ticker, 100),
    svc.getAggregate(ticker, 90)
  ]);

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <DashboardTabs ticker={ticker} active="insiders" />
      </div>

      <Card>
        <CardHeader><CardTitle>Insider Activity</CardTitle></CardHeader>
        <CardContent>
          <InsidersView ticker={ticker} transactions={transactions} aggregate={aggregate} />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 7.2: Add `'insiders'` to dashboard tabs**

Open `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`.

Current `DashboardTab` union:

```tsx
export type DashboardTab =
  | 'overview'
  | 'financials'
  | 'technical'
  | 'news'
  | 'filings'
  | 'quality'
  | 'ask';
```

Add `'insiders'`. Tab order: place it after `'news'` (catalyst-ish content lives together):

```tsx
export type DashboardTab =
  | 'overview'
  | 'financials'
  | 'technical'
  | 'news'
  | 'insiders'
  | 'filings'
  | 'quality'
  | 'ask';
```

In the `TABS` array, insert a new entry after the News entry:

```tsx
{ value: 'insiders',   label: 'Insiders',   href: (t) => `/stock/${t}/insiders` },
```

Final array should match this order: Overview, Financials, Technical, News, Insiders, Filings, Quality, Ask.

- [ ] **Step 7.3: Slot `<InsiderCard>` into the Overview grid**

Open `app/(app)/stock/[ticker]/page.tsx`. The current grid for sibling cards is:

```tsx
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
  <GrowthCard growth={growthSummary} />
  <EarningsCard ticker={ticker} />
  <QualityCard ticker={ticker} quality={quality} />
</div>
```

We need to add `<InsiderCard>`. Three options:
1. Wrap to a new row with just InsiderCard
2. Expand the existing row to `lg:grid-cols-4`
3. Push Quality to its own row, add Insider next to Growth+Earnings

Option 2 makes the row cramped on smaller `lg` screens; option 3 splits siblings inconsistently. Option 1 is cleanest — wrap to a new row:

Add the import:

```tsx
import { InsiderCard } from './_components/insider-card';
```

Add the data load. Find the existing `Promise.all` block (the one that loads snapshot/prices/incomeBundle/etc.) and add InsidersService loads to it:

```tsx
import { InsidersService } from '@/lib/services/insiders';
```

Update the `Promise.all` to add insider list + aggregate (matching the catch-fallback pattern of siblings):

```tsx
const insidersSvc = new InsidersService({
  db,
  fdProvider: fd
});

const [snapshot, prices5Y, incomeBundle, balanceBundle, cashFlowBundle, quality, insiderAggregate, insiderHasData] = await Promise.all([
  snapshotSvc.get(ticker).catch(() => null),
  pricesSvc.get(ticker, '5Y').catch(() => []),
  financialsSvc.get(ticker, 'income', 'annual').catch(() => ({ ticker, statementType: 'income' as const, periodType: 'annual' as const, rows: [] })),
  financialsSvc.get(ticker, 'balance', 'annual').catch(() => ({ ticker, statementType: 'balance' as const, periodType: 'annual' as const, rows: [] })),
  financialsSvc.get(ticker, 'cash_flow', 'annual').catch(() => ({ ticker, statementType: 'cash_flow' as const, periodType: 'annual' as const, rows: [] })),
  loadQuality(db, ticker).catch(() => ({ current: { piotroskiF: null, altmanZ: null, beneishM: null }, trend: [] })),
  insidersSvc.getAggregate(ticker, 90).catch(() => ({
    windowDays: 90, netShares: 0, netDollarValue: 0,
    buyCount: 0, sellCount: 0, uniqueBuyers: 0, uniqueSellers: 0,
    largestBuy: null, largestSell: null,
    hasClusterBuy: false, clusterBuyDates: [], lastTransactionDate: null
  })),
  insidersSvc.getList(ticker, 1).then((rows) => rows.length > 0).catch(() => false)
]);
```

Then in the JSX, after the existing 3-card row, add a new row with InsiderCard. The new row should span the same grid (use `lg:col-span-1` so it occupies one cell of a 3-col grid, leaving room to add 2 more cards later):

```tsx
<div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
  <InsiderCard ticker={ticker} aggregate={insiderAggregate} hasAnyData={insiderHasData} />
</div>
```

- [ ] **Step 7.4: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

All expected: clean.

- [ ] **Step 7.5: Commit**

```bash
git add "app/(app)/stock/[ticker]/insiders/page.tsx" \
        "app/(app)/stock/[ticker]/page.tsx" \
        "app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx"
git commit -m "feat(insiders): /insiders page + Overview card + tab nav

8-tab dashboard nav: Overview / Financials / Technical / News /
Insiders / Filings / Quality / Ask.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Push + CI + populate + browser smoke

**Files:** None modified; rollout task.

- [ ] **Step 8.1: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

- [ ] **Step 8.2: Verify CI**

```bash
gh run list --limit 1 --json status,databaseId,headSha
```

Note the run id.

- [ ] **Step 8.3: Watch CI**

```bash
gh run watch <run-id> --exit-status
```

Expected: exits 0, all jobs green.

- [ ] **Step 8.4: Populate insiders for all 6 tickers via the smoke script**

```bash
for t in AAPL NVDA MSFT GOOGL JD TSLA; do echo "=== $t ==="; pnpm try-insiders $t 2>&1 | tail -20; done
```

Expected per ticker: fetched count > 0 (some tickers have many insider transactions, some few — JD as an ADR may have few since SEC Form 4 mostly applies to US-listed companies' insiders). Most tickers should show a 90-day summary, recent transactions, and possibly a cluster buy flag.

- [ ] **Step 8.5: Browser smoke**

Wait ~30s for Vercel deploy, then in the browser:

1. https://equity-research-workbench-mauve.vercel.app/stock/AAPL — Overview should show an **Insider activity** card on its own row (below Growth/Earnings/Quality)
2. https://equity-research-workbench-mauve.vercel.app/stock/AAPL/insiders — tab page with aggregate panel + transaction list with glyph-classified rows
3. Test the filter dropdown — switch between All / Buys & sells / Buys only / Sells only / No-comp
4. Click the **Refresh** button — should complete within ~5s
5. Verify the 8-tab nav now shows: Overview · Financials · Technical · News · **Insiders** · Filings · Quality · Ask
6. Repeat for NVDA / MSFT / GOOGL / JD / TSLA

For tickers with no recent open-market activity, expect the "No open-market activity in the last 90 days" empty state with a "Last filing" date.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| `insider_trades` table + RLS + composite dedupe key | T1 |
| Drizzle schema in sync | T1.6 |
| `FinancialDatasetsProvider.insiderTrades()` method | T2 |
| `InsiderTradeMeta` interface | T2 |
| FD fixture | T2 |
| `classifyTransaction` 5-bucket classifier | T3 |
| `computeInsiderAggregate` over rows + window | T3 |
| Cluster-buy detection (Lakonishok-Lee) | T3 |
| Open-market filter for net buy/sell signal | T3 (classifyTransaction → buys + sells only) |
| Largest buy / largest sell extraction | T3 |
| `InsidersService` (refresh / getList / getAggregate) | T4 |
| Idempotent refresh via composite key | T4 |
| `refresh_runs` row with kind='insiders' | T4 |
| GET + POST `/api/tickers/[symbol]/insiders` | T5 |
| Rate limit 10/min/user | T5 |
| `pnpm try-insiders <TICKER>` smoke script | T5 |
| RLS smoke test (authenticated SELECT works, INSERT denied) | T5 |
| `<InsiderCard>` Overview compact summary | T6 |
| `<InsiderAggregatePanel>` full breakdown + cluster callout | T6 |
| `<InsiderTransactionRow>` with glyph + classification | T6 |
| Filter dropdown (All / B&S / Buys / Sells / No-comp) | T6 |
| `<InsidersView>` client wrapper with refresh button | T6 |
| `/stock/[ticker]/insiders` server page | T7 |
| Tab nav update (1-file thanks to shared DashboardTabs) | T7 |
| Overview grid integration | T7 |
| Push + CI + populate + browser smoke | T8 |

All requirements have a task. No gaps.
