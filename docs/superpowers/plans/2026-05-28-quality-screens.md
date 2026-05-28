# Quality Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Piotroski F-Score, Altman Z-Score, and Beneish M-Score on every ticker's Overview card + a dedicated `/quality` tab with per-score breakdowns and 5-year sparkline trends.

**Architecture:** Two-part plan. **Part A** extends the yfinance ingestion script to fetch 7 missing line items (current assets/liabilities, retained earnings, accounts receivable, PP&E, shares outstanding, SG&A, D&A) and backfills the 5 existing tickers. **Part B** then adds pure-functional compute for the three scores plus UI surfaces.

**Tech Stack:** Python (yfinance), TypeScript strict, Next.js 14 App Router, Drizzle ORM, Vitest, Recharts, Tailwind/shadcn.

**Spec:** `docs/superpowers/specs/2026-05-28-quality-screens-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `scripts/yfinance_fetch.py` | Modify | Extend INCOME_MAP / BALANCE_MAP / CASH_FLOW_MAP for 7 new line items; add shares_outstanding from `info` |
| `scripts/refresh-fundamentals.ts` | Create | One-off backfill: delete `fundamentals` rows for ticker(s), re-fetch via FinancialsService |
| `package.json` | Modify | Add `refresh-fundamentals` script |
| `lib/compute/quality.ts` | Create | `AnnualFinancials` type, `piotroskiFScore`, `altmanZScore`, `beneishMScore`, `computeQuality` — pure functions |
| `tests/compute/quality.test.ts` | Create | ~10 unit tests across all three scores |
| `lib/services/quality.ts` | Create | `loadQuality(db, ticker)` — pivots `fundamentals` rows + reads market cap from `snapshots`, calls `computeQuality` |
| `tests/integration/quality-service.test.ts` | Create | Integration test with seeded fundamentals + snapshot, asserts QualityResult shape |
| `app/(app)/stock/[ticker]/_components/quality-card.tsx` | Create | Compact 3-line card for Overview grid |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Add `<QualityCard>` to grid; load via `loadQuality()` |
| `app/(app)/stock/[ticker]/quality/page.tsx` | Create | Server component for `/quality` tab |
| `app/(app)/stock/[ticker]/quality/_components/quality-view.tsx` | Create | Client wrapper composing 3 sections |
| `app/(app)/stock/[ticker]/quality/_components/piotroski-section.tsx` | Create | F-score breakdown + sparkline + "What is this?" |
| `app/(app)/stock/[ticker]/quality/_components/altman-section.tsx` | Create | Z-score components + sparkline + footnote |
| `app/(app)/stock/[ticker]/quality/_components/beneish-section.tsx` | Create | M-score components + sparkline + footnote |
| `app/(app)/stock/[ticker]/quality/_components/score-sparkline.tsx` | Create | Reusable sparkline for the 5-year score trend |
| `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` | Modify | Add `'quality'` to `DashboardTab` type + `TABS` array |

---

# Part A — Extend ingestion (Tasks 1–4)

## Task 1: Extend yfinance line-item mappings

**Files:**
- Modify: `scripts/yfinance_fetch.py:211-246` (the three mapping dicts)

The current mappings in `yfinance_fetch.py` cover the core financials but omit several line items needed for quality scoring. yfinance's `Ticker(symbol).balance_sheet`, `.income_stmt`, and `.cashflow` DataFrames expose more rows than we currently parse — we just need to add them to the maps. `shares_outstanding` comes from `info` not the balance sheet, so it's a special case handled in the income-statement fetch.

- [ ] **Step 1.1: Probe a ticker to see what yfinance actually exposes**

This step is exploration, not implementation. Create a temporary probe script:

`_yf_probe.py`:

```python
import yfinance as yf
import json

t = yf.Ticker('AAPL')

print('--- balance_sheet row names ---')
bs = t.balance_sheet
if bs is not None and not bs.empty:
    for name in bs.index:
        print(f'  "{name}"')

print('\n--- income_stmt row names ---')
inc = t.income_stmt
if inc is not None and not inc.empty:
    for name in inc.index:
        print(f'  "{name}"')

print('\n--- cashflow row names ---')
cf = t.cashflow
if cf is not None and not cf.empty:
    for name in cf.index:
        print(f'  "{name}"')

print('\n--- info keys that look like shares ---')
info = t.info
for k in info:
    if 'share' in k.lower() or 'float' in k.lower():
        print(f'  {k}: {info[k]}')
```

Run:

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
python _yf_probe.py 2>&1 | head -120
```

Expected output lists the exact yfinance row names. **The names below are the most common; if yfinance returns slightly different strings, adjust accordingly in Step 1.2.** Common names (from yfinance docs and prior projects):

| Our normalized name | Likely yfinance row(s) |
|---|---|
| `current_assets` | "Current Assets" |
| `current_liabilities` | "Current Liabilities" |
| `retained_earnings` | "Retained Earnings" |
| `accounts_receivable` | "Accounts Receivable", "Receivables" |
| `property_plant_equipment_net` | "Net PPE", "Net Property Plant And Equipment" |
| `shares_outstanding` | (from `info`: `sharesOutstanding` or `ordinarySharesNumber`) |
| `selling_general_admin` | "Selling General And Administration", "Selling General And Administrative" |
| `depreciation_amortization` | "Depreciation And Amortization", "Reconciled Depreciation" |

Delete `_yf_probe.py` after recording the actual names.

- [ ] **Step 1.2: Extend `BALANCE_MAP`**

In `scripts/yfinance_fetch.py`, find `BALANCE_MAP` (line ~223) and add the new entries:

```python
BALANCE_MAP = {
    "Total Assets": "total_assets",
    "Total Liabilities Net Minority Interest": "total_liabilities",
    "Total Liab": "total_liabilities",
    "Stockholders Equity": "total_equity",
    "Total Stockholder Equity": "total_equity",
    "Cash And Cash Equivalents": "cash_and_equivalents",
    "Cash Cash Equivalents And Short Term Investments": "cash_and_equivalents",
    "Long Term Debt": "long_term_debt",
    "Current Debt": "short_term_debt",
    "Short Long Term Debt": "short_term_debt",
    # Slice: quality screens
    "Current Assets": "current_assets",
    "Total Current Assets": "current_assets",
    "Current Liabilities": "current_liabilities",
    "Total Current Liabilities": "current_liabilities",
    "Retained Earnings": "retained_earnings",
    "Accounts Receivable": "accounts_receivable",
    "Receivables": "accounts_receivable",
    "Net PPE": "property_plant_equipment_net",
    "Net Property Plant And Equipment": "property_plant_equipment_net",
    "Property Plant And Equipment Net": "property_plant_equipment_net",
}
```

Use whichever yfinance row names the probe in Step 1.1 actually showed.

- [ ] **Step 1.3: Extend `INCOME_MAP`**

```python
INCOME_MAP = {
    "Total Revenue": "revenue",
    "Cost Of Revenue": "cost_of_revenue",
    "Gross Profit": "gross_profit",
    "Operating Expense": "operating_expense",
    "Operating Income": "operating_income",
    "Net Income": "net_income",
    "Net Income Common Stockholders": "net_income",
    "Basic EPS": "earnings_per_share",
    "Diluted EPS": "earnings_per_share",
    # Slice: quality screens
    "Selling General And Administration": "selling_general_admin",
    "Selling General And Administrative": "selling_general_admin",
    "Reconciled Depreciation": "depreciation_amortization",
    "Depreciation And Amortization": "depreciation_amortization",
}
```

- [ ] **Step 1.4: Add `shares_outstanding` injection from `info`**

`shares_outstanding` is exposed as a scalar in `info`, not a DataFrame row. Inject it as a per-period row in `fetch_statements` for the income statement (most natural place — could equally be balance, but income is fetched on the same provider call schedule).

Find `fetch_statements` (around line ~285). After the line `rows = _statements_from_df(df, mapping, fx_by_period)`, add:

```python
    # Slice quality screens: yfinance exposes shares_outstanding as a scalar in
    # `info`, not as a DataFrame row. Inject it for each period_end so Piotroski
    # test 7 (no-dilution) can be computed. yfinance only provides the latest
    # value, so all periods get the same number — this means YoY comparisons
    # will be flat (test passes by default) until ingestion is upgraded to
    # historical shares data. Acceptable tradeoff; flagged in spec.
    if kind == "income":
        shares = num_or_none(info.get("sharesOutstanding") or info.get("ordinarySharesNumber"))
        if shares is not None:
            existing_period_ends = {r["periodEnd"] for r in rows}
            for pe in existing_period_ends:
                rows.append({
                    "periodEnd": pe,
                    "lineItem": "shares_outstanding",
                    "value": shares,
                    "currency": "USD"
                })
```

