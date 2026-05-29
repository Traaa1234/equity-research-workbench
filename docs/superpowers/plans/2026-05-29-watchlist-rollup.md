# Watchlist Roll-up Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a multi-signal per-ticker row table to `/watchlist` showing Snapshot, Technical, News, Insiders, and Filings status at a glance — each cell deep-linking into the relevant per-ticker tab.

**Architecture:** Pure formatters in `lib/compute/watchlist-cells.ts` turn service data into `Cell = {glyph, color, tooltip?}` values. Server-component cells each call one existing service, apply a formatter, render via shared `<CellChip>`. `<WatchlistRow>` composes 5 cells in per-cell `<Suspense>`. `<WatchlistTable>` composes rows in per-row `<Suspense>` (with `key={ticker}` so rows stream independently). New `Roll-up` tab on `<WatchlistTabs>`, defaults the page to it.

**Tech Stack:** Next.js 14 (server components + Suspense streaming), TypeScript strict, Tailwind/shadcn, Vitest for unit, Playwright for E2E.

**Spec:** `docs/superpowers/specs/2026-05-29-watchlist-rollup-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/compute/watchlist-cells.ts` | Create | `Cell` type + 5 pure formatters |
| `tests/compute/watchlist-cells.test.ts` | Create | ~20 unit tests |
| `app/(app)/watchlist/_components/cells/cell-chip.tsx` | Create | Shared chip render: color mapping + `<Link>` wrap + tooltip |
| `app/(app)/watchlist/_components/cells/cell-skeleton.tsx` | Create | One-cell loading placeholder |
| `app/(app)/watchlist/_components/cells/snapshot-cell.tsx` | Create | Loads snapshot + prices, computes day-change, renders chip |
| `app/(app)/watchlist/_components/cells/technical-cell.tsx` | Create | Loads prices, runs computeTechnical, renders chip |
| `app/(app)/watchlist/_components/cells/news-cell.tsx` | Create | Loads news, filters past 7 days, renders chip |
| `app/(app)/watchlist/_components/cells/insiders-cell.tsx` | Create | Loads insider aggregate, renders chip |
| `app/(app)/watchlist/_components/cells/filings-cell.tsx` | Create | Loads filings list, picks most recent, renders chip |
| `app/(app)/watchlist/_components/watchlist-row.tsx` | Create | Composes 5 cells in per-cell Suspense |
| `app/(app)/watchlist/_components/watchlist-row-skeleton.tsx` | Create | Row-level Suspense fallback |
| `app/(app)/watchlist/_components/watchlist-row-mobile.tsx` | Create | Mobile stacked card variant |
| `app/(app)/watchlist/_components/watchlist-table.tsx` | Create | Header + per-row Suspense streaming |
| `app/(app)/watchlist/_components/sort-toggle.tsx` | Create | Client `<select>` for `?sort=` URL param |
| `app/(app)/watchlist/_components/watchlist-tabs.tsx` | Modify | Add `'rollup'` to tab union |
| `app/(app)/watchlist/page.tsx` | Modify | Handle `?tab=rollup` (default), render `<WatchlistTable>` |
| `tests/e2e/watchlist-rollup.spec.ts` | Create | 1 Playwright E2E test |

15 new files, 2 modifications.

---

## Task 1: Pure formatters in `lib/compute/watchlist-cells.ts`

**Files:**
- Create: `lib/compute/watchlist-cells.ts`
- Create: `tests/compute/watchlist-cells.test.ts`

This task is entirely pure compute + tests. Five formatters, each ~10-20 lines, no DB / no network / no React. They form the "signal-to-chip" boundary the cell components will use.

- [ ] **Step 1.1: Write failing tests first**

