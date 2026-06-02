/**
 * Pure validation for journal write inputs. Throws on invalid input with a
 * descriptive message. Used by JournalService before any DB write — and
 * mirrored as Zod schemas at the API-route layer.
 */

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;
const MAX_BYTES = 50_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_KINDS = new Set(['entry', 'review', 'exit']);
const VALID_OUTCOMES = new Set(['right', 'wrong', 'mixed']);

export interface NewPositionInput {
  ticker: string;
  openedAt: string;
  convictionAtOpen?: number;
  targetPrice?: number;
  stopPrice?: number;
  expectedHoldingDays?: number;
}

export interface NewEntryInput {
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;
  thesisMd: string;
  convictionAtTime?: number;
  outcome?: 'right' | 'wrong' | 'mixed';
  whatChanged?: string;
  lessons?: string;
}

export function validateNewPosition(input: NewPositionInput): void {
  if (!TICKER_RE.test(input.ticker)) throw new Error(`Invalid ticker: ${input.ticker}`);
  if (!ISO_DATE_RE.test(input.openedAt)) throw new Error(`Invalid opened_at: ${input.openedAt}`);
  if (new Date(input.openedAt).getTime() > Date.now()) {
    throw new Error(`opened_at cannot be in the future: ${input.openedAt}`);
  }
  if (input.convictionAtOpen != null && (input.convictionAtOpen < 1 || input.convictionAtOpen > 10)) {
    throw new Error(`conviction must be in [1, 10]: ${input.convictionAtOpen}`);
  }
  if (input.targetPrice != null && input.targetPrice <= 0) {
    throw new Error(`target_price must be positive: ${input.targetPrice}`);
  }
  if (input.stopPrice != null && input.stopPrice <= 0) {
    throw new Error(`stop_price must be positive: ${input.stopPrice}`);
  }
  if (input.expectedHoldingDays != null && input.expectedHoldingDays <= 0) {
    throw new Error(`expected_holding_days must be positive: ${input.expectedHoldingDays}`);
  }
}

export function validateNewEntry(input: NewEntryInput): void {
  if (!VALID_KINDS.has(input.kind)) throw new Error(`Invalid kind: ${input.kind}`);
  if (!ISO_DATE_RE.test(input.occurredAt)) throw new Error(`Invalid occurred_at: ${input.occurredAt}`);
  if (input.thesisMd.length > MAX_BYTES) throw new Error(`thesis_md exceeds ${MAX_BYTES} bytes`);
  if ((input.whatChanged?.length ?? 0) > MAX_BYTES) throw new Error(`what_changed exceeds ${MAX_BYTES} bytes`);
  if ((input.lessons?.length ?? 0) > MAX_BYTES) throw new Error(`lessons exceeds ${MAX_BYTES} bytes`);
  if (input.convictionAtTime != null && (input.convictionAtTime < 1 || input.convictionAtTime > 10)) {
    throw new Error(`conviction must be in [1, 10]: ${input.convictionAtTime}`);
  }
  if (input.outcome != null) {
    if (!VALID_OUTCOMES.has(input.outcome)) throw new Error(`Invalid outcome: ${input.outcome}`);
    if (input.kind !== 'exit') throw new Error(`outcome may only be set on exit entries`);
  }
}