Note: This is a documented known limitation. Without historical shares data, Piotroski test 7 (no share dilution) effectively passes by default. We could fix this by adding a dedicated `fetch_shares_history()` function later, but it's out of scope.

- [ ] **Step 1.5: Smoke-test the extended script against AAPL**

```bash
python scripts/yfinance_fetch.py AAPL statements_balance_annual | python -c "
import json, sys
d = json.load(sys.stdin)
rows = d['rows']
items = {r['lineItem'] for r in rows}
print('balance line items found:')
for it in sorted(items):
    print(f'  {it}')
needed = {'current_assets', 'current_liabilities', 'retained_earnings', 'accounts_receivable', 'property_plant_equipment_net'}
missing = needed - items
if missing:
    print(f'MISSING: {missing}')
else:
    print('All needed balance items present.')
"
```

Expected: all 5 balance-sheet items present. If any are missing, the row name in yfinance differs — go back to Step 1.2 and add the actual name.

Repeat for income:

```bash
python scripts/yfinance_fetch.py AAPL statements_income_annual | python -c "
import json, sys
d = json.load(sys.stdin)
rows = d['rows']
items = {r['lineItem'] for r in rows}
needed = {'selling_general_admin', 'depreciation_amortization', 'shares_outstanding'}
missing = needed - items
print(f'income items present: {sorted(items)}')
if missing:
    print(f'MISSING: {missing}')
else:
    print('All needed income items present.')
"
```

Expected: all 3 income items present. If `selling_general_admin` or `depreciation_amortization` are missing, fix Step 1.3. If `shares_outstanding` is missing, fix Step 1.4.

- [ ] **Step 1.6: Commit**

```bash
git add scripts/yfinance_fetch.py
git commit -m "feat(ingestion): extend yfinance line-item mappings for quality screens

Adds 7 line items to BALANCE_MAP + INCOME_MAP:
  current_assets, current_liabilities, retained_earnings,
  accounts_receivable, property_plant_equipment_net,
  selling_general_admin, depreciation_amortization.

shares_outstanding is injected from info (yfinance exposes it as a scalar,
not a historical series). All periods get the latest value; Piotroski test
7 (no-dilution) will effectively pass by default until historical shares
ingestion is added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backfill script for existing tickers

**Files:**
- Create: `scripts/refresh-fundamentals.ts`
- Modify: `package.json`

- [ ] **Step 2.1: Create the backfill script**

Create `scripts/refresh-fundamentals.ts`:

```ts
#!/usr/bin/env tsx
/**
 * One-off backfill: delete fundamentals rows for a ticker (or all watched
 * tickers) and re-fetch via FinancialsService. Used after extending the
 * yfinance line-item mappings — existing fundamentals rows are stale.
 *
 * Usage: pnpm refresh-fundamentals <TICKER>
 *        pnpm refresh-fundamentals --all   (refreshes every company in DB)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { and, eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { companies, fundamentals } from '@/lib/db/schema';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { FinancialsService } from '@/lib/services/financials';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

async function main() {
  const arg = process.argv[2] ?? '';
  const env = loadServerEnv();
  const db = getServiceDb();
  const yf = new YFinanceProvider();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const redis = getRedisCache();
  const svc = new FinancialsService({ db, primary: yf, fallback: fd, redis });

  let tickers: string[];
  if (arg === '--all') {
    const rows = await db.select({ ticker: companies.ticker }).from(companies);
    tickers = rows.map((r) => r.ticker);
  } else if (/^[A-Z][A-Z.]{0,5}$/.test(arg.toUpperCase())) {
    tickers = [arg.toUpperCase()];
  } else {
    console.error('Usage: pnpm refresh-fundamentals <TICKER> | --all');
    process.exit(2);
  }

  console.log(`Refreshing fundamentals for ${tickers.length} ticker(s)...\n`);
  for (const t of tickers) {
    process.stdout.write(`${t}: `);
    const t0 = Date.now();
    try {
      // Delete existing rows for this ticker — re-fetch will repopulate
      await db.delete(fundamentals).where(eq(fundamentals.ticker, t));
      // Refresh all three statement types
      await svc.refresh(t, 'income', 'annual');
      await svc.refresh(t, 'balance', 'annual');
      await svc.refresh(t, 'cash_flow', 'annual');
      const count = await db
        .select({ c: fundamentals.lineItem })
        .from(fundamentals)
        .where(and(eq(fundamentals.ticker, t), eq(fundamentals.periodType, 'annual')));
      console.log(`${count.length} rows in ${Date.now() - t0}ms`);
    } catch (err) {
      console.log(`FAIL: ${String(err).slice(0, 200)}`);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('refresh-fundamentals failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2.2: Add `refresh-fundamentals` script to `package.json`**

Edit `package.json`. In the `scripts` block, add alongside existing `try-*` and `reparse` entries:

```json
"refresh-fundamentals": "tsx scripts/refresh-fundamentals.ts"
```

- [ ] **Step 2.3: Run backfill on all 5 tickers**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm refresh-fundamentals --all
```

Expected output:

```
Refreshing fundamentals for 5 ticker(s)...

AAPL: ~50-60 rows in ~3000ms
NVDA: ~50-60 rows in ~3000ms
MSFT: ~50-60 rows in ~3000ms
GOOGL: ~50-60 rows in ~3000ms
JD: ~50-60 rows in ~3000ms
```

The row count is per-ticker × statement-type × period — for 3 statements × 5 years × ~3-5 line items per statement = ~45–75 rows per ticker. Higher than before because of the new line items.

- [ ] **Step 2.4: Verify the new line items landed for AAPL**

```bash
pnpm exec tsx -e "
import { config } from 'dotenv'; config({ path: '.env.local' });
import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL_SERVICE_ROLE!, { prepare: false, max: 1 });
const rows = await sql\`
  SELECT statement_type, line_item, COUNT(DISTINCT period_end)::int AS periods
  FROM fundamentals
  WHERE ticker = 'AAPL' AND period_type = 'annual'
  GROUP BY statement_type, line_item
  ORDER BY statement_type, line_item\`;
for (const r of rows) console.log(\`\${r.statement_type.padEnd(10)} | \${r.line_item.padEnd(40)} | \${r.periods}\`);
await sql.end();
process.exit(0);
"
```

Expected: at least these line items present:
- `balance | current_assets`
- `balance | current_liabilities`
- `balance | retained_earnings`
- `balance | accounts_receivable`
- `balance | property_plant_equipment_net`
- `income | selling_general_admin`
- `income | depreciation_amortization`
- `income | shares_outstanding`

If any are missing — go back to Task 1 and check the yfinance row names. Some tickers (e.g., financial institutions) may not report every line item; that's acceptable per the null-fallback design.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/refresh-fundamentals.ts package.json
git commit -m "chore(scripts): refresh-fundamentals.ts backfill + 5-ticker rerun

Re-fetched annual fundamentals for AAPL/NVDA/MSFT/GOOGL/JD with the
extended line-item mappings from Task 1. All target line items now
present in DB (where yfinance reports them).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Part B — Quality scoring + UI (Tasks 3–8)

## Task 3: Piotroski F-Score

**Files:**
- Create: `lib/compute/quality.ts`
- Create: `tests/compute/quality.test.ts`

- [ ] **Step 3.1: Write the failing tests FIRST**

Create `tests/compute/quality.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  piotroskiFScore,
  type AnnualFinancials
} from '@/lib/compute/quality';

function emptyFinancials(periodEnd: string): AnnualFinancials {
  return {
    periodEnd,
    revenue: null, costOfRevenue: null, grossProfit: null, sga: null,
    depreciation: null, ebit: null, netIncome: null,
    cashAndEquivalents: null, receivables: null, currentAssets: null,
    ppe: null, totalAssets: null, currentLiabilities: null,
    longTermDebt: null, totalLiabilities: null, retainedEarnings: null,
    sharesOutstanding: null, operatingCashFlow: null
  };
}

describe('piotroskiFScore', () => {
  it('returns 9/9 when all conditions improve', () => {
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      netIncome: 50, operatingCashFlow: 60, totalAssets: 1000,
      longTermDebt: 200, currentAssets: 300, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 200, revenue: 800
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      netIncome: 80, operatingCashFlow: 100, totalAssets: 1100,
      longTermDebt: 150, currentAssets: 400, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 280, revenue: 1000
    };

    const r = piotroskiFScore(current, prior);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(9);
    expect(r!.tests.every((t) => t.passed)).toBe(true);
  });

  it('returns 0/9 when all conditions deteriorate', () => {
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      netIncome: 100, operatingCashFlow: 120, totalAssets: 1000,
      longTermDebt: 100, currentAssets: 400, currentLiabilities: 200,
      sharesOutstanding: 100, grossProfit: 300, revenue: 1000
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      netIncome: -10, operatingCashFlow: -20, totalAssets: 1200,
      longTermDebt: 300, currentAssets: 200, currentLiabilities: 400,
      sharesOutstanding: 120, grossProfit: 150, revenue: 800
    };

    const r = piotroskiFScore(current, prior);
    expect(r).not.toBeNull();
    expect(r!.score).toBe(0);
    expect(r!.tests.every((t) => !t.passed)).toBe(true);
  });

  it('returns null when required inputs are missing', () => {
    const prior = emptyFinancials('2024-09-28');
    const current = emptyFinancials('2025-09-27');
    const r = piotroskiFScore(current, prior);
    expect(r).toBeNull();
  });

  it('emits the 9 test names in canonical order', () => {
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      netIncome: 50, operatingCashFlow: 60, totalAssets: 1000,
      longTermDebt: 200, currentAssets: 300, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 200, revenue: 800
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      netIncome: 80, operatingCashFlow: 100, totalAssets: 1100,
      longTermDebt: 150, currentAssets: 400, currentLiabilities: 250,
      sharesOutstanding: 100, grossProfit: 280, revenue: 1000
    };
    const r = piotroskiFScore(current, prior)!;
    expect(r.tests.map((t) => t.name)).toEqual([
      'Positive net income',
      'Positive operating cash flow',
      'Higher ROA YoY',
      'Operating CF > net income (high quality earnings)',
      'Lower leverage YoY',
      'Higher current ratio YoY',
      'No share dilution',
      'Higher gross margin YoY',
      'Higher asset turnover YoY'
    ]);
  });
});
```

- [ ] **Step 3.2: Run the test — confirm it fails**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm test -- tests/compute/quality.test.ts
```

Expected: 4 tests fail with `Cannot find module '@/lib/compute/quality'`.

- [ ] **Step 3.3: Implement `piotroskiFScore` + `AnnualFinancials`**

Create `lib/compute/quality.ts`:

```ts
/**
 * Quality screens — pure-functional compute for Piotroski F-Score,
 * Altman Z-Score, and Beneish M-Score over annual financial statements.
 *
 * All functions return `null` when required inputs are missing rather than
 * throwing or producing NaN. Callers (UI) render "—" for null.
 *
 * Sources:
 *   Piotroski, J. (2000), "Value Investing: The Use of Historical Financial
 *     Statement Information to Separate Winners from Losers," J. Accounting
 *     Research.
 *   Altman, E. (1968), "Financial Ratios, Discriminant Analysis and the
 *     Prediction of Corporate Bankruptcy," Journal of Finance.
 *   Beneish, M. (1999), "The Detection of Earnings Manipulation,"
 *     Financial Analysts Journal.
 */

