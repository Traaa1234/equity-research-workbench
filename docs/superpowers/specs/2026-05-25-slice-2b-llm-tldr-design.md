# Slice 2B — LLM Briefing (Whole-Filing Summary) Design

**Status:** Approved 2026-05-25. Implementation plan to follow.

**Builds on:** Slice 2A (EDGAR ingestion + section parsing) — shipped to production at commit `3ac2e0c` on 2026-05-25.

## Goal

Show an investor a structured one-shot summary at the top of every filing reader page. Summary is generated **on demand** the first time someone opens that filing, persisted to the database, and served instantly on subsequent visits.

## Non-Goals

- Per-section TLDRs (one summary per Item 1A, Item 7, etc.) — chose whole-filing only to keep cost at ~$0.025/filing instead of ~$0.15.
- Quarter-over-quarter diff/change detection — deferred to a future slice.
- Streaming token-by-token output — server-rendered with a Suspense skeleton is sufficient UX for a 5-10s call.
- Embeddings / semantic search — that's Slice 2C.
- Multi-provider abstraction. We commit to DashScope/Qwen for now. The provider class is swappable later if we decide to add fallbacks.

## Product

The single-filing reader page (`/stock/[ticker]/filings/[accession]`) gets a "Briefing" card slotted between the existing header and the section-tab navigator. The card displays four fixed sections rendered from markdown:

```
## What they do
[1-2 sentences in plain English]

## This period's highlights
- [Specific revenue/margin/segment numbers from MD&A]
- [Material events: acquisitions, restructure, lawsuits]
- [Guidance changes]

## Key risks
- [2-3 company-specific risks from Risk Factors]

## Bottom line
[One sentence takeaway]
```

A `[Regenerate]` button at the card's footer triggers a forced re-run (useful when iterating on the prompt without a code deploy). Metadata footer shows model name + age of summary.

## Architecture

```
Browser → /stock/AAPL/filings/<accession>
            ↓ server component (existing T6.2 page)
        renders header + section nav (instant from DB)
            +
        <Suspense fallback={<BriefingSkeleton/>}>
            <FilingBriefing accession=… />   (async server component)
                ↓
            SummariesService.getOrGenerate(filingId)
                ↓ if cache miss or stale:
            FilingsService.getAllSectionTexts(filingId)
                ↓
            assemble prompt
                ↓
            QwenProvider.summarize()
                ↓ HTTP POST → dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions
                ↓
            persist to filing_summaries
                ↓ return summary
            render markdown via react-markdown
        </Suspense>
```

The Suspense boundary ensures the rest of the page paints instantly. Only the briefing card waits for the LLM on first visit. Subsequent visits: instant (DB read).

## Schema

**One new table** in `lib/db/schema.ts`:

```ts
export const filingSummaries = pgTable(
  'filing_summaries',
  {
    filingId: text('filing_id')
      .primaryKey()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    summaryText: text('summary_text').notNull(),
    model: text('model').notNull(),                  // e.g. 'qwen-plus'
    promptVersion: text('prompt_version').notNull(), // e.g. 'v1'
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow()
  }
);
```

- **PK is `filing_id`** (one summary per filing). If we later want to A/B prompts side-by-side, we'd switch to a composite PK `(filing_id, prompt_version)`; not needed for v1.
- **`model` + `prompt_version`** drive the "stale = regenerate" logic. When the code-level constants advance past what's in the row, the next read triggers regeneration.
- **Token columns** let us audit DashScope spend per ticker without crossing into their billing console.
- **`generated_at`** powers the "generated 2m ago" footer.

**RLS migration** at `lib/db/migrations/9997_rls_filing_summaries.sql`:

```sql
alter table public.filing_summaries enable row level security;

drop policy if exists "auth read filing_summaries" on public.filing_summaries;
create policy "auth read filing_summaries"
  on public.filing_summaries for select to authenticated using (true);

grant select on public.filing_summaries to authenticated;
```

Same pattern as the other reference tables: authenticated users read; only service role writes. The `9997` prefix sequences it before the existing `9998_rls_filings.sql` and `9999_rls_policies.sql`.

**Applied manually via `postgres.js` script** to both Neon branches — **never via `drizzle-kit push --force`** (that command wiped existing RLS in Slice 2A T1.2; lesson learned).

## Provider — `lib/providers/qwen.ts`

```ts
export interface QwenProvider {
  summarize(opts: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
  }): Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export class QwenProviderImpl implements QwenProvider {
  constructor(opts?: {
    apiKey?: string;          // default: process.env.DASHSCOPE_API_KEY
    baseUrl?: string;         // default: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    timeoutMs?: number;       // default: 30_000
    fetch?: typeof fetch;     // injected for testing
  });
}
```

