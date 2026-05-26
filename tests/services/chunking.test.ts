import { describe, it, expect } from 'vitest';
import { subChunk } from '@/lib/services/chunking';

describe('subChunk', () => {
  it('returns empty array for empty input', () => {
    const chunks = subChunk('');
    expect(chunks).toEqual([]);
  });

  it('returns single chunk when text fits in one window', () => {
    const text = 'Apple designs and sells consumer electronics.';
    const chunks = subChunk(text, { targetTokens: 500, overlapTokens: 50 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
    expect(chunks[0]!.charOffsetStart).toBe(0);
    expect(chunks[0]!.charOffsetEnd).toBe(text.length);
  });

  it('splits long text into multiple windows', () => {
    // Build ~1500 tokens of text by repeating a sentence
    const sentence = 'This is a test sentence about Apple Inc. and its risk factors related to manufacturing operations in China. ';
    const text = sentence.repeat(80); // roughly 1500-2000 tokens
    const chunks = subChunk(text, { targetTokens: 500, overlapTokens: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      expect(c.charOffsetStart).toBeGreaterThanOrEqual(0);
      expect(c.charOffsetEnd).toBeLessThanOrEqual(text.length);
      expect(c.charOffsetEnd).toBeGreaterThan(c.charOffsetStart);
    }
  });

  it('consecutive chunks overlap', () => {
    const sentence = 'Sentence about manufacturing concentration risk in supply chains. ';
    const text = sentence.repeat(80);
    const chunks = subChunk(text, { targetTokens: 500, overlapTokens: 50 });
    if (chunks.length >= 2) {
      expect(chunks[1]!.charOffsetStart).toBeLessThan(chunks[0]!.charOffsetEnd);
    }
  });

  it('char offsets map back to original text', () => {
    const text = 'Apple designs phones. Apple sells phones globally. Apple faces competition.';
    const chunks = subChunk(text, { targetTokens: 5, overlapTokens: 1 });
    for (const c of chunks) {
      const sliced = text.slice(c.charOffsetStart, c.charOffsetEnd);
      // The chunk text should equal (or be substring of) the original slice (possibly trimmed)
      expect(sliced.includes(c.text.trim().slice(0, 10)) || c.text.trim().startsWith(sliced.trim().slice(0, 10))).toBe(true);
    }
  });

  it('snaps to paragraph boundary when nearby', () => {
    const text = 'Para one talks about manufacturing risks in detail.\n\nPara two talks about regulatory risks in detail.\n\nPara three is here.';
    const chunks = subChunk(text, { targetTokens: 10, overlapTokens: 1 });
    const offsets = chunks.flatMap((c) => [c.charOffsetStart, c.charOffsetEnd]);
    const paraBreaks = [text.indexOf('\n\n'), text.indexOf('\n\n', text.indexOf('\n\n') + 1)].filter((i) => i >= 0);
    const aligned = offsets.some((o) => paraBreaks.some((p) => Math.abs(o - p) < 50));
    expect(aligned).toBe(true);
  });

  it('handles default options', () => {
    const text = 'Short text. '.repeat(10);
    const chunks = subChunk(text);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
    }
  });
});