export interface AnnualFinancials {
  periodEnd: string;             // ISO YYYY-MM-DD
  // Income statement
  revenue: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  sga: number | null;
  depreciation: number | null;
  ebit: number | null;
  netIncome: number | null;
  // Balance sheet
  cashAndEquivalents: number | null;
  receivables: number | null;
  currentAssets: number | null;
  ppe: number | null;
  totalAssets: number | null;
  currentLiabilities: number | null;
  longTermDebt: number | null;
  totalLiabilities: number | null;
  retainedEarnings: number | null;
  sharesOutstanding: number | null;
  // Cash flow statement
  operatingCashFlow: number | null;
}

export interface PiotroskiResult {
  score: number;                                              // 0-9
  tests: Array<{ name: string; passed: boolean }>;
}

function isFiniteNum(v: number | null): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Piotroski F-Score: nine binary tests of fundamental strength.
 * Each "passed" test contributes 1 point. Score 7-9 = healthy,
 * 4-6 = mediocre, 0-3 = weak.
 *
 * Returns null when any required input is missing.
 */
export function piotroskiFScore(
  current: AnnualFinancials,
  prior: AnnualFinancials
): PiotroskiResult | null {
  // All 9 tests reference these inputs at minimum:
  const required = [
    current.netIncome, current.operatingCashFlow, current.totalAssets,
    current.longTermDebt, current.currentAssets, current.currentLiabilities,
    current.sharesOutstanding, current.grossProfit, current.revenue,
    prior.netIncome, prior.totalAssets, prior.longTermDebt,
    prior.currentAssets, prior.currentLiabilities, prior.sharesOutstanding,
    prior.grossProfit, prior.revenue
  ];
  if (!required.every(isFiniteNum)) return null;

  const currentROA = current.netIncome! / current.totalAssets!;
  const priorROA   = prior.netIncome!   / prior.totalAssets!;
  const currentLeverage = current.longTermDebt! / current.totalAssets!;
  const priorLeverage   = prior.longTermDebt!   / prior.totalAssets!;
  const currentRatio    = current.currentAssets! / current.currentLiabilities!;
  const priorRatio      = prior.currentAssets!   / prior.currentLiabilities!;
  const currentGM   = current.grossProfit! / current.revenue!;
  const priorGM     = prior.grossProfit!   / prior.revenue!;
  const currentAT   = current.revenue!  / current.totalAssets!;
  const priorAT     = prior.revenue!    / prior.totalAssets!;

  const tests = [
    { name: 'Positive net income',                                passed: current.netIncome! > 0 },
    { name: 'Positive operating cash flow',                       passed: current.operatingCashFlow! > 0 },
    { name: 'Higher ROA YoY',                                     passed: currentROA > priorROA },
    { name: 'Operating CF > net income (high quality earnings)',  passed: current.operatingCashFlow! > current.netIncome! },
    { name: 'Lower leverage YoY',                                 passed: currentLeverage < priorLeverage },
    { name: 'Higher current ratio YoY',                           passed: currentRatio > priorRatio },
    { name: 'No share dilution',                                  passed: current.sharesOutstanding! <= prior.sharesOutstanding! },
    { name: 'Higher gross margin YoY',                            passed: currentGM > priorGM },
    { name: 'Higher asset turnover YoY',                          passed: currentAT > priorAT }
  ];
  const score = tests.filter((t) => t.passed).length;
  return { score, tests };
}
```

- [ ] **Step 3.4: Run the test — confirm it passes**

```bash
pnpm test -- tests/compute/quality.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add lib/compute/quality.ts tests/compute/quality.test.ts
git commit -m "feat(compute): Piotroski F-Score + AnnualFinancials type

Pure function over current + prior annual financials. Returns null if
required inputs missing. 4 unit tests covering 9/9, 0/9, null, and test
ordering.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Altman Z-Score

**Files:**
- Modify: `lib/compute/quality.ts` (append `altmanZScore`)
- Modify: `tests/compute/quality.test.ts` (append 3 tests)

- [ ] **Step 4.1: Write the failing tests**

Append to `tests/compute/quality.test.ts`:

```ts
import { altmanZScore } from '@/lib/compute/quality';

describe('altmanZScore', () => {
  // Original 1968 formula: Z = 1.2A + 1.4B + 3.3C + 0.6D + 1.0E

  it('returns "safe" zone for healthy fixture', () => {
    const f: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      currentAssets: 400, currentLiabilities: 200,
      totalAssets: 1000, retainedEarnings: 500, ebit: 200,
      totalLiabilities: 400, revenue: 1500
    };
    const marketCap = 5000;
    const r = altmanZScore(f, marketCap);
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(2.99);
    expect(r!.zone).toBe('safe');
  });

  it('returns "distress" zone for highly-leveraged near-insolvent fixture', () => {
    const f: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      currentAssets: 50, currentLiabilities: 200,    // negative working capital
      totalAssets: 1000, retainedEarnings: -100,     // accumulated losses
      ebit: 20,                                       // barely profitable
      totalLiabilities: 900, revenue: 400
    };
    const marketCap = 200;                            // small mkt cap vs liabs
    const r = altmanZScore(f, marketCap);
    expect(r).not.toBeNull();
    expect(r!.score).toBeLessThan(1.81);
    expect(r!.zone).toBe('distress');
  });

  it('returns null when retained earnings is missing', () => {
    const f: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      currentAssets: 400, currentLiabilities: 200,
      totalAssets: 1000, retainedEarnings: null,     // missing
      ebit: 200, totalLiabilities: 400, revenue: 1500
    };
    const r = altmanZScore(f, 5000);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run the test — confirm 3 fail**

```bash
pnpm test -- tests/compute/quality.test.ts
```

Expected: 3 new tests fail (undefined `altmanZScore`).

- [ ] **Step 4.3: Implement `altmanZScore`**

Append to `lib/compute/quality.ts`:

```ts
export type AltmanZone = 'safe' | 'caution' | 'distress';

