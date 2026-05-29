/**
 * ISO 2-letter country code → flag emoji.
 * Unicode flag emojis are made of two regional-indicator code points,
 * one per letter. So 'BR' → 🇧🇷 = U+1F1E7 + U+1F1F7.
 *
 * We compute them programmatically for any valid 2-letter code rather
 * than maintaining a hardcoded map.
 */
export function flagFor(code: string | null): string {
  if (!code) return '';
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return code;
  const A = 'A'.codePointAt(0)!;
  const REGIONAL_BASE = 0x1f1e6; // 🇦
  const c1 = String.fromCodePoint(REGIONAL_BASE + (upper.codePointAt(0)! - A));
  const c2 = String.fromCodePoint(REGIONAL_BASE + (upper.codePointAt(1)! - A));
  return c1 + c2;
}
