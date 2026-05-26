import OpenAI from 'openai';
import {
  EmbeddingsProvider,
  EmbeddingsRequest,
  EmbeddingsResult,
  NotFoundError,
  ProviderError,
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

export class EmbeddingsProviderImpl implements EmbeddingsProvider {
  private readonly client: OpenAI;

  constructor(opts: Options = {}) {
    const apiKey = opts.apiKey ?? process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new ProviderError('DASHSCOPE_API_KEY is not set');
    }
    type ClientConfig = ConstructorParameters<typeof OpenAI>[0] & { fetch?: typeof fetch };
    const clientConfig: ClientConfig = {
      apiKey,
      baseURL: opts.baseUrl ?? DEFAULT_BASE_URL,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: 0
    };
    if (opts.fetch) clientConfig.fetch = opts.fetch;
    this.client = new OpenAI(clientConfig);
  }

  async embed(req: EmbeddingsRequest): Promise<EmbeddingsResult> {
    if (req.texts.length === 0) {
      return { vectors: [], inputTokens: 0 };
    }
    try {
      const response = await this.client.embeddings.create({
        model: req.model,
        input: req.texts,
        encoding_format: 'float'
      });
      if (!response.data || response.data.length !== req.texts.length) {
        throw new UnknownProviderError(
          `DashScope returned ${response.data?.length ?? 0} vectors for ${req.texts.length} inputs`
        );
      }
      const vectors = response.data.map((d) => d.embedding);
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      return { vectors, inputTokens };
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
  const anyErr = err as { status?: number; message?: string; name?: string };
  const msg = anyErr.message ?? 'Unknown DashScope embeddings error';
  if (anyErr.name === 'APIConnectionTimeoutError' || /timeout/i.test(msg)) {
    return new ProviderError(`Embeddings timeout: ${msg}`);
  }
  if (anyErr.status === 429) return new RateLimitError(msg);
  if (anyErr.status && anyErr.status >= 500) return new ProviderError(`Embeddings ${anyErr.status}: ${msg}`);
  if (anyErr.status === 401 || anyErr.status === 403) return new ValidationError(`Embeddings auth failed: ${msg}`);
  if (anyErr.status && anyErr.status >= 400) return new ValidationError(`Embeddings ${anyErr.status}: ${msg}`);
  return new UnknownProviderError(msg);
}