export interface AltmanResult {
  score: number;
  zone: AltmanZone;
  components: { a: number; b: number; c: number; d: number; e: number };
}

/**
 * Altman Z-Score (1968 model for public manufacturers).
 *
 *   Z = 1.2·A + 1.4·B + 3.3·C + 0.6·D + 1.0·E
 *
 *   A = Working capital / Total assets
 *   B = Retained earnings / Total assets
 *   C = EBIT / Total assets
 *   D = Market value of equity / Total liabilities
 *   E = Sales / Total assets
 *
 * Zones: Z > 2.99 safe, 1.81 < Z < 2.99 caution, Z < 1.81 distress.
 * Best-suited for non-financial manufacturers — UI footnote warns.
 *
 * Returns null when any required input is missing.
 */
export function altmanZScore(
  f: AnnualFinancials,
  marketCap: number
): AltmanResult | null {
  if (
    !isFiniteNum(f.currentAssets) ||
    !isFiniteNum(f.currentLiabilities) ||
    !isFiniteNum(f.totalAssets) ||
    !isFiniteNum(f.retainedEarnings) ||
    !isFiniteNum(f.ebit) ||
    !isFiniteNum(f.totalLiabilities) ||
    !isFiniteNum(f.revenue) ||
    !isFiniteNum(marketCap) ||
    f.totalAssets === 0 ||
    f.totalLiabilities === 0
  ) {
    return null;
  }

  const workingCapital = f.currentAssets - f.currentLiabilities;
  const a = workingCapital / f.totalAssets;
  const b = f.retainedEarnings / f.totalAssets;
  const c = f.ebit / f.totalAssets;
  const d = marketCap / f.totalLiabilities;
  const e = f.revenue / f.totalAssets;

  const score = 1.2 * a + 1.4 * b + 3.3 * c + 0.6 * d + 1.0 * e;
  const zone: AltmanZone =
    score > 2.99 ? 'safe' : score < 1.81 ? 'distress' : 'caution';

  return { score, zone, components: { a, b, c, d, e } };
}
```

- [ ] **Step 4.4: Run the test — confirm all pass**

```bash
pnpm test -- tests/compute/quality.test.ts
```

Expected: all 7 tests pass (4 from T3 + 3 new).

- [ ] **Step 4.5: Commit**

```bash
git add lib/compute/quality.ts tests/compute/quality.test.ts
git commit -m "feat(compute): Altman Z-Score + zone classification

1968 formula for public manufacturers. Returns score, zone (safe/caution/
distress), and the 5 components for UI breakdown. 3 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Beneish M-Score

**Files:**
- Modify: `lib/compute/quality.ts`
- Modify: `tests/compute/quality.test.ts`

- [ ] **Step 5.1: Write the failing tests**

Append to `tests/compute/quality.test.ts`:

```ts
import { beneishMScore } from '@/lib/compute/quality';

describe('beneishMScore', () => {
  // Beneish M-Score formula:
  //   M = -4.84 + 0.92·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
  //       + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
  // Threshold: M > -1.78 → manipulation likely.

  it('returns clean (flag=false) for stable ratios fixture', () => {
    // All ratios stable YoY → most indices ≈ 1 → M-score near the floor
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      revenue: 1000, costOfRevenue: 600, grossProfit: 400,
      sga: 100, depreciation: 50, netIncome: 200, operatingCashFlow: 220,
      receivables: 100, currentAssets: 300, ppe: 500,
      totalAssets: 1000, totalLiabilities: 400
    };
    // Slight growth (5%) with stable ratios — nothing suspicious
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      revenue: 1050, costOfRevenue: 630, grossProfit: 420,
      sga: 105, depreciation: 52, netIncome: 210, operatingCashFlow: 230,
      receivables: 105, currentAssets: 315, ppe: 525,
      totalAssets: 1050, totalLiabilities: 420
    };
    const r = beneishMScore(current, prior);
    expect(r).not.toBeNull();
    expect(r!.score).toBeLessThan(-1.78);
    expect(r!.flag).toBe(false);
  });

  it('returns flagged (true) for manipulation-pattern fixture', () => {
    // Constructed to push every component in the "manipulation" direction:
    //   - Receivables grew faster than revenue (DSRI > 1)
    //   - Margins shrank (GMI > 1)
    //   - More soft assets (AQI > 1)
    //   - Sales spiked (SGI > 1)
    //   - Depreciation rate dropped (DEPI > 1)
    //   - Accruals high (TATA > 0)
    const prior: AnnualFinancials = {
      ...emptyFinancials('2024-09-28'),
      revenue: 1000, costOfRevenue: 600, grossProfit: 400,
      sga: 100, depreciation: 100, netIncome: 200, operatingCashFlow: 220,
      receivables: 100, currentAssets: 300, ppe: 500,
      totalAssets: 1000, totalLiabilities: 400
    };
    const current: AnnualFinancials = {
      ...emptyFinancials('2025-09-27'),
      revenue: 1500, costOfRevenue: 1100, grossProfit: 400,  // GP flat → margin down
      sga: 100, depreciation: 80,                            // depr rate down
      netIncome: 300, operatingCashFlow: 100,                // NI >> CFO → high accruals
      receivables: 300,                                       // way faster than revenue
      currentAssets: 600, ppe: 400,                          // more soft assets
      totalAssets: 1500, totalLiabilities: 800
    };
    const r = beneishMScore(current, prior);
    expect(r).not.toBeNull();
    expect(r!.score).toBeGreaterThan(-1.78);
    expect(r!.flag).toBe(true);
  });

  it('returns null when required inputs are missing', () => {
    const prior = emptyFinancials('2024-09-28');
    const current = emptyFinancials('2025-09-27');
    const r = beneishMScore(current, prior);
    expect(r).toBeNull();
  });
});
```

- [ ] **Step 5.2: Run the test — confirm 3 fail**

```bash
pnpm test -- tests/compute/quality.test.ts
```

Expected: 3 new tests fail (undefined `beneishMScore`).

- [ ] **Step 5.3: Implement `beneishMScore`**

Append to `lib/compute/quality.ts`:

```ts
export interface BeneishResult {
  score: number;
  flag: boolean;        // true if score > -1.78 (manipulation possible)
  components: {
    dsri: number; gmi: number; aqi: number; sgi: number;
    depi: number; sgai: number; lvgi: number; tata: number;
  };
}

/**
 * Beneish M-Score: 8-variable model detecting earnings manipulation.
 *
 *   M = -4.84 + 0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
 *           + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
 *
 * Threshold: M > -1.78 → manipulation possible (suspicion signal, not proof).
 *
 * Each variable is a YoY ratio. GMI and DEPI are inverted (prior/current
 * rather than current/prior) by Beneish's convention.
 *
 * Returns null when any required input is missing.
 */
export function beneishMScore(
  current: AnnualFinancials,
  prior: AnnualFinancials
): BeneishResult | null {
  const req = [
    current.revenue, current.costOfRevenue, current.grossProfit,
    current.sga, current.depreciation, current.netIncome,
    current.operatingCashFlow, current.receivables, current.currentAssets,
    current.ppe, current.totalAssets, current.totalLiabilities,
    prior.revenue, prior.costOfRevenue, prior.grossProfit,
    prior.sga, prior.depreciation, prior.receivables, prior.currentAssets,
    prior.ppe, prior.totalAssets, prior.totalLiabilities
  ];
  if (!req.every(isFiniteNum)) return null;

  // Guard against div-by-zero across the formula
  if (
    current.revenue === 0 || prior.revenue === 0 ||
    current.totalAssets === 0 || prior.totalAssets === 0 ||
    current.ppe! + current.depreciation! === 0 ||
    prior.ppe! + prior.depreciation! === 0
  ) {
    return null;
  }

  // DSRI: Days Sales in Receivables Index
  const dsri = (current.receivables! / current.revenue!) /
               (prior.receivables!   / prior.revenue!);

  // GMI: Gross Margin Index (inverted — prior / current)
  const currentGM = current.grossProfit! / current.revenue!;
  const priorGM   = prior.grossProfit!   / prior.revenue!;
  const gmi = priorGM / currentGM;

  // AQI: Asset Quality Index
  const currentSoftRatio = 1 - (current.currentAssets! + current.ppe!) / current.totalAssets!;
  const priorSoftRatio   = 1 - (prior.currentAssets!   + prior.ppe!)   / prior.totalAssets!;
  const aqi = currentSoftRatio / priorSoftRatio;

  // SGI: Sales Growth Index
  const sgi = current.revenue! / prior.revenue!;

  // DEPI: Depreciation Index (inverted — prior rate / current rate)
  const currentDeprRate = current.depreciation! / (current.ppe! + current.depreciation!);
  const priorDeprRate   = prior.depreciation!   / (prior.ppe!   + prior.depreciation!);
  const depi = priorDeprRate / currentDeprRate;

  // SGAI: SGA Index
  const sgai = (current.sga! / current.revenue!) / (prior.sga! / prior.revenue!);

  // LVGI: Leverage Index
  const lvgi = (current.totalLiabilities! / current.totalAssets!) /
               (prior.totalLiabilities!   / prior.totalAssets!);

  // TATA: Total Accruals to Total Assets (current year only)
  const tata = (current.netIncome! - current.operatingCashFlow!) / current.totalAssets!;

  const score = -4.84
    + 0.920 * dsri
    + 0.528 * gmi
    + 0.404 * aqi
    + 0.892 * sgi
    + 0.115 * depi
    - 0.172 * sgai
    + 4.679 * tata
    - 0.327 * lvgi;

  return {
    score,
    flag: score > -1.78,
    components: { dsri, gmi, aqi, sgi, depi, sgai, lvgi, tata }
  };
}
```

