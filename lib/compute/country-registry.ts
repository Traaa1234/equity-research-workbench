/**
 * Country registry — 16 countries for the scorecard feature.
 *
 * Coverage (verified 2026-06-03 via FRED keyless CSV endpoint):
 * - CLI (OECD CLI, ISO-3 codes): current for all 15 non-TW countries. Taiwan is not
 *   on OECD-FRED → null (scores on equity momentum, rest neutral).
 * - Unemployment + long rate (ISO-2 families): current for all 10 DM countries; the EM
 *   set (CN/IN/BR/MX/ZA) and TW lack them on FRED → null (those dims score neutral 50).
 * - CPI: US only (CPIAUCSL — current index → YoY). The OECD international CPI families on
 *   FRED (CPALTT01…M657N is MoM%-rate, CPIALLMINMEI is stale ~2024) are NOT usable for a
 *   current YoY *index* derivation, so non-US cpi is null (best-effort inflation → neutral).
 *   Sourcing current national CPI indexes per country is a documented future enhancement.
 */

export interface CountryDef {
  code: string;          // ISO2 app key, e.g. 'US'
  name: string;
  flag: string;          // emoji
  etf: string;           // yfinance symbol
  series: {
    cli: string | null;          // OECD CLI
    unemployment: string | null; // harmonized unemployment
    longRate: string | null;     // 10y gov yield
    cpi: string | null;          // current CPI index → YoY (best-effort)
  };
}

export const COUNTRY_REGISTRY: CountryDef[] = [
  { code: 'US', name: 'United States', flag: '🇺🇸', etf: 'SPY',  series: { cli: 'USALOLITOAASTSAM', unemployment: 'LRHUTTTTUSM156S', longRate: 'IRLTLT01USM156N', cpi: 'CPIAUCSL' } },
  { code: 'CA', name: 'Canada',        flag: '🇨🇦', etf: 'EWC',  series: { cli: 'CANLOLITOAASTSAM', unemployment: 'LRHUTTTTCAM156S', longRate: 'IRLTLT01CAM156N', cpi: null } },
  { code: 'GB', name: 'United Kingdom',flag: '🇬🇧', etf: 'EWU',  series: { cli: 'GBRLOLITOAASTSAM', unemployment: 'LRHUTTTTGBM156S', longRate: 'IRLTLT01GBM156N', cpi: null } },
  { code: 'DE', name: 'Germany',       flag: '🇩🇪', etf: 'EWG',  series: { cli: 'DEULOLITOAASTSAM', unemployment: 'LRHUTTTTDEM156S', longRate: 'IRLTLT01DEM156N', cpi: null } },
  { code: 'FR', name: 'France',        flag: '🇫🇷', etf: 'EWQ',  series: { cli: 'FRALOLITOAASTSAM', unemployment: 'LRHUTTTTFRM156S', longRate: 'IRLTLT01FRM156N', cpi: null } },
  { code: 'IT', name: 'Italy',         flag: '🇮🇹', etf: 'EWI',  series: { cli: 'ITALOLITOAASTSAM', unemployment: 'LRHUTTTTITM156S', longRate: 'IRLTLT01ITM156N', cpi: null } },
  { code: 'ES', name: 'Spain',         flag: '🇪🇸', etf: 'EWP',  series: { cli: 'ESPLOLITOAASTSAM', unemployment: 'LRHUTTTTESM156S', longRate: 'IRLTLT01ESM156N', cpi: null } },
  { code: 'JP', name: 'Japan',         flag: '🇯🇵', etf: 'EWJ',  series: { cli: 'JPNLOLITOAASTSAM', unemployment: 'LRHUTTTTJPM156S', longRate: 'IRLTLT01JPM156N', cpi: null } },
  { code: 'AU', name: 'Australia',     flag: '🇦🇺', etf: 'EWA',  series: { cli: 'AUSLOLITOAASTSAM', unemployment: 'LRHUTTTTAUM156S', longRate: 'IRLTLT01AUM156N', cpi: null } },
  { code: 'KR', name: 'South Korea',   flag: '🇰🇷', etf: 'EWY',  series: { cli: 'KORLOLITOAASTSAM', unemployment: 'LRHUTTTTKRM156S', longRate: 'IRLTLT01KRM156N', cpi: null } },
  { code: 'CN', name: 'China',         flag: '🇨🇳', etf: 'MCHI', series: { cli: 'CHNLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'IN', name: 'India',         flag: '🇮🇳', etf: 'INDA', series: { cli: 'INDLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'BR', name: 'Brazil',        flag: '🇧🇷', etf: 'EWZ',  series: { cli: 'BRALOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'MX', name: 'Mexico',        flag: '🇲🇽', etf: 'EWW',  series: { cli: 'MEXLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
  { code: 'TW', name: 'Taiwan',        flag: '🇹🇼', etf: 'EWT',  series: { cli: null, unemployment: null, longRate: null, cpi: null } },
  { code: 'ZA', name: 'South Africa',  flag: '🇿🇦', etf: 'EZA',  series: { cli: 'ZAFLOLITOAASTSAM', unemployment: null, longRate: null, cpi: null } },
];

/** Every distinct, non-null FRED series id across the registry (for refresh). */
export function countryFredIds(): string[] {
  const ids = new Set<string>();
  for (const c of COUNTRY_REGISTRY) for (const v of Object.values(c.series)) if (v) ids.add(v);
  return [...ids];
}
/** Every ETF symbol (for the batched price fetch). */
export function countryEtfs(): string[] {
  return COUNTRY_REGISTRY.map((c) => c.etf);
}
