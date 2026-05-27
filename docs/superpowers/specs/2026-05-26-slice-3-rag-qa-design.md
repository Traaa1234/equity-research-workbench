# Slice 3 — RAG / Q&A Across Watchlist Filings Design

**Status:** Approved 2026-05-26. Implementation plan to follow.

**Builds on:** Slices 1, 2A (EDGAR ingestion), 2B (LLM briefings), 2C (semantic search) — all shipped to production.

## Goal

Add a natural-language Q&A interface where users ask questions about SEC filings ("What did Apple say about AI infrastructure capex?", "Which of my companies have China supply concentration?") and receive **Gemini-generated** answers with inline numbered citations linking back to specific filing sections. Vector retrieval (from Slice 2C) selects the top-8 chunks; the LLM synthesizes a grounded answer with bracketed `[N]` markers that map to source cards prefetched in the same response.

Two entry surfaces share one component:
- **Cross-watchlist Q&A** at `/watchlist` — searches across every filing of every watched ticker
- **Per-ticker Q&A** at `/stock/[ticker]/ask` — bounded to one ticker's filings

Response streams token-by-token via Vercel AI SDK + the existing `openai` npm package configured for **Google's Gemini OpenAI-compatible endpoint**. Why Gemini for RAG instead of Qwen (Slice 2B):
- **Free tier**: 15 RPM, 1M input tokens/day — covers a single user's research load indefinitely with $0 ongoing cost
- **5× cheaper paid tier** ($0.075/M input vs Qwen's $0.40/M) if free tier is ever exceeded
- **Provider diversity**: if DashScope ever has a bad day (as observed in our Slice 2C deploy), the RAG path keeps working

**DashScope/Qwen stays for Slice 2B briefings and Slice 2C embeddings unchanged** — only the new RAG path uses Gemini. The embedding model in particular cannot be swapped without re-embedding the entire `chunk_embeddings` corpus (different dimensionalities).

## Non-Goals

- **Multi-turn / threaded chat.** Single-shot Q&A only. Each question is independent. The `qa_history` table is an audit log, not conversational memory.
- **Cached / semantically-equivalent question reuse.** Every Q&A re-runs retrieval + LLM. Streaming caches add complexity for marginal benefit at our usage.
- **Cross-filing comparison mode** ("compare risk language Q-over-Q"). Needs a different retrieval shape; defer to Slice 3.5.
- **Reranking** (Cohere Rerank, cross-encoders). Add only if hallucination becomes a problem in practice.
- **Voice input / TTS output.** Different product.
- **Suggested follow-up questions** at end of answer. Easy add-on, not v1.
- **Dedicated "Compare A vs B" mode.** Works via cross-watchlist Q&A today.
- **Citation accuracy validation** (verifying `[N]` markers point to chunks that actually support the claim). Whole sub-system; trust the prompt for v1.
- **Conversation export / share.** YAGNI.
- **qa_history browse UI.** Data is captured but not surfaced; add when valued.
- **Edge runtime streaming.** Node runtime is sufficient; Edge restrictions outweigh the latency win.
- **E2E Playwright tests.** Stack Auth ESM blocker continues from Slice 1C.

## Product

### Cross-watchlist Q&A on `/watchlist`

Today the watchlist page has a Slice 2C search bar at top. Slice 3 adds a tab strip that switches between **Search** (Slice 2C: ranked chunk list) and **Ask** (Slice 3: synthesized answer with citations):

```
┌──────────────────────────────────────────────────────────┐
│  Watchlist · 3 tickers                                   │
│                                                          │
│  ┌─[Search] [Ask]─────────────────────────────────────┐  │
│  │                                                    │  │
│  │  🔍 Ask a question about your watchlist's filings… │  │
│  │                                          [Submit]  │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  Examples: "Which of my companies have China supply      │
│  exposure?", "Compare AI infrastructure spending across  │
│  my watchlist", "Who flagged regulatory risk in their    │
│  latest 10-K?"                                           │
│                                                          │
│  [results render here after submit]                      │
│                                                          │
│  ────── Your tickers ──────                              │
│  [AAPL] [TSLA] [NVDA]                                    │
└──────────────────────────────────────────────────────────┘
```

URL-driven: `/watchlist?mode=ask&q=...` is shareable + back-button friendly.

### Per-ticker Q&A on `/stock/[ticker]/ask`

Each ticker dashboard gets an "Ask" tab next to Overview · Financials · Filings:

```
┌──────────────────────────────────────────────────────────┐
│  AAPL                Overview · Financials · Filings ·Ask│
│  Apple Inc.                                              │
│  ════════════════════════════════════════════════════════│
│                                                          │
│  🔍 Ask a question about AAPL's filings…       [Submit]  │
│                                                          │
│  Examples: "What did Apple say about AI capex in their   │
│  most recent 10-K?", "How has the China tariff risk      │
│  language changed quarter-over-quarter?"                 │
│                                                          │
│  [results render here after submit]                      │
└──────────────────────────────────────────────────────────┘
```

Scope is fixed to the URL's ticker; examples are ticker-aware.

### Result rendering (both surfaces)

After submit, three sections appear in order:

1. **Sources row** (~500ms after submit) — 8 source cards horizontally, each showing ticker, form, date, section, snippet, click-through to filing reader. Numbered `[1]` through `[8]`.

2. **Answer** (starts streaming ~1.2s after submit, completes ~7s) — token-by-token typewriter rendering. Inline `[N]` markers parse client-side into clickable superscripts; hover highlights the corresponding source card above.

3. **"Ask another question"** button after stream completes — resets state.

## Architecture

```
                                ┌──────────────────────────┐
client useChat() POST /api/rag  │  RagService.answer()     │
   ↓                            │                          │
   { query, scope }             │  1. SearchService        │
                                │     (top-30 chunks,      │
                                │      maxDistance 0.55)   │
                                │                          │
                                │  2. diversity post-rank  │
                                │     (≤3 per filing,      │
                                │      keep 8)             │
                                │                          │
                                │  3. assemble prompt      │
                                │     w/ numbered chunks   │
                                │                          │
                                │  4. streamText({         │
                                │       model: gemini-2.5- │
                                │         flash,           │
                                │       messages,          │
                                │       provider: google   │
                                │         openai-compat    │
                                │     })                   │
                                │                          │
                                │  5. emit sources via     │
                                │     streamData;          │
                                │     emit tokens as       │
                                │     they arrive          │
                                │                          │
                                │  6. async post-stream:   │
                                │     INSERT qa_history    │
                                │     w/ full answer +     │
                                │     citations            │
                                └──────────────────────────┘
                                            │
                                            ▼
client useChat()
   ↓ streamData receives sources first  → renders source cards
   ↓ messages stream tokens             → typewriter answer
   ↓ regex parses [N] markers           → clickable links
```

End-to-end: ~7s total, first tokens at ~1.2s, ~$0.003 per question.

## Schema

### New table: `qa_history`

```ts
export const qaHistory = pgTable(
  'qa_history',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    scopeType: text('scope_type').notNull(),       // 'watchlist' | 'ticker'
    scopeTicker: text('scope_ticker'),             // nullable; only set when scope_type='ticker'
    query: text('query').notNull(),
    answerText: text('answer_text').notNull(),
    citations: jsonb('citations').notNull(),       // SearchResult[]-ish with cited chunk identifiers
    model: text('model').notNull(),                // e.g. 'gemini-2.5-flash'
    promptVersion: text('prompt_version').notNull(), // e.g. 'v1'
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
  },
  (t) => ({
    userCreatedIdx: index('qa_history_user_created_idx').on(t.userId, t.createdAt.desc())
  })
);
```

**The `scope_ticker` FK is intentionally absent.** If a user asks a per-ticker Q&A and later removes that ticker from their watchlist, the history row should still be readable — it's an audit log of past activity. A foreign key with cascade would delete history rows when watchlist entries are removed.

**`citations` column is JSONB** containing an array of objects:

```ts
type CitationRow = {
  marker: number;          // 1..8 matching [N] in answer_text
  accessionNo: string;
  ticker: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  subChunkIndex: number;
  distance: number;
};
```

Stored as JSON because the cardinality is bounded (≤8 citations per row) and we'll never query individual citations independently of the answer.

### RLS migration: `9995_rls_qa_history.sql`

**This is the first user-scoped RLS in the project.** Previous tables are reference data (filings, embeddings, summaries) where anyone authenticated can read. `qa_history` is per-user — Alice cannot see Bob's questions.

```sql
alter table public.qa_history enable row level security;

drop policy if exists "users read own qa_history" on public.qa_history;
create policy "users read own qa_history"
  on public.qa_history for select to authenticated
  using (user_id::text = current_setting('request.jwt.claim.sub', true));

grant select on public.qa_history to authenticated;
```

Writes still go through `service_role` (BYPASSRLS) — the API route writes the row after the stream completes; the user role never inserts directly.

The `9995` prefix sequences before existing RLS files (`9996`, `9997`, `9998`, `9999`).

Applied manually via `_apply.ts` script to both Neon branches — **never via `drizzle-kit push --force`** (RLS-wipe lesson from Slice 2A).

## SearchService extensions

Add two optional opts to `SearchService.searchAcrossWatchlist`:

```ts
async searchAcrossWatchlist(opts: {
  userId: string;
  query: string;
  limit?: number;
  formTypes?: string[];
  tickerScope?: string;     // NEW: limit to one ticker
  maxDistance?: number;     // NEW: stricter cutoff for RAG
}): Promise<SearchResult[]>;
```

**`tickerScope`** — when set, the SQL gets `AND f.ticker = $tickerScope` added to the WHERE clause. RLS + watchlist filter still apply, so passing a ticker the user doesn't watch returns empty.

**`maxDistance`** — defaults to `DISTANCE_THRESHOLD = 0.7` for backward compatibility with the Slice 2C search UI. RagService passes `0.55` for stricter retrieval.

Updates **2 of the existing 6** SearchService integration tests (assertion adjustments). Adds **2 new tests** specifically for the new opts.

## GeminiProvider (new) + streaming

A NEW provider `lib/providers/gemini.ts` mirrors `lib/providers/qwen.ts` but points at Google's Gemini OpenAI-compatible endpoint. **Qwen provider stays unchanged**; both providers coexist (Qwen for Slice 2B briefings, Gemini for Slice 3 RAG).

```ts
export class GeminiProviderImpl implements ChatProvider {
  constructor(opts?: {
    apiKey?: string;       // default: process.env.GEMINI_API_KEY
    baseUrl?: string;      // default: https://generativelanguage.googleapis.com/v1beta/openai/
    timeoutMs?: number;    // default: 30_000
    fetch?: typeof fetch;
  });

  async streamChat(opts: {
    model: string;          // e.g. 'gemini-2.5-flash'
    systemPrompt: string;
    userPrompt: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<string>>;

  // Optional: non-streaming variant for testing / parity with Qwen
  async chat(opts: { ... }): Promise<{ text: string; inputTokens: number; outputTokens: number; }>;
}
```

Internally uses the existing `openai` npm package — Gemini speaks OpenAI's API shape at the `/v1beta/openai/` base URL.

**Streaming**: calls `client.chat.completions.create({ stream: true, ... })` and adapts the SDK's stream interface into a plain `AsyncIterable<string>` for `for await` consumption.

**Abort support**: passing a `signal: AbortSignal` lets RagService cancel the stream if the client disconnects mid-response (avoids paying for tokens the user won't see).

**Error handling**: errors mid-stream propagate by throwing inside the iterator on the next `.next()` call. Maps to the existing typed errors from `lib/providers/types.ts` (`RateLimitError`, `ProviderError`, `ValidationError`, `UnknownProviderError`) — same shape as `QwenProviderImpl`.

**Why a new provider class, not extending Qwen's:**
- Different env var (`GEMINI_API_KEY` vs `DASHSCOPE_API_KEY`)
- Different default base URL
- Cleaner separation: if we ever want both providers active in different routes, the two classes stay independent
- The shared error taxonomy in `lib/providers/types.ts` covers both

**A shared `ChatProvider` interface** is added to `lib/providers/types.ts` so RagService can depend on the interface (not the concrete class), enabling swap or fallback:

```ts
export interface ChatProvider {
  streamChat(opts: {...}): Promise<AsyncIterable<string>>;
}
```

Both `QwenProviderImpl` and `GeminiProviderImpl` implement it. `QwenProviderImpl` gains a `streamChat()` method for symmetry (deferred — not built in Slice 3 since briefings don't need streaming).

**4 new unit tests for GeminiProvider:**
1. Happy path — streamChat yields chunks
2. Stream abort via AbortSignal — iterator stops
3. 429 mid-stream → RateLimitError thrown
4. Empty/malformed response → UnknownProviderError

## RagService — `lib/services/rag.ts`

```ts
export const CURRENT_MODEL = 'gemini-2.5-flash';
export const CURRENT_PROMPT_VERSION = 'v1';
const MAX_OUTPUT_TOKENS = 800;
const RAG_MAX_DISTANCE = 0.55;
const RETRIEVAL_RAW_K = 30;
const RETRIEVAL_FINAL_K = 8;
const MAX_PER_FILING = 3;
const MAX_QUERY_CHARS = 500;

interface Deps {
  db: ServiceDb;
  searchService: SearchService;
  chatProvider: ChatProvider;   // GeminiProviderImpl in production
}

export interface RagScope {
  type: 'watchlist' | 'ticker';
  ticker?: string;  // required when type='ticker'
}

export interface RagSource {
  marker: number;
  ticker: string;
  companyName: string;
  accessionNo: string;
  formType: string;
  filingDate: string;
  sectionKey: string;
  sectionTitle: string;
  subChunkIndex: number;
  snippet: string;
  distance: number;
}

export interface RagResult {
  sources: RagSource[];
  answerStream: AsyncIterable<string>;
  finalize: (fullAnswer: string, tokenUsage?: { input: number; output: number }) => Promise<void>;
}

export class RagService {
  constructor(private readonly deps: Deps) {}

  async answer(opts: {
    userId: string;
    query: string;
    scope: RagScope;
  }): Promise<RagResult>;
}
```

**`answer()` flow:**

1. Validate query length and scope shape; throw `ValidationError` on invalid input.
2. Call `searchService.searchAcrossWatchlist({...opts, limit: 30, maxDistance: 0.55, tickerScope: scope.ticker})`.
3. If 0 results → return a result with empty sources + an async iterable that yields one apologetic message ("The filings don't contain content relevant to your question."). Skip the LLM call entirely (saves $0.003).
4. Apply per-filing diversity post-rank: greedy walk through results in distance order, accept each chunk only if its filing's running count is < 3, stop at 8. Renumber `marker` 1..N.
5. Assemble prompt (see Prompt section below).
6. Call `chatProvider.streamChat({...})` → get the AsyncIterable.
7. Return `{ sources, answerStream, finalize }` where `finalize` is a closure capturing `userId`, `query`, `scope`, `sources`, etc. The route handler calls `finalize(fullAnswer, tokens)` after the stream completes.

**`finalize()` flow** (called by the route handler after stream done):
- INSERT into `qa_history` with full answer text + citation metadata
- Insert `refresh_runs` row with `kind = 'rag:<scope>'`, `source_used = 'gemini'`, `ok = true`
- Both writes are wrapped in try/catch — failure logs a warning but doesn't throw (best-effort; user already has the answer on screen)

**8 integration tests:**
1. Cross-watchlist retrieval: returns 8 sources from multiple tickers
2. Ticker-scoped retrieval: returns only chunks from the specified ticker
3. Per-filing diversity: when 20 chunks from same filing rank highest, output has only 3 from that filing + 5 others
4. Empty retrieval (all > maxDistance) short-circuits: no LLM call made, returns empty sources + apology stream
5. Empty watchlist: throws `ValidationError`
6. Happy path: finalize() persists qa_history row with full answer + citations
7. Zero-citations answer (LLM emits no `[N]` markers): finalize() still persists; warning logged
8. finalize() DB failure doesn't throw (best-effort)

## Prompt design

Locked under `prompt_version = 'v1'` after smoke-test iteration in T6.1.

**System prompt (~100 tokens):**

```
You are a senior equity research analyst answering investor questions
using SEC filing excerpts. Rules:

1. Only use facts from the numbered sources below. Do NOT use outside
   knowledge or guess. If the sources don't contain the answer, say
   "The provided filings don't directly answer this. The closest
   relevant content is: [briefly summarize what was retrieved]."

2. Cite every factual claim with a bracketed marker matching the
   source number, e.g. "Revenue grew 14% to $96B [1]".

3. Be concise. Aim for 3-6 sentences, plus optional bullet points
   when the question asks for a list.

4. Use exact numbers, dates, and named entities from the sources.
   Avoid hedging ("appears", "seems", "may").

5. Do not summarize the entire filing. Answer ONLY the question asked.
```

**User prompt template:**

````
Question: {QUERY}

Sources (each numbered chunk is a passage from an SEC filing):

[1] {ticker} · {formType} · filed {filingDate} · {sectionTitle}
{chunk.text}

[2] {ticker} · {formType} · filed {filingDate} · {sectionTitle}
{chunk.text}

...

[8] {ticker} · {formType} · filed {filingDate} · {sectionTitle}
{chunk.text}

Answer the question using only these sources. Cite with [N] markers.
````

**Token math per Q (Gemini 2.5 Flash):**

- System prompt: ~100 tokens
- 8 chunks × ~500 tokens = ~4000 tokens
- Question + scaffolding: ~50 tokens
- Total context: ~4150 tokens (well under Gemini 2.5 Flash's 1M token context window)
- Output: ~400 tokens (3-6 sentences + citations)
- Cost on paid tier: ~$0.0003 input + ~$0.00012 output ≈ **~$0.0004 per question** (~5× cheaper than Qwen would have been)
- Cost on free tier (≤1M input tokens/day, 15 RPM): **$0** — covers ~250 questions/day comfortably

**Prompt iteration policy:**

Before locking `prompt_version = 'v1'`, the smoke script (`pnpm try-ask`) is run against 3 questions: one cross-watchlist, one per-ticker, one that should retrieve nothing. Each output is eyeballed for:
- Does it cite every claim with `[N]`?
- Are the numbers / names taken verbatim from sources?
- Does the "I don't have data for this" fallback fire correctly?

If poor, iterate the system prompt or template, re-run, repeat. Lock when 3-of-3 outputs pass criteria.

Any post-launch prompt changes → bump to `v2`, which (via the `prompt_version` column on `qa_history`) lets us identify which answers came from which prompt version when auditing.

## Streaming pipeline

**Vercel AI SDK** (`ai` + `@ai-sdk/openai-compatible` packages) bridges between RagService's AsyncIterable and the React client.

**Server-side (route handler):**

```ts
import { streamText, createDataStreamResponse } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const gemini = createOpenAICompatible({
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  apiKey: process.env.GEMINI_API_KEY,
  name: 'gemini'
});

export async function POST(req: Request) {
  const userId = await requireUserId();
  const { query, scope } = await req.json();
  // ...validate...

  const rag = new RagService({ db, searchService, chatProvider });
  const ragResult = await rag.answer({ userId, query, scope });

  return createDataStreamResponse({
    execute: (writer) => {
      // Emit sources first (via streamData side-channel)
      writer.writeData({ type: 'sources', sources: ragResult.sources });

      // Stream the LLM tokens
      const llmStream = streamText({
        model: gemini('gemini-2.5-flash'),
        messages: ragResult.messages
      });

      llmStream.mergeIntoDataStream(writer, { sendReasoning: false });

      // After stream completes, persist qa_history
      llmStream.consumeStream().then(async () => {
        await ragResult.finalize(llmStream.text, {
          input: llmStream.usage.promptTokens,
          output: llmStream.usage.completionTokens
        });
      });
    }
  });
}
```

**Client-side (in `<AskPanel>`):**

```tsx
'use client';
import { useChat } from 'ai/react';

const { messages, input, handleSubmit, status, data } = useChat({
  api: '/api/rag/stream'
});

// `data` is the streamData side-channel — contains the sources object
const sources = data?.find(d => d.type === 'sources')?.sources;
const answer = messages.find(m => m.role === 'assistant')?.content;
```

`useChat` manages: opening the stream, decoding tokens, updating React state on each chunk, handling errors, exposing `isLoading` / `stop()` / `reload()` helpers. We get all of this for free; we don't write any streaming code.

**Citation parsing (client-side):**

```ts
function parseCitations(answer: string, sources: RagSource[]) {
  // Match all [N] markers, link to corresponding source
  return answer.replace(/\[(\d+)\]/g, (full, n) => {
    const idx = parseInt(n);
    const source = sources.find(s => s.marker === idx);
    if (!source) return full; // invalid marker stays as text
    return `<sup data-source="${idx}">[${idx}]</sup>`;
  });
}
```

Rendered via `react-markdown` (already installed for Slice 2B briefings) with a custom `sup` component that triggers hover-highlight on the corresponding source card.

## API route — `/api/rag/stream`

```
POST /api/rag/stream
Body: { query: string; scope: { type: 'watchlist' | 'ticker'; ticker?: string } }
```

**Auth:** `requireUserId()` (Stack Auth cookie). Returns 401 if missing.

**Validation:**
- `query` is 1..500 chars after trim → else 400
- `scope.type` is `'watchlist'` or `'ticker'` → else 400
- if `scope.type === 'ticker'`, `scope.ticker` matches `/^[A-Z][A-Z.]{0,5}$/` → else 400

**Response:** `Content-Type: text/event-stream` (or whatever Vercel AI SDK defaults to for `createDataStreamResponse`). Body is the streamed token sequence with sources injected first.

**Errors:**
- 401 — unauth
- 400 — validation
- 503 — provider rate limit (with `Retry-After` header if Gemini sent one)
- 502 — provider error (generic)
- 500 — unexpected

**`maxDuration = 60`** on the route file (covers ~7s typical + safety headroom).

## UI components

### Shared `<AskPanel>` component

```tsx
// app/(app)/_components/ask-panel.tsx
'use client';

interface Props {
  scope: { type: 'watchlist'; } | { type: 'ticker'; ticker: string };
}

export function AskPanel({ scope }: Props) {
  // useChat + state machine + render
}
```

Internal state machine: `[empty] → [retrieving] → [streaming] → [done]` (or `[error]` from any state).

### Child components

- `<AskInput>` — controlled `<input>` + submit button + ticker-aware example hints
- `<AskSourcesRow>` — 8 source cards in a horizontal scroll row, numbered, click-through to filing reader at the source's section
- `<AskSourceCard>` — single card (ticker badge, form, date, section, snippet)
- `<AskAnswer>` — streaming answer area; parses `[N]` markers into linked `<sup>` elements; auto-scrolls source row when hovered
- `<AskSkeleton>` — placeholder during `[retrieving]`

### Surface wiring

**`/watchlist`** (modified `page.tsx`):
- Accepts `searchParams: { q?, mode? }`
- If `mode === 'ask'`, renders `<AskPanel scope={{ type: 'watchlist' }} />`
- If `mode === 'search'` (or undefined), renders existing Slice 2C `<SearchResults>`
- Both modes accessible via a `<WatchlistTabs>` component that toggles via the `?mode=` URL param

**`/stock/[ticker]/ask`** (NEW page):
- Fresh route file at `app/(app)/stock/[ticker]/ask/page.tsx`
- Renders `<AskPanel scope={{ type: 'ticker', ticker }} />`
- The shared header + Tabs component on every ticker page gets a new "Ask" trigger linking here

### Files

```
app/(app)/_components/
  ask-panel.tsx                   # NEW: shared Ask UI
  ask-input.tsx                   # NEW: client island, controlled input
  ask-sources-row.tsx             # NEW: horizontal scroll of cards
  ask-source-card.tsx             # NEW: single source card
  ask-answer.tsx                  # NEW: streaming answer + citation parsing
  ask-skeleton.tsx                # NEW: retrieving state placeholder

app/(app)/watchlist/
  page.tsx                        # MODIFIED: searchParams.mode toggles Search/Ask
  _components/
    watchlist-tabs.tsx            # NEW: Search/Ask tab strip

app/(app)/stock/[ticker]/
  ask/
    page.tsx                      # NEW: per-ticker Ask tab content
  page.tsx                        # MODIFIED: add Ask trigger to Tabs nav
  financials/page.tsx             # MODIFIED: add Ask trigger
  filings/page.tsx                # MODIFIED: add Ask trigger
  filings/[accession]/page.tsx    # MODIFIED: add Ask trigger
```

## Error handling

| Failure | Surface | UI | Persisted? |
|---|---|---|---|
| `GEMINI_API_KEY` missing | stream | "Q&A unavailable (provider not configured)" + retry | No |
| `DASHSCOPE_API_KEY` missing | retrieval-time query embedding | "Q&A unavailable (provider not configured)" + retry | No |
| Query embedding 429 | retrieval | "Rate-limited, try in a moment" + retry | No |
| Empty watchlist | retrieval | "Add tickers to your watchlist to ask questions about them" | No |
| Retrieval yields 0 chunks (all > maxDistance) | retrieval | Apologetic stream: "The filings don't contain content relevant to your question." | No |
| LLM 429 mid-stream | stream | Partial answer kept + "Connection interrupted, retry" | No |
| LLM 5xx mid-stream | stream | Partial answer kept + "Provider error, retry" | No |
| Stream timeout (>60s) | stream | Partial answer + retry button | No |
| LLM emits 0 `[N]` markers | post-stream | Answer renders with footer: "This answer has no citations — verify independently." | **Yes** (still useful) |
| LLM cites `[N]` outside 1..len(sources) | post-stream | Invalid marker rendered as plain text; same footer warning | **Yes** |
| User clicks Stop mid-stream | client | Partial answer kept; "Ask another question?" prompt | No |
| `qa_history` INSERT fails post-stream | persistence | UI unaffected; warning logged | **No** (best-effort) |

**Critical invariant: persistence is best-effort, async, post-stream.** A DB failure during finalize doesn't fail the user-visible Q&A. Different from Slice 2A/2B where DB writes were synchronous to the response.

**`refresh_runs` integration:** every attempt writes a row (`kind = 'rag:<scope>'`, `source_used = 'gemini'`, `ok`, `error` truncated to 1000 chars on failure).

## Testing

| Layer | Cases | Count |
|---|---|---|
| **SearchService** unit (modified) | new `tickerScope` filter · new `maxDistance` threshold | +2 tests (existing 6 still pass) |
| **GeminiProvider streaming** unit | streamChat happy path · abort signal stops iterator · 429 mid-stream → RateLimitError · empty/malformed → UnknownProviderError | 4 |
| **RagService** integration (real test DB, mocked chat provider) | cross-watchlist retrieval returns sources · ticker-scoped retrieval · per-filing diversity ≤3 · empty retrieval short-circuits (no LLM) · empty watchlist → ValidationError · finalize persists qa_history · zero-citation answer persists with warning · finalize DB failure doesn't throw | 8 |
| **API route** `/api/rag/stream` integration | 200 streaming · 400 invalid scope · 400 oversized query · 401 unauth · 503 on rate limit · empty retrieval returns helpful message | 6 |
| **RLS smoke** for `qa_history` | user can SELECT own rows · user cannot SELECT others' rows · user cannot INSERT directly | 3 |
| **Smoke script** `pnpm try-ask` | manual end-to-end against live DashScope, prints sources + streaming answer | (manual) |

**Total: 4 new unit + 19 new integration = 23 new tests.** Cumulative project-wide after Slice 3: **107 unit + 136 integration = 243 tests** (existing 103 + 4 new unit; existing 117 + 19 new integration).

**Streaming tests strategy:** the openai SDK's `stream: true` mode is mocked via dependency injection on `GeminiProvider` — tests pass in an `AsyncIterable<string>` directly, bypassing the SDK's network layer. No real LLM calls in CI.

**No E2E Playwright** (Stack Auth ESM blocker carries from Slice 1C).

## Vercel Deploy

- **New env var: `GEMINI_API_KEY`** — grab from https://aistudio.google.com/apikey (free tier, no credit card needed). Add to `.env.local`, Vercel env vars (Production + Preview), and GitHub Actions secrets if CI needs it (tests mock the provider so likely not needed).
- `DASHSCOPE_API_KEY` still in use for Slice 2B briefings + Slice 2C embeddings (unchanged)
- `maxDuration = 60` on `/api/rag/stream`
- Vercel Node runtime supports streaming responses natively — no config changes
- New npm packages: `ai`, `@ai-sdk/openai-compatible`
- Node runtime (NOT edge) — we use `postgres` (TCP) and other Node-only APIs in the route

## Implementation Order

Plan tasks proceed in this order, each step committing independently:

1. **Schema + RLS** — `qa_history` table on both Neon branches, user-scoped RLS policy
2. **SearchService extensions** — add `tickerScope` + `maxDistance` opts + 2 new tests
3. **GeminiProvider** — new `lib/providers/gemini.ts` with `streamChat()` AsyncIterable method + shared `ChatProvider` interface in `lib/providers/types.ts` + 4 unit tests
4. **RagService** — retrieval + diversity + prompt + finalize + 8 integration tests
5. **Vercel AI SDK install + API route** — `pnpm add ai @ai-sdk/openai-compatible`; write `/api/rag/stream` + 6 integration tests
6. **RLS smoke for qa_history** — 3 tests
7. **Smoke script** — `pnpm try-ask "<query>"` + prompt iteration + lock v1
8. **UI components** — `<AskPanel>`, sources row, answer, skeleton, citation parser
9. **Wire in both surfaces** — `/watchlist` tabs + `/stock/[ticker]/ask` page + dashboard tab nav updates
10. **Push + Vercel deploy + browser smoke** on both surfaces

Each phase commits independently. TDD: tests before code for the service + API layers.