- [ ] **Step 5.4: Run the test — confirm all pass**

```bash
pnpm test -- tests/compute/quality.test.ts
```

Expected: all 10 tests pass (4 Piotroski + 3 Altman + 3 Beneish).

- [ ] **Step 5.5: Commit**

```bash
git add lib/compute/quality.ts tests/compute/quality.test.ts
git commit -m "feat(compute): Beneish M-Score for earnings-manipulation detection

8-variable formula from Beneish (1999). Threshold > -1.78 flags possible
manipulation. 3 unit tests: clean fixture, manipulation-pattern fixture,
missing-inputs null return.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `computeQuality` wrapper + service-layer DB loader

**Files:**
- Modify: `lib/compute/quality.ts` (append `computeQuality`)
- Create: `lib/services/quality.ts`
- Modify: `tests/compute/quality.test.ts` (append wrapper test)
- Create: `tests/integration/quality-service.test.ts`

- [ ] **Step 6.1: Add wrapper compute test**

Append to `tests/compute/quality.test.ts`:

```ts
import { computeQuality } from '@/lib/compute/quality';

describe('computeQuality (wrapper)', () => {
  it('returns latest scores + up to 5-year trend, newest first', () => {
    // 6 years of annual financials, all with stable healthy ratios
    const annuals: AnnualFinancials[] = [2020, 2021, 2022, 2023, 2024, 2025].map((year) => ({
      ...emptyFinancials(`${year}-09-30`),
      revenue: 1000 + (year - 2020) * 50,
      costOfRevenue: 600 + (year - 2020) * 30,
      grossProfit: 400 + (year - 2020) * 20,
      sga: 100, depreciation: 50,
      ebit: 200 + (year - 2020) * 10,
      netIncome: 180 + (year - 2020) * 10,
      operatingCashFlow: 200 + (year - 2020) * 12,
      receivables: 100,
      currentAssets: 300 + (year - 2020) * 15,
      ppe: 500,
      totalAssets: 1000 + (year - 2020) * 50,
      currentLiabilities: 200,
      longTermDebt: 300 - (year - 2020) * 10,
      totalLiabilities: 400,
      retainedEarnings: 200 + (year - 2020) * 50,
      sharesOutstanding: 100
    }));

    const r = computeQuality('TEST', annuals, 5000);

    expect(r.current.piotroskiF).not.toBeNull();
    expect(r.current.altmanZ).not.toBeNull();
    expect(r.current.beneishM).not.toBeNull();

    expect(r.trend.length).toBeLessThanOrEqual(5);
    // Newest first
    expect(r.trend[0]!.periodEnd > r.trend[r.trend.length - 1]!.periodEnd).toBe(true);
  });

  it('handles 0-1 years of data gracefully', () => {
    const r = computeQuality('TEST', [], 1000);
    expect(r.current.piotroskiF).toBeNull();
    expect(r.current.altmanZ).toBeNull();
    expect(r.current.beneishM).toBeNull();
    expect(r.trend).toEqual([]);
  });
});
```

- [ ] **Step 6.2: Implement `computeQuality`**

Append to `lib/compute/quality.ts`:

```ts
export interface QualityResult {
  current: {
    piotroskiF: PiotroskiResult | null;
    altmanZ: AltmanResult | null;
    beneishM: BeneishResult | null;
  };
  trend: Array<{
    periodEnd: string;
    piotroskiF: number | null;
    altmanZ: number | null;
    beneishM: number | null;
  }>;   // newest first, up to 5 entries
}

/**
 * Compute all three scores for the latest annual period (vs prior year),
 * plus a 5-year trend of just the headline numbers.
 *
 * `annuals` MUST be sorted ascending by periodEnd. `currentMarketCap` is
 * the current market cap (used by Altman Z's component D for the latest
 * period only — trend entries reuse the same value as an approximation).
 */
export function computeQuality(
  ticker: string,
  annuals: AnnualFinancials[],
  currentMarketCap: number
): QualityResult {
  void ticker;  // not used in compute; here for future ticker-scoped variants

  if (annuals.length < 2) {
    return {
      current: { piotroskiF: null, altmanZ: null, beneishM: null },
      trend: []
    };
  }

  const latest = annuals[annuals.length - 1]!;
  const priorToLatest = annuals[annuals.length - 2]!;

  const current = {
    piotroskiF: piotroskiFScore(latest, priorToLatest),
    altmanZ: altmanZScore(latest, currentMarketCap),
    beneishM: beneishMScore(latest, priorToLatest)
  };

  // Trend: walk pairs (annuals[i-1], annuals[i]) for the last 5 such pairs
  const trendAsc: QualityResult['trend'] = [];
  const startIdx = Math.max(1, annuals.length - 5);
  for (let i = startIdx; i < annuals.length; i++) {
    const curr = annuals[i]!;
    const prev = annuals[i - 1]!;
    const f = piotroskiFScore(curr, prev);
    const z = altmanZScore(curr, currentMarketCap);
    const m = beneishMScore(curr, prev);
    trendAsc.push({
      periodEnd: curr.periodEnd,
      piotroskiF: f ? f.score : null,
      altmanZ: z ? z.score : null,
      beneishM: m ? m.score : null
    });
  }
  // Newest first
  const trend = [...trendAsc].reverse();

  return { current, trend };
}
```

- [ ] **Step 6.3: Run the test — confirm pass**

```bash
pnpm test -- tests/compute/quality.test.ts
```

Expected: all 12 tests pass.

- [ ] **Step 6.4: Create the service-layer loader**

Create `lib/services/quality.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { fundamentals, snapshots } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import {
  computeQuality,
  type AnnualFinancials,
  type QualityResult
} from '@/lib/compute/quality';

/**
 * Pivot the row-wise `fundamentals` table into one `AnnualFinancials`
 * struct per period_end, then call `computeQuality`. Pulls current market
 * cap from `snapshots`.
 *
 * Lives in services, not compute, because it touches the DB.
 */
export async function loadQuality(
  db: ServiceDb,
  ticker: string
): Promise<QualityResult> {
  const t = ticker.toUpperCase();

  // Load all annual fundamentals for this ticker
  const rows = await db
    .select({
      periodEnd: fundamentals.periodEnd,
      statementType: fundamentals.statementType,
      lineItem: fundamentals.lineItem,
      value: fundamentals.value
    })
    .from(fundamentals)
    .where(and(eq(fundamentals.ticker, t), eq(fundamentals.periodType, 'annual')));

  // Group by periodEnd, building one AnnualFinancials per period
  const byPeriod = new Map<string, AnnualFinancials>();
  for (const r of rows) {
    if (!byPeriod.has(r.periodEnd)) {
      byPeriod.set(r.periodEnd, makeEmpty(r.periodEnd));
    }
    const f = byPeriod.get(r.periodEnd)!;
    const val = r.value == null ? null : Number(r.value);
    if (val == null || !Number.isFinite(val)) continue;
    applyLineItem(f, r.lineItem, val);
  }

  const annuals = Array.from(byPeriod.values()).sort((a, b) =>
    a.periodEnd.localeCompare(b.periodEnd)
  );

  // Current market cap from snapshots
  const snap = await db
    .select({ marketCap: snapshots.marketCap })
    .from(snapshots)
    .where(eq(snapshots.ticker, t))
    .limit(1);
  const marketCap = snap[0]?.marketCap != null ? Number(snap[0].marketCap) : 0;

  return computeQuality(t, annuals, marketCap);
}

