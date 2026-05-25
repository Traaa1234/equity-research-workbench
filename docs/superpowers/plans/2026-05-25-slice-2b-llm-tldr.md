# Slice 2B — LLM Briefing (Whole-Filing Summary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a structured LLM briefing ("What they do · Highlights · Key risks · Bottom line") to the top of every filing reader page. Generated on-demand the first time someone opens a filing, persisted to Postgres, served instantly on every subsequent visit. ~$0.025/filing via Qwen-plus on Alibaba DashScope.

**Architecture:** New `QwenProvider` TS adapter wraps the `openai` npm package (OpenAI-compatible API) pointed at DashScope's international endpoint. New `SummariesService` is the cache layer over a new `filing_summaries` table; reads return cached rows if `model` + `prompt_version` match the code-level constants, otherwise it re-runs the LLM and upserts. UI uses an async server component inside `<Suspense>` so the rest of the page paints instantly while the briefing loads.

**Tech Stack:** Slice 2A stack + `openai` npm package (configured for DashScope) + `react-markdown` + `remark-gfm` for output rendering.

**Spec reference:** `docs/superpowers/specs/2026-05-25-slice-2b-llm-tldr-design.md`

**Prior phases:** Slices 1 + 2A are shipped. This plan picks up at commit `972e86b` (the Slice 2B spec).

---

## File Structure for Slice 2B

```
equity-research-workbench/
├── app/
│   ├── (app)/stock/[ticker]/filings/[accession]/
│   │   ├── page.tsx                                  # MODIFIED: add briefing card in Suspense
│   │   └── _components/
│   │       ├── filing-briefing.tsx                   # async server component (NEW)
│   │       ├── briefing-skeleton.tsx                 # CSS skeleton (NEW)
│   │       └── regenerate-button.tsx                 # client island (NEW)
│   └── api/
│       └── tickers/[symbol]/filings/[accession]/
│           └── summary/
│               └── route.ts                          # GET + POST (NEW)
├── lib/
│   ├── db/
│   │   ├── schema.ts                                 # MODIFIED: add filingSummaries
│   │   ├── types.ts                                  # MODIFIED: add FilingSummary types
│   │   └── migrations/
│   │       └── 9997_rls_filing_summaries.sql         # RLS for new table (NEW)
│   ├── providers/
│   │   ├── qwen.ts                                   # QwenProviderImpl (NEW)
│   │   └── types.ts                                  # MODIFIED: add QwenProvider interface + types
│   └── services/
│       ├── filings.ts                                # MODIFIED: add getAllSectionTexts method
│       └── summaries.ts                              # SummariesService (NEW)
├── scripts/
│   └── try-summarize.ts                              # smoke test (NEW)
└── tests/
    ├── providers/
    │   ├── qwen.test.ts                              # unit tests (NEW)
    │   └── __fixtures__/
    │       └── qwen-completion-response.json         # mock LLM response (NEW)
    └── integration/
        ├── summaries-service.test.ts                 # 6 tests (NEW)
        ├── api-summary.test.ts                       # 6 tests (NEW)
        └── filing-summaries-rls.test.ts              # 2 tests (NEW)
```

**Module responsibilities:**

| Module | Purpose | Depends on |
| --- | --- | --- |
| `lib/providers/qwen.ts` | OpenAI-SDK-backed adapter pointed at DashScope; single `summarize()` method | `openai`, provider types |
| `lib/services/summaries.ts` | Cache + invalidation logic over `filing_summaries`; assembles prompt | QwenProvider, FilingsService, db |
| `lib/services/filings.ts` (modified) | Adds `getAllSectionTexts()` for the prompt assembler | db schema |
| `app/api/tickers/[symbol]/filings/[accession]/summary/route.ts` | Thin HTTP shell — GET serves cache or generates, POST?regenerate=1 forces regen | SummariesService |
| `app/(app)/stock/[ticker]/filings/[accession]/_components/filing-briefing.tsx` | Async RSC; calls service directly server-side, renders markdown | SummariesService, react-markdown |
| `app/(app)/stock/[ticker]/filings/[accession]/_components/regenerate-button.tsx` | Client island; POSTs to regenerate route, toasts, refreshes | fetch, useToast |
| `app/(app)/stock/[ticker]/filings/[accession]/_components/briefing-skeleton.tsx` | Pure CSS skeleton shown via Suspense fallback | Skeleton primitive |

---

## Milestone 1: Schema + RLS

### Task 1.1: Add `filingSummaries` to Drizzle schema

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/db/types.ts`

- [ ] **Step 1: Append to `lib/db/schema.ts`**

`integer` and `timestamp` are already imported from Slice 2A. Just add the table at the end of the file:

```ts
export const filingSummaries = pgTable(
  'filing_summaries',
  {
    filingId: text('filing_id')
      .primaryKey()
      .references(() => filings.accessionNo, { onDelete: 'cascade' }),
    summaryText: text('summary_text').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow()
  }
);
```

No additional indexes needed — the PK on `filing_id` is the only access pattern.

- [ ] **Step 2: Append to `lib/db/types.ts`**

Merge `filingSummaries` into the existing `import type { ... } from './schema'` line at the top, then add:

```ts
export type FilingSummary    = typeof filingSummaries.$inferSelect;
export type NewFilingSummary = typeof filingSummaries.$inferInsert;
```

- [ ] **Step 3: Generate migration**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm db:generate
```

Expected: creates `lib/db/migrations/0005_<random>.sql` with `CREATE TABLE filing_summaries (...)`. Inspect the generated SQL to confirm it has the PK, FK with cascade, and the timestamp default.

- [ ] **Step 4: Apply migration to BOTH Neon branches via SQL (do NOT use drizzle-kit push --force)**

`drizzle-kit push --force` wiped RLS policies during Slice 2A. We apply this migration directly with postgres.js.

Write a temporary `_apply.ts` in the project root:

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const targetArg = process.argv.indexOf('--target');
const fileArg = process.argv.indexOf('--file');
const target = targetArg >= 0 ? process.argv[targetArg + 1] : null;
const file = fileArg >= 0 ? process.argv[fileArg + 1] : null;
if (!target || !file) { console.error('Usage: tsx _apply.ts --target prod|test --file <path>'); process.exit(2); }

const url = target === 'prod' ? process.env.DATABASE_URL_SERVICE_ROLE : process.env.DATABASE_URL_TEST_SERVICE_ROLE;
if (!url) { console.error(`URL for ${target} not set`); process.exit(2); }

const sqlText = readFileSync(file, 'utf8');
const sql = postgres(url, { prepare: false, max: 1 });
try {
  await sql.unsafe(sqlText);
  console.log(`Applied ${file} to ${target} OK`);
} catch (e) {
  console.error('Apply failed:', e);
  process.exit(1);
} finally {
  await sql.end();
}
```

Apply to both branches:

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/0005_<random>.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/0005_<random>.sql
```

Expected: both print `Applied ... OK`.

- [ ] **Step 5: Verify both branches have the new table**

Write `_check.ts`:

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';