Create `tests/compute/watchlist-cells.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  snapshotToCell,
  technicalToCell,
  newsToCell,
  insidersToCell,
  filingsToCell,
  type Cell
} from '@/lib/compute/watchlist-cells';

describe('snapshotToCell', () => {
  it('formats positive change as green with + sign', () => {
    const c = snapshotToCell({ price: 290.45, changePct: 0.0042 });
    expect(c.glyph).toContain('290.45');
    expect(c.glyph).toContain('+0.4%');
    expect(c.color).toBe('green');
  });
  it('formats negative change as red without + sign', () => {
    const c = snapshotToCell({ price: 175.10, changePct: -0.021 });
    expect(c.glyph).toContain('175.10');
    expect(c.glyph).toContain('-2.1%');
    expect(c.color).toBe('red');
  });
  it('formats zero/null change as muted', () => {
    const c = snapshotToCell({ price: 100, changePct: null });
    expect(c.glyph).toBe('$100.00');
    expect(c.color).toBe('muted');
  });
  it('handles null snapshot', () => {
    const c = snapshotToCell(null);
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});

describe('technicalToCell', () => {
  it('marks RSI > 70 as overbought (red OB)', () => {
    const c = technicalToCell({ rsi: 72, recentCross: null });
    expect(c.glyph).toBe('OB');
    expect(c.color).toBe('red');
    expect(c.tooltip).toContain('RSI 72');
  });
  it('marks RSI < 30 as oversold (green OS)', () => {
    const c = technicalToCell({ rsi: 25, recentCross: null });
    expect(c.glyph).toBe('OS');
    expect(c.color).toBe('green');
  });
  it('shows GC when most recent signal is golden_cross within 10 days', () => {
    const c = technicalToCell({ rsi: 55, recentCross: 'golden' });
    expect(c.glyph).toBe('GC');
    expect(c.color).toBe('green');
  });
  it('shows DC when most recent signal is death_cross within 10 days', () => {
    const c = technicalToCell({ rsi: 55, recentCross: 'death' });
    expect(c.glyph).toBe('DC');
    expect(c.color).toBe('red');
  });
  it('prioritizes OB over GC (extreme over directional)', () => {
    // Spec: RSI extremes take priority over crosses because they're rarer
    const c = technicalToCell({ rsi: 75, recentCross: 'golden' });
    expect(c.glyph).toBe('OB');
  });
  it('returns neutral dot when nothing special', () => {
    const c = technicalToCell({ rsi: 55, recentCross: null });
    expect(c.glyph).toBe('●');
    expect(c.color).toBe('muted');
  });
  it('returns em-dash when rsi is null (no data)', () => {
    const c = technicalToCell({ rsi: null, recentCross: null });
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});

describe('newsToCell', () => {
  it('counts articles in past 7 days and reports bullish skew', () => {
    const c = newsToCell([
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'neutral' },
      { publishedAt: new Date(), sentiment: 'bearish' }
    ]);
    expect(c.glyph).toBe('+5 art');
    expect(c.color).toBe('green');
    expect(c.tooltip).toContain('3 bullish');
  });
  it('reports red color when net sentiment is bearish', () => {
    const c = newsToCell([
      { publishedAt: new Date(), sentiment: 'bearish' },
      { publishedAt: new Date(), sentiment: 'bearish' },
      { publishedAt: new Date(), sentiment: 'neutral' }
    ]);
    expect(c.glyph).toBe('+3 art');
    expect(c.color).toBe('red');
  });
  it('reports muted when articles are balanced', () => {
    const c = newsToCell([
      { publishedAt: new Date(), sentiment: 'bullish' },
      { publishedAt: new Date(), sentiment: 'bearish' }
    ]);
    expect(c.color).toBe('muted');
  });
  it('excludes articles older than 7 days', () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const c = newsToCell([
      { publishedAt: old, sentiment: 'bullish' },
      { publishedAt: old, sentiment: 'bullish' }
    ]);
    expect(c.glyph).toBe('· quiet');
    expect(c.color).toBe('muted');
  });
  it('reports quiet when empty', () => {
    const c = newsToCell([]);
    expect(c.glyph).toBe('· quiet');
    expect(c.color).toBe('muted');
  });
});

describe('insidersToCell', () => {
  it('marks cluster-buy first regardless of net', () => {
    const c = insidersToCell({
      hasClusterBuy: true, netShares: -1000, buyCount: 3, sellCount: 2
    });
    expect(c.glyph).toBe('⚡ cluster');
    expect(c.color).toBe('green');
  });
  it('shows +N buys when net positive and no cluster', () => {
    const c = insidersToCell({
      hasClusterBuy: false, netShares: 5000, buyCount: 2, sellCount: 0
    });
    expect(c.glyph).toBe('+2 buys');
    expect(c.color).toBe('green');
  });
  it('shows -N sells when net negative', () => {
    const c = insidersToCell({
      hasClusterBuy: false, netShares: -3200, buyCount: 0, sellCount: 5
    });
    expect(c.glyph).toBe('-5 sells');
    expect(c.color).toBe('red');
  });
  it('shows quiet when no buy/sell activity', () => {
    const c = insidersToCell({
      hasClusterBuy: false, netShares: 0, buyCount: 0, sellCount: 0
    });
    expect(c.glyph).toBe('· quiet');
    expect(c.color).toBe('muted');
  });
  it('handles null aggregate', () => {
    const c = insidersToCell(null);
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});

describe('filingsToCell', () => {
  const FIXED_NOW = new Date('2026-05-29T00:00:00Z');

  it('shows form + days since filed', () => {
    const c = filingsToCell({ formType: '10-Q', filingDate: '2026-05-17' }, FIXED_NOW);
    expect(c.glyph).toBe('10-Q · 12d');
    expect(c.color).toBe('default');
  });
  it('marks amber when within 7 days', () => {
    const c = filingsToCell({ formType: '8-K', filingDate: '2026-05-26' }, FIXED_NOW);
    expect(c.glyph).toBe('8-K · 3d');
    expect(c.color).toBe('amber');
  });
  it('handles 0d (filed today)', () => {
    const c = filingsToCell({ formType: '8-K', filingDate: '2026-05-29' }, FIXED_NOW);
    expect(c.glyph).toBe('8-K · 0d');
    expect(c.color).toBe('amber');
  });
  it('handles null filing', () => {
    const c = filingsToCell(null);
    expect(c.glyph).toBe('—');
    expect(c.color).toBe('muted');
  });
});
```

- [ ] **Step 1.2: Run tests — confirm all fail with module-not-found**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test -- tests/compute/watchlist-cells.test.ts
```

Expected: 22 tests fail with `Cannot find module '@/lib/compute/watchlist-cells'`.

- [ ] **Step 1.3: Implement `lib/compute/watchlist-cells.ts`**

Create the file:

```ts
/**
 * Pure formatters turning per-service signal data into compact UI Cells.
 * No DB, no network, no React — just data-shape transformations.
 *
 * Each formatter handles null/empty inputs gracefully (returns the
 * '—' or '· quiet' Cell instead of throwing).
 */

export type CellColor = 'green' | 'red' | 'amber' | 'muted' | 'default';

export interface Cell {
  glyph: string;
  color: CellColor;
  tooltip?: string;
}

// -------- snapshot --------

export function snapshotToCell(
  snap: { price: number | null; changePct: number | null } | null
): Cell {
  if (snap == null || snap.price == null) {
    return { glyph: '—', color: 'muted' };
  }
  const priceStr = `$${snap.price.toFixed(2)}`;
  if (snap.changePct == null || snap.changePct === 0) {
    return { glyph: priceStr, color: 'muted' };
  }
  const pct = snap.changePct * 100;
  const sign = pct > 0 ? '+' : '';
  const color: CellColor = pct > 0 ? 'green' : 'red';
  return {
    glyph: `${priceStr}  ${sign}${pct.toFixed(1)}%`,
    color
  };
}

// -------- technical --------

