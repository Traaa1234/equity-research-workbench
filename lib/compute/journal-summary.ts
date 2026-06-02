/**
 * Pure computation of a per-position summary card.
 *
 * Takes the position's status + dates and optionally its latest entry,
 * returns a small struct with the data the UI needs:
 *   - daysHeld     — how long the user has been (or was) in the position
 *   - thesisPreview — truncated latest-entry thesis for the card
 *   - stale        — true if the position is open and hasn't been reviewed
 *                    in > 90 days; UI surfaces this as a quiet warning chip
 *
 * `now` is injected so tests are deterministic.
 */

export interface SummaryEntry {
  kind: 'entry' | 'review' | 'exit';
  occurredAt: string;       // YYYY-MM-DD
  thesisMd: string;
}

export interface SummaryInput {
  status: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  latestEntry: SummaryEntry | null;
  now: Date;
}

export interface PositionSummary {
  daysHeld: number;
  thesisPreview: string;
  stale: boolean;
}

const PREVIEW_MAX = 120;
const STALE_DAYS = 90;

export function summarizePosition(input: SummaryInput): PositionSummary {
  const end = input.status === 'closed' && input.closedAt
    ? new Date(input.closedAt)
    : input.now;
  const start = new Date(input.openedAt);
  const daysHeld = Math.max(0, Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));

  const thesisPreview = truncateAtWordBoundary(input.latestEntry?.thesisMd ?? '', PREVIEW_MAX);

  let stale = false;
  if (input.status === 'open') {
    const referenceDate = input.latestEntry?.occurredAt ?? input.openedAt;
    const ageDays = Math.floor((input.now.getTime() - new Date(referenceDate).getTime()) / (24 * 60 * 60 * 1000));
    stale = ageDays > STALE_DAYS;
  }

  return { daysHeld, thesisPreview, stale };
}

function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > max * 0.6) {
    // Include the space so the ellipsis follows a non-word character
    return slice.slice(0, lastSpace + 1) + '...';
  }
  return slice + '...';
}