for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
]) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const t = await sql`select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'filing_summaries' order by ordinal_position`;
  console.log(`\n${label}:`);
  for (const r of t) console.log(`  ${r.column_name}: ${r.data_type}`);
  await sql.end();
}
```

```bash
pnpm exec tsx _check.ts
```

Expected output for each branch:
```
filing_id: text
summary_text: text
model: text
prompt_version: text
input_tokens: integer
output_tokens: integer
generated_at: timestamp with time zone
```

Delete `_apply.ts` and `_check.ts`.

- [ ] **Step 6: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/db/schema.ts lib/db/types.ts lib/db/migrations/
git commit -m "feat(db): add filing_summaries table for Slice 2B"
```

---

### Task 1.2: RLS policy for `filing_summaries`

**Files:**
- Create: `lib/db/migrations/9997_rls_filing_summaries.sql`

The `9997` prefix sequences this before the existing `9998_rls_filings.sql` and `9999_rls_policies.sql`. Same pattern: authenticated users read, service role writes.

- [ ] **Step 1: Write the SQL file**

```sql
-- RLS for Slice 2B: filing_summaries.
-- Same pattern as filings/filing_chunks: any authenticated user can SELECT,
-- writes go through service_role (BYPASSRLS).

alter table public.filing_summaries enable row level security;

drop policy if exists "auth read filing_summaries" on public.filing_summaries;
create policy "auth read filing_summaries"
  on public.filing_summaries for select to authenticated using (true);

grant select on public.filing_summaries to authenticated;
```

The `drop policy if exists ... ; create policy ...` shape makes it idempotent.

- [ ] **Step 2: Apply to both Neon branches**

Reuse the temp `_apply.ts` runner (write again if you deleted it after T1.1):

```ts
// _apply.ts — same content as T1.1 Step 4
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const targetArg = process.argv.indexOf('--target');
const fileArg = process.argv.indexOf('--file');
const target = targetArg >= 0 ? process.argv[targetArg + 1] : null;
const file = fileArg >= 0 ? process.argv[fileArg + 1] : null;
if (!target || !file) { console.error('Usage: tsx _apply.ts --target prod|test --file <path>'); process.exit(2); }

const url = target === 'prod' ? process.env.DATABASE_URL_SERVICE_ROLE : process.env.DATABASE_URL_TEST_SERVICE_ROLE;
if (!url) { console.error(`URL for ${target} not set`); process.exit(2); }

const sqlText = readFileSync(file, 'utf8');
const sql = postgres(url, { prepare: false, max: 1 });
try {
  await sql.unsafe(sqlText);
  console.log(`Applied ${file} to ${target} OK`);
} catch (e) {
  console.error('Apply failed:', e);
  process.exit(1);
} finally {
  await sql.end();
}
```

Apply:

```bash
pnpm exec tsx _apply.ts --target prod --file lib/db/migrations/9997_rls_filing_summaries.sql
pnpm exec tsx _apply.ts --target test --file lib/db/migrations/9997_rls_filing_summaries.sql
```

- [ ] **Step 3: Verify policy exists on both branches**

Write `_check_rls.ts`:

```ts
import { config } from 'dotenv';
config({ path: '.env.local' });
import postgres from 'postgres';

for (const [label, url] of [
  ['prod', process.env.DATABASE_URL_SERVICE_ROLE!],
  ['test', process.env.DATABASE_URL_TEST_SERVICE_ROLE!]
]) {
  const sql = postgres(url, { prepare: false, max: 1 });
  const rows = await sql`select tablename, policyname from pg_policies where schemaname = 'public' and tablename = 'filing_summaries'`;
  console.log(`${label}: ${rows.length} policies on filing_summaries`);
  for (const r of rows) console.log(`  ${r.tablename}: ${r.policyname}`);
  await sql.end();
}
```

Run:

```bash
pnpm exec tsx _check_rls.ts
```

Expected:
```
prod: 1 policies on filing_summaries
  filing_summaries: auth read filing_summaries
test: 1 policies on filing_summaries
  filing_summaries: auth read filing_summaries
```

Delete `_apply.ts` and `_check_rls.ts`.

- [ ] **Step 4: Commit**

```bash
git add lib/db/migrations/9997_rls_filing_summaries.sql
git commit -m "feat(db): RLS for filing_summaries (read-only for authenticated)"
```

---

## Milestone 2: Qwen provider

### Task 2.1: Install `openai` package + write `QwenProviderImpl`

**Files:**
- Modify: `package.json` (add `openai` dep)
- Modify: `lib/providers/types.ts` (add interface + types)
- Create: `lib/providers/qwen.ts`

- [ ] **Step 1: Install the `openai` package**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add openai
```

Expected: installs `openai` (the official OpenAI SDK; works with any OpenAI-compatible endpoint, including DashScope). No peer-dep issues expected on Node 22.

- [ ] **Step 2: Append types + interface to `lib/providers/types.ts`**

```ts
// Qwen / DashScope provider types — used by QwenProvider.
export interface QwenSummarizeRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}

export interface QwenSummarizeResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface QwenProvider {
  summarize(req: QwenSummarizeRequest): Promise<QwenSummarizeResult>;
}
```

- [ ] **Step 3: Write `lib/providers/qwen.ts`**

```ts
import OpenAI from 'openai';
import {
  NotFoundError,
  ProviderError,
  QwenProvider,
  QwenSummarizeRequest,
  QwenSummarizeResult,
  RateLimitError,
  UnknownProviderError,
  ValidationError
} from './types';

const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

interface Options {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class QwenProviderImpl implements QwenProvider {
  private readonly client: OpenAI;
  private readonly timeoutMs: number;

  constructor(opts: Options = {}) {
    const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new ProviderError('DASHSCOPE_API_KEY is not set');
    }
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const clientConfig: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_BASE_URL,
      timeout: this.timeoutMs
    };
    if (opts.fetch) clientConfig.fetch = opts.fetch as unknown as typeof fetch;
    this.client = new OpenAI(clientConfig);
  }

  async summarize(req: QwenSummarizeRequest): Promise<QwenSummarizeResult> {
    try {
      const completion = await this.client.chat.completions.create({
        model: req.model,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt }
        ],
        max_tokens: req.maxTokens ?? 800
      });

      const choice = completion.choices[0];
      const text = choice?.message?.content ?? '';
      if (!text) {
        throw new UnknownProviderError('Qwen returned empty completion');
      }

      const usage = completion.usage;
      return {
        text,
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0
      };
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }
}

function mapOpenAIError(err: unknown): Error {
  if (err instanceof NotFoundError || err instanceof ValidationError || err instanceof ProviderError || err instanceof RateLimitError || err instanceof UnknownProviderError) {
    return err;
  }
  // OpenAI SDK errors expose `status` + `message`
  const anyErr = err as { status?: number; message?: string; name?: string };
  const msg = anyErr.message ?? 'Unknown Qwen error';
  if (anyErr.name === 'APIConnectionTimeoutError' || /timeout/i.test(msg)) {
    return new ProviderError(`Qwen timeout: ${msg}`);
  }
  if (anyErr.status === 429) return new RateLimitError(msg);
  if (anyErr.status && anyErr.status >= 500) return new ProviderError(`Qwen ${anyErr.status}: ${msg}`);
  if (anyErr.status === 401 || anyErr.status === 403) return new ValidationError(`Qwen auth failed: ${msg}`);
  if (anyErr.status && anyErr.status >= 400) return new ValidationError(`Qwen ${anyErr.status}: ${msg}`);
  return new UnknownProviderError(msg);
}
```

- [ ] **Step 4: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml lib/providers/types.ts lib/providers/qwen.ts
git commit -m "feat(providers): QwenProvider (DashScope OpenAI-compatible)"
```

