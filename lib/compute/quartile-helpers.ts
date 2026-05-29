/**
 * Quartile-based color coding for peer comparison tables.
 *
 * Given a value and the full set of peer values for the same metric, return
 * a Tailwind text-color class that highlights "best" (green) and "worst" (red)
 * quartiles. Middle quartiles stay neutral. Null values stay neutral.
 *
 * Direction:
 *   - 'higher-is-better' (growth, ROE, F-score, margins) — top quartile = green
 *   - 'lower-is-better'  (P/E, EV/EBITDA when positive) — bottom quartile = green
 */

export type QuartileDirection = 'higher-is-better' | 'lower-is-better';

const GREEN = 'text-emerald-600';
const RED = 'text-rose-600';
const NEUTRAL = '';

export function quartileClass(
  value: number | null,
  allValues: Array<number | null>,
  direction: QuartileDirection
): string {
  if (value == null) return NEUTRAL;

  // Filter out nulls; need at least 2 non-null values to distinguish quartiles.
  const finite = allValues.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 2) return NEUTRAL;

  // Sort ascending; rank = how many values are strictly less than `value`.
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= value);
  const position = rank < 0 ? sorted.length - 1 : rank;
  const quartile = position / (sorted.length - 1);   // 0..1 normalized

  // Top quartile = position 0.75..1, bottom = 0..0.25.
  if (direction === 'higher-is-better') {
    if (quartile >= 0.75) return GREEN;
    if (quartile <= 0.25) return RED;
  } else {
    if (quartile <= 0.25) return GREEN;
    if (quartile >= 0.75) return RED;
  }
  return NEUTRAL;
}
