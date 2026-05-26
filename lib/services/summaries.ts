import { eq } from 'drizzle-orm';
import { filings, filingSummaries, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { ProviderError, ValidationError } from '@/lib/providers/types';
import type { QwenProvider } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import { FilingsService } from './filings';

export const CURRENT_MODEL = 'qwen-plus';
export const CURRENT_PROMPT_VERSION = 'v1';
const MAX_OUTPUT_TOKENS = 800;
const MIN_SUMMARY_CHARS = 20;
const MAX_PROMPT_CHARS = 400_000;

// Locked v1 prompt — copied EXACTLY from scripts/try-summarize.ts (commit e5630e4)
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

    // Locked v1 user prompt template — copied EXACTLY from scripts/try-summarize.ts (commit e5630e4)
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