function makeEmpty(periodEnd: string): AnnualFinancials {
  return {
    periodEnd,
    revenue: null, costOfRevenue: null, grossProfit: null, sga: null,
    depreciation: null, ebit: null, netIncome: null,
    cashAndEquivalents: null, receivables: null, currentAssets: null,
    ppe: null, totalAssets: null, currentLiabilities: null,
    longTermDebt: null, totalLiabilities: null, retainedEarnings: null,
    sharesOutstanding: null, operatingCashFlow: null
  };
}

// Maps from DB line_item strings → AnnualFinancials field. Mirror of the
// yfinance script's mapping side. Centralized here so the compute layer
// stays pure-functional and unaware of DB strings.
function applyLineItem(f: AnnualFinancials, lineItem: string, value: number): void {
  switch (lineItem) {
    case 'revenue':                       f.revenue = value; break;
    case 'cost_of_revenue':               f.costOfRevenue = value; break;
    case 'gross_profit':                  f.grossProfit = value; break;
    case 'selling_general_admin':         f.sga = value; break;
    case 'depreciation_amortization':     f.depreciation = value; break;
    case 'operating_income':              f.ebit = value; break;   // proxy for EBIT
    case 'net_income':                    f.netIncome = value; break;
    case 'cash_and_equivalents':          f.cashAndEquivalents = value; break;
    case 'accounts_receivable':           f.receivables = value; break;
    case 'current_assets':                f.currentAssets = value; break;
    case 'property_plant_equipment_net':  f.ppe = value; break;
    case 'total_assets':                  f.totalAssets = value; break;
    case 'current_liabilities':           f.currentLiabilities = value; break;
    case 'long_term_debt':                f.longTermDebt = value; break;
    case 'total_liabilities':             f.totalLiabilities = value; break;
    case 'retained_earnings':             f.retainedEarnings = value; break;
    case 'shares_outstanding':            f.sharesOutstanding = value; break;
    case 'operating_cash_flow':           f.operatingCashFlow = value; break;
    // Other line items (earnings_per_share, free_cash_flow, etc.) are
    // ignored — not needed by the three scores.
  }
}
```

- [ ] **Step 6.5: Write the integration test**

Create `tests/integration/quality-service.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, fundamentals, snapshots } from '@/lib/db/schema';
import { loadQuality } from '@/lib/services/quality';

config({ path: '.env.local' });

const TICKER = 'AAPL';

function seed(db: any, periodEnd: string, vals: Record<string, number>) {
  const stmtType: Record<string, string> = {
    revenue: 'income', cost_of_revenue: 'income', gross_profit: 'income',
    selling_general_admin: 'income', depreciation_amortization: 'income',
    operating_income: 'income', net_income: 'income',
    cash_and_equivalents: 'balance', accounts_receivable: 'balance',
    current_assets: 'balance', property_plant_equipment_net: 'balance',
    total_assets: 'balance', current_liabilities: 'balance',
    long_term_debt: 'balance', total_liabilities: 'balance',
    retained_earnings: 'balance', shares_outstanding: 'balance',
    operating_cash_flow: 'cash_flow'
  };
  return db.insert(fundamentals).values(
    Object.entries(vals).map(([lineItem, value]) => ({
      ticker: TICKER,
      periodEnd,
      periodType: 'annual',
      statementType: stmtType[lineItem] ?? 'income',
      lineItem,
      value: String(value),
      currency: 'USD',
      source: 'test'
    }))
  );
}

describe('loadQuality (integration)', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values({ ticker: TICKER, name: 'Apple Inc.' });
    await dbH.db.insert(snapshots).values({
      ticker: TICKER, price: '200.00', marketCap: '3000000000000',
      asOf: new Date(), source: 'test'
    });
  });

  it('pivots fundamentals rows and computes all three scores', async () => {
    // Seed 2 years of complete fundamentals
    await seed(dbH.db, '2024-09-28', {
      revenue: 1000, cost_of_revenue: 600, gross_profit: 400,
      selling_general_admin: 100, depreciation_amortization: 50,
      operating_income: 200, net_income: 180,
      operating_cash_flow: 200, accounts_receivable: 100,
      current_assets: 300, property_plant_equipment_net: 500,
      total_assets: 1000, current_liabilities: 200,
      long_term_debt: 300, total_liabilities: 400,
      retained_earnings: 200, shares_outstanding: 100
    });
    await seed(dbH.db, '2025-09-27', {
      revenue: 1100, cost_of_revenue: 650, gross_profit: 450,
      selling_general_admin: 105, depreciation_amortization: 52,
      operating_income: 220, net_income: 200,
      operating_cash_flow: 220, accounts_receivable: 105,
      current_assets: 320, property_plant_equipment_net: 525,
      total_assets: 1100, current_liabilities: 200,
      long_term_debt: 270, total_liabilities: 420,
      retained_earnings: 280, shares_outstanding: 100
    });

    const r = await loadQuality(dbH.db, 'AAPL');
    expect(r.current.piotroskiF).not.toBeNull();
    expect(r.current.altmanZ).not.toBeNull();
    expect(r.current.beneishM).not.toBeNull();
    expect(r.trend.length).toBeGreaterThan(0);
  });

  it('returns nulls when no data exists for a ticker', async () => {
    const r = await loadQuality(dbH.db, 'NOTHERE');
    expect(r.current.piotroskiF).toBeNull();
    expect(r.current.altmanZ).toBeNull();
    expect(r.current.beneishM).toBeNull();
  });
});
```

- [ ] **Step 6.6: Run + commit**

```bash
pnpm test -- tests/compute/quality.test.ts
pnpm test:integration -- quality-service
```

Both expected: all pass.

```bash
git add lib/compute/quality.ts lib/services/quality.ts \
        tests/compute/quality.test.ts tests/integration/quality-service.test.ts
git commit -m "feat(quality): computeQuality wrapper + loadQuality service

computeQuality assembles all 3 scores + 5-year trend from AnnualFinancials[].
loadQuality (in services/, not compute/) pivots row-wise fundamentals into
AnnualFinancials[], reads market cap from snapshots, calls computeQuality.

2 wrapper unit tests + 2 service integration tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `<QualityCard>` on Overview page

**Files:**
- Create: `app/(app)/stock/[ticker]/_components/quality-card.tsx`
- Modify: `app/(app)/stock/[ticker]/page.tsx`

- [ ] **Step 7.1: Create the card component**

Create `app/(app)/stock/[ticker]/_components/quality-card.tsx`:

