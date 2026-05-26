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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientConfig: any = {
      apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_BASE_URL,
      timeout: this.timeoutMs
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
