import { describe, it, expect } from 'vitest';
import { summarizePosition, type SummaryInput } from '@/lib/compute/journal-summary';

const baseInput: SummaryInput = {
  status: 'open',
  openedAt: '2024-01-15',
  closedAt: null,
  latestEntry: null,
  now: new Date('2024-04-15T12:00:00Z')
};

describe('summarizePosition', () => {
  it('computes days held for an open position', () => {
    const result = summarizePosition(baseInput);
    expect(result.daysHeld).toBe(91);
  });

  it('computes days held for a closed position', () => {
    const result = summarizePosition({ ...baseInput, status: 'closed', closedAt: '2024-02-15' });
    expect(result.daysHeld).toBe(31);
  });

  it('truncates latest entry preview at 120 chars on a word boundary', () => {
    const longThesis = 'Apple is well positioned given its services growth, ' +
      'iPhone refresh cycle, and Vision Pro launch. The market remains skeptical ' +
      'but recent guidance is encouraging across all segments.';
    const result = summarizePosition({
      ...baseInput,
      latestEntry: { kind: 'entry', occurredAt: '2024-01-15', thesisMd: longThesis }
    });
    expect(result.thesisPreview.length).toBeLessThanOrEqual(123);
    expect(result.thesisPreview.endsWith('...')).toBe(true);
    expect(result.thesisPreview).not.toMatch(/\w\.\.\.$/);
  });

  it('returns empty preview when there are no entries', () => {
    const result = summarizePosition(baseInput);
    expect(result.thesisPreview).toBe('');
  });

  it('marks stale when latest review > 90 days old and status open', () => {
    const result = summarizePosition({
      ...baseInput,
      latestEntry: { kind: 'review', occurredAt: '2023-12-01', thesisMd: 'x' }
    });
    expect(result.stale).toBe(true);
  });

  it('does not mark stale for closed positions even with old entries', () => {
    const result = summarizePosition({
      ...baseInput, status: 'closed', closedAt: '2024-02-15',
      latestEntry: { kind: 'exit', occurredAt: '2024-02-15', thesisMd: 'x' }
    });
    expect(result.stale).toBe(false);
  });

  it('does not mark stale within 90 days', () => {
    const result = summarizePosition({
      ...baseInput,
      latestEntry: { kind: 'review', occurredAt: '2024-02-01', thesisMd: 'x' }
    });
    expect(result.stale).toBe(false);
  });

  it('treats opened_at as the latest entry when no entries exist', () => {
    const result = summarizePosition({ ...baseInput, openedAt: '2023-09-15', latestEntry: null });
    expect(result.stale).toBe(true);
  });
});