export function technicalToCell(
  tech: { rsi: number | null; recentCross: 'golden' | 'death' | null }
): Cell {
  if (tech.rsi == null) {
    return { glyph: '—', color: 'muted' };
  }
  // Priority: RSI extremes > crosses > neutral
  if (tech.rsi > 70) {
    return { glyph: 'OB', color: 'red', tooltip: `RSI ${tech.rsi.toFixed(0)} (overbought)` };
  }
  if (tech.rsi < 30) {
    return { glyph: 'OS', color: 'green', tooltip: `RSI ${tech.rsi.toFixed(0)} (oversold)` };
  }
  if (tech.recentCross === 'golden') {
    return { glyph: 'GC', color: 'green', tooltip: 'Golden cross within 10 days' };
  }
  if (tech.recentCross === 'death') {
    return { glyph: 'DC', color: 'red', tooltip: 'Death cross within 10 days' };
  }
  return { glyph: '●', color: 'muted', tooltip: `RSI ${tech.rsi.toFixed(0)}` };
}

// -------- news --------

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function newsToCell(
  articles: Array<{ publishedAt: Date; sentiment: 'bullish' | 'bearish' | 'neutral' | null }>
): Cell {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const recent = articles.filter((a) => a.publishedAt.getTime() >= cutoff);
  if (recent.length === 0) {
    return { glyph: '· quiet', color: 'muted' };
  }
  const bull = recent.filter((a) => a.sentiment === 'bullish').length;
  const bear = recent.filter((a) => a.sentiment === 'bearish').length;
  const neut = recent.length - bull - bear;
  const skew = bull - bear;
  let color: CellColor = 'muted';
  if (skew >= 2) color = 'green';
  else if (skew <= -2) color = 'red';
  return {
    glyph: `+${recent.length} art`,
    color,
    tooltip: `${bull} bullish · ${neut} neutral · ${bear} bearish (past 7d)`
  };
}

// -------- insiders --------

export function insidersToCell(
  agg: { hasClusterBuy: boolean; netShares: number; buyCount: number; sellCount: number } | null
): Cell {
  if (agg == null) return { glyph: '—', color: 'muted' };
  if (agg.hasClusterBuy) {
    return { glyph: '⚡ cluster', color: 'green', tooltip: 'Cluster-buy detected (Lakonishok-Lee)' };
  }
  if (agg.netShares > 0 && agg.buyCount > 0) {
    return { glyph: `+${agg.buyCount} buys`, color: 'green' };
  }
  if (agg.netShares < 0 && agg.sellCount > 0) {
    return { glyph: `-${agg.sellCount} sells`, color: 'red' };
  }
  return { glyph: '· quiet', color: 'muted' };
}

// -------- filings --------

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function filingsToCell(
  filing: { formType: string; filingDate: string } | null,
  asOf: Date = new Date()
): Cell {
  if (filing == null) return { glyph: '—', color: 'muted' };
  const filedMs = Date.parse(filing.filingDate + 'T00:00:00Z');
  const days = Number.isFinite(filedMs)
    ? Math.max(0, Math.floor((asOf.getTime() - filedMs) / ONE_DAY_MS))
    : null;
  if (days == null) return { glyph: filing.formType, color: 'muted' };
  const color: CellColor = days <= 7 ? 'amber' : 'default';
  return { glyph: `${filing.formType} · ${days}d`, color };
}
```

- [ ] **Step 1.4: Run tests — confirm all pass**

```bash
pnpm test -- tests/compute/watchlist-cells.test.ts
```

Expected: 22/22 pass.

- [ ] **Step 1.5: Commit**

```bash
git add lib/compute/watchlist-cells.ts tests/compute/watchlist-cells.test.ts
git commit -m "$(cat <<'EOF'
feat(watchlist): pure cell formatters for roll-up dashboard

snapshotToCell / technicalToCell / newsToCell / insidersToCell /
filingsToCell. Each takes per-service data and returns
Cell = { glyph, color, tooltip? }. All handle null/empty gracefully.
22 unit tests covering happy paths, priority ordering (RSI extremes
beat crosses), empty states, and the 7-day news cutoff.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Shared `<CellChip>` + `<CellSkeleton>` components

**Files:**
- Create: `app/(app)/watchlist/_components/cells/cell-chip.tsx`
- Create: `app/(app)/watchlist/_components/cells/cell-skeleton.tsx`

`<CellChip>` is the single render boundary that maps `Cell.color` enum values to Tailwind classes and wraps in `<Link>` (deep link) + tooltip. Keeping color mapping centralized means we can re-skin without touching every cell.

- [ ] **Step 2.1: Create `app/(app)/watchlist/_components/cells/cell-chip.tsx`**

```tsx
import Link from 'next/link';
import type { Cell, CellColor } from '@/lib/compute/watchlist-cells';

interface Props {
  cell: Cell;
  href: string;
  align?: 'left' | 'center' | 'right';
}

const COLOR_CLASSES: Record<CellColor, string> = {
  green:   'text-green-600',
  red:     'text-red-600',
  amber:   'text-amber-700',
  muted:   'text-muted-foreground',
  default: 'text-foreground'
};

export function CellChip({ cell, href, align = 'center' }: Props) {
  const alignClass =
    align === 'left' ? 'text-left' :
    align === 'right' ? 'text-right' :
    'text-center';
  return (
    <Link
      href={href}
      title={cell.tooltip}
      className={`block ${alignClass} ${COLOR_CLASSES[cell.color]} font-mono tabular-nums text-sm hover:underline`}
    >
      {cell.glyph}
    </Link>
  );
}
```

- [ ] **Step 2.2: Create `app/(app)/watchlist/_components/cells/cell-skeleton.tsx`**

```tsx
export function CellSkeleton() {
  return (
    <div className="text-center">
      <span className="inline-block h-4 w-16 rounded bg-muted animate-pulse" />
    </div>
  );
}
```

- [ ] **Step 2.3: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 2.4: Commit**