---

### Task 2.2: Provider unit tests

**Files:**
- Create: `tests/providers/__fixtures__/qwen-completion-response.json`
- Create: `tests/providers/qwen.test.ts`

The OpenAI SDK accepts a custom `fetch` impl in its config. We inject a mock fetch in tests and verify request shape + response handling.

- [ ] **Step 1: Write the fixture**

`lib/providers/__fixtures__/qwen-completion-response.json` (existing fixture path convention — confirmed by Slice 2A T3.2):

```json
{
  "id": "chatcmpl-test-123",
  "object": "chat.completion",
  "created": 1716595200,
  "model": "qwen-plus",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "## What they do\nApple designs and sells consumer electronics.\n\n## This period's highlights\n- Services revenue +13% to $96B\n\n## Key risks\n- China supply concentration\n\n## Bottom line\nServices growth offsets iPhone plateau."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 52000,
    "completion_tokens": 410,
    "total_tokens": 52410
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/providers/qwen.test.ts
import { describe, it, expect, vi } from 'vitest';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import {
  ProviderError,
  RateLimitError,
  UnknownProviderError,
  ValidationError
} from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProvider(fetchMock: typeof fetch) {
  return new QwenProviderImpl({
    apiKey: 'sk-test-key',
    baseUrl: 'http://test.local/v1',
    fetch: fetchMock,
    timeoutMs: 5000
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('QwenProviderImpl', () => {
  it('constructor throws ProviderError when DASHSCOPE_API_KEY is missing', () => {
    const orig = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      expect(() => new QwenProviderImpl()).toThrow(ProviderError);
    } finally {
      if (orig) process.env.DASHSCOPE_API_KEY = orig;
    }
  });

  it('summarize: happy path returns parsed text + token counts', async () => {
    const fix = loadFixture('qwen-completion-response.json');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
    const provider = makeProvider(fetchMock);
    const result = await provider.summarize({
      model: 'qwen-plus',
      systemPrompt: 'sys',
      userPrompt: 'user'
    });
    expect(result.text).toContain('## What they do');
    expect(result.inputTokens).toBe(52000);
    expect(result.outputTokens).toBe(410);
  });

  it('summarize: sends correct request shape', async () => {
    const fix = loadFixture('qwen-completion-response.json');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
    const provider = makeProvider(fetchMock);
    await provider.summarize({
      model: 'qwen-plus',
      systemPrompt: 'system-text',
      userPrompt: 'user-text',
      maxTokens: 1000
    });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://test.local/v1/chat/completions');
    const body = JSON.parse(String((init as any).body));
    expect(body.model).toBe('qwen-plus');
    expect(body.max_tokens).toBe(1000);
    expect(body.messages).toEqual([
      { role: 'system', content: 'system-text' },
      { role: 'user', content: 'user-text' }
    ]);
    expect(String((init as any).headers.Authorization ?? (init as any).headers.authorization)).toContain('Bearer sk-test-key');
  });

  it('summarize: 429 throws RateLimitError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.summarize({ model: 'qwen-plus', systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  it('summarize: 500 throws ProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 500 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.summarize({ model: 'qwen-plus', systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toBeInstanceOf(ProviderError);
  });

  it('summarize: 401 throws ValidationError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.summarize({ model: 'qwen-plus', systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('summarize: empty content in response throws UnknownProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'x', object: 'chat.completion', created: 0, model: 'qwen-plus',
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 }
      })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.summarize({ model: 'qwen-plus', systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toBeInstanceOf(UnknownProviderError);
  });
});
```

- [ ] **Step 3: Run, verify passes**

```bash
pnpm test tests/providers/qwen.test.ts 2>&1 | tail -15
```

Expected: 7 passing.

If any test fails because the OpenAI SDK normalizes errors differently than expected, inspect the actual error thrown (`console.log` it in the test) and adjust `mapOpenAIError` in `lib/providers/qwen.ts` accordingly. Do NOT change the test to match buggy behavior.

- [ ] **Step 4: Commit**

```bash
git add tests/providers/qwen.test.ts lib/providers/__fixtures__/qwen-completion-response.json
git commit -m "test(providers): QwenProvider unit tests (7 cases)"
```

---

## Milestone 3: Prompt iteration + lock v1

### Task 3.1: `scripts/try-summarize.ts` smoke + lock prompt v1

This task does NOT touch the service or DB yet. We run the prompt against 3 real filings via the provider directly, eyeball the output, iterate on the prompt template, and only commit the prompt as `v1` once it's solid.

**Files:**
- Create: `scripts/try-summarize.ts`
- Modify: `package.json` (add `try-summarize` script)

- [ ] **Step 1: Add the env var**

You should have `DASHSCOPE_API_KEY` from earlier. Add it to `.env.local` at the project root:

```
DASHSCOPE_API_KEY=sk-xxxxxxxxxxxx...
```

If you haven't yet, sign up at https://dashscope-intl.aliyuncs.com and generate a key from the console. (DashScope international is the US-friendly endpoint.)

- [ ] **Step 2: Write `scripts/try-summarize.ts`**

```ts
#!/usr/bin/env tsx
/**
 * End-to-end smoke: `pnpm try-summarize AAPL <accession>`
 *
 * Pulls a filing's section text from the local Postgres (the filing must
 * already be ingested via Slice 2A), assembles the prompt, calls Qwen, and
 * prints the summary + token counts. Used for prompt iteration before
 * locking prompt_version = 'v1'.
 *
 * Run T2A's smoke test first if needed:
 *   pnpm try-filings AAPL
 *   pnpm exec tsx -e "import {QwenProviderImpl} from '@/lib/providers/qwen'; ..."
 */
import { config } from 'dotenv';
config({ path: '.env.local' });

import { eq } from 'drizzle-orm';
import { getServiceDb } from '@/lib/db/client';
import { companies, filings, filingChunks } from '@/lib/db/schema';
import { QwenProviderImpl } from '@/lib/providers/qwen';

const SYSTEM_PROMPT = `You are a senior equity research analyst writing concise investor briefings on SEC filings.
Your output is read by investors who want the signal, not the boilerplate. Be specific:
quote numbers and names directly from the filing when they support the point. Avoid hedging
language ("the company believes…", "it appears…"). Do not invent facts not in the source.`;

function buildUserPrompt(meta: {
  ticker: string;
  companyName: string;
  formType: string;
  filingDate: string;
  periodEnd: string | null;
}, sections: Array<{ sectionTitle: string; text: string }>): string {
  const filingText = sections.map((s) => `=== ${s.sectionTitle} ===\n${s.text}`).join('\n\n');

  return `Below is the text of an SEC filing. Produce a structured briefing in this EXACT markdown format:

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
- Ticker: ${meta.ticker}
- Company: ${meta.companyName}
- Form: ${meta.formType}
- Filed: ${meta.filingDate}
- Period ending: ${meta.periodEnd ?? '—'}

