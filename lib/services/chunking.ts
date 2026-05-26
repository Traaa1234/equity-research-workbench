import { encode, decode } from 'gpt-tokenizer';

export interface SubChunk {
  text: string;
  charOffsetStart: number;
  charOffsetEnd: number;
}

interface Opts {
  targetTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_TARGET = 500;
const DEFAULT_OVERLAP = 50;
const PARAGRAPH_SNAP_WINDOW_CHARS = 50;

/**
 * Split text into ~targetTokens windows with overlap, snapping to paragraph
 * breaks where convenient. Pure function — no DB, no network, deterministic.
 *
 * Uses gpt-tokenizer (cl100k_base encoding). Token counts don't need to be
 * exact for our use — they just need to be consistent for window math.
 */
export function subChunk(text: string, opts: Opts = {}): SubChunk[] {
  if (!text || text.length === 0) return [];

  const targetTokens = opts.targetTokens ?? DEFAULT_TARGET;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP;

  const tokens = encode(text);
  if (tokens.length === 0) return [];
  if (tokens.length <= targetTokens) {
    return [{ text, charOffsetStart: 0, charOffsetEnd: text.length }];
  }

  const chunks: SubChunk[] = [];
  let tokenStart = 0;
  while (tokenStart < tokens.length) {
    const tokenEnd = Math.min(tokenStart + targetTokens, tokens.length);

    const subTokens = tokens.slice(tokenStart, tokenEnd);
    const chunkText = decode(subTokens);

    let charStart: number;
    if (chunks.length === 0) {
      charStart = 0;
    } else {
      const prev = chunks[chunks.length - 1]!;
      const overlapFrac = overlapTokens / targetTokens;
      const estimatedStep = (prev.charOffsetEnd - prev.charOffsetStart) * (1 - overlapFrac);
      charStart = Math.max(0, Math.round(prev.charOffsetStart + estimatedStep));
      const foundAt = text.indexOf(chunkText.slice(0, 30), charStart - 20);
      if (foundAt >= 0) charStart = foundAt;
    }
    let charEnd = Math.min(charStart + chunkText.length, text.length);

    const snapTarget = text.lastIndexOf('\n\n', charEnd + PARAGRAPH_SNAP_WINDOW_CHARS);
    if (snapTarget >= 0 && snapTarget > charStart && Math.abs(snapTarget - charEnd) <= PARAGRAPH_SNAP_WINDOW_CHARS) {
      charEnd = snapTarget;
    }

    const slicedText = text.slice(charStart, charEnd).trim();
    if (slicedText.length > 0) {
      chunks.push({
        text: slicedText,
        charOffsetStart: charStart,
        charOffsetEnd: charEnd
      });
    }

    const step = Math.max(1, targetTokens - overlapTokens);
    tokenStart += step;
  }

  return chunks;
}
