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
    const headers = (init as any).headers as Headers;
    const authHeader = headers.get('authorization') ?? headers.get('Authorization') ?? '';
    expect(authHeader).toContain('Bearer sk-test-key');
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