Filing text follows:
---
${filingText}
---`;
}

async function main() {
  const ticker = (process.argv[2] ?? '').toUpperCase();
  const accession = process.argv[3] ?? '';
  if (!/^[A-Z][A-Z.]{0,5}$/.test(ticker) || !/^\d{10}-\d{2}-\d{6}$/.test(accession)) {
    console.error('Usage: pnpm try-summarize <TICKER> <ACCESSION>');
    console.error('  e.g. pnpm try-summarize AAPL 0000320193-25-000123');
    process.exit(2);
  }

  const db = getServiceDb();

  const companyRows = await db.select().from(companies).where(eq(companies.ticker, ticker)).limit(1);
  if (companyRows.length === 0) {
    console.error(`Company ${ticker} not in DB. Add via /api/tickers/add first.`);
    process.exit(2);
  }
  const company = companyRows[0]!;

  const filingRows = await db.select().from(filings).where(eq(filings.accessionNo, accession)).limit(1);
  if (filingRows.length === 0) {
    console.error(`Filing ${accession} not ingested. Run pnpm try-filings ${ticker} first, then check /stock/${ticker}/filings.`);
    process.exit(2);
  }
  const filing = filingRows[0]!;

  const chunks = await db
    .select({ sectionKey: filingChunks.sectionKey, sectionTitle: filingChunks.sectionTitle, text: filingChunks.text })
    .from(filingChunks)
    .where(eq(filingChunks.filingId, accession))
    .orderBy(filingChunks.id);

  if (chunks.length === 0) {
    console.error(`Filing ${accession} has no parsed chunks. Re-ingest via the Filings page.`);
    process.exit(2);
  }

  console.log(`\n[${filing.formType} ${filing.filingDate}] ${ticker} ${accession}`);
  console.log(`Sections: ${chunks.map((c) => c.sectionTitle).join(', ')}`);
  const totalChars = chunks.reduce((sum, c) => sum + c.text.length, 0);
  console.log(`Total chars: ${totalChars}`);

  const userPrompt = buildUserPrompt(
    { ticker, companyName: company.name, formType: filing.formType, filingDate: filing.filingDate, periodEnd: filing.periodEnd },
    chunks
  );

  console.log(`\nCalling qwen-plus…`);
  const t0 = Date.now();
  const provider = new QwenProviderImpl();
  const result = await provider.summarize({
    model: 'qwen-plus',
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 800
  });
  const elapsed = Date.now() - t0;

  console.log(`\n--- Briefing (${elapsed}ms, ${result.inputTokens} in, ${result.outputTokens} out) ---`);
  console.log(result.text);
  console.log(`\n--- End ---`);
  process.exit(0);
}

main().catch((err) => {
  console.error('try-summarize failed:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Add to `package.json` scripts**

Find the existing `"try-filings": "tsx scripts/try-filings.ts"` line and add right after:

```json
"try-summarize": "tsx scripts/try-summarize.ts",
```

- [ ] **Step 4: Run against 3 real filings, iterate prompt**

Pre-req: at least one ticker's filings must already be in DB. Verify via:
```bash
pnpm try-filings AAPL
```
(This is the Slice 2A smoke test. It also ingests if not already.)

Then list the accession numbers in DB:
```bash
pnpm exec tsx -e "
import { config } from 'dotenv'; config({ path: '.env.local' });
import { getServiceDb } from '@/lib/db/client';
import { filings } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
const db = getServiceDb();
const rows = await db.select({a: filings.accessionNo, f: filings.formType, d: filings.filingDate}).from(filings).where(eq(filings.ticker, 'AAPL'));
for (const r of rows) console.log(r.f, r.d, r.a);
process.exit(0);
"
```

Pick the most recent 10-K and the most recent 10-Q. Run:

```bash
pnpm try-summarize AAPL <10-K-accession>
pnpm try-summarize AAPL <10-Q-accession>
```

Then add a non-tech ticker for variety. Add JD or NIO via the UI (`/api/tickers/add` flow), ingest filings, and run on one of those too:

```bash
pnpm try-summarize JD <10-K-accession>
```

**Eyeball each output:**
- Is each `## What they do` section 1-2 sentences and free of marketing language?
- Does `## This period's highlights` cite specific numbers (revenue figures, segment growth, margins)?
- Does `## Key risks` list company-specific risks, not boilerplate?
- Is `## Bottom line` one sentence and actually useful?
- Does the model ever invent facts? (Spot-check 2-3 numbers against the source filing.)
- Total elapsed time: should be 5-15s.
- Input tokens: should be 20k-80k depending on form. Output: 300-700.

**If the output is bad:**
- Tweak `SYSTEM_PROMPT` or the structured-headings template in `buildUserPrompt` directly.
- Re-run. Don't commit yet.
- Iterate until 3-of-3 outputs look like something an investor would actually find useful.

**Once it's good, lock the prompt:** copy the final `SYSTEM_PROMPT` and `buildUserPrompt` template into a comment block at the top of the file marked `// PROMPT VERSION: v1 (locked YYYY-MM-DD)`. This will be the source of truth that Task 4.2 copies into `lib/services/summaries.ts`.

- [ ] **Step 5: Commit the smoke script + locked prompt**

```bash
git add scripts/try-summarize.ts package.json
git commit -m "chore(scripts): pnpm try-summarize <TICKER> <ACCESSION> smoke + lock prompt v1"
```

---

## Milestone 4: Service layer

### Task 4.1: Add `getAllSectionTexts` to `FilingsService`

**Files:**
- Modify: `lib/services/filings.ts`
- Modify: `tests/integration/filings-service.test.ts` (add 1 test)

- [ ] **Step 1: Add the failing test**

Open `tests/integration/filings-service.test.ts` and append inside the existing `describe('FilingsService', () => { ... })` block:

```ts
  it('getAllSectionTexts returns chunks ordered by id', async () => {
    await dbH.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await dbH.db.insert(filingChunks).values([
      { filingId: '0000320193-24-000123', sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'A', charCount: 1 },
      { filingId: '0000320193-24-000123', sectionKey: 'item_7_mdna', sectionTitle: 'MD&A', text: 'B', charCount: 1 },
      { filingId: '0000320193-24-000123', sectionKey: 'item_1a_risk_factors', sectionTitle: 'Risk Factors', text: 'C', charCount: 1 }
    ]);
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const sections = await svc.getAllSectionTexts('0000320193-24-000123');
    expect(sections).toHaveLength(3);
    expect(sections[0]!.sectionKey).toBe('item_1_business');
    expect(sections[1]!.sectionKey).toBe('item_7_mdna');
    expect(sections[2]!.sectionKey).toBe('item_1a_risk_factors');
    expect(sections[0]!.text).toBe('A');
  });

  it('getAllSectionTexts returns empty array for missing filing', async () => {
    const svc = new FilingsService({ db: dbH.db, provider: mockProvider({}) as any });
    const sections = await svc.getAllSectionTexts('nope');
    expect(sections).toEqual([]);
  });
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/filings-service.test.ts 2>&1 | tail -10
```

Expected: 2 of 9 fail with "getAllSectionTexts is not a function".

- [ ] **Step 3: Add the method to `FilingsService`**

In `lib/services/filings.ts`, add after the existing `getSectionText` method (around line ~190):

