import {
  NotFoundError,
  ProviderError,
  RateLimitError,
  ValidationError
} from '@/lib/providers/types';
import { UnauthorizedError } from '@/lib/auth/current-user';
import { logger } from '@/lib/logger';
import { NextResponse } from 'next/server';

export interface ApiError {
  status: number;
  body: { error: string; details?: unknown };
  headers?: Record<string, string>;
}

export function mapError(err: unknown, context: Record<string, unknown> = {}): ApiError {
  if (err instanceof UnauthorizedError) {
    return { status: 401, body: { error: 'Unauthorized' } };
  }
  if (err instanceof NotFoundError) {
    return { status: 404, body: { error: err.message || 'Not found' } };
  }
  if (err instanceof ValidationError) {
    return { status: 400, body: { error: err.message || 'Bad request' } };
  }
  if (err instanceof RateLimitError) {
    return {
      status: 503,
      body: { error: 'Upstream rate limit; try again shortly' },
      headers: { 'Retry-After': '30' }
    };
  }
  if (err instanceof ProviderError) {
    return {
      status: 503,
      body: { error: 'Upstream provider error' },
      headers: { 'Retry-After': '30' }
    };
  }
  logger.error({ err: String(err), context }, 'api: unhandled error');
  return { status: 500, body: { error: 'Internal server error' } };
}

export function errorResponse(err: unknown, context?: Record<string, unknown>): NextResponse {
  const { status, body, headers } = mapError(err, context);
  const init: ResponseInit = headers ? { status, headers } : { status };
  return NextResponse.json(body, init);
}
