# 13F EDGAR Pivot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot the 13F Institutional Holdings feature from Financial Datasets (broken: alphabetical-200 only, no credits) to SEC EDGAR raw 13F-HR XML via the existing Python serverless. Track ~45 curated investors (30 active managers + 15 index giants), one global "Refresh tracked investors" job.

**Architecture:** Per-investor ingestion. Python serverless gains a `thirteen_f_filings` handler that parses SEC's 13F-HR InformationTable XML. Service iterates the 45 CIKs, filters positions to our 6 hardcoded watchlist CUSIPs, upserts via composite unique key. Schema, RLS, compute, UI all stay; only the data source and refresh model change.

**Tech Stack:** Python 3.x serverless (Vercel), Next.js 14, TypeScript strict, Drizzle ORM, Postgres/Neon, Vitest, Tailwind/shadcn, Recharts.

**Spec:** `docs/superpowers/specs/2026-05-28-13f-edgar-pivot-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/providers/financial-datasets.ts` | Modify | Delete `institutionalOwnership()` method |
| `lib/providers/types.ts` | Modify | Delete `HoldingsMeta` interface |
| `lib/providers/__fixtures__/fd-institutional-ownership-aapl.json` | Delete | Dead fixture |
| `tests/providers/financial-datasets.test.ts` | Modify | Delete `.institutionalOwnership()` describe block |
| `lib/compute/cusip-map.ts` | Create | Watchlist CUSIP ↔ ticker mapping |
| `tests/compute/cusip-map.test.ts` | Create | 3 unit tests |
| `lib/compute/smart-money.ts` | Modify | Add `INDEX_GIANTS` + `getReverseLookupCiks()` |
| `tests/compute/smart-money.test.ts` | Modify | Add 2 tests for new exports |
| `api/fallback/sec.py` | Modify | Add `thirteen_f_filings` handler |
| `lib/providers/__fixtures__/sec-13f-berkshire-2026q1.xml` | Create | Sample InformationTable XML fixture |
| `lib/providers/sec-edgar.ts` | Modify | Add `thirteenFFilings(cik)` method + types |
| `tests/providers/sec-edgar.test.ts` | Modify | Add `.thirteenFFilings()` describe block (3 tests) |
| `lib/services/holdings.ts` | Rewrite | `refreshTrackedInvestors` replaces `refresh`; new `EnrichedHolding` |
| `tests/integration/holdings-service.test.ts` | Rewrite | New mock shape, 6 integration tests |
| `app/api/holdings/refresh-tracked/route.ts` | Create | Global refresh endpoint |
| `tests/integration/api-holdings-refresh-tracked.test.ts` | Create | 2 API tests |
| `app/api/tickers/[symbol]/holdings/route.ts` | Modify | Delete POST handler, keep GET |
| `tests/integration/api-tickers-holdings.test.ts` | Modify | Drop POST tests, keep GET tests |
| `app/(app)/stock/[ticker]/_components/holdings-card.tsx` | Modify | Relabel copy |
| `app/(app)/stock/[ticker]/holdings/_components/holdings-aggregate-panel.tsx` | Modify | Relabel copy |
| `app/(app)/stock/[ticker]/holdings/_components/holdings-view.tsx` | Modify | Relabel, drop smart-money filter, use EnrichedHolding |
| `scripts/try-13f.ts` | Modify | No ticker arg, call global refresh |
| `tests/integration/institutional-holdings-rls.test.ts` | Unchanged | Stays green |

---

## Task 1: Delete FD-specific dead code

**Files:**
- Modify: `lib/providers/financial-datasets.ts`
- Modify: `lib/providers/types.ts`
- Delete: `lib/providers/__fixtures__/fd-institutional-ownership-aapl.json`
- Modify: `tests/providers/financial-datasets.test.ts`

This is the easy clean-slate task. The FD institutional ownership code is dead; remove it before adding the new code so the codebase reflects the pivot decision clearly.

- [ ] **Step 1.1: Delete `institutionalOwnership()` from `lib/providers/financial-datasets.ts`**

Open the file, find the method block:
```ts
async institutionalOwnership(
  ticker: string,
  opts: { limit?: number; reportPeriodGte?: string; reportPeriodLte?: string } = {}
): Promise<HoldingsMeta[]> {
  // ...
}
```
Delete the entire method. Also remove `HoldingsMeta` from the import list from `./types` at the top of the file.

- [ ] **Step 1.2: Delete `HoldingsMeta` from `lib/providers/types.ts`**

Find the interface block (it's at or near the bottom of the file):
```ts
export interface HoldingsMeta {
  // ...
}
```
Delete the entire interface and any trailing comment.

- [ ] **Step 1.3: Delete the fixture file**

```bash
rm "lib/providers/__fixtures__/fd-institutional-ownership-aapl.json"
```

- [ ] **Step 1.4: Delete the `.institutionalOwnership()` describe block in `tests/providers/financial-datasets.test.ts`**

Find the entire block:
```ts
describe('.institutionalOwnership()', () => {
  // 5 tests
});
```
Delete the entire describe block.

- [ ] **Step 1.5: Run tests to confirm nothing else breaks**

```bash
pnpm test -- tests/providers/financial-datasets.test.ts
pnpm typecheck
```
Expected: tests pass with the 5 deleted tests gone (test count drops by 5), typecheck clean. If anything else imports `HoldingsMeta`, fix it — but only `lib/services/holdings.ts` should, and we're about to rewrite that.

- [ ] **Step 1.6: Commit**

```bash
git add lib/providers/financial-datasets.ts lib/providers/types.ts \
        lib/providers/__fixtures__/ tests/providers/financial-datasets.test.ts
git commit -m "$(cat <<'EOF'
refactor(13f): delete FD institutional-ownership dead code

FD's by-ticker endpoint can only return the alphabetical first 200
filers (no sort/pagination) and the FD account is out of credits.
Pivot to SEC EDGAR 13F-HR; this commit removes the FD-specific code
ahead of the pivot work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: CUSIP ↔ ticker mapping

**Files:**
- Create: `lib/compute/cusip-map.ts`
- Create: `tests/compute/cusip-map.test.ts`

- [ ] **Step 2.1: Write failing tests first**

Create `tests/compute/cusip-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { tickerForCusip, watchlistCusips, CUSIP_BY_TICKER } from '@/lib/compute/cusip-map';

describe('cusip-map', () => {
  it('maps known CUSIPs back to tickers', () => {
    expect(tickerForCusip('037833100')).toBe('AAPL');
    expect(tickerForCusip('67066G104')).toBe('NVDA');
    expect(tickerForCusip('594918104')).toBe('MSFT');
  });

  it('is case-insensitive on lookup (CUSIPs use uppercase letters)', () => {
    expect(tickerForCusip('67066g104')).toBe('NVDA');
    expect(tickerForCusip('02079K305')).toBe('GOOGL');
  });

  it('returns null for unknown CUSIPs', () => {
    expect(tickerForCusip('000000000')).toBeNull();
    expect(tickerForCusip('UNKNOWN12')).toBeNull();
  });

  it('watchlistCusips returns 6 entries', () => {
    expect(watchlistCusips()).toHaveLength(6);
    expect(watchlistCusips()).toContain('037833100');   // AAPL
  });

  it('CUSIP_BY_TICKER has the expected 6 keys', () => {
    expect(Object.keys(CUSIP_BY_TICKER).sort()).toEqual(
      ['AAPL', 'GOOGL', 'JD', 'MSFT', 'NVDA', 'TSLA']
    );
  });
});
```

- [ ] **Step 2.2: Run tests to confirm they fail**

```bash
pnpm test -- tests/compute/cusip-map.test.ts
```
Expected: 5 tests fail with `Cannot find module '@/lib/compute/cusip-map'`.

- [ ] **Step 2.3: Implement `lib/compute/cusip-map.ts`**

Create the file:

```ts
/**
 * CUSIP-to-ticker mapping for our watchlist.
 *
 * 13F filings use CUSIP (9-character security identifier), not ticker
 * symbols. CUSIPs verified against SEC EDGAR issuer pages.
 *
 * To add a watchlist ticker: look up its CUSIP at
 *   https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<ticker>
 * (the CUSIP appears in the company's filings header) and add one line
 * to CUSIP_BY_TICKER below.
 */

export const CUSIP_BY_TICKER: Readonly<Record<string, string>> = {
  AAPL:  '037833100',
  NVDA:  '67066G104',
  MSFT:  '594918104',
  GOOGL: '02079K305',     // Class A; GOOG is 02079K107 — Class A only in watchlist
  TSLA:  '88160R101',
  JD:    '47215P106'
};

const TICKER_BY_CUSIP: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CUSIP_BY_TICKER).map(([t, c]) => [c.toUpperCase(), t])
);

/**
 * Look up the watchlist ticker for a CUSIP. Returns null if the CUSIP
 * is not on the watchlist (e.g. a fund's other positions).
 */
export function tickerForCusip(cusip: string): string | null {
  return TICKER_BY_CUSIP[cusip.toUpperCase()] ?? null;
}

/**
 * All CUSIPs on the current watchlist. Used to filter incoming 13F
 * position rows before insert.
 */