```ts
  async getAllSectionTexts(filingId: string): Promise<Array<{
    sectionKey: string;
    sectionTitle: string;
    text: string;
  }>> {
    const rows = await this.deps.db
      .select({
        sectionKey: filingChunks.sectionKey,
        sectionTitle: filingChunks.sectionTitle,
        text: filingChunks.text
      })
      .from(filingChunks)
      .where(eq(filingChunks.filingId, filingId))
      .orderBy(filingChunks.id);
    return rows;
  }
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/filings-service.test.ts 2>&1 | tail -10
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/services/filings.ts tests/integration/filings-service.test.ts
git commit -m "feat(services): FilingsService.getAllSectionTexts for prompt assembly"
```

---

### Task 4.2: Write `SummariesService` + integration tests

**Files:**
- Create: `lib/services/summaries.ts`
- Create: `tests/integration/summaries-service.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/integration/summaries-service.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { eq } from 'drizzle-orm';
import { makeTestServiceDb, resetDb } from '../helpers/test-db';
import { companies, filings, filingChunks, filingSummaries } from '@/lib/db/schema';
import { FilingsService } from '@/lib/services/filings';
import { SummariesService, CURRENT_MODEL, CURRENT_PROMPT_VERSION } from '@/lib/services/summaries';
import { ValidationError } from '@/lib/providers/types';

config({ path: '.env.local' });

function mockQwen(textOrError: string | Error = 'mocked summary text long enough') {
  return {
    summarize: vi.fn().mockImplementation(async () => {
      if (textOrError instanceof Error) throw textOrError;
      return { text: textOrError, inputTokens: 1000, outputTokens: 200 };
    })
  };
}

const ACCESSION = '0000320193-24-000123';

async function seedFilingWithChunks(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
  await db.insert(filings).values({
    accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values([
    { filingId: ACCESSION, sectionKey: 'item_1_business', sectionTitle: 'Business', text: 'Apple does things.', charCount: 18 },
    { filingId: ACCESSION, sectionKey: 'item_7_mdna', sectionTitle: 'MD&A', text: 'Revenue was up.', charCount: 15 }
  ]);
}

describe('SummariesService', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;

  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => { await resetDb(dbH.db); });

  it('getOrGenerate: cache miss → calls provider, persists, returns', async () => {
    await seedFilingWithChunks(dbH.db);
    const provider = mockQwen('## What they do\nApple makes phones.\n\n## Bottom line\nServices growth.');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toContain('Apple makes phones');
    expect(result.model).toBe(CURRENT_MODEL);
    expect(result.promptVersion).toBe(CURRENT_PROMPT_VERSION);
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);

    const rows = await dbH.db.select().from(filingSummaries).where(eq(filingSummaries.filingId, ACCESSION));
    expect(rows).toHaveLength(1);
  });

  it('getOrGenerate: cache hit → does not call provider', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'cached summary that is long enough',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputTokens: 999,
      outputTokens: 100
    });
    const provider = mockQwen('SHOULD NOT BE RETURNED');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).not.toHaveBeenCalled();
    expect(result.summaryText).toBe('cached summary that is long enough');
    expect(result.inputTokens).toBe(999);
  });

  it('getOrGenerate: stale model triggers regeneration', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'stale summary',
      model: 'old-model-name',
      promptVersion: CURRENT_PROMPT_VERSION
    });
    const provider = mockQwen('## fresh summary text long enough\n');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toContain('fresh summary');
    expect(result.model).toBe(CURRENT_MODEL);
  });

  it('getOrGenerate: stale prompt_version triggers regeneration', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'stale summary',
      model: CURRENT_MODEL,
      promptVersion: 'v0'
    });
    const provider = mockQwen('## fresh prompt version output long enough\n');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.getOrGenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.promptVersion).toBe(CURRENT_PROMPT_VERSION);
  });

  it('regenerate: always re-runs even when cache is fresh', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'fresh cached summary',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION
    });
    const provider = mockQwen('## regenerated output that is long enough\n');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    const result = await svc.regenerate(ACCESSION);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(result.summaryText).toContain('regenerated output');
  });

  it('getOrGenerate: filing with no chunks throws ValidationError', async () => {
    await dbH.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple Inc.' });
    await dbH.db.insert(filings).values({
      accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    // No chunks inserted.
    const provider = mockQwen('should not be called');
    const filingsSvc = new FilingsService({ db: dbH.db, provider: {} as any });
    const svc = new SummariesService({ db: dbH.db, provider: provider as any, filingsService: filingsSvc });

    await expect(svc.getOrGenerate(ACCESSION)).rejects.toBeInstanceOf(ValidationError);
    expect(provider.summarize).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify fails**

```bash
pnpm test:integration tests/integration/summaries-service.test.ts 2>&1 | tail -10
```

Expected: fails at import (module not found).

- [ ] **Step 3: Write `lib/services/summaries.ts`**

Replace the prompt strings below with the **finalized locked version from `scripts/try-summarize.ts`** (Task 3.1 Step 4). The values below match the spec — they're a starting point if Task 3.1 didn't change anything.

```ts
import { eq } from 'drizzle-orm';
import { filings, filingSummaries, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { ProviderError, QwenProvider, ValidationError } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { FilingsService } from './filings';

export const CURRENT_MODEL = 'qwen-plus';
export const CURRENT_PROMPT_VERSION = 'v1';
const MAX_OUTPUT_TOKENS = 800;
const MIN_SUMMARY_CHARS = 50;
const MAX_PROMPT_CHARS = 400_000;

const SYSTEM_PROMPT = `You are a senior equity research analyst writing concise investor briefings on SEC filings.
Your output is read by investors who want the signal, not the boilerplate. Be specific:
quote numbers and names directly from the filing when they support the point. Avoid hedging
language ("the company believes…", "it appears…"). Do not invent facts not in the source.`;

interface Deps {
  db: ServiceDb;
  provider: QwenProvider;
  filingsService: FilingsService;
}

export interface FilingSummaryDto {
  filingId: string;
  summaryText: string;
  model: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  generatedAt: Date;
}

export class SummariesService {
  constructor(private readonly deps: Deps) {}

  async getOrGenerate(filingId: string): Promise<FilingSummaryDto> {
    const existing = await this.fetchExisting(filingId);
    if (existing && existing.model === CURRENT_MODEL && existing.promptVersion === CURRENT_PROMPT_VERSION) {
      return existing;
    }
    return this.generate(filingId);
  }

  async regenerate(filingId: string): Promise<FilingSummaryDto> {
    return this.generate(filingId);
  }

  // -------- internal --------

  private async fetchExisting(filingId: string): Promise<FilingSummaryDto | null> {
    const rows = await this.deps.db
      .select()
      .from(filingSummaries)
      .where(eq(filingSummaries.filingId, filingId))
      .limit(1);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      filingId: r.filingId,
      summaryText: r.summaryText,
      model: r.model,
      promptVersion: r.promptVersion,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      generatedAt: r.generatedAt
    };
  }

  private async generate(filingId: string): Promise<FilingSummaryDto> {
    const filingRows = await this.deps.db
      .select()
      .from(filings)
      .where(eq(filings.accessionNo, filingId))
      .limit(1);
    if (filingRows.length === 0) {
      throw new ValidationError(`Filing not found: ${filingId}`);
    }
    const filing = filingRows[0]!;

    const sections = await this.deps.filingsService.getAllSectionTexts(filingId);
    if (sections.length === 0) {
      throw new ValidationError(`No parsed sections to summarize for ${filingId}`);
    }

    const userPrompt = this.buildUserPrompt(
      { ticker: filing.ticker, formType: filing.formType, filingDate: filing.filingDate, periodEnd: filing.periodEnd },
      sections
    );

    const startedAt = new Date();
    try {
      const result = await this.deps.provider.summarize({
        model: CURRENT_MODEL,
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: MAX_OUTPUT_TOKENS
      });
      if (result.text.trim().length < MIN_SUMMARY_CHARS) {
        throw new ProviderError(`Qwen returned suspiciously short output (${result.text.length} chars)`);
      }

      const row = {
        filingId,
        summaryText: result.text,
        model: CURRENT_MODEL,
        promptVersion: CURRENT_PROMPT_VERSION,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        generatedAt: new Date()
      };
      await this.deps.db
        .insert(filingSummaries)
        .values(row)
        .onConflictDoUpdate({
          target: filingSummaries.filingId,
          set: {
            summaryText: row.summaryText,
            model: row.model,
            promptVersion: row.promptVersion,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            generatedAt: row.generatedAt
          }
        });

      await this.deps.db.insert(refreshRuns).values({
        ticker: filing.ticker,
        kind: `summary:${filingId}`,
        startedAt,
        completedAt: new Date(),
        ok: true,
        sourceUsed: 'qwen'
      });

      return row;
    } catch (err) {
      await this.deps.db.insert(refreshRuns).values({
        ticker: filing.ticker,
        kind: `summary:${filingId}`,
        startedAt,
        completedAt: new Date(),
        ok: false,
        sourceUsed: 'qwen',
        error: String(err).slice(0, 1000)
      });
      logger.warn({ filingId, err: String(err) }, 'summaries: generate failed');
      throw err;
    }
  }

  private buildUserPrompt(
    meta: { ticker: string; formType: string; filingDate: string; periodEnd: string | null },
    sections: Array<{ sectionTitle: string; text: string }>
  ): string {
    let filingText = sections.map((s) => `=== ${s.sectionTitle} ===\n${s.text}`).join('\n\n');
    if (filingText.length > MAX_PROMPT_CHARS) {
      logger.warn({ ticker: meta.ticker, length: filingText.length }, 'summaries: truncating oversized filing text');
      filingText = filingText.slice(0, MAX_PROMPT_CHARS);
    }

    return `Below is the text of an SEC filing. Produce a structured briefing in this EXACT markdown format:

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
- Ticker: ${meta.ticker}
- Form: ${meta.formType}
- Filed: ${meta.filingDate}
- Period ending: ${meta.periodEnd ?? '—'}

Filing text follows:
---
${filingText}
---`;
  }
}
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/summaries-service.test.ts 2>&1 | tail -10
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/services/summaries.ts tests/integration/summaries-service.test.ts
git commit -m "feat(services): SummariesService with cache + regen logic"
```

---

## Milestone 5: API routes + RLS smoke

### Task 5.1: GET + POST `/api/tickers/[symbol]/filings/[accession]/summary`

**Files:**
- Create: `app/api/tickers/[symbol]/filings/[accession]/summary/route.ts`
- Create: `tests/integration/api-summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/integration/api-summary.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, resetDb, newUserId } from '../helpers/test-db';
import { companies, filings, filingChunks, filingSummaries } from '@/lib/db/schema';
import { CURRENT_MODEL, CURRENT_PROMPT_VERSION } from '@/lib/services/summaries';

