import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Returns a configured Gemini AI SDK provider.
 *
 * Reads GEMINI_API_KEY from the environment at call-time (not module-load
 * time) so tests can inject a different key via process.env without
 * worrying about module-level closures.
 */
export function createGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  return createOpenAICompatible({
    name: 'gemini',
    baseURL: GEMINI_BASE_URL,
    apiKey
  });
}