export function watchlistCusips(): string[] {
  return Object.values(CUSIP_BY_TICKER);
}
```

- [ ] **Step 2.4: Run tests to confirm they pass**

```bash
pnpm test -- tests/compute/cusip-map.test.ts
```
Expected: 5 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add lib/compute/cusip-map.ts tests/compute/cusip-map.test.ts
git commit -m "$(cat <<'EOF'
feat(13f): cusip-map for watchlist CUSIP↔ticker lookup

Hardcoded 6 entries (AAPL/NVDA/MSFT/GOOGL/TSLA/JD). 13F filings use
CUSIP, not ticker; the service uses this to filter incoming positions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend smart-money with INDEX_GIANTS + getReverseLookupCiks

**Files:**
- Modify: `lib/compute/smart-money.ts`
- Modify: `tests/compute/smart-money.test.ts`

The existing `SMART_MONEY` constant (30 active managers) stays. This task adds the 15 index-giant managers and a helper that returns the union of all 45 CIKs — the canonical "investors to fetch from EDGAR" list.

- [ ] **Step 3.1: Write failing tests first**

Append these tests to `tests/compute/smart-money.test.ts` AFTER the existing tests (don't modify existing ones):

```ts
describe('INDEX_GIANTS + getReverseLookupCiks', () => {
  it('INDEX_GIANTS has 15 entries spanning the major index houses', async () => {
    const { INDEX_GIANTS } = await import('@/lib/compute/smart-money');
    expect(INDEX_GIANTS).toHaveLength(15);
    const names = INDEX_GIANTS.map((g) => g.name);
    expect(names).toContain('Vanguard Group');
    expect(names).toContain('BlackRock');
    expect(names).toContain('State Street');
  });

  it('getReverseLookupCiks returns 45 unique CIKs (30 SMART_MONEY + 15 INDEX_GIANTS)', async () => {
    const { getReverseLookupCiks, SMART_MONEY, INDEX_GIANTS } = await import('@/lib/compute/smart-money');
    const ciks = getReverseLookupCiks();
    // De-duped union of two sets
    expect(ciks.length).toBe(SMART_MONEY.length + INDEX_GIANTS.length);
    expect(new Set(ciks).size).toBe(ciks.length);
  });

  it('getReverseLookupCiks: every cik is 10-digit zero-padded', async () => {
    const { getReverseLookupCiks } = await import('@/lib/compute/smart-money');
    for (const c of getReverseLookupCiks()) {
      expect(c).toMatch(/^\d{10}$/);
    }
  });
});
```

(Why dynamic `await import`: the existing tests at the top of the file likely use static `import { SMART_MONEY } from '@/lib/compute/smart-money'`. If you can static-import everything cleanly without breaking the existing tests, do that instead — dynamic imports are only needed if the static imports conflict.)

- [ ] **Step 3.2: Run tests to confirm they fail**

```bash
pnpm test -- tests/compute/smart-money.test.ts
```
Expected: the 3 new tests fail with `INDEX_GIANTS is undefined` or `getReverseLookupCiks is not a function`. The existing tests continue passing.

- [ ] **Step 3.3: Add `INDEX_GIANTS` and `getReverseLookupCiks` to `lib/compute/smart-money.ts`**

Open the file. AFTER the existing `SMART_MONEY` constant, add:

```ts
/**
 * The "passive giants" — index funds + ETF sponsors that don't make
 * conviction calls but dominate 13F filings by AUM. Included so the
 * holdings refresh fetches their positions for correct top-10
 * concentration math. Not flagged as "smart money" in the UI; they
 * are not in SMART_MONEY's smart-money matcher.
 */
export const INDEX_GIANTS: ReadonlyArray<{ cik: string; name: string }> = [
  { cik: '0000102909', name: 'Vanguard Group' },
  { cik: '0001364742', name: 'BlackRock' },
  { cik: '0000093751', name: 'State Street' },
  { cik: '0000315066', name: 'Fidelity (FMR)' },
  { cik: '0000080424', name: 'T. Rowe Price' },
  { cik: '0000895421', name: 'Morgan Stanley' },
  { cik: '0000886982', name: 'Goldman Sachs' },
  { cik: '0000019617', name: 'JPMorgan Chase' },
  { cik: '0000050166', name: 'Wells Fargo & Co.' },
  { cik: '0000895646', name: 'Bank of America' },
  { cik: '0000034088', name: 'Northern Trust' },
  { cik: '0000037996', name: 'Bank of New York Mellon' },
  { cik: '0001039765', name: 'Capital Research Global Investors' },
  { cik: '0000866787', name: 'Wellington Management' },
  { cik: '0000800240', name: 'Geode Capital Management' }
];

/**
 * All investors to fetch from SEC EDGAR during a holdings refresh.
 * Union of SMART_MONEY (30 active managers) + INDEX_GIANTS (15
 * passive giants). Deduplicated by CIK. Every CIK is 10-digit
 * zero-padded.
 */
export function getReverseLookupCiks(): string[] {
  const ciks = new Set<string>();
  for (const e of SMART_MONEY) ciks.add(e.cik);
  for (const g of INDEX_GIANTS) ciks.add(g.cik);
  return Array.from(ciks);
}
```

- [ ] **Step 3.4: Run tests to confirm they pass**

```bash
pnpm test -- tests/compute/smart-money.test.ts
```
Expected: all existing tests + 3 new tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add lib/compute/smart-money.ts tests/compute/smart-money.test.ts
git commit -m "$(cat <<'EOF'
feat(13f): add INDEX_GIANTS + getReverseLookupCiks to smart-money

15 index-AUM giants (Vanguard / BlackRock / State Street / Fidelity /
etc.) join the existing 30 active managers as the canonical list of
investors the service fetches from SEC EDGAR. getReverseLookupCiks()
returns the deduped union, all 10-digit zero-padded.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Python serverless — `thirteen_f_filings` handler + fixture

**Files:**
- Create: `lib/providers/__fixtures__/sec-13f-berkshire-2026q1.xml`
- Modify: `api/fallback/sec.py`

The Python serverless adds a new `kind` value handler. The handler fetches an investor's submissions index, finds recent 13F-HR filings, downloads the InformationTable XML for each, and parses positions.

- [ ] **Step 4.1: Create a minimal fixture XML**

Create `lib/providers/__fixtures__/sec-13f-berkshire-2026q1.xml`. A real 13F-HR InformationTable looks like this (simplified to 3 positions — AAPL, Bank of America, Coca-Cola — representing what Berkshire's actual filing looks like):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>APPLE INC</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>037833100</cusip>
    <value>263012040</value>
    <shrsOrPrnAmt>
      <sshPrnamt>905560000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority>
      <Sole>905560000</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
  <infoTable>
    <nameOfIssuer>BANK OF AMERICA CORP</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>060505104</cusip>
    <value>30000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>700000000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority>
      <Sole>700000000</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
  <infoTable>
    <nameOfIssuer>COCA COLA CO</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>191216100</cusip>
    <value>25000000</value>
    <shrsOrPrnAmt>
      <sshPrnamt>400000000</sshPrnamt>
      <sshPrnamtType>SH</sshPrnamtType>
    </shrsOrPrnAmt>
    <investmentDiscretion>SOLE</investmentDiscretion>
    <votingAuthority>
      <Sole>400000000</Sole>
      <Shared>0</Shared>
      <None>0</None>
    </votingAuthority>
  </infoTable>
</informationTable>
```

Note: SEC's `<value>` element reports value in thousands of dollars. So AAPL's $263,012,040 in the XML represents $263,012,040,000 (≈$263B). The Python parser MUST multiply by 1000.

- [ ] **Step 4.2: Read the existing `api/fallback/sec.py` to understand the dispatcher pattern**

```bash
head -80 api/fallback/sec.py
```

You'll see a `BaseHTTPRequestHandler` subclass with a `do_GET` method that switches on the `kind` query parameter, dispatching to per-kind handler functions. The existing kinds are `resolve_cik`, `index`, `filing`. You'll add `thirteen_f_filings` to that switch.

There's also a rate-limiting helper that gates outbound SEC requests (`MIN_INTERVAL_SECONDS = 0.21`). Reuse it for all SEC calls.

- [ ] **Step 4.3: Implement the handler in `api/fallback/sec.py`**

The natural shape (adapt names to match the existing dispatcher):

1. Add a top-level constant near the other regex/section patterns:
   ```python
   THIRTEEN_F_FORMS = ('13F-HR', '13F-HR/A')
   INFOTABLE_NAMESPACE = '{http://www.sec.gov/edgar/document/thirteenf/informationtable}'
   ```

2. Add a parser function (place near the existing parser helpers):
   ```python
   def _parse_information_table(xml_bytes: bytes) -> list[dict]:
       """
       Parse a 13F-HR InformationTable XML into a list of position dicts.
       SEC reports <value> in thousands of dollars — multiply by 1000 for value_usd.
       """
       if BeautifulSoup is None:
           raise RuntimeError("BeautifulSoup not installed")
       soup = BeautifulSoup(xml_bytes, 'xml')
       positions = []
       for info in soup.find_all('infoTable'):
           cusip_el = info.find('cusip')
           value_el = info.find('value')
           shares_el = info.find('sshPrnamt')
           shares_type_el = info.find('sshPrnamtType')
           name_el = info.find('nameOfIssuer')
           class_el = info.find('titleOfClass')
           if not (cusip_el and value_el and shares_el):
               continue
           try:
               value_thousands = int(value_el.text.strip())
               shares = int(shares_el.text.strip())
           except (ValueError, AttributeError):
               continue
           positions.append({
               'cusip': cusip_el.text.strip(),
               'issuer_name': name_el.text.strip() if name_el else '',
               'class_title': class_el.text.strip() if class_el else '',
               'value_usd': value_thousands * 1000,
               'shares': shares,
               'shares_type': shares_type_el.text.strip() if shares_type_el else 'SH'
           })
       return positions
   ```

