import { describe, it, expect, vi } from 'vitest';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { NotFoundError, RateLimitError, ValidationError } from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProviderHttp(fetchImpl: typeof fetch) {
  return new SecEdgarProviderImpl({
    useHttp: true,
    httpEndpoint: 'http://test.local/api/fallback/sec',
    fetch: fetchImpl
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}

describe('SecEdgarProviderImpl (HTTP mode)', () => {
  describe('.resolveCik()', () => {
    it('returns CIK for known ticker', async () => {
      const fix = loadFixture('sec-cik-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProviderHttp(fetchMock);
      const cik = await provider.resolveCik('AAPL');
      expect(cik).toBe('0000320193');
    });

    it('throws NotFoundError on 404', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not found', kind: 'NotFound' }), { status: 404 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.resolveCik('ZZZZ')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws RateLimitError on 503/RateLimit', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate limited', kind: 'RateLimit' }), { status: 503 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.resolveCik('AAPL')).rejects.toBeInstanceOf(RateLimitError);
    });
  });

  describe('.listFilings()', () => {
    it('returns filings list', async () => {
      const fix = loadFixture('sec-index-aapl.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProviderHttp(fetchMock);
      const result = await provider.listFilings('0000320193', ['10-K', '10-Q'], 5);
      expect(result.cik).toBe('0000320193');
      expect(result.filings).toHaveLength(2);
      expect(result.filings[0]!.formType).toBe('10-K');
    });

    it('400 from upstream produces ValidationError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'bad cik', kind: 'Validation' }), { status: 400 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.listFilings('bad', ['10-K'], 5)).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe('.fetchFiling()', () => {
    it('returns parsed sections', async () => {
      const fix = loadFixture('sec-filing-aapl-10k-2024.json');
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
      const provider = makeProviderHttp(fetchMock);
      const result = await provider.fetchFiling('https://example.com/aapl-10k.htm', '10-K');
      expect(result.formType).toBe('10-K');
      expect(result.sections).toHaveLength(3);
      expect(result.sections[0]!.section_key).toBe('item_1_business');
    });
  });

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
      const provider = makeProviderHttp(fetchMock);
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
      const provider = makeProviderHttp(fetchMock);
      const result = await provider.thirteenFFilings('0001234567');
      expect(result.filings).toEqual([]);
    });

    it('maps 404 from the serverless to NotFoundError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'not found', kind: 'NotFound' }), { status: 404 })
      );
      const provider = makeProviderHttp(fetchMock);
      await expect(provider.thirteenFFilings('0001067983')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('subprocess mode (smoke)', () => {
    function fakeSpawn(stdout: string, exitCode: number) {
      return () => {
        const listeners: Record<string, ((arg?: any) => void)[]> = {};
        const proc = {
          stdout: { on: (ev: string, cb: (data: Buffer) => void) => { if (ev === 'data') cb(Buffer.from(stdout)); } },
          stderr: { on: () => {} },
          on: (ev: string, cb: (arg?: any) => void) => { (listeners[ev] ??= []).push(cb); }
        };
        setTimeout(() => listeners.close?.forEach((cb) => cb(exitCode)), 0);
        return proc;
      };
    }

    it('parses subprocess JSON stdout', async () => {
      const provider = new SecEdgarProviderImpl({
        useHttp: false,
        spawn: fakeSpawn(JSON.stringify({ cik: '0000320193' }), 0) as any
      });
      const cik = await provider.resolveCik('AAPL');
      expect(cik).toBe('0000320193');
    });

    it('subprocess exit 1 with NotFound kind throws NotFoundError', async () => {
      const provider = new SecEdgarProviderImpl({
        useHttp: false,
        spawn: fakeSpawn(JSON.stringify({ error: 'no such', kind: 'NotFound' }), 1) as any
      });
      await expect(provider.resolveCik('ZZ')).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
