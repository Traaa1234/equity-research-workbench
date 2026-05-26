import { describe, it, expect, vi } from 'vitest';
import { EmbeddingsProviderImpl } from '@/lib/providers/embeddings';
import {
  ProviderError,
  RateLimitError,
  UnknownProviderError,
  ValidationError
} from '@/lib/providers/types';
import { loadFixture } from '../helpers/fixtures';

function makeProvider(fetchMock: typeof fetch) {
  return new EmbeddingsProviderImpl({
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

describe('EmbeddingsProviderImpl', () => {
  it('constructor throws ProviderError when DASHSCOPE_API_KEY is missing', () => {
    const orig = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      expect(() => new EmbeddingsProviderImpl()).toThrow(ProviderError);
    } finally {
      if (orig) process.env.DASHSCOPE_API_KEY = orig;
    }
  });

  it('embed: happy path returns vectors + token counts', async () => {
    const fix = loadFixture('embeddings-response.json');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
    const provider = makeProvider(fetchMock);
    const result = await provider.embed({
      model: 'text-embedding-v3',
      texts: ['hello', 'world']
    });
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toEqual([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08]);
    expect(result.inputTokens).toBe(50);
  });

  it('embed: sends correct request shape', async () => {
    const fix = loadFixture('embeddings-response.json');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(fix));
    const provider = makeProvider(fetchMock);
    await provider.embed({ model: 'text-embedding-v3', texts: ['a', 'b'] });
    expect(fetchMock).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://test.local/v1/embeddings');
    const body = JSON.parse(String((init as any).body));
    expect(body.model).toBe('text-embedding-v3');
    expect(body.input).toEqual(['a', 'b']);
    const headers = (init as any).headers as Headers;
    expect(headers.get('authorization')).toContain('Bearer sk-test-key');
  });

  it('embed: empty input returns empty result without calling API', async () => {
    const fetchMock = vi.fn();
    const provider = makeProvider(fetchMock);
    const result = await provider.embed({ model: 'text-embedding-v3', texts: [] });
    expect(result.vectors).toEqual([]);
    expect(result.inputTokens).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embed: 429 throws RateLimitError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['x'] }))
      .rejects.toBeInstanceOf(RateLimitError);
  });

  it('embed: 500 throws ProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'server error' } }), { status: 500 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['x'] }))
      .rejects.toBeInstanceOf(ProviderError);
  });

  it('embed: 401 throws ValidationError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['x'] }))
      .rejects.toBeInstanceOf(ValidationError);
  });

  it('embed: response with wrong vector count throws UnknownProviderError', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
        model: 'text-embedding-v3',
        usage: { prompt_tokens: 10, total_tokens: 10 }
      })
    );
    const provider = makeProvider(fetchMock);
    await expect(provider.embed({ model: 'text-embedding-v3', texts: ['a', 'b'] }))
      .rejects.toBeInstanceOf(UnknownProviderError);
  });
});