3. Add the main handler function:
   ```python
   def _handle_thirteen_f_filings(cik: str) -> tuple[int, dict]:
       """
       Fetch the investor's submissions index, find recent 13F-HR filings
       (up to 8), download each InformationTable XML, return parsed positions.
       """
       global SESSION
       if SESSION is None:
           SESSION = requests.Session()
           SESSION.headers.update({'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip, deflate'})

       cik_padded = cik.zfill(10)
       cik_unpadded = str(int(cik_padded))

       # Step 1: investor submissions index
       _wait_for_rate_limit()
       sub_url = f'https://data.sec.gov/submissions/CIK{cik_padded}.json'
       r = SESSION.get(sub_url, timeout=20)
       if r.status_code == 404:
           return 404, {'error': 'investor not found', 'kind': 'thirteen_f_filings', 'cik': cik_padded}
       if r.status_code != 200:
           return r.status_code, {'error': f'SEC submissions index returned {r.status_code}', 'kind': 'thirteen_f_filings'}
       sub_json = r.json()
       investor_name = sub_json.get('name', '')

       # Recent filings — pull form_type + accession + filing_date + report_date
       recent = sub_json.get('filings', {}).get('recent', {})
       forms = recent.get('form', [])
       accessions = recent.get('accessionNumber', [])
       filing_dates = recent.get('filingDate', [])
       report_dates = recent.get('reportDate', [])

       targets = []
       for form, acc, fdate, rdate in zip(forms, accessions, filing_dates, report_dates):
           if form in THIRTEEN_F_FORMS:
               targets.append({'accession': acc, 'filing_date': fdate, 'report_period': rdate, 'form_type': form})
               if len(targets) >= 8:
                   break

       filings = []
       for t in targets:
           acc_no_dashes = t['accession'].replace('-', '')
           archive_dir = f'https://www.sec.gov/Archives/edgar/data/{cik_unpadded}/{acc_no_dashes}/'

           # Step 2: filing's index.json — find the InformationTable XML filename
           _wait_for_rate_limit()
           idx_r = SESSION.get(archive_dir + 'index.json', timeout=20)
           if idx_r.status_code != 200:
               # skip this filing — log via the JSON response shape (Python serverless has no logger here)
               continue
           idx_json = idx_r.json()
           items = idx_json.get('directory', {}).get('item', [])
           info_filename = None
           for item in items:
               name = item.get('name', '')
               if 'informationtable' in name.lower() and name.lower().endswith('.xml'):
                   info_filename = name
                   break
           if not info_filename:
               continue

           # Step 3: download + parse InformationTable XML
           _wait_for_rate_limit()
           xml_r = SESSION.get(archive_dir + info_filename, timeout=30)
           if xml_r.status_code != 200:
               continue
           try:
               positions = _parse_information_table(xml_r.content)
           except Exception:
               continue

           filings.append({
               'accession': t['accession'],
               'filing_date': t['filing_date'],
               'report_period': t['report_period'],
               'form_type': t['form_type'],
               'positions': positions
           })

       return 200, {
           'cik': cik_padded,
           'investor_name': investor_name,
           'filings': filings
       }
   ```

4. Wire into the dispatcher. Find the `do_GET` method's switch — wherever it dispatches on `kind`, add:
   ```python
   elif kind == 'thirteen_f_filings':
       cik = (params.get('cik') or [None])[0]
       if not cik:
           self._send_json(400, {'error': "'cik' is required", 'kind': 'thirteen_f_filings'})
           return
       status, body = _handle_thirteen_f_filings(cik)
       self._send_json(status, body)
   ```

   If the existing dispatcher uses a different style (e.g. a dictionary mapping kind → function), adapt to match. Look at how `index` and `filing` are wired and mirror that.

