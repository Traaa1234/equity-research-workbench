import { and, desc, eq, sql } from 'drizzle-orm';
import { companies, filings, filingChunks, refreshRuns } from '@/lib/db/schema';
import type { ServiceDb } from '@/lib/db/client';
import { NotFoundError } from '@/lib/providers/types';
import type { SecEdgarProvider } from '@/lib/providers/types';
import { logger } from '@/lib/logger';
import type { EmbeddingsService } from './embeddings';

interface Deps {
  db: ServiceDb;
  provider: SecEdgarProvider;
  embeddingsService?: EmbeddingsService;  // OPTIONAL — added in Slice 2C
}

export interface FilingListItem {
  accessionNo: string;
  formType: string;
  filingDate: string;
  periodEnd: string | null;
  primaryDocUrl: string;
  parsedAt: Date | null;
}

export interface FilingListResult {
  filings: FilingListItem[];
  needsIngest: boolean;
}

export interface FilingSectionRef {
  sectionKey: string;
  sectionTitle: string;
  charCount: number;
}

export interface FilingDetail {
  filing: FilingListItem;
  sections: FilingSectionRef[];
}

export interface IngestSummary {
  ticker: string;
  count: number;
  succeeded: number;
  failed: number;
  durationMs: number;
}

const FORMS_DEFAULT = ['10-K', '10-Q'];
const YEARS_DEFAULT = 5;

export class FilingsService {
  constructor(private readonly deps: Deps) {}

  async getList(ticker: string): Promise<FilingListResult> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        accessionNo: filings.accessionNo,
        formType: filings.formType,
        filingDate: filings.filingDate,
        periodEnd: filings.periodEnd,
        primaryDocUrl: filings.primaryDocUrl,
        parsedAt: filings.parsedAt
      })
      .from(filings)
      .where(eq(filings.ticker, t))
      .orderBy(desc(filings.filingDate));

    return { filings: rows, needsIngest: rows.length === 0 };
  }

  async ingest(ticker: string): Promise<IngestSummary> {
    const t = ticker.toUpperCase();
    const started = Date.now();
    const summary: IngestSummary = { ticker: t, count: 0, succeeded: 0, failed: 0, durationMs: 0 };

    const companyRows = await this.deps.db
      .select()
      .from(companies)
      .where(eq(companies.ticker, t))
      .limit(1);
    if (companyRows.length === 0) {
      throw new NotFoundError(`Company ${t} not in companies table; add via /api/tickers/add first`);
    }
    const company = companyRows[0]!;

    let cik = company.cik;
    if (!cik) {
      cik = await this.deps.provider.resolveCik(t);
      await this.deps.db.update(companies).set({ cik }).where(eq(companies.ticker, t));
    }

    const list = await this.deps.provider.listFilings(cik, FORMS_DEFAULT, YEARS_DEFAULT);

    if (list.filings.length === 0) {
      summary.durationMs = Date.now() - started;
      return summary;
    }

    await this.deps.db
      .insert(filings)
      .values(
        list.filings.map((f) => ({
          accessionNo: f.accessionNo,
          ticker: t,
          cik: cik!,
          formType: f.formType,
          filingDate: f.filingDate,
          periodEnd: f.periodEnd,
          primaryDocUrl: f.primaryDocUrl
        }))
      )
      .onConflictDoNothing();

    summary.count = list.filings.length;

    const needParsing = await this.deps.db
      .select()
      .from(filings)
      .where(and(eq(filings.ticker, t), sql`${filings.parsedAt} is null`));

    for (const filing of needParsing) {
      const t0 = new Date();
      try {
        const full = await this.deps.provider.fetchFiling(filing.primaryDocUrl, filing.formType);
        if (full.sections.length > 0) {
          await this.deps.db
            .insert(filingChunks)
            .values(
              full.sections.map((s) => ({
                filingId: filing.accessionNo,
                sectionKey: s.section_key,
                sectionTitle: s.section_title,
                text: s.text,
                charCount: s.text.length,
                charOffsetStart: s.char_offset_start,
                charOffsetEnd: s.char_offset_end
              }))
            )
            .onConflictDoNothing();
        }
        await this.deps.db
          .update(filings)
          .set({ parsedAt: new Date() })
          .where(eq(filings.accessionNo, filing.accessionNo));
        await this.deps.db.insert(refreshRuns).values({
          ticker: t,
          kind: `filing:${filing.accessionNo}`,
          startedAt: t0,
          completedAt: new Date(),
          ok: true,
          sourceUsed: 'sec_edgar'
        });
        summary.succeeded++;
        // Slice 2C: embed the freshly-parsed filing.
        // Embedding failure does NOT block ingestion — caught + logged separately.
        if (this.deps.embeddingsService) {
          try {
            await this.deps.embeddingsService.embedFiling(filing.accessionNo);
          } catch (embedErr) {
            logger.warn(
              { ticker: t, accession: filing.accessionNo, err: String(embedErr) },
              'filings: embedding failed (filing still readable)'
            );
            // EmbeddingsService writes its own refresh_runs row on failure.
          }
        }
      } catch (err) {
        await this.deps.db.insert(refreshRuns).values({
          ticker: t,
          kind: `filing:${filing.accessionNo}`,
          startedAt: t0,
          completedAt: new Date(),
          ok: false,
          sourceUsed: 'sec_edgar',
          error: String(err).slice(0, 1000)
        });
        summary.failed++;
        logger.warn({ ticker: t, accession: filing.accessionNo, err: String(err) }, 'filings: parse failed');
      }
    }

    summary.durationMs = Date.now() - started;
    return summary;
  }

  async getFiling(ticker: string, accessionNo: string): Promise<FilingDetail | null> {
    const t = ticker.toUpperCase();
    const rows = await this.deps.db
      .select({
        accessionNo: filings.accessionNo,
        formType: filings.formType,
        filingDate: filings.filingDate,
        periodEnd: filings.periodEnd,
        primaryDocUrl: filings.primaryDocUrl,
        parsedAt: filings.parsedAt
      })
      .from(filings)
      .where(and(eq(filings.ticker, t), eq(filings.accessionNo, accessionNo)))
      .limit(1);

    if (rows.length === 0) return null;

    const filing = rows[0]!;
    const sectionRows = await this.deps.db
      .select({
        sectionKey: filingChunks.sectionKey,
        sectionTitle: filingChunks.sectionTitle,
        charCount: filingChunks.charCount
      })
      .from(filingChunks)
      .where(eq(filingChunks.filingId, accessionNo))
      .orderBy(filingChunks.id);

    return { filing, sections: sectionRows };
  }

  async getSectionText(accessionNo: string, sectionKey: string): Promise<string | null> {
    const rows = await this.deps.db
      .select({ text: filingChunks.text })
      .from(filingChunks)
      .where(and(eq(filingChunks.filingId, accessionNo), eq(filingChunks.sectionKey, sectionKey)))
      .limit(1);

    return rows[0]?.text ?? null;
  }

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
}