- Internally uses the `openai` npm package (already OpenAI-compatible API). Configured with DashScope's base URL + API key. Reuses the existing taxonomy from `lib/providers/types.ts`:
  - HTTP 429 → `RateLimitError`
  - HTTP 5xx → `ProviderError`
  - HTTP 4xx → `ValidationError`
  - Timeout → `ProviderError("timeout after Nms")`
  - Network failure → `ProviderError(network message)`
  - Malformed response (empty `choices`, missing `content`) → `UnknownProviderError`
- **Single method** — `summarize`. No generic `chat()` because we don't need conversational state. YAGNI.
- The OpenAI SDK exposes `usage.prompt_tokens` and `usage.completion_tokens` on the response; we expose them as `inputTokens` / `outputTokens`.
- DashScope quirk: international endpoint is `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. The China endpoint (`dashscope.aliyuncs.com`) is geo-restricted for US-based traffic. Use international by default.

**Env vars:**
- `DASHSCOPE_API_KEY` — required. Added to `.env.local` (local) + Vercel env (prod) + GitHub Actions secret (CI smoke if we add one; not in unit/integration tests).

## Service — `lib/services/summaries.ts`

```ts
const CURRENT_MODEL = 'qwen-plus';
const CURRENT_PROMPT_VERSION = 'v1';
const MAX_OUTPUT_TOKENS = 800;

export class SummariesService {
  constructor(deps: { db: ServiceDb; provider: QwenProvider; filingsService: FilingsService });

  async getOrGenerate(filingId: string): Promise<FilingSummary>;
  async regenerate(filingId: string): Promise<FilingSummary>;
}

export interface FilingSummary {
  filingId: string;
  summaryText: string;
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  generatedAt: Date;
}
```

**`getOrGenerate(filingId)` logic:**

1. SELECT from `filing_summaries` where `filing_id = $1`.
2. If row exists AND `row.model === CURRENT_MODEL` AND `row.promptVersion === CURRENT_PROMPT_VERSION` → return it. Done.
3. Otherwise (missing OR stale):
   1. Fetch all chunks via `filingsService.getAllSectionTexts(filingId)`. If empty, throw `ValidationError("no parsed sections to summarize")`.
   2. Assemble prompt (see Prompt Design below).
   3. Call `provider.summarize({ model: CURRENT_MODEL, ..., maxTokens: MAX_OUTPUT_TOKENS })`.
   4. If `result.text.trim().length < 50` → throw `ProviderError("empty/short response")` (don't persist garbage).
   5. UPSERT into `filing_summaries` (`ON CONFLICT (filing_id) DO UPDATE`).
   6. Insert `refresh_runs` row: `kind = 'summary:<accession>'`, `ok = true`, `sourceUsed = 'qwen'`. On failure, the catch block inserts `ok = false` with the error.
   7. Return the new summary.

**`regenerate(filingId)` logic:** skip the cache check, always do steps 3.1–3.7. Used by the Regenerate button.

**`FilingsService` gets one new method:**

```ts
async getAllSectionTexts(filingId: string): Promise<Array<{
  sectionKey: string;
  sectionTitle: string;
  text: string;
}>>;
```

This is just `SELECT section_key, section_title, text FROM filing_chunks WHERE filing_id = $1 ORDER BY id`. We keep this in `FilingsService` (not `SummariesService`) because it's a query on filings data, not on summaries.

## Prompt Design

**System prompt** (fixed, ~80 tokens):

```
You are a senior equity research analyst writing concise investor briefings on SEC filings.
Your output is read by investors who want the signal, not the boilerplate. Be specific:
quote numbers and names directly from the filing when they support the point. Avoid hedging
language ("the company believes…", "it appears…"). Do not invent facts not in the source.
```

**User prompt template** (~120 tokens of instructions + the assembled filing text):

````
Below is the text of an SEC filing. Produce a structured briefing in this EXACT markdown format:

## What they do
[1-2 sentences. The business in plain English. No marketing language.]

## This period's highlights
- [Specific revenue/margin/segment numbers from MD&A. 2-3 bullets.]
- [If guidance changed, say so.]
- [If there's a material event (acquisition, restructure, lawsuit), include it.]

## Key risks
- [The 2-3 most material risks from Risk Factors. Specific risks tied to this company, not generic boilerplate like "competition" or "regulation in general".]

## Bottom line
[One sentence: what an investor should take away from this filing.]

Filing context:
- Ticker: {TICKER}
- Company: {COMPANY_NAME}
- Form: {FORM_TYPE}
- Filed: {FILING_DATE}
- Period ending: {PERIOD_END_OR_DASH}

Filing text follows:
---
{ASSEMBLED_FILING_TEXT}
---
````

**Assembled filing text format:**

```
=== Business ===
[full text of item_1_business]