```tsx
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { QualityResult } from '@/lib/compute/quality';

interface Props {
  ticker: string;
  quality: QualityResult;
}

function piotroskiLabel(score: number): { label: string; color: string } {
  if (score >= 7) return { label: 'Healthy',  color: 'bg-green-600' };
  if (score >= 4) return { label: 'Mediocre', color: 'bg-yellow-500' };
  return                     { label: 'Weak',     color: 'bg-red-600' };
}

function altmanLabel(zone: 'safe' | 'caution' | 'distress'): { label: string; color: string } {
  if (zone === 'safe')     return { label: 'Safe',     color: 'bg-green-600' };
  if (zone === 'caution')  return { label: 'Caution',  color: 'bg-yellow-500' };
  return                          { label: 'Distress', color: 'bg-red-600' };
}

function beneishLabel(flag: boolean): { label: string; color: string } {
  return flag
    ? { label: 'Flagged', color: 'bg-red-600' }
    : { label: 'Clean',   color: 'bg-green-600' };
}

function row(
  name: string,
  score: number | null,
  fmt: (n: number) => string,
  badge: { label: string; color: string } | null
) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{name}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono tabular-nums">
          {score == null ? '—' : fmt(score)}
        </span>
        {badge && (
          <>
            <span className={`inline-block h-2 w-2 rounded-full ${badge.color}`} />
            <span className="text-xs text-muted-foreground w-16">{badge.label}</span>
          </>
        )}
      </span>
    </div>
  );
}

export function QualityCard({ ticker, quality }: Props) {
  const f = quality.current.piotroskiF;
  const z = quality.current.altmanZ;
  const m = quality.current.beneishM;

  return (
    <Card>
      <CardHeader><CardTitle>Quality</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {row(
          'Piotroski F-Score',
          f?.score ?? null,
          (n) => `${n}/9`,
          f ? piotroskiLabel(f.score) : null
        )}
        {row(
          'Altman Z-Score',
          z?.score ?? null,
          (n) => n.toFixed(2),
          z ? altmanLabel(z.zone) : null
        )}
        {row(
          'Beneish M-Score',
          m?.score ?? null,
          (n) => n.toFixed(2),
          m ? beneishLabel(m.flag) : null
        )}
        <div className="pt-2 text-right">
          <Link
            href={`/stock/${ticker}/quality`}
            className="text-xs text-primary hover:underline"
          >
            See full breakdown →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 7.2: Slot the card into the Overview grid**

Open `app/(app)/stock/[ticker]/page.tsx`. The file currently loads snapshot/financials/prices and renders a grid with `<SnapshotCard>`, `<ValuationCard>`, etc. Add `<QualityCard>` after the existing cards (or in a sensible grid position — match the project's existing pattern).

Add the import near the other `_components/*` imports:

```tsx
import { QualityCard } from './_components/quality-card';
```

Add a call to `loadQuality` near where other services are called (after the existing `snapshotSvc.get(ticker)` line). Locate the section where data is loaded:

```tsx
const quality = await loadQuality(getServiceDb(), ticker);
```

Add the import:

```tsx
import { loadQuality } from '@/lib/services/quality';
```

In the JSX, add the card to the grid. Look for the existing `<Card>` blocks (e.g. Snapshot/Growth/Valuation). Add this one alongside them:

```tsx
<QualityCard ticker={ticker} quality={quality} />
```

- [ ] **Step 7.3: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: clean.

- [ ] **Step 7.4: Commit**

```bash
git add "app/(app)/stock/[ticker]/_components/quality-card.tsx" \
        "app/(app)/stock/[ticker]/page.tsx"
git commit -m "feat(quality): QualityCard on Overview + page integration

Loads QualityResult via loadQuality(), renders 3 scores with color-coded
labels and link to the /quality tab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `/quality` tab page + section components + tab nav

**Files:**
- Create: `app/(app)/stock/[ticker]/quality/page.tsx`
- Create: `app/(app)/stock/[ticker]/quality/_components/quality-view.tsx`
- Create: `app/(app)/stock/[ticker]/quality/_components/score-sparkline.tsx`
- Create: `app/(app)/stock/[ticker]/quality/_components/piotroski-section.tsx`
- Create: `app/(app)/stock/[ticker]/quality/_components/altman-section.tsx`
- Create: `app/(app)/stock/[ticker]/quality/_components/beneish-section.tsx`
- Modify: `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`

- [ ] **Step 8.1: Create the reusable sparkline**

Create `app/(app)/stock/[ticker]/quality/_components/score-sparkline.tsx`:

```tsx
'use client';

import { ResponsiveContainer, LineChart, Line, YAxis, Tooltip } from 'recharts';

interface Point {
  periodEnd: string;
  value: number | null;
}

export function ScoreSparkline({ data, color = 'hsl(var(--primary))' }: { data: Point[]; color?: string }) {
  const series = data
    .filter((d) => d.value != null && Number.isFinite(d.value))
    .map((d) => ({ x: d.periodEnd, y: d.value as number }));

  if (series.length < 2) {
    return <p className="text-xs text-muted-foreground">Insufficient history for trend.</p>;
  }

  const ys = series.map((d) => d.y);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const pad = (max - min) * 0.1 || 0.5;

  return (
    <div className="h-16 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series}>
          <YAxis domain={[min - pad, max + pad]} hide />
          <Tooltip
            contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: 11 }}
            labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
            formatter={(v) => (typeof v === 'number' ? v.toFixed(2) : '—')}
            labelFormatter={(label) => `Period: ${label}`}
          />
          <Line type="monotone" dataKey="y" stroke={color} strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 8.2: Create the Piotroski section**

Create `app/(app)/stock/[ticker]/quality/_components/piotroski-section.tsx`:

```tsx
import type { PiotroskiResult, QualityResult } from '@/lib/compute/quality';
import { ScoreSparkline } from './score-sparkline';

function label(score: number): { text: string; color: string } {
  if (score >= 7) return { text: 'Healthy',  color: 'text-green-600' };
  if (score >= 4) return { text: 'Mediocre', color: 'text-yellow-600' };
  return                     { text: 'Weak',     color: 'text-red-600' };
}

export function PiotroskiSection({
  result,
  trend
}: {
  result: PiotroskiResult | null;
  trend: QualityResult['trend'];
}) {
  return (
    <section className="space-y-3 border-b pb-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Piotroski F-Score</h2>
        {result ? (
          <span className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">{result.score}/9</span>
            <span className={`text-sm font-medium ${label(result.score).color}`}>
              {label(result.score).text}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {result ? (
        <ul className="space-y-1 text-sm">
          {result.tests.map((t) => (
            <li key={t.name} className="flex items-baseline gap-2">
              <span className={t.passed ? 'text-green-600' : 'text-red-600'}>
                {t.passed ? '✓' : '✗'}
              </span>
              <span>{t.name}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          Score could not be computed — required line items missing for the most recent annual period.
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground mb-1">5-year trend</p>
        <ScoreSparkline
          data={[...trend].reverse().map((t) => ({ periodEnd: t.periodEnd, value: t.piotroskiF }))}
        />
      </div>

      <div className="text-xs text-muted-foreground italic">
        <p className="font-medium text-sm not-italic mb-1 text-foreground">What is this?</p>
        A 9-question quiz from Joseph Piotroski (Stanford, 2000) measuring fundamental
        improvements year-over-year. Each &quot;yes&quot; = 1 point. The original study
        showed that cheap stocks scoring 8–9 outperformed cheap stocks scoring 0–1 by
        23%/year. <strong>Score 7-9 = strong, 4-6 = mediocre, 0-3 = weak.</strong>
      </div>
    </section>
  );
}
```

- [ ] **Step 8.3: Create the Altman section**

Create `app/(app)/stock/[ticker]/quality/_components/altman-section.tsx`:

```tsx
import type { AltmanResult, QualityResult } from '@/lib/compute/quality';
import { ScoreSparkline } from './score-sparkline';

function label(zone: AltmanResult['zone']): { text: string; color: string } {
  if (zone === 'safe')     return { text: 'Safe',     color: 'text-green-600' };
  if (zone === 'caution')  return { text: 'Caution',  color: 'text-yellow-600' };
  return                          { text: 'Distress', color: 'text-red-600' };
}

export function AltmanSection({
  result,
  trend
}: {
  result: AltmanResult | null;
  trend: QualityResult['trend'];
}) {
  return (
    <section className="space-y-3 border-b pb-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Altman Z-Score</h2>
        {result ? (
          <span className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">{result.score.toFixed(2)}</span>
            <span className={`text-sm font-medium ${label(result.zone).color}`}>
              {label(result.zone).text}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {result ? (
        <div className="text-sm space-y-1">
          <p className="text-xs text-muted-foreground">
            Formula: 1.2·A + 1.4·B + 3.3·C + 0.6·D + 1.0·E
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono tabular-nums text-xs">
            <span>A (WC / Assets):</span>           <span>{result.components.a.toFixed(3)}</span>
            <span>B (Retained Earnings / Assets):</span> <span>{result.components.b.toFixed(3)}</span>
            <span>C (EBIT / Assets):</span>          <span>{result.components.c.toFixed(3)}</span>
            <span>D (Market Cap / Liabilities):</span> <span>{result.components.d.toFixed(2)}</span>
            <span>E (Sales / Assets):</span>         <span>{result.components.e.toFixed(3)}</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Score could not be computed — required line items missing.
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground mb-1">5-year trend</p>
        <ScoreSparkline
          data={[...trend].reverse().map((t) => ({ periodEnd: t.periodEnd, value: t.altmanZ }))}
        />
      </div>

      <div className="text-xs text-muted-foreground italic">
        <p className="font-medium text-sm not-italic mb-1 text-foreground">What is this?</p>
        A bankruptcy-risk indicator from Edward Altman (NYU, 1968). Mixes 5 financial
        ratios into one number that predicts bankruptcy 2 years ahead with ~72% accuracy.
        <strong> Above 2.99 = safe, 1.81–2.99 = caution, below 1.81 = distress.</strong>
        <br />
        <em>Best-suited for non-financial manufacturers. Treat with caution for banks,
        REITs, or pure-software companies.</em>
      </div>
    </section>
  );
}
```

- [ ] **Step 8.4: Create the Beneish section**

Create `app/(app)/stock/[ticker]/quality/_components/beneish-section.tsx`:

```tsx
import type { BeneishResult, QualityResult } from '@/lib/compute/quality';
import { ScoreSparkline } from './score-sparkline';

export function BeneishSection({
  result,
  trend
}: {
  result: BeneishResult | null;
  trend: QualityResult['trend'];
}) {
  return (
    <section className="space-y-3 border-b pb-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Beneish M-Score</h2>
        {result ? (
          <span className="flex items-center gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums">{result.score.toFixed(2)}</span>
            <span className={`text-sm font-medium ${result.flag ? 'text-red-600' : 'text-green-600'}`}>
              {result.flag ? 'Flagged' : 'Clean'}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>

      {result ? (
        <div className="text-sm space-y-1">
          <p className="text-xs text-muted-foreground">
            {result.flag
              ? 'Above −1.78 threshold → possible manipulation patterns detected'
              : 'Below −1.78 threshold → low manipulation risk'}
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono tabular-nums text-xs">
            <span>DSRI (receivables/sales):</span>     <span>{result.components.dsri.toFixed(3)}</span>
            <span>SGI (sales growth):</span>           <span>{result.components.sgi.toFixed(3)}</span>
            <span>GMI (gross-margin inverse):</span>   <span>{result.components.gmi.toFixed(3)}</span>
            <span>DEPI (depreciation inverse):</span>  <span>{result.components.depi.toFixed(3)}</span>
            <span>AQI (asset quality):</span>          <span>{result.components.aqi.toFixed(3)}</span>
            <span>SGAI (SGA/sales):</span>             <span>{result.components.sgai.toFixed(3)}</span>
            <span>LVGI (leverage growth):</span>       <span>{result.components.lvgi.toFixed(3)}</span>
            <span>TATA (accruals/assets):</span>       <span>{result.components.tata.toFixed(3)}</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Score could not be computed — required line items missing.
        </p>
      )}

      <div>
        <p className="text-xs text-muted-foreground mb-1">5-year trend</p>
        <ScoreSparkline
          data={[...trend].reverse().map((t) => ({ periodEnd: t.periodEnd, value: t.beneishM }))}
        />
      </div>

      <div className="text-xs text-muted-foreground italic">
        <p className="font-medium text-sm not-italic mb-1 text-foreground">What is this?</p>
        A &quot;lie detector&quot; for financial reports from Messod Beneish (Indiana
        University, 1999). Looks at 8 things companies cooking the books tend to do
        — like collecting from customers more slowly, or shifting toward credit sales.
        Famously flagged Enron, WorldCom, and Tyco <em>before</em> their scandals broke.
        <strong> Below −1.78 = clean, above −1.78 = flagged.</strong>
        <br />
        <em>This is a suspicion signal, not proof of fraud. Most companies above the
        threshold are not fraudsters — they just look statistically similar.</em>
      </div>
    </section>
  );
}
```

- [ ] **Step 8.5: Create the view wrapper**

Create `app/(app)/stock/[ticker]/quality/_components/quality-view.tsx`:

```tsx
import type { QualityResult } from '@/lib/compute/quality';
import { PiotroskiSection } from './piotroski-section';
import { AltmanSection } from './altman-section';
import { BeneishSection } from './beneish-section';

export function QualityView({ quality }: { quality: QualityResult }) {
  return (
    <div className="space-y-6">
      <PiotroskiSection result={quality.current.piotroskiF} trend={quality.trend} />
      <AltmanSection    result={quality.current.altmanZ}    trend={quality.trend} />
      <BeneishSection   result={quality.current.beneishM}   trend={quality.trend} />
    </div>
  );
}
```

- [ ] **Step 8.6: Create the server page**

Create `app/(app)/stock/[ticker]/quality/page.tsx`:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { loadQuality } from '@/lib/services/quality';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { QualityView } from './_components/quality-view';

interface PageProps {
  params: { ticker: string };
}

export default async function QualityPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const quality = await loadQuality(getServiceDb(), ticker);

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <DashboardTabs ticker={ticker} active="quality" />
      </div>

      <Card>
        <CardHeader><CardTitle>Quality Scores</CardTitle></CardHeader>
        <CardContent>
          <QualityView quality={quality} />
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 8.7: Add `'quality'` to the dashboard tabs**

Open `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx`. Update the `DashboardTab` union and the `TABS` array.

The file currently looks like:

```tsx
export type DashboardTab =
  | 'overview' | 'financials' | 'technical' | 'news' | 'filings' | 'ask';

const TABS: Array<{ value: DashboardTab; label: string; href: (t: string) => string }> = [
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
  { value: 'technical',  label: 'Technical',  href: (t) => `/stock/${t}/technical` },
  { value: 'news',       label: 'News',       href: (t) => `/stock/${t}/news` },
  { value: 'filings',    label: 'Filings',    href: (t) => `/stock/${t}/filings` },
  { value: 'ask',        label: 'Ask',        href: (t) => `/stock/${t}/ask` }
];
```

Add `'quality'` to the union and insert the row at the end of `TABS`:

```tsx
export type DashboardTab =
  | 'overview' | 'financials' | 'technical' | 'news' | 'filings' | 'ask' | 'quality';

const TABS: Array<{ value: DashboardTab; label: string; href: (t: string) => string }> = [
  { value: 'overview',   label: 'Overview',   href: (t) => `/stock/${t}` },
  { value: 'financials', label: 'Financials', href: (t) => `/stock/${t}/financials` },
  { value: 'technical',  label: 'Technical',  href: (t) => `/stock/${t}/technical` },
  { value: 'news',       label: 'News',       href: (t) => `/stock/${t}/news` },
  { value: 'filings',    label: 'Filings',    href: (t) => `/stock/${t}/filings` },
  { value: 'ask',        label: 'Ask',        href: (t) => `/stock/${t}/ask` },
  { value: 'quality',    label: 'Quality',    href: (t) => `/stock/${t}/quality` }
];
```

This single-file edit propagates to all 6 existing dashboard pages thanks to the Slice 5B+ refactor.

- [ ] **Step 8.8: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

All expected: clean.

- [ ] **Step 8.9: Commit**

```bash
git add "app/(app)/stock/[ticker]/quality/" \
        "app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx"
git commit -m "feat(quality): /quality tab + 3 section components + tab nav

PiotroskiSection / AltmanSection / BeneishSection each show:
  - Headline (score + color-coded zone)
  - Component breakdown
  - 5-year trend sparkline
  - 'What is this?' explainer paragraph

Single tab-nav addition propagates to all 7 dashboard pages thanks to
the shared DashboardTabs component.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Push + CI + browser smoke

**Files:** None modified; rollout task.

- [ ] **Step 9.1: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

- [ ] **Step 9.2: Find + watch CI**

```bash
gh run list --limit 1 --json status,databaseId,headSha
gh run watch <run-id> --exit-status
```

Expected: exits 0, all jobs green.

- [ ] **Step 9.3: Browser smoke on production**

Wait ~30s for Vercel deploy, then in your browser:

1. https://equity-research-workbench-mauve.vercel.app/stock/AAPL — Overview should now show a `Quality` card with three score rows + link
2. https://equity-research-workbench-mauve.vercel.app/stock/AAPL/quality — full tab with Piotroski / Altman / Beneish sections
3. Repeat for NVDA / MSFT / GOOGL / JD
4. Verify tab nav now shows 7 entries: Overview · Financials · Technical · News · Filings · Ask · **Quality**

For each, expect:
- Header: 3 score values with color-coded labels
- Breakdown: 9 Piotroski tests with ✓/✗, 5 Altman components, 8 Beneish components
- 5-year sparkline below each section
- "What is this?" paragraph below each
- Scores look reasonable (AAPL F-score should be 6-8; Z-score safe; M-score clean)

If any score shows "—", check the DB for the ticker — that's a real missing-data case, not a bug.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Extend yfinance to fetch 7 missing line items | T1 |
| `shares_outstanding` from `info` | T1.4 |
| Backfill existing tickers | T2 |
| `piotroskiFScore` + 9 binary tests | T3 |
| `AnnualFinancials` type | T3 |
| `altmanZScore` + safe/caution/distress zones | T4 |
| `beneishMScore` + −1.78 threshold flag | T5 |
| `computeQuality` wrapper + 5-year trend | T6 |
| DB→AnnualFinancials pivot (service layer, not compute) | T6 (`lib/services/quality.ts`) |
| `<QualityCard>` on Overview | T7 |
| `/stock/[ticker]/quality` server page | T8 |
| Per-score sections with headline + breakdown + sparkline + "What is this?" | T8.2-T8.5 |
| Permanent footnotes for Altman (manufacturer caveat) and Beneish (suspicion-not-proof) | T8.3, T8.4 |
| Tab nav update (single-file thanks to refactor) | T8.7 |
| Null-fallback (UI shows "—" for unavailable scores) | Throughout |
| Push + CI + browser smoke | T9 |

All requirements have a task. No gaps.