5. Verify `_wait_for_rate_limit` exists in the existing file (it's the rate-limiter for SEC calls). If it's named differently (e.g. `_throttle()` or `_rate_limit()`), use the actual existing name.

- [ ] **Step 4.4: Add inline assertion tests at the bottom of `api/fallback/sec.py`**

The existing file likely has a `if __name__ == '__main__':` block with inline assertion tests for the other handlers. Add tests for `_parse_information_table` next to those:

```python
    # Inline assertions for _parse_information_table
    import pathlib
    fixture_path = pathlib.Path(__file__).resolve().parents[1] / 'lib' / 'providers' / '__fixtures__' / 'sec-13f-berkshire-2026q1.xml'
    if fixture_path.exists():
        with open(fixture_path, 'rb') as f:
            xml_bytes = f.read()
        positions = _parse_information_table(xml_bytes)
        assert len(positions) == 3, f"expected 3 positions, got {len(positions)}"
        aapl = next(p for p in positions if p['cusip'] == '037833100')
        assert aapl['issuer_name'] == 'APPLE INC', f"expected APPLE INC, got {aapl['issuer_name']!r}"
        # SEC reports value in thousands; parser multiplies by 1000
        assert aapl['value_usd'] == 263_012_040_000, f"expected 263012040000, got {aapl['value_usd']}"
        assert aapl['shares'] == 905_560_000
        assert aapl['shares_type'] == 'SH'
        print('[thirteen_f_filings] inline assertions PASS')
    else:
        print(f'[thirteen_f_filings] fixture not found at {fixture_path}, skipping inline test')
```

If the existing file uses a different inline-test pattern (e.g. separate `assert_*` functions called at the bottom), use that style instead.

- [ ] **Step 4.5: Run the inline assertion test**

```bash
python api/fallback/sec.py
```
Expected output: `[thirteen_f_filings] inline assertions PASS` plus whatever the existing inline tests print. If you see `BeautifulSoup not installed`, install: `pip install beautifulsoup4 lxml`.

- [ ] **Step 4.6: Commit**

```bash
git add api/fallback/sec.py lib/providers/__fixtures__/sec-13f-berkshire-2026q1.xml
git commit -m "$(cat <<'EOF'
feat(13f): Python serverless thirteen_f_filings handler

Extends api/fallback/sec.py with a new kind=thirteen_f_filings handler.
Given a CIK, fetches the investor's submissions index, walks the most
recent 8 13F-HR filings, downloads each filing's InformationTable XML
via the SEC index.json manifest, parses positions (multiplying SEC's
thousands-of-dollars value by 1000 for value_usd).

Returns { cik, investor_name, filings: [{accession, filing_date,
report_period, form_type, positions: [...]}] }. Reuses existing
USER_AGENT + rate-limit machinery. Inline assertion test against
a 3-position Berkshire fixture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: TS provider — `thirteenFFilings(cik)` method

**Files:**
- Modify: `lib/providers/sec-edgar.ts`
- Modify: `tests/providers/sec-edgar.test.ts`

The TS adapter wraps the Python serverless `thirteen_f_filings` endpoint, exposing typed `ThirteenFInvestor` / `ThirteenFFiling` / `ThirteenFPosition` types.

- [ ] **Step 5.1: Write failing tests first**

Append to `tests/providers/sec-edgar.test.ts` (inside the existing top-level `describe('SecEdgarProvider', ...)` block, after the existing methods):

```ts
  describe('.thirteenFFilings()', () => {
    it('calls /api/fallback/sec?kind=thirteen_f_filings&cik=<CIK> and maps to camelCase', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        cik: '0001067983',
        investor_name: 'BERKSHIRE HATHAWAY INC',
        filings: [
          {
            accession: '0001067983-26-000001',
            filing_date: '2026-05-14',
            report_period: '2026-03-31',
            form_type: '13F-HR',
            positions: [
              {
                cusip: '037833100',
                issuer_name: 'APPLE INC',
                class_title: 'COM',
                value_usd: 263012040000,
                shares: 905560000,
                shares_type: 'SH'
              }
            ]
          }
        ]
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.thirteenFFilings('0001067983');

      const calledUrl = fetchMock.mock.calls[0]![0] as string;
      expect(calledUrl).toContain('kind=thirteen_f_filings');
      expect(calledUrl).toContain('cik=0001067983');
      expect(result.cik).toBe('0001067983');
      expect(result.investorName).toBe('BERKSHIRE HATHAWAY INC');
      expect(result.filings).toHaveLength(1);
      expect(result.filings[0]!.reportPeriod).toBe('2026-03-31');
      expect(result.filings[0]!.positions[0]!.valueUsd).toBe(263012040000);
      expect(result.filings[0]!.positions[0]!.sharesType).toBe('SH');
    });

    it('returns empty filings array when investor has no 13F-HRs', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
        cik: '0001234567', investor_name: 'SMALL FUND', filings: []
      }));
      const provider = makeProvider(fetchMock);
      const result = await provider.thirteenFFilings('0001234567');
      expect(result.filings).toEqual([]);
    });

    it('maps 404 from the serverless to NotFoundError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
      const provider = makeProvider(fetchMock);
      await expect(provider.thirteenFFilings('0001067983')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
```

Note: the existing `tests/providers/sec-edgar.test.ts` file should already have `makeProvider`, `jsonResponse`, `NotFoundError` helpers from Slice 2A's tests. If they're missing or named differently, look at the existing tests in that file and adapt.

- [ ] **Step 5.2: Run tests, confirm 3 fail**

```bash
pnpm test -- tests/providers/sec-edgar.test.ts
```
Expected: 3 new tests fail with `provider.thirteenFFilings is not a function`.

- [ ] **Step 5.3: Add types + method to `lib/providers/sec-edgar.ts`**

First, define the types. Find the existing type definitions in the file (likely near the top) and add:

```ts
export interface ThirteenFPosition {
  cusip: string;
  issuerName: string;
  classTitle: string;
  valueUsd: number;
  shares: number;
  sharesType: string;
}

export interface ThirteenFFiling {
  accession: string;
  filingDate: string;          // YYYY-MM-DD
  reportPeriod: string;        // YYYY-MM-DD
  formType: string;
  positions: ThirteenFPosition[];
}

export interface ThirteenFInvestor {
  cik: string;
  investorName: string;
  filings: ThirteenFFiling[];
}
```

Then add the method to the `SecEdgarProvider` class. Look at how the existing methods (`resolveCik`, `listFilings`, `fetchFiling`, etc.) construct URLs and parse responses — match that style. The method:

```ts
  async thirteenFFilings(cik: string): Promise<ThirteenFInvestor> {
    const params = new URLSearchParams({ kind: 'thirteen_f_filings', cik });
    const url = `${this.baseUrl}/api/fallback/sec?${params.toString()}`;
    const res = await this.fetchImpl(url);
    if (res.status === 404) throw new NotFoundError(`SEC 13F filings not found for CIK ${cik}`);
    if (res.status === 429) throw new RateLimitError('SEC rate limit hit');
    if (!res.ok) throw new Error(`SEC 13F filings failed: HTTP ${res.status}`);
    const body = await res.json() as {
      cik: string;
      investor_name: string;
      filings: Array<{
        accession: string;
        filing_date: string;
        report_period: string;
        form_type: string;
        positions: Array<{
          cusip: string;
          issuer_name: string;
          class_title: string;
          value_usd: number;
          shares: number;
          shares_type: string;
        }>;
      }>;
    };
    return {
      cik: body.cik,
      investorName: body.investor_name,
      filings: body.filings.map((f) => ({
        accession: f.accession,
        filingDate: f.filing_date,
        reportPeriod: f.report_period,
        formType: f.form_type,
        positions: f.positions.map((p) => ({
          cusip: p.cusip,
          issuerName: p.issuer_name,
          classTitle: p.class_title,
          valueUsd: p.value_usd,
          shares: p.shares,
          sharesType: p.shares_type
        }))
      }))
    };
  }
```

If `this.fetchImpl`, `this.baseUrl`, or the error classes are named differently in the actual file, match the existing conventions.

- [ ] **Step 5.4: Run tests, confirm all pass**

```bash
pnpm test -- tests/providers/sec-edgar.test.ts
```
Expected: all existing + 3 new tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add lib/providers/sec-edgar.ts tests/providers/sec-edgar.test.ts
git commit -m "$(cat <<'EOF'
feat(13f): SecEdgarProvider.thirteenFFilings(cik) method + types

Wraps the Python serverless thirteen_f_filings kind. Maps snake_case
wire format to camelCase ThirteenFInvestor / ThirteenFFiling /
ThirteenFPosition. Standard NotFoundError / RateLimitError mapping.
3 unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `HoldingsService.refreshTrackedInvestors()` rewrite

**Files:**
- Rewrite: `lib/services/holdings.ts`
- Rewrite: `tests/integration/holdings-service.test.ts`

The service swaps `fdProvider` for `secProvider`, drops `refresh(ticker)`, adds `refreshTrackedInvestors()`. Plus a new `EnrichedHolding` interface that `getList` returns (carrying delta + smart-money info inline), which lets the UI drop its `HoldingPlus` workaround.

- [ ] **Step 6.1: Write the failing integration tests first**

Rewrite `tests/integration/holdings-service.test.ts` from scratch — the old shape (per-ticker refresh, FD mock) doesn't apply anymore.

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, institutionalHoldings, refreshRuns } from '@/lib/db/schema';
import { HoldingsService } from '@/lib/services/holdings';
import type { ThirteenFInvestor } from '@/lib/providers/sec-edgar';

config({ path: '.env.local' });

/**
 * Build a per-CIK lookup table from a flat array of ThirteenFInvestor.
 * The mock returns the matching investor (or an empty-filings stub) for
 * any CIK the service requests.
 */
function mockSecProvider(investors: ThirteenFInvestor[]) {
  const byCik = new Map<string, ThirteenFInvestor>(investors.map((i) => [i.cik, i]));
  return {
    thirteenFFilings: vi.fn(async (cik: string): Promise<ThirteenFInvestor> => {
      const padded = cik.padStart(10, '0');
      return byCik.get(padded) ?? { cik: padded, investorName: 'UNKNOWN', filings: [] };
    })
  };
}

function position(cusip: string, issuerName: string, shares: number, valueUsd: number) {
  return {
    cusip,
    issuerName,
    classTitle: 'COM',
    valueUsd,
    shares,
    sharesType: 'SH'
  };
}

function filing(reportPeriod: string, positions: ReturnType<typeof position>[]) {
  return {
    accession: `acc-${reportPeriod}`,
    filingDate: reportPeriod,
    reportPeriod,
    formType: '13F-HR',
    positions
  };
}

function berkshire(filings: ReturnType<typeof filing>[]): ThirteenFInvestor {
  return { cik: '0001067983', investorName: 'BERKSHIRE HATHAWAY INC', filings };
}

function vanguard(filings: ReturnType<typeof filing>[]): ThirteenFInvestor {
  return { cik: '0000102909', investorName: 'VANGUARD GROUP', filings };
}

describe('HoldingsService.refreshTrackedInvestors', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    // Seed companies for all 6 watchlist tickers — required by the FK
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL',  name: 'Apple',     cik: null },
      { ticker: 'NVDA',  name: 'NVIDIA',    cik: null },
      { ticker: 'MSFT',  name: 'Microsoft', cik: null },
      { ticker: 'GOOGL', name: 'Alphabet',  cik: null },
      { ticker: 'TSLA',  name: 'Tesla',     cik: null },
      { ticker: 'JD',    name: 'JD.com',    cik: null }
    ]);
  });

  it('happy path: fetches all CIKs, filters to watchlist CUSIPs, inserts rows, writes refresh_runs', async () => {
    const sec = mockSecProvider([
      berkshire([
        filing('2026-03-31', [
          position('037833100', 'APPLE INC', 905_560_000, 263_012_040_000),    // AAPL — watchlist
          position('060505104', 'BANK OF AMERICA CORP', 700_000_000, 30_000_000_000) // NOT watchlist
        ])
      ]),
      vanguard([
        filing('2026-03-31', [
          position('037833100', 'APPLE INC', 1_377_000_000, 400_000_000_000),  // AAPL — watchlist
          position('594918104', 'MICROSOFT CORP', 890_000_000, 360_000_000_000) // MSFT — watchlist
        ])
      ])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    const summary = await svc.refreshTrackedInvestors();

    expect(summary.investorsAttempted).toBeGreaterThanOrEqual(2);
    expect(summary.investorsSucceeded).toBeGreaterThanOrEqual(2);
    // 3 positions land (Berkshire AAPL + Vanguard AAPL + Vanguard MSFT)
    // — BAC was filtered as off-watchlist
    expect(summary.newRows).toBe(3);

    const aaplRows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    expect(aaplRows).toHaveLength(2);
    const msftRows = await dbH.db.select().from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'MSFT'));
    expect(msftRows).toHaveLength(1);

    const runs = await dbH.db.select().from(refreshRuns);
    const holdingsRuns = runs.filter((r) => r.kind === 'holdings');
    expect(holdingsRuns).toHaveLength(1);
    expect(holdingsRuns[0]!.ticker).toBe('*');     // sentinel
    expect(holdingsRuns[0]!.ok).toBe(true);
  });

  it('idempotent: second call inserts zero new rows', async () => {
    const sec = mockSecProvider([
      berkshire([filing('2026-03-31', [position('037833100', 'APPLE INC', 905_560_000, 263_012_040_000)])])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    await svc.refreshTrackedInvestors();
    const second = await svc.refreshTrackedInvestors();

    expect(second.newRows).toBe(0);
    const all = await dbH.db.select().from(institutionalHoldings);
    expect(all).toHaveLength(1);
  });

  it('prunes rows older than 8 quarters per ticker', async () => {
    const periods = [
      '2026-03-31','2025-12-31','2025-09-30','2025-06-30',
      '2025-03-31','2024-12-31','2024-09-30','2024-06-30',
      '2024-03-31','2023-12-31'    // last 2 should be pruned
    ];
    const sec = mockSecProvider([
      berkshire(periods.map((p) => filing(p, [position('037833100', 'APPLE INC', 100, 100_000_000)])))
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    await svc.refreshTrackedInvestors();

    const rows = await dbH.db.select({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings).where(eq(institutionalHoldings.ticker, 'AAPL'));
    const remaining = new Set(rows.map((r) => r.p));
    expect(remaining.size).toBe(8);
    expect(remaining.has('2024-03-31')).toBe(false);
    expect(remaining.has('2023-12-31')).toBe(false);
  });

  it('skips positions for CUSIPs not on the watchlist', async () => {
    const sec = mockSecProvider([
      berkshire([
        filing('2026-03-31', [
          position('999999999', 'UNKNOWN CORP', 1000, 1_000_000),
          position('888888888', 'ANOTHER CORP', 2000, 2_000_000)
        ])
      ])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    const summary = await svc.refreshTrackedInvestors();

    expect(summary.newRows).toBe(0);   // nothing matched the watchlist
    const all = await dbH.db.select().from(institutionalHoldings);
    expect(all).toHaveLength(0);
  });

  it('partial failure: one investor throws, others continue', async () => {
    const failingCik = '0001067983';   // Berkshire — first in our list
    const sec = {
      thirteenFFilings: vi.fn(async (cik: string) => {
        const padded = cik.padStart(10, '0');
        if (padded === failingCik) throw new Error('SEC 500');
        if (padded === '0000102909') {
          return vanguard([filing('2026-03-31', [position('037833100', 'APPLE INC', 100, 100_000_000)])]);
        }
        return { cik: padded, investorName: 'UNKNOWN', filings: [] };
      })
    };
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });

    const summary = await svc.refreshTrackedInvestors();

    expect(summary.investorsFailed).toBeGreaterThanOrEqual(1);
    expect(summary.investorsSucceeded).toBeGreaterThanOrEqual(1);
    expect(summary.newRows).toBe(1);   // Vanguard's AAPL position landed
  });

  it('getList: returns enriched rows with delta info computed against the previous quarter', async () => {
    const sec = mockSecProvider([
      berkshire([
        filing('2026-03-31', [position('037833100', 'APPLE INC', 110_000_000, 32_000_000_000)]),
        filing('2025-12-31', [position('037833100', 'APPLE INC', 100_000_000, 29_000_000_000)])
      ])
    ]);
    const svc = new HoldingsService({ db: dbH.db, secProvider: sec as any });
    await svc.refreshTrackedInvestors();

    const list = await svc.getList('AAPL', '2026-03-31', 100);
    expect(list).toHaveLength(1);
    expect(list[0]!.delta).toBe('added');
    expect(list[0]!.sharesPrev).toBe(100_000_000);
    expect(list[0]!.isSmartMoney).toBe(true);
    expect(list[0]!.smartMoneyCategory).toBe('value');
  });
});
```

- [ ] **Step 6.2: Run integration tests, confirm all fail**

```bash
pnpm test:integration -- holdings-service
```
Expected: 6 tests fail. Either `Cannot find module` (if you replace the file) or signature mismatch errors (if the old `refresh` is gone but the new `refreshTrackedInvestors` doesn't exist yet).

- [ ] **Step 6.3: Rewrite `lib/services/holdings.ts`**

The new file in full. Comments call out what changed vs. the old shape.

```ts
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { institutionalHoldings, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import type { ThirteenFInvestor } from '@/lib/providers/sec-edgar';
import {
  computeHoldingsAggregate,
  joinHoldersWithDeltas,
  type HoldingsAggregate,
  type HoldingsRow,
  type HolderDelta
} from '@/lib/compute/holdings-aggregate';
import { matchSmartMoney, type SmartMoneyCategory, getReverseLookupCiks } from '@/lib/compute/smart-money';
import { tickerForCusip, watchlistCusips, CUSIP_BY_TICKER } from '@/lib/compute/cusip-map';
import { logger } from '@/lib/logger';

interface SecHoldingsProvider {
  thirteenFFilings(cik: string): Promise<ThirteenFInvestor>;
}

interface Deps {
  db: ServiceDb;
  secProvider: SecHoldingsProvider;
}

/**
 * One row returned by getList. Carries delta + smart-money fields
 * inline so the UI doesn't have to recompute or shim them.
 */
export interface EnrichedHolding {
  id: string;
  ticker: string;
  investorId: string;
  investorName: string;
  reportPeriod: string;
  shares: number;
  marketValue: number | null;
  sharesPctOfPortfolio: number | null;
  sharesPctOfShareholders: number | null;
  filingDate: string;
  // New (was previously computed in the UI via the HoldingPlus workaround)
  delta: HolderDelta;
  sharesPrev: number | null;
  isSmartMoney: boolean;
  smartMoneyCategory: SmartMoneyCategory | null;
}

export interface TrackedInvestorRefreshSummary {
  investorsAttempted: number;
  investorsSucceeded: number;
  investorsFailed: number;
  newRows: number;
  prunedRows: number;
  durationMs: number;
}

const WINDOW_QUARTERS = 8;

function numToStr(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return String(n);
}

function quartersBefore(periodIso: string, n: number): string {
  const t = Date.parse(periodIso + 'T00:00:00Z');
  const cutoff = new Date(t - n * 90 * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

export class HoldingsService {
  constructor(private readonly deps: Deps) {}

  async getList(
    ticker: string,
    reportPeriod?: string,
    limit = 200
  ): Promise<EnrichedHolding[]> {
    const t = ticker.toUpperCase();
    const period = reportPeriod ?? (await this.latestPeriod(t));
    if (!period) return [];

    // Fetch the period's holders + the previous period's holders so we can join.
    const periodsRows = await this.deps.db
      .selectDistinct({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, t))
      .orderBy(desc(institutionalHoldings.reportPeriod));
    const periods = periodsRows.map((r) => r.p);
    const periodIdx = periods.indexOf(period);
    const prevPeriod = periodIdx >= 0 && periodIdx < periods.length - 1 ? periods[periodIdx + 1] : null;

    const currentRowsRaw = await this.deps.db
      .select()
      .from(institutionalHoldings)
      .where(and(
        eq(institutionalHoldings.ticker, t),
        eq(institutionalHoldings.reportPeriod, period)
      ))
      .orderBy(desc(institutionalHoldings.shares))
      .limit(limit);

    const prevByInvestorId = new Map<string, number>();
    if (prevPeriod) {
      const prevRows = await this.deps.db
        .select({ id: institutionalHoldings.investorId, sh: institutionalHoldings.shares })
        .from(institutionalHoldings)
        .where(and(
          eq(institutionalHoldings.ticker, t),
          eq(institutionalHoldings.reportPeriod, prevPeriod)
        ));
      for (const r of prevRows) prevByInvestorId.set(r.id, Number(r.sh));
    }

    return currentRowsRaw.map((r) => {
      const shares = Number(r.shares);
      const prev = prevByInvestorId.get(r.investorId) ?? null;
      const delta = classifyDeltaInline(shares, prev);
      const sm = matchSmartMoney(r.investorId, r.investorName);
      return {
        id: String(r.id),
        ticker: r.ticker,
        investorId: r.investorId,
        investorName: r.investorName,
        reportPeriod: r.reportPeriod,
        shares,
        marketValue: r.marketValue == null ? null : Number(r.marketValue),
        sharesPctOfPortfolio: r.sharesPctOfPortfolio == null ? null : Number(r.sharesPctOfPortfolio),
        sharesPctOfShareholders: r.sharesPctOfShareholders == null ? null : Number(r.sharesPctOfShareholders),
        filingDate: r.filingDate,
        delta,
        sharesPrev: prev,
        isSmartMoney: sm !== null,
        smartMoneyCategory: sm?.category ?? null
      };
    });
  }

  async getAggregate(ticker: string): Promise<HoldingsAggregate> {
    // Unchanged shape — same compute as before, same breadth-trend build,
    // same delegation to computeHoldingsAggregate. The only change is that
    // the data now comes from EDGAR, not FD.
    const t = ticker.toUpperCase();
    const all = await this.deps.db
      .select({
        investorId: institutionalHoldings.investorId,
        investorName: institutionalHoldings.investorName,
        reportPeriod: institutionalHoldings.reportPeriod,
        shares: institutionalHoldings.shares,
        marketValue: institutionalHoldings.marketValue,
        sharesPctOfPortfolio: institutionalHoldings.sharesPctOfPortfolio
      })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, t))
      .orderBy(desc(institutionalHoldings.reportPeriod), desc(institutionalHoldings.shares));

    const breadthMap = new Map<string, number>();
    for (const r of all) {
      breadthMap.set(r.reportPeriod, (breadthMap.get(r.reportPeriod) ?? 0) + 1);
    }
    const breadthTrend = Array.from(breadthMap.entries())
      .map(([period, holders]) => ({ period, holders }))
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, WINDOW_QUARTERS);

    if (breadthTrend.length === 0) {
      return computeHoldingsAggregate([], []);
    }

    const currentPeriod = breadthTrend[0]!.period;
    const previousPeriod = breadthTrend[1]?.period ?? null;

    const toHoldingsRow = (r: typeof all[number]): HoldingsRow => ({
      investorId: r.investorId,
      investorName: r.investorName,
      reportPeriod: r.reportPeriod,
      shares: Number(r.shares),
      marketValue: r.marketValue == null ? null : Number(r.marketValue),
      sharesPctOfPortfolio: r.sharesPctOfPortfolio == null ? null : Number(r.sharesPctOfPortfolio)
    });

    const current = all.filter((r) => r.reportPeriod === currentPeriod).map(toHoldingsRow);
    const previous = previousPeriod
      ? all.filter((r) => r.reportPeriod === previousPeriod).map(toHoldingsRow)
      : [];

    const joined = joinHoldersWithDeltas(current, previous);
    return computeHoldingsAggregate(joined, breadthTrend);
  }

  async listAvailablePeriods(ticker: string): Promise<string[]> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .selectDistinct({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, t))
      .orderBy(desc(institutionalHoldings.reportPeriod));
    return rows.map((r) => r.p);
  }

  private async latestPeriod(ticker: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ p: institutionalHoldings.reportPeriod })
      .from(institutionalHoldings)
      .where(eq(institutionalHoldings.ticker, ticker))
      .orderBy(desc(institutionalHoldings.reportPeriod))
      .limit(1);
    return rows[0]?.p ?? null;
  }

  /**
   * Fetch all curated investors from SEC EDGAR, filter their positions to
   * our 6 watchlist CUSIPs, upsert via composite UK. Prune each ticker's
   * rows older than 8 quarters. Records one refresh_runs row with
   * ticker='*' kind='holdings'.
   */
  async refreshTrackedInvestors(): Promise<TrackedInvestorRefreshSummary> {
    const started = Date.now();
    const startedAt = new Date(started);
    const ciks = getReverseLookupCiks();
    const cusipSet = new Set(watchlistCusips().map((c) => c.toUpperCase()));
    const inserts: Array<typeof institutionalHoldings.$inferInsert> = [];
    let succeeded = 0, failed = 0;

    for (const cik of ciks) {
      try {
        const investor = await this.deps.secProvider.thirteenFFilings(cik);
        succeeded++;
        for (const filing of investor.filings) {
          for (const pos of filing.positions) {
            const cusipUpper = pos.cusip.toUpperCase();
            if (!cusipSet.has(cusipUpper)) continue;
            const ticker = tickerForCusip(cusipUpper);
            if (!ticker) continue;
            const sharesStr = numToStr(pos.shares);
            if (sharesStr == null) continue;
            inserts.push({
              ticker,
              investorId: cik.padStart(10, '0'),
              investorName: investor.investorName,
              reportPeriod: filing.reportPeriod,
              shares: sharesStr,
              marketValue: numToStr(pos.valueUsd),
              sharesPctOfPortfolio: null,
              sharesPctOfShareholders: null,
              filingDate: filing.filingDate
            });
          }
        }
      } catch (err) {
        failed++;
        logger.warn({ cik, err: String(err) }, 'refreshTrackedInvestors: investor fetch failed');
      }
    }

    let newRows = 0;
    if (inserts.length > 0) {
      const before = await this.countTotalRows();
      await this.deps.db.insert(institutionalHoldings).values(inserts).onConflictDoNothing();
      const after = await this.countTotalRows();
      newRows = after - before;
    }

    const prunedRows = await this.pruneAllTickersTo8Q();

    await this.deps.db.insert(refreshRuns).values({
      ticker: '*',
      kind: 'holdings',
      startedAt,
      completedAt: new Date(),
      ok: true,
      sourceUsed: 'sec_edgar'
    });

    return {
      investorsAttempted: ciks.length,
      investorsSucceeded: succeeded,
      investorsFailed: failed,
      newRows,
      prunedRows,
      durationMs: Date.now() - started
    };
  }

  private async countTotalRows(): Promise<number> {
    const r = await this.deps.db
      .select({ c: sql<number>`count(*)::int` })
      .from(institutionalHoldings);
    return r[0]?.c ?? 0;
  }

  private async pruneAllTickersTo8Q(): Promise<number> {
    let total = 0;
    for (const ticker of Object.keys(CUSIP_BY_TICKER)) {
      const latest = await this.latestPeriod(ticker);
      if (!latest) continue;
      const cutoff = quartersBefore(latest, WINDOW_QUARTERS);
      const toDelete = await this.deps.db
        .select({ id: institutionalHoldings.id })
        .from(institutionalHoldings)
        .where(and(
          eq(institutionalHoldings.ticker, ticker),
          lt(institutionalHoldings.reportPeriod, cutoff)
        ));
      if (toDelete.length > 0) {
        await this.deps.db
          .delete(institutionalHoldings)
          .where(and(
            eq(institutionalHoldings.ticker, ticker),
            lt(institutionalHoldings.reportPeriod, cutoff)
          ));
        total += toDelete.length;
      }
    }
    return total;
  }
}

// classifyDelta is exported from holdings-aggregate but inlined here for getList
// to avoid an extra import. (Pure compute; safe.)
function classifyDeltaInline(currentShares: number, prevShares: number | null): HolderDelta {
  if (prevShares == null || prevShares === 0) return currentShares > 0 ? 'new' : 'unchanged';
  if (currentShares === 0) return 'sold-out';
  const pctChange = (currentShares - prevShares) / prevShares;
  if (pctChange > 0.05) return 'added';
  if (pctChange < -0.05) return 'reduced';
  return 'unchanged';
}
```

(If `classifyDelta` from `@/lib/compute/holdings-aggregate` is already exported and works for `getList`, just import it. The inline copy above is a fallback for if the type signature doesn't match exactly.)

- [ ] **Step 6.4: Run integration tests, confirm all 6 pass**

```bash
pnpm test:integration -- holdings-service
```
Expected: 6/6 pass. If the "partial failure" test trips on the order in which CIKs are iterated, double-check that Berkshire's CIK (`0001067983`) is in `SMART_MONEY` (it should be — it's the first entry).

- [ ] **Step 6.5: Commit**

```bash
git add lib/services/holdings.ts tests/integration/holdings-service.test.ts
git commit -m "$(cat <<'EOF'
feat(13f): HoldingsService.refreshTrackedInvestors + EnrichedHolding

Pivot from FD's per-ticker refresh to a global per-investor fetch:
- Constructor now takes secProvider (was fdProvider)
- refreshTrackedInvestors() iterates getReverseLookupCiks(), filters
  to watchlist CUSIPs, upserts via composite UK, prunes per ticker
  to 8 quarters, records one refresh_runs row (ticker='*' sentinel)
- getList returns EnrichedHolding (delta/sharesPrev/isSmartMoney/
  smartMoneyCategory inline) — removes the UI's HoldingPlus workaround
- getAggregate + listAvailablePeriods unchanged

6 integration tests covering happy path, idempotency, prune, off-
watchlist filtering, partial failure, enriched delta computation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: API routes — new global refresh + delete per-ticker POST

**Files:**
- Create: `app/api/holdings/refresh-tracked/route.ts`
- Create: `tests/integration/api-holdings-refresh-tracked.test.ts`
- Modify: `app/api/tickers/[symbol]/holdings/route.ts`
- Modify: `tests/integration/api-tickers-holdings.test.ts`

- [ ] **Step 7.1: Create the new route**

Create `app/api/holdings/refresh-tracked/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { SecEdgarProvider } from '@/lib/providers/sec-edgar';
import { HoldingsService } from '@/lib/services/holdings';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';

const RATE_LIMIT_PER_HOUR = 5;

let svc: HoldingsService | null = null;
function service(): HoldingsService {
  if (svc) return svc;
  const env = loadServerEnv();
  svc = new HoldingsService({
    db: getServiceDb(),
    secProvider: new SecEdgarProvider({ baseUrl: env.SITE_BASE_URL ?? 'http://localhost:3000' })
  });
  return svc;
}

async function rateLimit(userId: string): Promise<boolean> {
  const redis = getRedisCache();
  const key = `ratelimit:holdings-refresh-global:${userId}`;
  const cur = (await redis.get<number>(key)) ?? 0;
  if (cur >= RATE_LIMIT_PER_HOUR) return false;
  await redis.set(key, cur + 1, 60 * 60);
  return true;
}

export async function POST() {
  try {
    const userId = await requireUserId();
    if (!(await rateLimit(userId))) {
      return NextResponse.json(
        { error: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '3600' } }
      );
    }
    const summary = await service().refreshTrackedInvestors();
    return ok(summary);
  } catch (err) {
    return errorResponse(err, { route: 'holdings/refresh-tracked POST' });
  }
}
```

**Important:** The `SecEdgarProvider` constructor signature should match the existing one from Slice 2A. If the existing constructor doesn't take `{ baseUrl }`, match what it actually takes. If the provider was originally instantiated elsewhere (e.g. inside a different service), look at that callsite for the right options shape.

If `env.SITE_BASE_URL` isn't a thing, check `lib/env.ts` for the right name (could be `VERCEL_URL`, `NEXT_PUBLIC_SITE_URL`, etc.) — or use the existing SecEdgarProvider's default.

- [ ] **Step 7.2: Write API integration tests**

Create `tests/integration/api-holdings-refresh-tracked.test.ts`:

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('POST /api/holdings/refresh-tracked', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    await dbH.db.insert(companies).values([
      { ticker: 'AAPL', name: 'Apple', cik: null },
      { ticker: 'NVDA', name: 'NVIDIA', cik: null },
      { ticker: 'MSFT', name: 'Microsoft', cik: null },
      { ticker: 'GOOGL', name: 'Alphabet', cik: null },
      { ticker: 'TSLA', name: 'Tesla', cik: null },
      { ticker: 'JD',   name: 'JD.com', cik: null }
    ]);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/db/client', () => ({ getServiceDb: () => dbH.db }));
    vi.doMock('@/lib/providers/sec-edgar', () => ({
      SecEdgarProvider: class {
        thirteenFFilings = vi.fn(async (cik: string) => {
          // Return one Berkshire-like position for the first CIK; empty for all others
          if (cik.padStart(10, '0') === '0001067983') {
            return {
              cik: '0001067983',
              investorName: 'BERKSHIRE HATHAWAY INC',
              filings: [{
                accession: 'acc-2026-03-31',
                filingDate: '2026-03-31',
                reportPeriod: '2026-03-31',
                formType: '13F-HR',
                positions: [{
                  cusip: '037833100', issuerName: 'APPLE INC', classTitle: 'COM',
                  valueUsd: 263012040000, shares: 905560000, sharesType: 'SH'
                }]
              }]
            };
          }
          return { cik: cik.padStart(10, '0'), investorName: 'OTHER', filings: [] };
        });
      }
    }));
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 0, set: async () => undefined })
    }));
  });

  it('POST happy path: inserts holdings and returns summary', async () => {
    const { POST } = await import('@/app/api/holdings/refresh-tracked/route');
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.investorsAttempted).toBeGreaterThan(0);
    expect(body.investorsSucceeded).toBeGreaterThan(0);
    expect(body.newRows).toBe(1);    // 1 Berkshire AAPL row
  });

  it('POST returns 429 when rate-limited', async () => {
    vi.doMock('@/lib/cache/redis', () => ({
      getRedisCache: () => ({ get: async () => 999, set: async () => undefined })
    }));
    vi.resetModules();
    const { POST } = await import('@/app/api/holdings/refresh-tracked/route');
    const res = await POST();
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 7.3: Run the new API tests, confirm they fail then implement, confirm they pass**

```bash
pnpm test:integration -- api-holdings-refresh-tracked
```
First run: tests fail with `Cannot find module '@/app/api/holdings/refresh-tracked/route'` until step 7.1 is done. Re-run after 7.1: 2 tests pass.

- [ ] **Step 7.4: Delete POST handler from `app/api/tickers/[symbol]/holdings/route.ts`**

Open the file. Find the `export async function POST(...)` block and delete it entirely, along with the now-unused imports (`NextResponse`, `getRedisCache`, the `rateLimit` helper). Keep `GET`.

- [ ] **Step 7.5: Update `tests/integration/api-tickers-holdings.test.ts` to drop POST tests**

Open the file. Delete the `POST refresh inserts holdings` test and `GET after POST returns the inserted holding` test and the `POST returns 429 when rate-limited` test. Keep the GET tests:
- `GET returns empty list + zero aggregate when no rows`
- `GET returns 400 for invalid ticker`
- `GET returns 400 for invalid period`

Update the remaining GET-with-data test (was "GET after POST") to insert data directly via `dbH.db.insert` instead of triggering POST:

```ts
it('GET with data returns the inserted holding', async () => {
  // Seed the DB directly since the POST handler is gone
  await dbH.db.insert(institutionalHoldings).values({
    ticker: 'AAPL', investorId: '0001067983', investorName: 'BERKSHIRE HATHAWAY INC',
    reportPeriod: '2026-03-31', shares: '905560000', filingDate: '2026-03-31',
    marketValue: '263012040000'
  });
  const { GET } = await import('@/app/api/tickers/[symbol]/holdings/route');
  const res = await GET(
    new Request('http://test.local/api/tickers/AAPL/holdings'),
    { params: { symbol: 'AAPL' } }
  );
  const body = await res.json();
  expect(body.holdings).toHaveLength(1);
  expect(body.holdings[0].investorName).toBe('BERKSHIRE HATHAWAY INC');
});
```

Add `institutionalHoldings` to the `@/lib/db/schema` import at the top.

Also drop the `vi.doMock('@/lib/providers/financial-datasets', ...)` block — no longer needed.

- [ ] **Step 7.6: Run all integration tests, confirm green**

```bash
pnpm test:integration -- holdings
```
Expected: 6 service + 2 new API + 4 per-ticker GET + 2 RLS = 14 tests pass.

- [ ] **Step 7.7: Commit**

```bash
git add "app/api/holdings/refresh-tracked/route.ts" \
        "app/api/tickers/[symbol]/holdings/route.ts" \
        tests/integration/api-holdings-refresh-tracked.test.ts \
        tests/integration/api-tickers-holdings.test.ts
git commit -m "$(cat <<'EOF'
feat(13f): global POST /api/holdings/refresh-tracked + delete per-ticker POST

New endpoint runs HoldingsService.refreshTrackedInvestors(). Rate-
limited 5/hour/user via Redis (heavier job than per-ticker; 13F is
quarterly anyway). Per-ticker POST handler at /api/tickers/[symbol]/
holdings is gone — the per-ticker semantic doesn't fit the new
ingestion model. Per-ticker GET stays.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: UI relabeling

**Files:**
- Modify: `app/(app)/stock/[ticker]/_components/holdings-card.tsx`
- Modify: `app/(app)/stock/[ticker]/holdings/_components/holdings-aggregate-panel.tsx`
- Modify: `app/(app)/stock/[ticker]/holdings/_components/holdings-view.tsx`

The 5 UI components keep their visual structure. Only copy + `<HoldingsView>`'s filter and refresh-endpoint change. Plus we drop the `HoldingPlus` workaround since `EnrichedHolding` from the service now carries delta info inline.

- [ ] **Step 8.1: Relabel `<HoldingsCard>`**

Open `app/(app)/stock/[ticker]/_components/holdings-card.tsx`. Three text changes:

1. `<CardTitle>Institutional holdings</CardTitle>` (3 occurrences — one per branch) → `<CardTitle>Tracked investor holdings</CardTitle>`

2. The "Holders" row's label + value:
```tsx
<span className="text-muted-foreground">Holders</span>
<span className="font-mono tabular-nums">{fmtCount(aggregate.totalHolders)} funds</span>
```
becomes:
```tsx
<span className="text-muted-foreground">Tracked holding</span>
<span className="font-mono tabular-nums">{aggregate.totalHolders} of 45 tracked</span>
```
(Remove `fmtCount` if it's now unused after this change. If it's used elsewhere in the file, leave it.)

3. The empty-state copy:
```tsx
No 13F data fetched yet.
```
becomes:
```tsx
No tracked investor data yet.
```

- [ ] **Step 8.2: Relabel `<HoldingsAggregatePanel>`**

Open `app/(app)/stock/[ticker]/holdings/_components/holdings-aggregate-panel.tsx`. Four text changes:

1. Section title:
```tsx
<h2 className="text-lg font-semibold">
  Summary <span className="text-sm font-normal text-muted-foreground">as of {aggregate.currentPeriod}</span>
</h2>
```
becomes:
```tsx
<h2 className="text-lg font-semibold">
  Tracked investors <span className="text-sm font-normal text-muted-foreground">as of {aggregate.currentPeriod}</span>
</h2>
```

2. "Total holders" → "Tracked investors holding".

3. "Top-10 concentration" → "Top-10 share-of-tracked" (with a `title` attribute tooltip):
```tsx
<span className="text-muted-foreground" title="Concentration within our 45 tracked managers, not total float.">
  Top-10 share-of-tracked
</span>
```

4. Breadth-trend caption:
```tsx
<div className="text-xs text-muted-foreground mb-1">Holder count trend (8 quarters)</div>
```
becomes:
```tsx
<div className="text-xs text-muted-foreground mb-1">Tracked investor breadth (out of 45, 8 quarters)</div>
```

- [ ] **Step 8.3: Rewrite `<HoldingsView>`'s import + state**

Open `app/(app)/stock/[ticker]/holdings/_components/holdings-view.tsx`.

Replace the existing imports + `HoldingPlus` interface + enrichment logic with the simpler shape that uses `EnrichedHolding` directly:

```tsx
'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import type { HoldingsAggregate, HolderDelta } from '@/lib/compute/holdings-aggregate';
import type { EnrichedHolding } from '@/lib/services/holdings';
import { HoldingsAggregatePanel } from './holdings-aggregate-panel';
import { SmartMoneyCallout } from './smart-money-callout';
import { HolderRow } from './holder-row';

type FilterMode = 'all' | 'new' | 'exits' | 'additions' | 'reductions';

interface Props {
  ticker: string;
  holdings: EnrichedHolding[];
  aggregate: HoldingsAggregate;
  availablePeriods: string[];
  selectedPeriod: string | null;
}

const FILTERS: Array<{ value: FilterMode; label: string }> = [
  { value: 'all',          label: 'All holders' },
  { value: 'additions',    label: 'Additions only' },
  { value: 'reductions',   label: 'Reductions only' },
  { value: 'new',          label: 'New positions only' },
  { value: 'exits',        label: 'Exits only' }
];

function applyFilter(rows: EnrichedHolding[], mode: FilterMode): EnrichedHolding[] {
  switch (mode) {
    case 'all':         return rows;
    case 'additions':   return rows.filter((r) => r.delta === 'added' || r.delta === 'new');
    case 'reductions':  return rows.filter((r) => r.delta === 'reduced' || r.delta === 'sold-out');
    case 'new':         return rows.filter((r) => r.delta === 'new');
    case 'exits':       return rows.filter((r) => r.delta === 'sold-out');
  }
}

export function HoldingsView({ ticker, holdings, aggregate, availablePeriods, selectedPeriod }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');

  const filtered = applyFilter(holdings, filter);

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      // Global refresh — refreshes all 6 watchlist tickers, ~10 seconds
      const res = await fetch(`/api/holdings/refresh-tracked`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 429) setError('Refreshing too quickly — try again in an hour.');
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

  function onPeriodChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const p = e.target.value;
    const url = p === availablePeriods[0]
      ? `/stock/${ticker}/holdings`
      : `/stock/${ticker}/holdings?period=${p}`;
    startTransition(() => router.push(url));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <HoldingsAggregatePanel aggregate={aggregate} />
        <div className="flex items-center gap-2">
          {availablePeriods.length > 1 && (
            <select
              value={selectedPeriod ?? availablePeriods[0] ?? ''}
              onChange={onPeriodChange}
              className="text-xs rounded border border-border bg-background px-2 py-1"
            >
              {availablePeriods.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
          <Button
            onClick={refresh}
            disabled={refreshing || isPending}
            title="Updates all tracked managers across all watchlist tickers (~10s)"
          >
            {refreshing ? 'Refreshing…' : 'Refresh tracked investors'}
          </Button>
        </div>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <SmartMoneyCallout aggregate={aggregate} />

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-medium">All tracked holders</h3>
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
            {holdings.length === 0
              ? 'No tracked investor data yet. Click Refresh to pull the latest 13F filings.'
              : 'No holders match the current filter.'}
          </p>
        ) : (
          <ul className="space-y-0">
            {filtered.map((h) => (
              <HolderRow
                key={h.id}
                investorId={h.investorId}
                investorName={h.investorName}
                shares={h.shares}
                marketValue={h.marketValue}
                sharesChange={h.sharesPrev != null ? h.shares - h.sharesPrev : h.shares}
                sharesPrev={h.sharesPrev}
                delta={h.delta}
                isSmartMoney={h.isSmartMoney}
                smartMoneyCategory={h.smartMoneyCategory}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

Key changes vs. the previous file:
- Imports `EnrichedHolding` from `@/lib/services/holdings`
- No more `HoldingPlus` interface, no more `matchSmartMoney` import, no more `enriched` mapping step
- `FilterMode` no longer has `'smart-money'`
- `FILTERS` is 5 entries instead of 6
- The 200-holders truncation footer is gone
- Refresh URL is `/api/holdings/refresh-tracked` (POST, no path param)
- Button label is `Refresh tracked investors` and tooltip explains the global behavior

- [ ] **Step 8.4: Update the parent page to pass `EnrichedHolding[]` to `<HoldingsView>`**

Open `app/(app)/stock/[ticker]/holdings/page.tsx`. The `svc.getList(...)` call already returns `EnrichedHolding[]` now (per Task 6's rewrite), so no TS error should arise — just confirm by running typecheck. If `<HoldingsView>` props don't match, fix the cast site.

- [ ] **Step 8.5: Typecheck + lint + tests**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: clean. If TS complains about prop shape, check that the page's `getList` return type matches `<HoldingsView>`'s `holdings` prop type.

- [ ] **Step 8.6: Commit**

```bash
git add "app/(app)/stock/[ticker]/_components/holdings-card.tsx" \
        "app/(app)/stock/[ticker]/holdings/_components/holdings-aggregate-panel.tsx" \
        "app/(app)/stock/[ticker]/holdings/_components/holdings-view.tsx" \
        "app/(app)/stock/[ticker]/holdings/page.tsx"
git commit -m "$(cat <<'EOF'
feat(13f): relabel UI to 'Tracked investors' + drop HoldingPlus workaround

- HoldingsCard: 'Institutional holdings' → 'Tracked investor holdings';
  'Holders / N funds' → 'Tracked holding / N of 45 tracked'
- AggregatePanel: 'Summary' → 'Tracked investors'; 'Total holders' →
  'Tracked investors holding'; 'Top-10 concentration' → 'Top-10
  share-of-tracked' with tooltip; breadth caption 'Holder count trend'
  → 'Tracked investor breadth (out of 45)'
- HoldingsView: uses EnrichedHolding directly (no enriched mapping in
  client), filter dropdown drops 'Smart money only' (every row is now
  tracked = smart-money or index-giant), button label 'Refresh' →
  'Refresh tracked investors', refresh URL is the global endpoint,
  truncation footer deleted

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `scripts/try-13f.ts` update

**Files:**
- Modify: `scripts/try-13f.ts`

The smoke script no longer takes a ticker arg — it triggers the global refresh and then prints results per ticker.

- [ ] **Step 9.1: Rewrite `scripts/try-13f.ts`**

Replace the entire file:

```ts
#!/usr/bin/env tsx
/**
 * Smoke: refresh all tracked investors via SEC EDGAR, print aggregate
 * and top 10 holders per watchlist ticker. No args.
 *
 * Usage: pnpm try-13f
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { getServiceDb } from '@/lib/db/client';
import { SecEdgarProvider } from '@/lib/providers/sec-edgar';
import { HoldingsService } from '@/lib/services/holdings';
import { loadServerEnv } from '@/lib/env';
import { CUSIP_BY_TICKER } from '@/lib/compute/cusip-map';

function fmtDollars(n: number | null): string {
  if (n == null) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`;
  return `${sign}$${abs.toLocaleString()}`;
}

async function main() {
  const env = loadServerEnv();
  const db = getServiceDb();
  const sec = new SecEdgarProvider({ baseUrl: env.SITE_BASE_URL ?? 'http://localhost:3000' });
  const svc = new HoldingsService({ db, secProvider: sec });

  console.log('Refreshing tracked investors via SEC EDGAR...');
  const t0 = Date.now();
  const summary = await svc.refreshTrackedInvestors();
  console.log(
    `  attempted: ${summary.investorsAttempted}, ` +
    `ok: ${summary.investorsSucceeded}, ` +
    `failed: ${summary.investorsFailed}, ` +
    `newRows: ${summary.newRows}, ` +
    `pruned: ${summary.prunedRows} ` +
    `(${Date.now() - t0}ms)\n`
  );

  for (const ticker of Object.keys(CUSIP_BY_TICKER)) {
    const agg = await svc.getAggregate(ticker);
    if (!agg.currentPeriod) {
      console.log(`=== ${ticker}: no tracked investors hold ===\n`);
      continue;
    }
    console.log(`=== ${ticker} (as of ${agg.currentPeriod}) ===`);
    console.log(`  tracked investors holding: ${agg.totalHolders} of 45`);
    console.log(`  total shares held: ${agg.totalSharesHeld.toLocaleString()}`);
    console.log(`  total mkt value:   ${fmtDollars(agg.totalMarketValue)}`);
    console.log(`  top-10 share-of:   ${(agg.top10Concentration * 100).toFixed(1)}%`);
    console.log(`  new positions:     ${agg.newPositions}`);
    console.log(`  exits:             ${agg.exits}`);
    console.log(`  smart-money +/-:   ${agg.smartMoneyMoves.additions.length}/${agg.smartMoneyMoves.reductions.length}`);
    const top10 = await svc.getList(ticker, undefined, 10);
    for (const h of top10) {
      const flag = h.isSmartMoney ? ` [${h.smartMoneyCategory}]` : '';
      console.log(`  ${h.investorName.padEnd(40)} ${h.shares.toLocaleString().padStart(14)} sh   ${fmtDollars(h.marketValue)}   ${h.delta}${flag}`);
    }
    console.log('');
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('try-13f failed:', err);
  process.exit(1);
});
```

If `env.SITE_BASE_URL` doesn't exist in `loadServerEnv()`, use whatever variable is the right local default (look at how other scripts under `scripts/` reach the Vercel-deployed serverless or default to localhost).

- [ ] **Step 9.2: Commit**

```bash
git add scripts/try-13f.ts
git commit -m "$(cat <<'EOF'
chore(13f): update try-13f script for global refresh

No args. Triggers refreshTrackedInvestors(), then prints aggregate +
top 10 holders per watchlist ticker. Smart-money holders flagged with
category tag inline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Push + CI + Vercel + smoke

**Files:** none modified; rollout task.

- [ ] **Step 10.1: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

- [ ] **Step 10.2: Verify CI run id**

```bash
gh run list --limit 1 --json status,databaseId,headSha
```

- [ ] **Step 10.3: Watch CI to green**

```bash
gh run watch <run-id> --exit-status
```

Expected: exits 0. If failure, inspect job logs and fix.

- [ ] **Step 10.4: Wait for Vercel deploy**

Vercel auto-deploys on push to master. Wait ~60s, then verify the Python serverless picked up the new `thirteen_f_filings` handler:

```bash
curl 'https://equity-research-workbench-mauve.vercel.app/api/fallback/sec?kind=thirteen_f_filings&cik=0001067983' \
  -H 'User-Agent: smoke-test' | head -200
```

Expected: JSON response with `cik`, `investor_name: "BERKSHIRE HATHAWAY INC"`, and a `filings` array with at least 1 entry.

If the response is `{"error": "unknown kind", ...}` or similar, the Vercel deploy hasn't picked up the new handler yet — wait another ~30s and retry.

- [ ] **Step 10.5: Populate via the smoke script**

```bash
pnpm try-13f 2>&1 | tee /tmp/try-13f-output.log
```

Expected:
- Refresh completes in 10-20 seconds.
- `attempted: 45, ok: 35-42, failed: 3-10` (some smaller managers don't file 13F).
- `newRows: 100-300` (varies — depends on how many tracked investors hold our 6 watchlist tickers).
- Per-ticker breakdowns:
  - AAPL: 20+ tracked investors holding, top includes Vanguard / BlackRock / State Street / Berkshire, smart-money +/- nonzero
  - NVDA: 15+ tracked investors, growth managers (Tiger / Coatue / Viking) visible
  - MSFT: similar shape to AAPL
  - GOOGL: similar shape to AAPL
  - TSLA: Coatue / ARK visible, fewer index-giant positions
  - JD: likely few or no tracked investors hold this (Chinese ADR — most US-focused managers don't track it)

If a specific investor fails repeatedly with "investor not found", their CIK in `INDEX_GIANTS` or `SMART_MONEY` may be wrong. Update the CIK and re-run.

- [ ] **Step 10.6: Browser smoke**

Visit these URLs in the browser:

1. https://equity-research-workbench-mauve.vercel.app/stock/AAPL
   - Overview row shows both InsiderCard and HoldingsCard side-by-side
   - HoldingsCard title: "Tracked investor holdings"
   - "Tracked holding: N of 45 tracked" with realistic N (~20)
   - "Top-10 stake: X%" — should be much lower than the FD-era 77% (closer to 30-50%)
   - Smart-money moves count shown if any

2. https://equity-research-workbench-mauve.vercel.app/stock/AAPL/holdings
   - Page header "Institutional Holdings (13F)"
   - Aggregate panel: "Tracked investors as of YYYY-MM-DD"
   - Top of holder list: Vanguard, BlackRock, State Street (not Aberdeen/Alecta)
   - Smart-money callout visible with Berkshire (if Berkshire's position changed QoQ)
   - Filter dropdown has 5 options (no "Smart money only")
   - Refresh button label: "Refresh tracked investors"
   - 9-tab nav unchanged: Overview · Financials · Technical · News · Insiders · Holdings · Filings · Quality · Ask

3. Repeat key checks for NVDA, MSFT, TSLA. GOOGL may have a thinner profile. JD may show an empty-state if no tracked investors hold it.

4. Click "Refresh tracked investors" on any /holdings page — should complete in ~10-20 seconds, page re-renders with updated data, rate-limited at 5/hour.

- [ ] **Step 10.7: No commit step — rollout only**

If everything passes, no commit is needed. The work is shipped.

---

## Spec coverage check

| Spec requirement | Task |
|---|---|
| Delete FD-specific dead code | T1 |
| `lib/compute/cusip-map.ts` with hardcoded 6 entries | T2 |
| `INDEX_GIANTS` added to `smart-money.ts` (15 entries) | T3 |
| `getReverseLookupCiks()` returns union of 45 CIKs | T3 |
| Python `thirteen_f_filings` handler | T4 |
| InformationTable XML parser (×1000 value math) | T4 |
| `index.json` manifest-based filename discovery | T4 |
| Inline assertion test against Berkshire fixture | T4 |
| `SecEdgarProvider.thirteenFFilings(cik)` method | T5 |
| `ThirteenFInvestor` / `ThirteenFFiling` / `ThirteenFPosition` types | T5 |
| `HoldingsService.refreshTrackedInvestors()` global refresh | T6 |
| Per-investor fan-out with CUSIP filter | T6 |
| 8-quarter prune per ticker | T6 |
| `refresh_runs.ticker = '*'` sentinel | T6 |
| Partial-failure resilience (continue on per-investor error) | T6 |
| `EnrichedHolding` returned from `getList` | T6 |
| `getAggregate` + `listAvailablePeriods` unchanged | T6 |
| New `POST /api/holdings/refresh-tracked` route | T7 |
| Rate-limit 5/hour/user | T7 |
| Delete per-ticker POST handler, keep GET | T7 |
| UI relabel: "Institutional holdings" → "Tracked investor holdings" | T8 |
| UI relabel: aggregate panel + breadth caption | T8 |
| UI: drop "Smart money only" filter (now redundant) | T8 |
| UI: drop 200-holders truncation footer | T8 |
| UI: Refresh button label + tooltip | T8 |
| UI: `<HoldingsView>` uses `EnrichedHolding` (drop HoldingPlus) | T8 |
| `scripts/try-13f.ts` no-args, global refresh | T9 |
| Push + CI + Vercel + smoke | T10 |

All spec requirements have a task. No gaps.