=== Risk Factors ===
[full text of item_1a_risk_factors]

=== Management's Discussion and Analysis ===
[full text of item_7_mdna]

=== Financial Statements and Notes ===
[full text of item_8_financial_statements]
```

For 10-Q filings (3 sections instead of 5), we include whichever sections exist. The skipped 10-K section `item_7a_market_risk` (Quantitative and Qualitative Disclosures About Market Risk) is excluded because it's mostly boilerplate VaR tables.

**Defensive truncation:** if `ASSEMBLED_FILING_TEXT` exceeds 400,000 characters (~100k tokens, a safe headroom below Qwen-plus's 128k context limit), truncate `item_8_financial_statements` first since it's the most repetitive. Log a `logger.warn` when this happens. In practice, 10-Ks average 50-60k tokens and 10-Qs average 20-25k tokens, so this is a defensive measure for edge cases (eg. issuers with unusually long S-1-style 10-Ks).

**Prompt iteration policy:**
- Before locking `prompt_version = 'v1'`, the smoke script (`pnpm try-summarize`) is run against 3 real filings (AAPL 10-K, AAPL 10-Q, and one non-tech ticker like JD or NIO). The output is eyeballed; if it's poor, the prompt is iterated until acceptable, THEN committed.
- After `v1` is in production, we DON'T edit it casually. Any prompt change → bump to `v2`, which auto-regenerates all summaries on next visit.

## API Routes

**`GET /api/tickers/[symbol]/filings/[accession]/summary`**

- Auth: `requireUserId()`.
- Validates `symbol` against `TICKER_RE`, `accession` against `ACCESSION_RE`.
- Calls `service.getOrGenerate(accession)`.
- Returns:
  ```json
  {
    "filingId": "0000320193-25-000123",
    "summaryText": "## What they do\n...",
    "model": "qwen-plus",
    "promptVersion": "v1",
    "inputTokens": 52341,
    "outputTokens": 412,
    "generatedAt": "2026-05-25T01:23:45.678Z"
  }
  ```
- Errors:
  - 400 — invalid params
  - 401 — unauth
  - 502 — provider failure (rate-limited or upstream error)
  - 503 — provider rate-limited (returns `Retry-After` header)
  - 404 — filing not found in DB
- `maxDuration = 60` on the route (covers 5-10s LLM call + safety headroom).

**`POST /api/tickers/[symbol]/filings/[accession]/summary?regenerate=1`**

- Same auth/validation.
- Requires `?regenerate=1` query param (defensive: prevents accidental POST from triggering expensive operations).
- Calls `service.regenerate(accession)` — always re-runs the LLM.
- Returns the same shape as GET.
- Same error model + `maxDuration`.

## UI

**Single-filing reader page** — modify `app/(app)/stock/[ticker]/filings/[accession]/page.tsx`:

```tsx
<article className="space-y-6">
  <header>{/* existing */}</header>

  <Suspense fallback={<BriefingSkeleton />}>
    <FilingBriefing ticker={ticker} accession={params.accession} />
  </Suspense>

  {/* existing SectionNav */}
