import { describe, it, expect, vi } from 'vitest';
import { DiscoverService } from '@/lib/services/discover';
import type { QwenProvider } from '@/lib/providers/types';

function mockQwen(jsonOutput: string): QwenProvider {
  return {
    summarize: vi.fn().mockResolvedValue({
      text: jsonOutput, inputTokens: 100, outputTokens: 50
    }),
    sentimentBatch: vi.fn()
  };
}

function makeSvc(qwen: QwenProvider) {
  return new DiscoverService({
    db: null as any,
    qwenProvider: qwen,
    embeddingsProvider: null as any,
    redis: null as any
  });
}

describe('DiscoverService.parseQuery', () => {
  it('parses "AI infrastructure" into Technology sector + concept text', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: null, sector: 'Technology', industry: null,
      exchanges: [], conceptText: 'AI infrastructure',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('AI infrastructure');
    expect(result.sector).toBe('Technology');
    expect(result.country).toBeNull();
    expect(result.conceptText).toBe('AI infrastructure');
  });

  it('parses "Brazilian CPG on US exchanges" into BR + Consumer Defensive + NYSE/NASDAQ', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: 'BR', sector: 'Consumer Defensive', industry: null,
      exchanges: ['NYSE', 'NASDAQ'], conceptText: 'consumer packaged goods',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('Brazilian CPG on US exchanges');
    expect(result.country).toBe('BR');
    expect(result.exchanges).toEqual(['NYSE', 'NASDAQ']);
  });

  it('parses "Chinese internet ADRs"', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: 'CN', sector: 'Technology', industry: null,
      exchanges: ['NYSE', 'NASDAQ'], conceptText: 'internet company',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('Chinese internet ADRs');
    expect(result.country).toBe('CN');
  });

  it('parses market-cap qualifiers', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: null, sector: 'Healthcare', industry: null,
      exchanges: [], conceptText: 'healthcare AI',
      marketCapMin: null, marketCapMax: 2000000000
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('small-cap healthcare AI');
    expect(result.marketCapMax).toBe(2_000_000_000);
  });

  it('strips markdown code fences from LLM output', async () => {
    const qwen = mockQwen('```json\n{"country":null,"sector":null,"industry":null,"exchanges":[],"conceptText":"hi","marketCapMin":null,"marketCapMax":null}\n```');
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('hi');
    expect(result.conceptText).toBe('hi');
  });

  it('falls back to defaults when LLM returns invalid JSON', async () => {
    const qwen = mockQwen('not json at all');
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('whatever');
    expect(result.country).toBeNull();
    expect(result.sector).toBeNull();
    expect(result.conceptText).toBe('whatever');
  });

  it('falls back when schema validation fails (e.g. non-array exchanges)', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: null, sector: 'Technology', industry: null,
      exchanges: 'NYSE',
      conceptText: 'hi', marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('hi');
    expect(result.exchanges).toEqual([]);
  });

  it('nulls out invalid country codes', async () => {
    const qwen = mockQwen(JSON.stringify({
      country: 'BRA',
      sector: null, industry: null,
      exchanges: [], conceptText: 'hi',
      marketCapMin: null, marketCapMax: null
    }));
    const svc = makeSvc(qwen);
    const result = await svc.parseQuery('hi');
    expect(result.country).toBeNull();
  });
});
