import OpenAI from 'openai';
import {
  NotFoundError,
  ProviderError,
  QwenProvider,
  QwenSummarizeRequest,
  QwenSummarizeResult,
  RateLimitError,
  SentimentBatchRequest,
  SentimentLabel,
  SentimentScore,
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
    // The openai SDK v6 ConstructorParameters type doesn't expose `fetch` cleanly
    // when combined with our optional-fetch test injection, so we type the config
    // as the SDK's expected shape plus an optional fetch field.
    type ClientConfig = ConstructorParameters<typeof OpenAI>[0] & { fetch?: typeof fetch };
    const clientConfig: ClientConfig = {
      apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_BASE_URL,
      timeout: this.timeoutMs,
      maxRetries: 0
    };
    if (opts.fetch) clientConfig.fetch = opts.fetch;
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

  async sentimentBatch(req: SentimentBatchRequest): Promise<SentimentScore[]> {
    const model = req.model ?? 'qwen-turbo';
    const titles = req.titles;
    const n = titles.length;

    if (n === 0) return [];

    const systemPrompt = (
      'You classify stock-news headlines. For each headline, decide whether the most ' +
      'likely market reaction is `bullish`, `bearish`, or `neutral`, with a `confidence` ' +
      'between 0.0 and 1.0. Output ONLY a JSON array of objects, no prose. Each object: ' +
      '{"sentiment": "...", "confidence": 0.0-1.0}. The array MUST be the same length as ' +
      'the input and in the same order.'
    );

    const tickerLabel = req.ticker ? `$${req.ticker.toUpperCase()}` : 'a public company';
    const numbered = titles.map((t, i) => `${i + 1}. ${t}`).join('\n');
    const userPrompt = `Classify these ${n} headlines about ${tickerLabel}:\n${numbered}`;

    const allNeutral = (): SentimentScore[] =>
      titles.map(() => ({ sentiment: 'neutral' as const, confidence: 0 }));

    let raw: string;
    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: Math.max(2000, n * 40)
      });
      raw = completion.choices[0]?.message?.content?.trim() ?? '';
      if (!raw) return allNeutral();
    } catch (err) {
      throw mapOpenAIError(err);
    }

    // Strip optional code fences (some models wrap JSON in ```json ... ```)
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return allNeutral();
    }

    if (!Array.isArray(parsed) || parsed.length !== n) {
      return allNeutral();
    }

    const VALID: SentimentLabel[] = ['bullish', 'neutral', 'bearish'];
    return parsed.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const obj = item as { sentiment?: unknown; confidence?: unknown };
        const sent = typeof obj.sentiment === 'string' && (VALID as string[]).includes(obj.sentiment)
          ? (obj.sentiment as SentimentLabel)
          : 'neutral';
        let conf = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
          ? obj.confidence
          : 0;
        // When sentiment was normalized away from a non-neutral label, reset confidence to 0
        if (sent === 'neutral' && typeof obj.sentiment === 'string' && obj.sentiment !== 'neutral') {
          conf = 0;
        }
        conf = Math.max(0, Math.min(1, conf));
        return { sentiment: sent, confidence: conf };
      }
      return { sentiment: 'neutral' as const, confidence: 0 };
    });
  }
}

function mapOpenAIError(err: unknown): Error {
  if (
    err instanceof NotFoundError ||
    err instanceof ValidationError ||
    err instanceof ProviderError ||
    err instanceof RateLimitError ||
    err instanceof UnknownProviderError
  ) {
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