config({ path: '.env.local' });

const ACCESSION = '0000320193-24-000123';

async function seedFilingWithChunks(db: any) {
  await db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
  await db.insert(filings).values({
    accessionNo: ACCESSION, ticker: 'AAPL', cik: '0000320193',
    formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
  });
  await db.insert(filingChunks).values({
    filingId: ACCESSION, sectionKey: 'item_1_business',
    sectionTitle: 'Business', text: 'Apple makes phones.', charCount: 19
  });
}

describe('/api/tickers/[symbol]/filings/[accession]/summary', () => {
  let dbH: ReturnType<typeof makeTestServiceDb>;
  beforeAll(() => { dbH = makeTestServiceDb(); });
  afterAll(async () => { await dbH.close(); });
  beforeEach(async () => {
    await resetDb(dbH.db);
    vi.resetModules();
    vi.doMock('@/lib/auth/current-user', () => ({
      requireUserId: async () => newUserId(),
      getCurrentUserId: async () => newUserId(),
      UnauthorizedError: class extends Error {}
    }));
    vi.doMock('@/lib/providers/qwen', () => ({
      QwenProviderImpl: class {
        async summarize() {
          return { text: '## What they do\nApple makes phones.\n\n## Bottom line\nServices growth.', inputTokens: 1000, outputTokens: 200 };
        }
      }
    }));
  });

  it('GET cache hit returns existing summary', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'cached briefing',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION,
      inputTokens: 100,
      outputTokens: 50
    });
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary`), {
      params: { symbol: 'AAPL', accession: ACCESSION }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryText).toBe('cached briefing');
    expect(body.inputTokens).toBe(100);
  });

  it('GET cache miss generates via provider mock', async () => {
    await seedFilingWithChunks(dbH.db);
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary`), {
      params: { symbol: 'AAPL', accession: ACCESSION }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryText).toContain('Apple makes phones');
    expect(body.model).toBe(CURRENT_MODEL);
  });

  it('POST?regenerate=1 always re-runs', async () => {
    await seedFilingWithChunks(dbH.db);
    await dbH.db.insert(filingSummaries).values({
      filingId: ACCESSION,
      summaryText: 'stale cached',
      model: CURRENT_MODEL,
      promptVersion: CURRENT_PROMPT_VERSION
    });
    const { POST } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await POST(
      new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary?regenerate=1`, { method: 'POST' }),
      { params: { symbol: 'AAPL', accession: ACCESSION } }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summaryText).toContain('Apple makes phones'); // from the mock provider
  });

  it('POST without regenerate=1 returns 400', async () => {
    const { POST } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await POST(
      new Request(`http://localhost/api/tickers/AAPL/filings/${ACCESSION}/summary`, { method: 'POST' }),
      { params: { symbol: 'AAPL', accession: ACCESSION } }
    );
    expect(res.status).toBe(400);
  });

  it('GET invalid ticker returns 400', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(new Request('http://localhost/api/tickers/bogus-1/filings/x/summary'), {
      params: { symbol: 'bogus-1', accession: 'x' }
    });
    expect(res.status).toBe(400);
  });

  it('GET unknown filing returns 400 (ValidationError from service)', async () => {
    const { GET } = await import('@/app/api/tickers/[symbol]/filings/[accession]/summary/route');
    const res = await GET(
      new Request(`http://localhost/api/tickers/AAPL/filings/9999999999-99-999999/summary`),
      { params: { symbol: 'AAPL', accession: '9999999999-99-999999' } }
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run, verify fails (route doesn't exist yet)**

```bash
pnpm test:integration tests/integration/api-summary.test.ts 2>&1 | tail -10
```

Expected: import error.

- [ ] **Step 3: Write the handler**

```ts
// app/api/tickers/[symbol]/filings/[accession]/summary/route.ts
import { errorResponse } from '@/lib/api/errors';
import { ok } from '@/lib/api/responses';
import { ValidationError } from '@/lib/providers/types';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { SummariesService } from '@/lib/services/summaries';
import { QwenProviderImpl } from '@/lib/providers/qwen';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const ACCESSION_RE = /^\d{10}-\d{2}-\d{6}$/;

interface RouteContext { params: { symbol: string; accession: string }; }

let svc: SummariesService | null = null;
function service() {
  if (svc) return svc;
  const db = getServiceDb();
  const filingsSvc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  svc = new SummariesService({
    db,
    provider: new QwenProviderImpl(),
    filingsService: filingsSvc
  });
  return svc;
}

export async function GET(_req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const accession = ctx.params.accession;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    const result = await service().getOrGenerate(accession);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession]/summary GET' });
  }
}

export async function POST(req: Request, ctx: RouteContext) {
  try {
    await requireUserId();
    const symbol = ctx.params.symbol.toUpperCase();
    if (!TICKER_RE.test(symbol)) throw new ValidationError(`Invalid ticker: ${symbol}`);
    const accession = ctx.params.accession;
    if (!ACCESSION_RE.test(accession)) throw new ValidationError(`Invalid accession: ${accession}`);
    const url = new URL(req.url);
    if (url.searchParams.get('regenerate') !== '1') {
      throw new ValidationError('POST requires ?regenerate=1 to avoid accidental triggers');
    }
    const result = await service().regenerate(accession);
    return ok(result);
  } catch (err) {
    return errorResponse(err, { route: 'tickers/[symbol]/filings/[accession]/summary POST' });
  }
}

export const maxDuration = 60;
```

- [ ] **Step 4: Run, verify passes**

```bash
pnpm test:integration tests/integration/api-summary.test.ts 2>&1 | tail -10
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add "app/api/tickers/[symbol]/filings/[accession]/summary/route.ts" tests/integration/api-summary.test.ts
git commit -m "feat(api): GET + POST /api/tickers/[symbol]/filings/[accession]/summary"
```

---

### Task 5.2: RLS smoke test for `filing_summaries`

**Files:**
- Create: `tests/integration/filing-summaries-rls.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { config } from 'dotenv';
import { makeTestServiceDb, makeTestUserDb, newUserId, resetDb } from '../helpers/test-db';
import { companies, filings, filingSummaries } from '@/lib/db/schema';

config({ path: '.env.local' });

describe('RLS: filing_summaries', () => {
  let svc: ReturnType<typeof makeTestServiceDb>;
  let user: ReturnType<typeof makeTestUserDb>;

  beforeAll(() => { svc = makeTestServiceDb(); user = makeTestUserDb(); });
  afterAll(async () => { await svc.close(); await user.close(); });

  beforeEach(async () => {
    await resetDb(svc.db);
    await svc.db.insert(companies).values({ ticker: 'AAPL', name: 'Apple' });
    await svc.db.insert(filings).values({
      accessionNo: '0000320193-24-000123', ticker: 'AAPL', cik: '0000320193',
      formType: '10-K', filingDate: '2024-11-01', primaryDocUrl: 'https://x'
    });
    await svc.db.insert(filingSummaries).values({
      filingId: '0000320193-24-000123',
      summaryText: 'cached briefing',
      model: 'qwen-plus',
      promptVersion: 'v1'
    });
  });

  it('authenticated role can SELECT filing_summaries', async () => {
    const uid = newUserId();
    const count = await user.asUser(uid, async (tx) => {
      const r = await tx.select().from(filingSummaries);
      return r.length;
    });
    expect(count).toBe(1);
  });

  it('authenticated role cannot INSERT into filing_summaries', async () => {
    const uid = newUserId();
    await expect(
      user.asUser(uid, async (tx) =>
        tx.insert(filingSummaries).values({
          filingId: '0000320193-24-000123',
          summaryText: 'x',
          model: 'qwen-plus',
          promptVersion: 'v2'
        })
      )
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, verify passes**

```bash
pnpm test:integration tests/integration/filing-summaries-rls.test.ts 2>&1 | tail -10
```

Expected: 2 passing.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/filing-summaries-rls.test.ts
git commit -m "test(db): RLS smoke for filing_summaries"
```

---

## Milestone 6: UI

### Task 6.1: Install `react-markdown` + build briefing components

**Files:**
- Modify: `package.json` (add `react-markdown`, `remark-gfm`)
- Create: `app/(app)/stock/[ticker]/filings/[accession]/_components/filing-briefing.tsx`
- Create: `app/(app)/stock/[ticker]/filings/[accession]/_components/briefing-skeleton.tsx`
- Create: `app/(app)/stock/[ticker]/filings/[accession]/_components/regenerate-button.tsx`

- [ ] **Step 1: Install dependencies**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
pnpm add react-markdown remark-gfm
```

Expected: both packages install cleanly. They're small (~30kb gzipped combined).

- [ ] **Step 2: Write `briefing-skeleton.tsx`**

```tsx
// app/(app)/stock/[ticker]/filings/[accession]/_components/briefing-skeleton.tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function BriefingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Briefing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Generating briefing… this takes 5-10s on first visit.
        </p>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Write `regenerate-button.tsx`**

```tsx
// app/(app)/stock/[ticker]/filings/[accession]/_components/regenerate-button.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface Props {
  ticker: string;
  accession: string;
}

export function RegenerateButton({ ticker, accession }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function regenerate() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/tickers/${ticker}/filings/${accession}/summary?regenerate=1`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({
          title: 'Regeneration failed',
          description: body.error ?? `HTTP ${res.status}`,
          variant: 'destructive'
        });
        setBusy(false);
        return;
      }
      toast({ title: 'Briefing regenerated' });
      router.refresh();
    } catch (e: unknown) {
      toast({ title: 'Network error', description: String(e), variant: 'destructive' });
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={regenerate} disabled={busy}>
      {busy ? 'Regenerating…' : 'Regenerate'}
    </Button>
  );
}
```

- [ ] **Step 4: Write `filing-briefing.tsx` (async server component)**

```tsx
// app/(app)/stock/[ticker]/filings/[accession]/_components/filing-briefing.tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getServiceDb } from '@/lib/db/client';
import { FilingsService } from '@/lib/services/filings';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { SummariesService } from '@/lib/services/summaries';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { ProviderError, RateLimitError, ValidationError } from '@/lib/providers/types';
import { RegenerateButton } from './regenerate-button';

function timeAgo(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface Props {
  ticker: string;
  accession: string;
}

export async function FilingBriefing({ ticker, accession }: Props) {
  const db = getServiceDb();
  const filingsSvc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });
  const svc = new SummariesService({
    db,
    provider: new QwenProviderImpl(),
    filingsService: filingsSvc
  });

  try {
    const summary = await svc.getOrGenerate(accession);
    return (
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between">
          <CardTitle>Briefing</CardTitle>
          <p className="text-xs text-muted-foreground">
            {summary.model} · generated {timeAgo(summary.generatedAt)}
          </p>
        </CardHeader>
        <CardContent>
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary.summaryText}</ReactMarkdown>
          </div>
          <div className="mt-6 flex justify-end">
            <RegenerateButton ticker={ticker} accession={accession} />
          </div>
        </CardContent>
      </Card>
    );
  } catch (err) {
    const isRate = err instanceof RateLimitError;
    const isValidation = err instanceof ValidationError;
    const isProvider = err instanceof ProviderError;
    return (
      <Card>
        <CardHeader><CardTitle>Briefing unavailable</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {isValidation && 'No parsed content available to summarize for this filing.'}
            {isRate && 'Briefing service is rate-limited. Try again in a moment.'}
            {isProvider && 'Briefing service is temporarily unavailable.'}
            {!isValidation && !isRate && !isProvider && 'Could not generate a briefing for this filing.'}
          </p>
          <RegenerateButton ticker={ticker} accession={accession} />
        </CardContent>
      </Card>
    );
  }
}
```

- [ ] **Step 5: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

If `react-markdown` types complain about `children`, you may need to install `@types/react-markdown` separately or adjust the import. The `react-markdown` v9+ packages ship their own types, so this should just work.

If `prose` Tailwind classes don't render anything visible, the project's Tailwind config may not include `@tailwindcss/typography`. Check `tailwind.config.ts`. If the plugin isn't present, install and add it:

```bash
pnpm add -D @tailwindcss/typography
```

Then in `tailwind.config.ts` add `require('@tailwindcss/typography')` to `plugins: []`. (Test this only if the styles look unstyled when you visit the page in T7.1.)

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml "app/(app)/stock/[ticker]/filings/[accession]/_components/"
git commit -m "feat(ui): FilingBriefing + Skeleton + Regenerate button components"
```

