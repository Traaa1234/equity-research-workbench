# Quality Screens — Piotroski F, Altman Z, Beneish M

**Date:** 2026-05-28
**Status:** Design approved, plan pending

## Goal

Add three classic quality screens to every ticker:
- **Piotroski F-Score** (Joseph Piotroski, 2000) — 9-point financial-health quiz, 0–9 scale
- **Altman Z-Score** (Edward Altman, 1968) — bankruptcy-risk indicator
- **Beneish M-Score** (Messod Beneish, 1999) — earnings-manipulation likelihood

Surface them in two places:
1. **Quality card** on the Overview page — three lines, color-coded labels, link to drill-down
2. **`/stock/[ticker]/quality` tab** — full breakdown per score + 5-year trend sparkline + "What is this?" explainer

All computation is pure functions over data the app already stores (`fundamentals` + `snapshots`). No new external APIs, no schema changes, no recurring cost.

## Non-Goals

- Real-time scoring (annual data only — quarterly variants exist but introduce noise and aren't canonical)
- Sector-relative scoring (e.g., "AAPL F-score vs tech sector average") — defer until peer-compare exists
- Custom score thresholds (locked to the published research thresholds)
- Beneish M-score "fraud confirmed" verdict (it's a *suspicion* signal, not proof — UI must communicate this)
- Backtesting scores against forward returns
- Manual override / re-classification per ticker

## Architecture

Pure server-side compute, no new persistence. Matches the Slice 5A (Technical Analysis) pattern.

```
┌──────────────────────────────────────────────────────────────┐
│  /stock/[ticker]/quality  (server component)                  │
│    1. requireUserId()                                         │
│    2. Read fundamentals + current snapshot from DB            │
│    3. computeQuality(ticker, fundamentals, marketCap)         │
│    4. Render <QualityView>                                    │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  lib/compute/quality.ts                                       │
│    piotroskiFScore(current, prior) → { score, tests }         │
│    altmanZScore(financials, marketCap) → { score, zone, ... } │
│    beneishMScore(current, prior) → { score, flag, ... }       │
│    computeQuality(ticker, annuals[], mcap) → QualityResult    │
│                                                               │
│  All pure. Returns null per-score when required inputs are    │
│  missing for that period. UI shows "—" for null.              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  UI:                                                          │
│    Overview: <QualityCard> compact 3-line summary             │
│    /quality: <QualityView> with full breakdown per score      │
└──────────────────────────────────────────────────────────────┘
```

## Compute Layer

### Input shape

`AnnualFinancials` — a flat struct populated from the `fundamentals` table for one ticker's one annual period. Each field is nullable because not every ticker reports every line item.

```ts
interface AnnualFinancials {
  periodEnd: string;             // ISO YYYY-MM-DD
  // Income statement
  revenue: number | null;
  costOfRevenue: number | null;
  grossProfit: number | null;
  sga: number | null;            // Selling, general & admin expense
  depreciation: number | null;
  ebit: number | null;
  netIncome: number | null;
  // Balance sheet
  cashAndEquivalents: number | null;
  receivables: number | null;
  currentAssets: number | null;
  ppe: number | null;            // Property, plant, & equipment (net)
  totalAssets: number | null;
  currentLiabilities: number | null;
  longTermDebt: number | null;
  totalLiabilities: number | null;
  retainedEarnings: number | null;
  sharesOutstanding: number | null;
  // Cash flow statement
  operatingCashFlow: number | null;
}
```

### Piotroski F-Score

Source: Piotroski, J. (2000), "Value Investing: The Use of Historical Financial Statement Information to Separate Winners from Losers," Journal of Accounting Research.

```ts
function piotroskiFScore(
  current: AnnualFinancials,
  prior: AnnualFinancials
): { score: number; tests: Array<{ name: string; passed: boolean }> } | null;
```

Nine binary tests (each passes = 1 point, fails = 0):

| # | Category | Test |
|---|---|---|
| 1 | Profitability | `current.netIncome > 0` |
| 2 | Profitability | `current.operatingCashFlow > 0` |
| 3 | Profitability | ROA improved: `current.netIncome / current.totalAssets > prior.netIncome / prior.totalAssets` |
| 4 | Profitability | Earnings quality: `current.operatingCashFlow > current.netIncome` |
| 5 | Leverage | Lower long-term debt: `current.longTermDebt / current.totalAssets < prior.longTermDebt / prior.totalAssets` |
| 6 | Liquidity | Higher current ratio: `current.currentAssets / current.currentLiabilities > prior.currentAssets / prior.currentLiabilities` |
| 7 | Dilution | No share issuance: `current.sharesOutstanding <= prior.sharesOutstanding` |
| 8 | Efficiency | Higher gross margin: `current.grossProfit / current.revenue > prior.grossProfit / prior.revenue` |
| 9 | Efficiency | Higher asset turnover: `current.revenue / current.totalAssets > prior.revenue / prior.totalAssets` |

Returns `null` if any required input is missing (caller decides whether to fall back gracefully).

**Thresholds (for UI labeling):**
- ≥ 7: `'healthy'`
- 4–6: `'mediocre'`
- ≤ 3: `'weak'`

### Altman Z-Score

Source: Altman, E. (1968), "Financial Ratios, Discriminant Analysis and the Prediction of Corporate Bankruptcy," Journal of Finance.

Original 1968 formula for publicly traded manufacturers:

```
Z = 1.2·A + 1.4·B + 3.3·C + 0.6·D + 1.0·E
```

Where:
- **A** = Working Capital / Total Assets = (currentAssets − currentLiabilities) / totalAssets
- **B** = Retained Earnings / Total Assets
- **C** = EBIT / Total Assets
- **D** = Market Value of Equity / Total Liabilities (uses **market cap** from `snapshots.market_cap`, not book equity)
- **E** = Sales / Total Assets (= revenue / totalAssets)

```ts
function altmanZScore(
  financials: AnnualFinancials,
  marketCap: number
): {
  score: number;
  zone: 'safe' | 'caution' | 'distress';
  components: { a: number; b: number; c: number; d: number; e: number };
} | null;
```

**Zones:**
- Z > 2.99: `'safe'`
- 1.81 ≤ Z ≤ 2.99: `'caution'`
- Z < 1.81: `'distress'`

**Caveat documented in UI:** Best-suited for non-financial manufacturers. Less reliable for banks/REITs/pure-software companies. We surface the score anyway but show a footnote on the quality tab.

### Beneish M-Score

Source: Beneish, M. (1999), "The Detection of Earnings Manipulation," Financial Analysts Journal.

```
M = -4.84 + 0.920·DSRI + 0.528·GMI + 0.404·AQI + 0.892·SGI
        + 0.115·DEPI − 0.172·SGAI + 4.679·TATA − 0.327·LVGI
```

Where each variable compares current year (`t`) to prior year (`t-1`):

| Var | Name | Formula |
|---|---|---|
| **DSRI** | Days Sales in Receivables Index | `(receivables_t / revenue_t) / (receivables_{t-1} / revenue_{t-1})` |
| **GMI** | Gross Margin Index | `(grossMargin_{t-1}) / (grossMargin_t)` *(note: inverted)* |
| **AQI** | Asset Quality Index | `(1 − (currentAssets_t + ppe_t)/totalAssets_t) / (1 − (currentAssets_{t-1} + ppe_{t-1})/totalAssets_{t-1})` |
| **SGI** | Sales Growth Index | `revenue_t / revenue_{t-1}` |
| **DEPI** | Depreciation Index | `(depreciation_{t-1} / (ppe_{t-1} + depreciation_{t-1})) / (depreciation_t / (ppe_t + depreciation_t))` *(inverted)* |
| **SGAI** | SGA Index | `(sga_t / revenue_t) / (sga_{t-1} / revenue_{t-1})` |
| **LVGI** | Leverage Index | `(totalLiabilities_t / totalAssets_t) / (totalLiabilities_{t-1} / totalAssets_{t-1})` |
| **TATA** | Total Accruals / Total Assets | `(netIncome_t − operatingCashFlow_t) / totalAssets_t` |

```ts
function beneishMScore(
  current: AnnualFinancials,
  prior: AnnualFinancials
): {
  score: number;
  flag: boolean;      // true if score > -1.78 (manipulation likely)
  components: {
    dsri: number; gmi: number; aqi: number; sgi: number;
    depi: number; sgai: number; lvgi: number; tata: number;
  };
} | null;
```

**Threshold:** > −1.78 → `flag = true` (manipulation possible). Below: `false` (clean).

The −1.78 threshold is the widely-cited probit cutoff from the original paper (some sources cite −2.22 as a more conservative threshold). We lock to −1.78 as the convention.

**Important UI note:** This is a *suspicion* signal, not proof of fraud. The "What is this?" section must explicitly state this.

### Wrapper

```ts
interface QualityResult {
  current: {
    piotroskiF: { score: number; tests: ... } | null;
    altmanZ: { score: number; zone: 'safe' | 'caution' | 'distress'; components: ... } | null;
    beneishM: { score: number; flag: boolean; components: ... } | null;
  };
  trend: Array<{
    periodEnd: string;
    piotroskiF: number | null;
    altmanZ: number | null;
    beneishM: number | null;
  }>;   // newest first, up to 5 years
}

function computeQuality(
  ticker: string,
  fundamentals: AnnualFinancials[],   // sorted ascending by periodEnd
  currentMarketCap: number
): QualityResult;
```

- Latest score computed from the two most-recent annual periods (current + prior).
- Trend array walks through pairs `(annuals[i-1], annuals[i])` and emits one entry per pair, newest first. Capped at 5 entries.
- Any score that can't be computed for a period (missing inputs) is `null` in the trend entry; UI shows "—" for those points.

### Mapping fundamentals → AnnualFinancials

The `fundamentals` table stores `(ticker, periodEnd, periodType, statementType, lineItem, value)`. The transformation from row-wise tuples to the flat `AnnualFinancials[]` struct is done **inline in the page/card server components** that need it — `lib/compute/quality.ts` itself stays purely functional (no DB imports).

Pattern matches Slice 5A (`technical/page.tsx` does `pricesSvc.get(ticker) → computeTechnical(prices)`). For quality, the page does a direct Drizzle query for `fundamentals where ticker = X AND period_type = 'annual'`, pivots rows into `AnnualFinancials[]` sorted ascending by `periodEnd`, then calls `computeQuality(ticker, annuals, marketCap)`.

Required `lineItem` values per statementType (exact strings confirmed during implementation by inspecting the seed data):

- **income**: `revenue`, `cost_of_revenue`, `gross_profit`, `selling_general_admin`, `depreciation_amortization`, `operating_income` (used as EBIT proxy), `net_income`
- **balance**: `cash_and_equivalents`, `accounts_receivable`, `current_assets`, `property_plant_equipment_net`, `total_assets`, `current_liabilities`, `long_term_debt`, `total_liabilities`, `retained_earnings`, `shares_outstanding`
- **cash_flow**: `cash_from_operations`

If a line item is missing for a period, the corresponding `AnnualFinancials` field is `null` and the affected score returns `null` for that period.

## UI

### Overview-page card

`app/(app)/stock/[ticker]/_components/quality-card.tsx` — slots into the existing grid alongside `<SnapshotCard>`, `<GrowthCard>`, `<ValuationCard>`.

```
┌────────────────────────────────────────────┐
│ Quality                                    │
├────────────────────────────────────────────┤
│ Piotroski F-Score    7/9   ●   Healthy     │
│ Altman Z-Score       4.2   ●   Safe        │
│ Beneish M-Score    −2.5   ●   Clean        │
│                                            │
│              See full breakdown →           │
└────────────────────────────────────────────┘
```

Color dot per score:
- Piotroski: ≥7 green / 4–6 yellow / ≤3 red
- Altman: safe green / caution yellow / distress red
- Beneish: `flag = false` green, `flag = true` red (no yellow)

If a score is `null` for the current period: row shows "—" with a gray dot and a footer "Some line items unavailable for this ticker."

The "See full breakdown" link routes to `/stock/[ticker]/quality`.

### Quality tab

`app/(app)/stock/[ticker]/quality/page.tsx` — server component renders `<QualityView>`.

Layout (one section per score):

```
┌──────────────────────────────────────────────────────────────┐
│  Piotroski F-Score: 7/9  ●  Healthy           Latest: FY2025 │
│  ────────────────────────────────────────────────────────── │
│  ✓ Positive net income                                       │
│  ✓ Positive operating cash flow                              │
│  ✓ Operating CF > net income (high-quality earnings)         │
│  ✓ Higher ROA YoY                                            │
│  ✓ Lower leverage YoY                                        │
│  ✗ Lower current ratio YoY                                   │
│  ✓ No share dilution                                         │
│  ✗ Higher gross margin YoY                                   │
│  ✓ Higher asset turnover YoY                                 │
│                                                              │
│  5-year trend:  [sparkline]                                  │
│                                                              │
│  What is this?                                               │
│  A 9-question quiz from Joseph Piotroski (Stanford, 2000)... │
└──────────────────────────────────────────────────────────────┘
```

Each section has:
- **Headline** — score + zone label + colored dot + period-end indicator
- **Component breakdown** — for Piotroski: per-test pass/fail list; for Altman: each component (A–E); for Beneish: 8 component values
- **5-year trend** — small Recharts line chart (same pattern as `<Sparkline>`), one series, no axes labels — minimal visualization
- **"What is this?" section** — always visible, ~3-4 sentences from the ELI5 descriptions, plus thresholds. Italicized in `text-muted-foreground` so it doesn't compete with primary data.

For each score, if `current.piotroskiF` (etc.) is `null`, the section header shows the headline as "—" and the components list shows "Score could not be computed — required line items missing for the most recent annual period." The "What is this?" section is still shown.

For Altman, an additional permanent footnote: *"Best-suited for non-financial manufacturers. Treat with caution for banks, REITs, or pure-software companies."*

For Beneish, an additional permanent footnote: *"This is a suspicion signal, not proof of fraud. Companies above the threshold are statistically similar to known manipulators, not necessarily manipulating."*

### Tab nav

Add `'quality'` to the `DashboardTab` union type and the `TABS` array in `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` (created in today's refactor). Single-file edit thanks to that refactor.

Tab order: Overview · Financials · Technical · News · Filings · Ask · **Quality**.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/compute/quality.ts` | Create | `piotroskiFScore`, `altmanZScore`, `beneishMScore`, `computeQuality`, `AnnualFinancials` + result types — all pure functions, no DB imports |
| `tests/compute/quality.test.ts` | Create | ~10 unit tests covering all three scores + edge cases + Enron M-score fixture |
| `app/(app)/stock/[ticker]/_components/quality-card.tsx` | Create | Compact card for Overview page |
| `app/(app)/stock/[ticker]/page.tsx` | Modify | Add `<QualityCard>` to the dashboard grid |
| `app/(app)/stock/[ticker]/quality/page.tsx` | Create | Server component for `/quality` tab |
| `app/(app)/stock/[ticker]/quality/_components/quality-view.tsx` | Create | Client wrapper |
| `app/(app)/stock/[ticker]/quality/_components/piotroski-section.tsx` | Create | F-score breakdown + sparkline + "What is this?" |
| `app/(app)/stock/[ticker]/quality/_components/altman-section.tsx` | Create | Z-score breakdown + sparkline + "What is this?" |
| `app/(app)/stock/[ticker]/quality/_components/beneish-section.tsx` | Create | M-score breakdown + sparkline + "What is this?" |
| `app/(app)/stock/[ticker]/_components/dashboard-tabs.tsx` | Modify | Add `'quality'` to TABS array + DashboardTab type |

## Testing Matrix

| Layer | Test | Asserts |
|---|---|---|
| `piotroskiFScore` | Perfect 9/9 fixture | score = 9, all tests passed |
| `piotroskiFScore` | Worst 0/9 fixture | score = 0, all failed |
| `piotroskiFScore` | Real AAPL FY2025 vs FY2024 | Score in 6-8 range, specific tests match expectation |
| `piotroskiFScore` | Missing `retainedEarnings` (not used here, but test missing-input handling for `longTermDebt`) | Returns null |
| `altmanZScore` | Safe zone fixture | Z > 2.99, zone = 'safe' |
| `altmanZScore` | Distress zone fixture | Z < 1.81, zone = 'distress' |
| `altmanZScore` | Missing `retainedEarnings` | Returns null |
| `beneishMScore` | Clean stable-ratios fixture | score < −1.78, flag = false |
| `beneishMScore` | Enron FY2000 vs FY1999 (hand-built from published filings) | flag = true |
| `computeQuality` | 5 years of AAPL annuals + market cap | All three scores compute, 5-entry trend, no NaN crashes |

## Rollout (Plan Tasks)

1. **Piotroski F-Score** — `piotroskiFScore` + tests
2. **Altman Z-Score** — `altmanZScore` + tests + `AnnualFinancials` type
3. **Beneish M-Score** — `beneishMScore` + tests including Enron fixture
4. **`computeQuality` wrapper** — pulls fundamentals from DB, computes all three + 5-year trend + integration test
5. **`<QualityCard>` for Overview** — compact 3-row card + slot into existing grid
6. **`/quality` tab page** — server component + three section components + sparkline + "What is this?" boxes
7. **Tab nav update** — add `'quality'` to `DashboardTabs` (1-file edit)
8. **Push + CI + browser smoke** on all 5 tickers

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Line-item names in `fundamentals` don't match what we expect | Medium | Implementation Task 4 confirms exact `lineItem` strings during DB query; null-fallback per missing field |
| Some tickers (e.g., JD as an ADR) might report different line items | Medium | Per-score null returns prevent crashes; UI handles "—" cleanly |
| Beneish M-score has 8 components with mixed signs — easy to make sign error | Medium | Hand-compute one fixture (Enron 2000) against published example; lock the sign convention with that test |
| Score formulas have subtle variants across textbooks | Low | Lock to original published papers (citations in code comments) |
| 5-year trend requires 5+ years of annual data | Low | UI handles missing years gracefully; chart shows what's available |
| Altman Z assumes manufacturing — may mislead for tech/finance companies | Low | Permanent footnote on /quality tab explicitly warns |

## Success Criteria

1. Visiting `/stock/AAPL` shows a "Quality" card with three score readouts in the grid
2. Clicking through to `/stock/AAPL/quality` shows full breakdown for each score + 5-year sparkline + "What is this?" explanation
3. Same for NVDA / MSFT / GOOGL / JD — any missing inputs render as "—" not crashes
4. All compute unit tests pass; CI green
5. The Enron M-score fixture test correctly flags `flag = true`