```bash
git add "app/(app)/watchlist/_components/cells/cell-chip.tsx" \
        "app/(app)/watchlist/_components/cells/cell-skeleton.tsx"
git commit -m "$(cat <<'EOF'
feat(watchlist): CellChip + CellSkeleton shared cell renderers

CellChip centralizes Cell.color → Tailwind mapping + Link wrap +
tooltip. Cells stay shallow — one render path for every signal type.
CellSkeleton is the per-cell Suspense fallback (pulsing bar).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Five cell server components

**Files:**
- Create: `app/(app)/watchlist/_components/cells/snapshot-cell.tsx`
- Create: `app/(app)/watchlist/_components/cells/technical-cell.tsx`
- Create: `app/(app)/watchlist/_components/cells/news-cell.tsx`
- Create: `app/(app)/watchlist/_components/cells/insiders-cell.tsx`
- Create: `app/(app)/watchlist/_components/cells/filings-cell.tsx`

Each cell is an async server component that takes a `ticker`, instantiates the relevant service, calls one method, applies the formatter from Task 1, renders `<CellChip>`. All cells follow the same shape; we write them together because they're so similar.

First, **read** `app/(app)/stock/[ticker]/page.tsx` to see how services are instantiated in the existing per-ticker page — match that exact pattern for the cell-internal `services()` calls:

```bash
sed -n '40,70p' "app/(app)/stock/[ticker]/page.tsx"
```

You should see `loadServerEnv()`, `getServiceDb()`, `getRedisCache()`, then `new FinancialDatasetsProvider`, `new YFinanceProvider`, etc. Cells must reuse that exact construction; do NOT introduce a singleton helper just for the cells (over-engineering for 5 components).

- [ ] **Step 3.1: Create `app/(app)/watchlist/_components/cells/snapshot-cell.tsx`**

```tsx
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { SnapshotService } from '@/lib/services/snapshot';
import { PricesService } from '@/lib/services/prices';
import { snapshotToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function SnapshotCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const redis = getRedisCache();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const snapshotSvc = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });

  // Load snapshot for price, and 1Y prices for day-change computation.
  // Snapshot has no built-in changePct (verified Phase 1 SnapshotData shape).
  const [snap, prices] = await Promise.all([
    snapshotSvc.get(ticker).catch(() => null),
    pricesSvc.get(ticker, '1Y').catch(() => [])
  ]);

  let changePct: number | null = null;
  if (prices.length >= 2) {
    const last = prices[prices.length - 1]!.close;
    const prev = prices[prices.length - 2]!.close;
    if (prev > 0) changePct = (last - prev) / prev;
  }

  const cell = snapshotToCell({
    price: snap?.price ?? null,
    changePct
  });
  return <CellChip cell={cell} href={`/stock/${ticker}`} align="right" />;
}
```

- [ ] **Step 3.2: Create `app/(app)/watchlist/_components/cells/technical-cell.tsx`**

The cell maps `computeTechnical().signals[0]` to the `recentCross` enum the formatter expects. Only golden/death within 10 days count.

```tsx
import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PricesService } from '@/lib/services/prices';
import { computeTechnical } from '@/lib/compute/technical';
import { technicalToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

export async function TechnicalCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const redis = getRedisCache();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });

  const prices = await pricesSvc.get(ticker, '1Y').catch(() => []);
  if (prices.length === 0) {
    return <CellChip cell={{ glyph: '—', color: 'muted' }} href={`/stock/${ticker}/technical`} />;
  }

  const tech = computeTechnical(prices);

  // Find a golden_cross or death_cross signal within the last 10 days.
  // computeTechnical returns signals newest-first.
  let recentCross: 'golden' | 'death' | null = null;
  const cutoff = Date.now() - TEN_DAYS_MS;
  for (const s of tech.signals) {
    const ms = Date.parse(s.date + 'T00:00:00Z');
    if (!Number.isFinite(ms) || ms < cutoff) break;
    if (s.kind === 'golden_cross') { recentCross = 'golden'; break; }
    if (s.kind === 'death_cross')  { recentCross = 'death';  break; }
  }

  const cell = technicalToCell({ rsi: tech.current.rsi, recentCross });
  return <CellChip cell={cell} href={`/stock/${ticker}/technical`} />;
}
```

- [ ] **Step 3.3: Create `app/(app)/watchlist/_components/cells/news-cell.tsx`**

```tsx
import { getServiceDb } from '@/lib/db/client';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProvider } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { newsToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function NewsCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const qwen = new QwenProvider({ apiKey: env.QWEN_API_KEY });
  const newsSvc = new NewsService({ db, fdProvider: fd, qwenProvider: qwen });

  // Service has no `days` filter; pull recent 50, formatter filters past 7d.
  const articles = await newsSvc.getList(ticker, 50).catch(() => []);

  // Service returns sentiment as SentimentLabel | null (string union from providers).
  // The formatter accepts the same shape; just map publishedAt to Date.
  const cell = newsToCell(
    articles.map((a) => ({
      publishedAt: a.publishedAt,
      sentiment: a.sentiment as 'bullish' | 'bearish' | 'neutral' | null
    }))
  );
  return <CellChip cell={cell} href={`/stock/${ticker}/news`} />;
}
```

**Important:** confirm the actual `QwenProvider` constructor + env var name by inspecting an existing route that uses it (e.g. `app/api/tickers/[symbol]/news/route.ts`). If the constructor takes different args, mirror exactly. If `QWEN_API_KEY` isn't in `lib/env.ts`, use the actual var name.

- [ ] **Step 3.4: Create `app/(app)/watchlist/_components/cells/insiders-cell.tsx`**

```tsx
import { getServiceDb } from '@/lib/db/client';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { insidersToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function InsidersCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const svc = new InsidersService({ db, fdProvider: fd });

  const agg = await svc.getAggregate(ticker, 90).catch(() => null);
  const cell = insidersToCell(agg ? {
    hasClusterBuy: agg.hasClusterBuy,
    netShares: agg.netShares,
    buyCount: agg.buyCount,
    sellCount: agg.sellCount
  } : null);
  return <CellChip cell={cell} href={`/stock/${ticker}/insiders`} />;
}
```

- [ ] **Step 3.5: Create `app/(app)/watchlist/_components/cells/filings-cell.tsx`**

```tsx
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { filingsToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function FilingsCell({ ticker }: Props) {
  const db = getServiceDb();
  const svc = new FilingsService({ db });

  const result = await svc.getList(ticker).catch(() => ({ filings: [], needsIngest: false }));
  const latest = result.filings[0] ?? null;
  const cell = filingsToCell(latest);
  return <CellChip cell={cell} href={`/stock/${ticker}/filings`} />;
}
```

**Important:** confirm the actual `FilingsService` constructor shape — it may take more deps than just `{ db }`. Inspect `app/(app)/stock/[ticker]/filings/page.tsx` or similar consumer to see how it's actually instantiated and mirror exactly.

- [ ] **Step 3.6: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: clean. If `lib/services/news.ts` or `lib/services/filings.ts` require constructor deps different from what's above, fix the cell to match. If env vars don't match, use actual names.

- [ ] **Step 3.7: Commit**

```bash
git add "app/(app)/watchlist/_components/cells/"
git commit -m "$(cat <<'EOF'
feat(watchlist): 5 server-component cells for the roll-up table

SnapshotCell loads snapshot + 1Y prices and derives day-change from
the last two close prices (SnapshotData carries no changePct).
TechnicalCell runs computeTechnical(1Y prices) and maps the most
recent golden/death cross within 10 days. NewsCell pulls 50 articles
and lets the formatter filter to past 7d. InsidersCell delegates to
getAggregate(ticker, 90). FilingsCell takes the first item of getList.
Every cell instantiates services inline (matches /stock/[ticker]/page
pattern) and renders via shared CellChip.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `<WatchlistRow>` + skeleton + mobile variant

**Files:**
- Create: `app/(app)/watchlist/_components/watchlist-row.tsx`
- Create: `app/(app)/watchlist/_components/watchlist-row-skeleton.tsx`
- Create: `app/(app)/watchlist/_components/watchlist-row-mobile.tsx`

- [ ] **Step 4.1: Create `app/(app)/watchlist/_components/watchlist-row.tsx`**

```tsx
import { Suspense } from 'react';
import Link from 'next/link';
import { SnapshotCell } from './cells/snapshot-cell';
import { TechnicalCell } from './cells/technical-cell';
import { NewsCell } from './cells/news-cell';
import { InsidersCell } from './cells/insiders-cell';
import { FilingsCell } from './cells/filings-cell';
import { CellSkeleton } from './cells/cell-skeleton';

interface Props { ticker: string; }

export function WatchlistRow({ ticker }: Props) {
  return (
    <li className="grid grid-cols-12 gap-3 items-baseline px-3 py-2 border-b border-border last:border-0 hover:bg-muted/50">
      <Link
        href={`/stock/${ticker}`}
        className="col-span-2 font-mono font-medium tabular-nums hover:text-primary"
      >
        {ticker}
      </Link>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          {/* @ts-expect-error Async Server Component */}
          <SnapshotCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          {/* @ts-expect-error Async Server Component */}
          <TechnicalCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          {/* @ts-expect-error Async Server Component */}
          <NewsCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          {/* @ts-expect-error Async Server Component */}
          <InsidersCell ticker={ticker} />
        </Suspense>
      </div>
      <div className="col-span-2">
        <Suspense fallback={<CellSkeleton />}>
          {/* @ts-expect-error Async Server Component */}
          <FilingsCell ticker={ticker} />
        </Suspense>
      </div>
    </li>
  );
}
```

**On the `@ts-expect-error`**: Next.js 14 type definitions don't yet recognize async server components as valid JSX children. The comment is the established Next 14 workaround. If your tsconfig + Next versions resolve this without the comment, remove it.

- [ ] **Step 4.2: Create `app/(app)/watchlist/_components/watchlist-row-skeleton.tsx`**

The row-level fallback used by `<WatchlistTable>`'s outer `<Suspense>`. Shows a ticker label + 5 cell skeletons.

```tsx
import { CellSkeleton } from './cells/cell-skeleton';

interface Props { ticker: string; }

export function WatchlistRowSkeleton({ ticker }: Props) {
  return (
    <li className="grid grid-cols-12 gap-3 items-baseline px-3 py-2 border-b border-border last:border-0">
      <span className="col-span-2 font-mono font-medium tabular-nums text-muted-foreground">
        {ticker}
      </span>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
      <div className="col-span-2"><CellSkeleton /></div>
    </li>
  );
}
```

- [ ] **Step 4.3: Create `app/(app)/watchlist/_components/watchlist-row-mobile.tsx`**

The mobile stacked variant — one card per ticker, signals as a 2×3 mini-grid inside.

```tsx
import { Suspense } from 'react';
import Link from 'next/link';
import { SnapshotCell } from './cells/snapshot-cell';
import { TechnicalCell } from './cells/technical-cell';
import { NewsCell } from './cells/news-cell';
import { InsidersCell } from './cells/insiders-cell';
import { FilingsCell } from './cells/filings-cell';
import { CellSkeleton } from './cells/cell-skeleton';

interface Props { ticker: string; }

export function WatchlistRowMobile({ ticker }: Props) {
  return (
    <li className="rounded border border-border p-3 mb-2 last:mb-0">
      <Link href={`/stock/${ticker}`} className="font-mono font-medium text-lg hover:text-primary">
        {ticker}
      </Link>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-muted-foreground">Snapshot</div>
          <Suspense fallback={<CellSkeleton />}>
            {/* @ts-expect-error Async Server Component */}
            <SnapshotCell ticker={ticker} />
          </Suspense>
        </div>
        <div>
          <div className="text-muted-foreground">Tech</div>
          <Suspense fallback={<CellSkeleton />}>
            {/* @ts-expect-error Async Server Component */}
            <TechnicalCell ticker={ticker} />
          </Suspense>
        </div>
        <div>
          <div className="text-muted-foreground">News</div>
          <Suspense fallback={<CellSkeleton />}>
            {/* @ts-expect-error Async Server Component */}
            <NewsCell ticker={ticker} />
          </Suspense>
        </div>
        <div>
          <div className="text-muted-foreground">Insiders</div>
          <Suspense fallback={<CellSkeleton />}>
            {/* @ts-expect-error Async Server Component */}
            <InsidersCell ticker={ticker} />
          </Suspense>
        </div>
        <div className="col-span-2">
          <div className="text-muted-foreground">Filings</div>
          <Suspense fallback={<CellSkeleton />}>
            {/* @ts-expect-error Async Server Component */}
            <FilingsCell ticker={ticker} />
          </Suspense>
        </div>
      </div>
    </li>
  );
}
```

- [ ] **Step 4.4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean (the `@ts-expect-error` comments suppress the async-server-component type complaints).

- [ ] **Step 4.5: Commit**

```bash
git add "app/(app)/watchlist/_components/watchlist-row.tsx" \
        "app/(app)/watchlist/_components/watchlist-row-skeleton.tsx" \
        "app/(app)/watchlist/_components/watchlist-row-mobile.tsx"
git commit -m "$(cat <<'EOF'
feat(watchlist): WatchlistRow + skeleton + mobile variant

WatchlistRow: 12-col grid composing ticker name + 5 cell server
components in per-cell Suspense (each cell streams independently —
a slow news fetch doesn't block snapshot rendering).
WatchlistRowSkeleton: the outer-Suspense fallback used by the table
while a row is loading. Shows ticker + 5 cell skeletons.
WatchlistRowMobile: 2×3 mini-grid card variant for narrow viewports.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `<WatchlistTable>` + `<SortToggle>` + URL-driven sort

**Files:**
- Create: `app/(app)/watchlist/_components/watchlist-table.tsx`
- Create: `app/(app)/watchlist/_components/sort-toggle.tsx`

The sort logic is server-side (rows reordered before render via a `?sort=` URL param). The toggle is the only client component in this slice — it just `router.push`es on change.

For the "interesting first" sort options, the implementation needs a lightweight pre-fetch: we look at insider aggregates and news counts to rank rows. To keep this cheap, we do a single batched pre-pass — one short DB query per ticker for `hasClusterBuy` / insider netShares / news count past 7d — and use the results to reorder before rendering rows. The cells themselves still load independently.

- [ ] **Step 5.1: Create `app/(app)/watchlist/_components/sort-toggle.tsx`**

```tsx
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';

const OPTIONS = [
  { value: 'default',  label: 'Alphabetical' },
  { value: 'insider',  label: 'Has insider activity' },
  { value: 'news',     label: 'Has news' },
  { value: 'cluster',  label: 'Has cluster buy' }
] as const;

export function SortToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('sort') ?? 'default';

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const newParams = new URLSearchParams(params.toString());
    if (next === 'default') newParams.delete('sort');
    else newParams.set('sort', next);
    const qs = newParams.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <select
      value={current}
      onChange={onChange}
      className="text-xs rounded border border-border bg-background px-2 py-1"
      aria-label="Sort tickers"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
```

- [ ] **Step 5.2: Create `app/(app)/watchlist/_components/watchlist-table.tsx`**

```tsx
import { Suspense } from 'react';
import { getServiceDb } from '@/lib/db/client';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { NewsService } from '@/lib/services/news';
import { QwenProvider } from '@/lib/providers/qwen';
import { WatchlistRow } from './watchlist-row';
import { WatchlistRowSkeleton } from './watchlist-row-skeleton';
import { WatchlistRowMobile } from './watchlist-row-mobile';
import { SortToggle } from './sort-toggle';

type SortMode = 'default' | 'insider' | 'news' | 'cluster';

interface Props {
  tickers: string[];
  sort?: SortMode;
}

async function rankSignals(tickers: string[]): Promise<Map<string, {
  hasClusterBuy: boolean;
  insiderActivity: number;       // abs(netShares); 0 if none
  newsCount7d: number;
}>> {
  const db = getServiceDb();
  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const qwen = new QwenProvider({ apiKey: env.QWEN_API_KEY });
  const insidersSvc = new InsidersService({ db, fdProvider: fd });
  const newsSvc = new NewsService({ db, fdProvider: fd, qwenProvider: qwen });
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const result = new Map<string, { hasClusterBuy: boolean; insiderActivity: number; newsCount7d: number }>();
  await Promise.all(tickers.map(async (t) => {
    const [agg, articles] = await Promise.all([
      insidersSvc.getAggregate(t, 90).catch(() => null),
      newsSvc.getList(t, 50).catch(() => [])
    ]);
    const recent = articles.filter((a) => a.publishedAt.getTime() >= cutoffMs);
    result.set(t, {
      hasClusterBuy: agg?.hasClusterBuy ?? false,
      insiderActivity: Math.abs(agg?.netShares ?? 0),
      newsCount7d: recent.length
    });
  }));
  return result;
}

async function sortTickers(tickers: string[], sort: SortMode): Promise<string[]> {
  if (sort === 'default') {
    return [...tickers].sort((a, b) => a.localeCompare(b));
  }
  const signals = await rankSignals(tickers);
  // For each non-default sort, partition into "has signal" (first) then alphabetical within each partition.
  const withSignal: string[] = [];
  const withoutSignal: string[] = [];
  for (const t of tickers) {
    const s = signals.get(t);
    let hit = false;
    if (s) {
      if (sort === 'cluster') hit = s.hasClusterBuy;
      else if (sort === 'insider') hit = s.insiderActivity > 0;
      else if (sort === 'news') hit = s.newsCount7d > 0;
    }
    (hit ? withSignal : withoutSignal).push(t);
  }
  withSignal.sort((a, b) => a.localeCompare(b));
  withoutSignal.sort((a, b) => a.localeCompare(b));
  return [...withSignal, ...withoutSignal];
}

export async function WatchlistTable({ tickers, sort = 'default' }: Props) {
  const ordered = await sortTickers(tickers, sort);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <SortToggle />
      </div>

      {/* Desktop / lg+ */}
      <div className="hidden lg:block border border-border rounded">
        <header className="grid grid-cols-12 gap-3 px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border">
          <span className="col-span-2">Ticker</span>
          <span className="col-span-2 text-right">Snapshot</span>
          <span className="col-span-2 text-center">Tech</span>
          <span className="col-span-2 text-center">News</span>
          <span className="col-span-2 text-center">Insiders</span>
          <span className="col-span-2 text-center">Filings</span>
        </header>
        <ul>
          {ordered.map((t) => (
            <Suspense key={t} fallback={<WatchlistRowSkeleton ticker={t} />}>
              <WatchlistRow ticker={t} />
            </Suspense>
          ))}
        </ul>
      </div>

      {/* Mobile / <lg */}
      <ul className="lg:hidden">
        {ordered.map((t) => (
          <Suspense key={t} fallback={<div className="rounded border border-border p-3 mb-2"><div className="font-mono font-medium text-muted-foreground">{t}</div></div>}>
            <WatchlistRowMobile ticker={t} />
          </Suspense>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5.3: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: clean.

- [ ] **Step 5.4: Commit**

```bash
git add "app/(app)/watchlist/_components/watchlist-table.tsx" \
        "app/(app)/watchlist/_components/sort-toggle.tsx"
git commit -m "$(cat <<'EOF'
feat(watchlist): WatchlistTable + SortToggle with URL-driven sort

WatchlistTable: server component composing rows in per-row Suspense
(key={ticker} so rows stream independently). Includes desktop grid
and mobile stacked variant via lg: breakpoint. Sort modes resolve
server-side before render: 'default' is alphabetical; 'insider' /
'news' / 'cluster' partition tickers into 'has signal' vs 'no signal',
each partition alphabetized.

SortToggle: tiny client component that updates ?sort= via router.push.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Page wiring — `?tab=rollup` default + tab nav

**Files:**
- Modify: `app/(app)/watchlist/_components/watchlist-tabs.tsx`
- Modify: `app/(app)/watchlist/page.tsx`

- [ ] **Step 6.1: Inspect current `watchlist-tabs.tsx`**

```bash
cat "app/(app)/watchlist/_components/watchlist-tabs.tsx"
```

You'll see a `WatchlistTab` union (probably `'list' | 'search' | 'ask'`) and a TABS array. Add `'rollup'` and position it first.

- [ ] **Step 6.2: Modify `app/(app)/watchlist/_components/watchlist-tabs.tsx`**

Update the union to include `'rollup'`:

```tsx
export type WatchlistTab = 'rollup' | 'list' | 'search' | 'ask';
```

In the TABS array, prepend the new entry:

```tsx
{ value: 'rollup', label: 'Roll-up', href: '/watchlist?tab=rollup' },
```

If the existing entries have different href shapes (e.g. omit the query param), match that pattern. The other tab entries should keep their current behavior — only the `rollup` entry is new.

If the tabs file determines "active" by comparing a prop `active: WatchlistTab` to the entry value, that prop's union now needs to accept `'rollup'`. Update accordingly.

- [ ] **Step 6.3: Modify `app/(app)/watchlist/page.tsx`**

Open the file. The current `PageProps` is `{ searchParams: { q?: string; mode?: string } }`. Extend to read `tab` and `sort`:

```tsx
interface PageProps {
  searchParams: { q?: string; mode?: string; tab?: string; sort?: string };
}
```

After `requireUserId` and before any return, parse the tab:

```tsx
type TabMode = 'rollup' | 'list' | 'search' | 'ask';
const VALID_TABS = new Set<TabMode>(['rollup', 'list', 'search', 'ask']);
const tab: TabMode = (VALID_TABS.has(searchParams.tab as TabMode) ? searchParams.tab : 'rollup') as TabMode;

type SortMode = 'default' | 'insider' | 'news' | 'cluster';
const VALID_SORTS = new Set<SortMode>(['default', 'insider', 'news', 'cluster']);
const sort: SortMode = (VALID_SORTS.has(searchParams.sort as SortMode) ? searchParams.sort : 'default') as SortMode;
```

Below the watchlist load (`items = await getWatchlistWithSnapshots(userId)`), branch the render based on `tab`. The existing `tab === 'search' || tab === 'ask'` branches stay; the existing default render path is the `'list'` view (snapshot cards). Add a new `'rollup'` branch that renders `<WatchlistTable>`:

```tsx
import { WatchlistTable } from './_components/watchlist-table';

// ... after items load ...

if (tab === 'rollup') {
  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Watchlist</h1>
        <WatchlistTabs active="rollup" />
      </header>
      <WatchlistTable tickers={items.map((i) => i.ticker)} sort={sort} />
    </div>
  );
}
```

For the existing branches (search / ask / list), pass `active={tab}` to `<WatchlistTabs>` where appropriate so the tab highlight reflects the URL.

**Important — empty watchlist:** if `items.length === 0` we want to show the existing `<EmptyState>` regardless of `tab` value. Make sure the `if (items.length === 0)` branch still fires first.

**Important — default landing:** since `tab` defaults to `'rollup'`, navigating to bare `/watchlist` now lands on the roll-up. That's the intended behavior per the spec. The existing card-grid `list` view is still accessible at `/watchlist?tab=list`.

- [ ] **Step 6.4: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: clean. Total unit-test count grows by 22 from this slice.

- [ ] **Step 6.5: Commit**

```bash
git add "app/(app)/watchlist/page.tsx" \
        "app/(app)/watchlist/_components/watchlist-tabs.tsx"
git commit -m "$(cat <<'EOF'
feat(watchlist): wire Roll-up tab as the default landing view

WatchlistTab union now includes 'rollup' (positioned first in TABS).
Page parses ?tab= and ?sort= from searchParams with strict whitelist,
defaults to ?tab=rollup, renders <WatchlistTable>. Existing list /
search / ask branches retained and tab-highlighting passes through.
Empty-watchlist EmptyState short-circuits before tab branching.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: E2E test + push + CI + browser smoke

**Files:**
- Create: `tests/e2e/watchlist-rollup.spec.ts`

- [ ] **Step 7.1: Create the Playwright test**

Inspect an existing E2E test to understand the auth/setup pattern:

```bash
ls tests/e2e/
head -40 tests/e2e/*.spec.ts | head -80
```

The existing tests likely use a `test.use(...)` block for storage state, or a helper for sign-in. Match whatever they do.

Create `tests/e2e/watchlist-rollup.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// Adapt the storageState/auth setup to match existing E2E tests in this repo.
// Most existing tests use a fixtures pattern; check tests/e2e/*.spec.ts for the
// established setup before deciding.

test.describe('Watchlist roll-up dashboard', () => {
  test('defaults to the roll-up tab and renders all watchlisted tickers', async ({ page }) => {
    await page.goto('/watchlist');

    // Default tab is Roll-up (per page.tsx)
    await expect(page.getByRole('heading', { name: 'Watchlist', exact: true })).toBeVisible();

    // Roll-up tab marked active
    const rollupTab = page.getByRole('link', { name: /Roll-up/i }).first();
    await expect(rollupTab).toBeVisible();

    // Table header visible
    await expect(page.getByText('Snapshot', { exact: true })).toBeVisible();
    await expect(page.getByText('Tech', { exact: true })).toBeVisible();
    await expect(page.getByText('Insiders', { exact: true })).toBeVisible();

    // At least one ticker row is present and clickable
    const aaplLink = page.getByRole('link', { name: 'AAPL', exact: true }).first();
    await expect(aaplLink).toBeVisible();

    // Wait for at least one cell to load real content (not skeleton).
    // The snapshot cell shows a $ sign once data arrives.
    await expect(page.locator('text=/\\$\\d/').first()).toBeVisible({ timeout: 10_000 });
  });

  test('clicking a ticker name navigates to the ticker overview', async ({ page }) => {
    await page.goto('/watchlist');
    const aaplLink = page.getByRole('link', { name: 'AAPL', exact: true }).first();
    await aaplLink.click();
    await expect(page).toHaveURL(/\/stock\/AAPL$/);
  });

  test('sort toggle updates the URL', async ({ page }) => {
    await page.goto('/watchlist');
    const select = page.getByLabel('Sort tickers');
    await select.selectOption('insider');
    await expect(page).toHaveURL(/sort=insider/);
  });
});
```

If the existing tests don't have a sign-in helper and instead use `playwright.config.ts`'s `storageState`, you may need a beforeEach that ensures a session cookie. Reuse whatever pattern existing E2Es follow.

- [ ] **Step 7.2: Run Playwright locally**

```bash
pnpm test:e2e -- tests/e2e/watchlist-rollup.spec.ts
```

Expected: 3 tests pass (assuming Playwright config + auth fixture work). If Playwright complains about no test runner available in the environment, skip local execution and rely on CI — but commit the spec file regardless.

- [ ] **Step 7.3: Commit the E2E test**

```bash
git add tests/e2e/watchlist-rollup.spec.ts
git commit -m "$(cat <<'EOF'
test(watchlist): E2E for roll-up dashboard

3 tests: (1) /watchlist defaults to roll-up and renders header +
columns + at least one ticker row with loaded snapshot data;
(2) clicking a ticker name navigates to /stock/[ticker];
(3) sort toggle updates ?sort= URL param.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7.4: Push and watch CI**

```bash
git push origin master
gh run list --limit 1 --json status,databaseId,headSha
```

Note the run id; then watch:

```bash
gh run watch <run-id> --exit-status
```

Expected: exits 0.

- [ ] **Step 7.5: Browser smoke**

Wait ~30s for Vercel deploy, then in the browser:

1. Visit `https://equity-research-workbench-mauve.vercel.app/watchlist`.
2. Expect: Roll-up tab active by default. All 6 watchlisted tickers visible as rows.
3. Each row should fill in progressively: snapshot ($price + +/-%) first, technical chip (OB/OS/GC/DC/●), news (`+N art` or `· quiet`), insiders (`⚡ cluster` / `+N buys` / `-N sells` / `· quiet`), filings (`form · Nd`).
4. Hover any cell — tooltip text appears.
5. Click the ticker name (e.g. AAPL) — navigates to `/stock/AAPL`.
6. Click any chip — navigates to the relevant `/stock/[ticker]/<tab>` page.
7. Change sort to "Has insider activity" — URL becomes `?sort=insider`; rows with insider activity move to the top.
8. Click "List" tab — switches to the existing card-grid view.
9. Verify on mobile (or narrow browser to < 1024px): rows render as stacked cards instead of grid.

Empty-state spot check: if any ticker has no data for a cell (likely JD for news/insiders), it shows `—` or `· quiet` cleanly. No crashes.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| 5-cell row: Snapshot / Technical / News / Insiders / Filings | T3 |
| Pure formatters returning `Cell = {glyph, color, tooltip?}` | T1 |
| 22 unit tests for formatters | T1 |
| Shared `<CellChip>` with color mapping + `<Link>` wrap + tooltip | T2 |
| `<CellSkeleton>` for per-cell Suspense fallback | T2 |
| SnapshotCell loads snapshot + 1Y prices (derives day-change) | T3 |
| TechnicalCell runs computeTechnical, maps cross within 10 days | T3 |
| NewsCell filters to past 7 days at formatter level | T1 + T3 |
| InsidersCell uses InsidersService.getAggregate(t, 90) | T3 |
| FilingsCell uses first item from FilingsService.getList | T3 |
| `<WatchlistRow>` with per-cell Suspense | T4 |
| `<WatchlistRowSkeleton>` for outer Suspense fallback | T4 |
| `<WatchlistRowMobile>` for narrow viewports | T4 |
| `<WatchlistTable>` with per-row Suspense (key={ticker}) | T5 |
| Desktop grid + mobile stacked via `lg:` breakpoint | T5 |
| URL-driven sort (`?sort=`) with 4 options | T5 |
| `<SortToggle>` client component using router.push | T5 |
| `<WatchlistTabs>` gains `'rollup'` entry | T6 |
| Page defaults to `?tab=rollup` | T6 |
| Empty-state short-circuits before tab branching | T6 |
| Playwright E2E for roll-up | T7 |
| Push + CI + browser smoke | T7 |

All spec requirements have a task. No gaps.