</article>
```

**`app/(app)/stock/[ticker]/filings/[accession]/_components/filing-briefing.tsx`** — async server component:

- Calls `SummariesService.getOrGenerate(accession)` directly (server-side, no extra HTTP hop).
- Renders markdown via `react-markdown` with custom component mapping (h2 → styled heading, ul → styled list).
- Footer: "Generated by {model} · {time-ago} · [Regenerate]" where Regenerate is the client island below.
- Catches `ProviderError` / `RateLimitError` from the service and renders a graceful failure card: "Briefing unavailable right now. [Retry]".

**`app/(app)/stock/[ticker]/filings/[accession]/_components/regenerate-button.tsx`** — `'use client'` island:

- POSTs to `/api/tickers/[symbol]/filings/[accession]/summary?regenerate=1`.
- Shows toast on success/failure.
- Calls `router.refresh()` after success.

**`app/(app)/stock/[ticker]/filings/[accession]/_components/briefing-skeleton.tsx`** — pure CSS skeleton:

- Four `<Skeleton>` blocks roughly the height of the four expected sections.
- Helper text: "Generating briefing… this takes 5-10s on first visit".

**New dependency:** `react-markdown` (~30kb gzipped) + `remark-gfm` if we want GitHub-flavored markdown bullets. Both are small, well-maintained, no native deps.

## Error Handling

Summary of behavior across failure modes:

| Failure | Response | UI | Persisted? |
|---|---|---|---|
| `DASHSCOPE_API_KEY` missing | 502 | "Briefing unavailable (provider not configured)" + retry button | No |
| DashScope 429 | 503 + `Retry-After` | "Rate-limited, try in a moment" + retry | No |
| DashScope timeout (>30s) | 502 | Generic "temporarily unavailable" | No |
| LLM returns empty / `<50` chars | 502 | Generic + retry | No |
| Filing has no chunks | 400 | "No parsed content to summarize" | No |
| Network error | 502 | Retry button | No |
| Output truncated (hit max_tokens) | 200 | Renders normally, warning logged | Yes (better than nothing) |

**Critical invariant: no persisted row on failure.** Avoids the trap where a transient failure produces a permanent "failed briefing" record. Cost: flaky API key = every visit retries. Mitigation: env-check fails the call before it's attempted.

**`refresh_runs` integration:** Every generation attempt writes a row (`kind = 'summary:<accession>'`, `source_used = 'qwen'`, `ok` = true/false). Failures include error message truncated to 1000 chars (matching existing pattern in `FilingsService`).

## Testing

| Layer | Test cases | Count |
|---|---|---|
| `QwenProvider` unit | Mock `fetch`. Request shape, happy path, 429 → RateLimitError, 500 → ProviderError, 401 → ValidationError, timeout, malformed response, structured error mapping | 7 |
| `SummariesService` integration | Real test-branch DB, mock provider. Cache hit, cache miss, stale model triggers regen, stale prompt_version triggers regen, regenerate() always re-runs, no-chunks filing → ValidationError | 6 |
| API routes integration | Real DB, mocked auth + provider. GET cache hit, GET cache miss, POST?regenerate=1 always regens, 401 unauth, 400 invalid params, 502 provider failure | 6 |
| RLS smoke | Authenticated SELECT works, authenticated INSERT blocked | 2 |
| Smoke script | `pnpm try-summarize AAPL <accession>` — real DashScope, real filing | (manual) |

**Total: ~21 new tests** (7 unit + 14 integration). Brings cumulative test counts to: ~88 unit + 93 integration.

**Tests mock the provider for everything except the smoke script.** Real LLM calls in CI = flaky + expensive. The mock returns a fixed markdown blob; we verify the service handles it correctly, not the LLM quality. Quality verification is via manual smoke script review before locking prompt v1.

**No E2E tests** — Stack Auth ESM/Playwright incompatibility from Slice 1C still unresolved. Deferred at the slice level (noted in plan).

## Vercel Deploy

- Add `DASHSCOPE_API_KEY` to Vercel project env vars (production + preview).
- Optional: add to GitHub Actions secrets if we want CI to hit the smoke script. Recommended: don't — keep CI deterministic. The smoke script is manual.
- No Vercel cron involvement. Summaries are user-triggered (page load), not scheduled.
- No new function timeout config needed beyond the `maxDuration = 60` on the summary route file.

## What's NOT in Slice 2B (deliberately deferred)

- **Per-section TLDRs** — would multiply LLM cost ~6x. May add in a future slice if user feedback warrants.
- **Quarter-over-quarter diff** — comparing this filing's Risk Factors to the prior filing's. Higher-signal product but more complex prompt + multi-filing fetch. Future slice.
- **Filings list "✨ briefing ready" pill** — optional polish. Defer to end-of-slice if time permits; cut if it pushes past scope.
- **Streaming token-by-token response** — adds complexity for marginal UX gain on a 5-10s call. Revisit only if perceived latency becomes a real problem.
- **Multi-provider fallback** (e.g., fall back to OpenAI when DashScope is down) — YAGNI until we observe DashScope reliability.
- **Cost dashboard** — token columns are there, but no UI yet. Can be a 1-task addition later.
- **E2E tests** — Stack Auth ESM blocker carries forward from Slice 1C.

## Implementation Order

The plan will follow this order:

1. **Schema + RLS** — new table, migration, RLS, both Neon branches.
2. **`QwenProvider` + unit tests** — happy path + 7 error cases.
3. **Prompt iteration** — write `scripts/try-summarize.ts`, run against 3 real filings, iterate prompt until output is solid, THEN commit `prompt_version = 'v1'`.
4. **`SummariesService` + integration tests** — service logic + 6 tests.
5. **API routes** — GET + POST + tests.
6. **UI** — briefing card + Suspense + regenerate button + markdown rendering.
7. **Push + Vercel verify** — confirm DashScope key in env, smoke test in browser.

Each phase commits independently following the established cadence from Slice 2A.