---

### Task 6.2: Wire briefing into the single-filing page

**Files:**
- Modify: `app/(app)/stock/[ticker]/filings/[accession]/page.tsx`

- [ ] **Step 1: Read the existing file to confirm the exact JSX**

```bash
cat "app/(app)/stock/[ticker]/filings/[accession]/page.tsx"
```

(You're looking for where the existing `<header>` ends and `<SectionNav>` begins.)

- [ ] **Step 2: Add imports + Suspense + briefing**

Find the existing import block at the top and add:

```tsx
import { Suspense } from 'react';
import { FilingBriefing } from './_components/filing-briefing';
import { BriefingSkeleton } from './_components/briefing-skeleton';
```

Then, in the JSX of the `FilingPage` component, find the closing `</header>` tag and the start of the conditional `{sections.length === 0 ? ... : <SectionNav ... />}`. Between them, insert:

```tsx
      <Suspense fallback={<BriefingSkeleton />}>
        <FilingBriefing ticker={ticker} accession={filing.accessionNo} />
      </Suspense>
```

The final JSX should look like:

```tsx
return (
  <article className="space-y-6">
    <header className="space-y-2">
      {/* ... existing header content unchanged ... */}
    </header>

    <Suspense fallback={<BriefingSkeleton />}>
      <FilingBriefing ticker={ticker} accession={filing.accessionNo} />
    </Suspense>

    {sections.length === 0 ? (
      {/* ... existing empty-state card unchanged ... */}
    ) : (
      <SectionNav ticker={ticker} accession={filing.accessionNo} sections={sections} />
    )}
  </article>
);
```

- [ ] **Step 3: Verify typecheck**

```bash
pnpm typecheck 2>&1 | tail -3
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/stock/[ticker]/filings/[accession]/page.tsx"
git commit -m "feat(ui): wire briefing into single-filing reader page (Suspense)"
```

---

## Milestone 7: Deploy verification

### Task 7.1: Add env var, push, verify Vercel + browser smoke

**Files:** none (verification only — except adding the env var)

- [ ] **Step 1: Add `DASHSCOPE_API_KEY` to Vercel**

In a browser, open the Vercel dashboard → your project → Settings → Environment Variables. Add:

- Name: `DASHSCOPE_API_KEY`
- Value: (your DashScope key, same as in `.env.local`)
- Environments: Production + Preview (NOT Development — local already has it via `.env.local`)

Save.

- [ ] **Step 2: Push to GitHub**

```bash
cd "C:/Users/elinw/Projects/equity-research-workbench"
git push origin master
```

GitHub Actions will run. Wait for it to pass (CI doesn't need DashScope — all tests mock the provider).

- [ ] **Step 3: Verify CI**

```bash
gh run list --limit 1
```

Expected: ✓ on the latest commit.

- [ ] **Step 4: Wait for Vercel deploy**

Open the Vercel dashboard → Deployments. Wait for the latest one to show "Ready". Should take 2-3 minutes.

- [ ] **Step 5: Browser smoke test**

1. Open `https://YOUR-DEPLOY-URL/stock/AAPL/filings` (sign in if needed).
2. If there are no filings yet, click "Load filings from SEC" and wait ~30-90s.
3. Click into one filing (a 10-K is the best test — most content).
4. Watch the page: the header + section tabs should appear instantly. The briefing card should show a skeleton for 5-15s, then render the markdown briefing.
5. Verify the briefing has all 4 sections (What they do · Highlights · Risks · Bottom line) and renders the markdown headings as styled headers (not literal `## What they do` text).
6. Click "Regenerate". The skeleton should re-appear briefly, then a new briefing renders (may be near-identical — that's fine).
7. Test a non-seed ticker too (add via "+ Add ticker" → ingest filings → open one → confirm briefing).

If the briefing card shows "Briefing unavailable":
- Open the Vercel deploy logs (Functions tab → look for `summary` route invocations) to see the error.
- Most likely cause: `DASHSCOPE_API_KEY` not set in Vercel env vars, or set with leading/trailing whitespace.

If the briefing renders but the markdown headings are literal `## What they do` instead of styled:
- The Tailwind `prose` classes aren't applying. Install `@tailwindcss/typography` per Task 6.1 Step 5.

- [ ] **Step 6: No commit — verification only**

---

## Slice 2B — Completion checklist

After all tasks above pass:

- [ ] All unit tests pass: `pnpm test` (existing 81 + 7 new qwen = 88)
- [ ] All integration tests pass: `pnpm test:integration` (existing 79 + 2 filings + 6 summaries + 6 api + 2 rls = 95)
- [ ] Typecheck clean: `pnpm typecheck`
- [ ] Lint clean: `pnpm lint`
- [ ] `pnpm build` succeeds
- [ ] `pnpm try-summarize AAPL <accession>` succeeds with sensible output
- [ ] Browser smoke works on a seed ticker (AAPL) and a non-seed ticker
- [ ] `DASHSCOPE_API_KEY` set in Vercel env vars
- [ ] GitHub Actions CI green on `master`
- [ ] Regenerate button visibly produces a fresh briefing

When all boxes are checked, Slice 2B is complete and Slice 2C (embeddings + semantic search) can be planned.

---

## What's NOT in Slice 2B (deliberately deferred)

- Per-section TLDRs (would multiply cost ~6×) → future slice if user feedback warrants
- Quarter-over-quarter diff / change detection → future slice
- Filings list "✨ briefing ready" pill on the list page → cuttable polish task
- Streaming token-by-token response → revisit only if 5-10s latency becomes painful
- Multi-provider fallback (e.g., OpenAI when DashScope is down) → YAGNI until needed
- Cost dashboard → token columns are there but no UI yet
- E2E Playwright tests → Stack Auth ESM blocker carries from Slice 1C
