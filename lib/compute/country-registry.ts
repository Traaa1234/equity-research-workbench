/**
 * Country registry — 16 countries for the scorecard feature.
 *
 * Coverage summary (verified 2026-06-03 via FRED keyless CSV endpoint):
 *
 *  code  cli  unemp  longRate  cpi
 *  ----  ---  -----  --------  ---
 *  US     ✓    ✓       ✓       CPIAUCSL (current, 2026-04)
 *  CA     ✓    ✓       ✓       CPALTT01CAM657N (stale ~2024-02, MoM%)
 *  GB     ✓    ✓       ✓       CPALTT01GBM657N (stale ~2024-02, MoM%)
 *  DE     ✓    ✓       ✓       CPALTT01DEM657N (stale ~2024-03, MoM%)
 *  FR     ✓    ✓       ✓       CPALTT01FRM657N (stale ~2024-02, MoM%)
 *  IT     ✓    ✓       ✓       CPALTT01ITM657N (stale ~2024-02, MoM%)
 *  ES     ✓    ✓       ✓       CPALTT01ESM657N (stale ~2024-03, MoM%)
 *  JP     ✓    ✓       ✓       CPALTT01JPM657N (stale ~2021-06, MoM%)
 *  AU     ✓    ✓       ✓       null (no candidate found on FRED)
 *  KR     ✓    ✓       ✓       CPALTT01KRM657N (stale ~2024-03, MoM%)
 *  CN     ✓   null    null     CPALTT01CNM657N (stale ~2024-03, MoM%)
 *  IN     ✓   null    null     CPALTT01INM657N (stale ~2024-01, MoM%)
 *  BR     ✓   null    null     CPALTT01BRM657N (stale ~2024-03, MoM%)
 *  MX     ✓   null    null     CPALTT01MXM657N (stale ~2024-03, MoM%)
 *  TW    null  null    null     null (Taiwan not on OECD-FRED; no CPI candidate found)
 *  ZA     ✓   null    null     CPALTT01ZAM657N (stale ~2024-02, MoM%)
 *
 * Notes:
 * - All CLI and DM unemployment/longRate series are current (2025-09 to 2026-05).
 * - CPALTT01{CC}M657N series are OECD MoM% CPI; last updated ~early 2024 on FRED
 *   keyless endpoint but confirmed present; will score on whatever data exists.
 * - AU and TW have no usable CPI on FRED (all candidates 404).
 * - EM countries (CN/IN/BR/MX/ZA) lack harmonized unemployment and long rates on FRED.
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
  { code: 'CA', name: 'Canada',        flag: '🇨🇦', etf: 'EWC',  series: { cli: 'CANLOLITOAASTSAM', unemployment: 'LRHUTTTTCAM156S', longRate: 'IRLTLT01CAM156N', cpi: 'CPALTT01CAM657N' } },
  { code: 'GB', name: 'United Kingdom',flag: '🇬🇧', etf: 'EWU',  series: { cli: 'GBRLOLITOAASTSAM', unemployment: 'LRHUTTTTGBM156S', longRate: 'IRLTLT01GBM156N', cpi: 'CPALTT01GBM657N' } },
  { code: 'DE', name: 'Germany',       flag: '🇩🇪', etf: 'EWG',  series: { cli: 'DEULOLITOAASTSAM', unemployment: 'LRHUTTTTDEM156S', longRate: 'IRLTLT01DEM156N', cpi: 'CPALTT01DEM657N' } },
  { code: 'FR', name: 'France',        flag: '🇫🇷', etf: 'EWQ',  series: { cli: 'FRALOLITOAASTSAM', unemployment: 'LRHUTTTTFRM156S', longRate: 'IRLTLT01FRM156N', cpi: 'CPALTT01FRM657N' } },
  { code: 'IT', name: 'Italy',         flag: '🇮🇹', etf: 'EWI',  series: { cli: 'ITALOLITOAASTSAM', unemployment: 'LRHUTTTTITM156S', longRate: 'IRLTLT01ITM156N', cpi: 'CPALTT01ITM657N' } },
  { code: 'ES', name: 'Spain',         flag: '🇪🇸', etf: 'EWP',  series: { cli: 'ESPLOLITOAASTSAM', unemployment: 'LRHUTTTTESM156S', longRate: 'IRLTLT01ESM156N', cpi: 'CPALTT01ESM657N' } },
  { code: 'JP', name: 'Japan',         flag: '🇯🇵', etf: 'EWJ',  series: { cli: 'JPNLOLITOAASTSAM', unemployment: 'LRHUTTTTJPM156S', longRate: 'IRLTLT01JPM156N', cpi: 'CPALTT01JPM657N' } },
  { code: 'AU', name: 'Australia',     flag: '🇦🇺', etf: 'EWA',  series: { cli: 'AUSLOLITOAASTSAM', unemployment: 'LRHUTTTTAUM156S', longRate: 'IRLTLT01AUM156N', cpi: null } },
  { code: 'KR', name: 'South Korea',   flag: '🇰🇷', etf: 'EWY',  series: { cli: 'KORLOLITOAASTSAM', unemployment: 'LRHUTTTTKRM156S', longRate: 'IRLTLT01KRM156N', cpi: 'CPALTT01KRM657N' } },
  { code: 'CN', name: 'China',         flag: '🇨🇳', etf: 'MCHI', series: { cli: 'CHNLOLITOAASTSAM', unemployment: null, longRate: null, cpi: 'CPALTT01CNM657N' } },
  { code: 'IN', name: 'India',         flag: '🇮🇳', etf: 'INDA', series: { cli: 'INDLOLITOAASTSAM', unemployment: null, longRate: null, cpi: 'CPALTT01INM657N' } },
  { code: 'BR', name: 'Brazil',        flag: '🇧🇷', etf: 'EWZ',  series: { cli: 'BRALOLITOAASTSAM', unemployment: null, longRate: null, cpi: 'CPALTT01BRM657N' } },
  { code: 'MX', name: 'Mexico',        flag: '🇲🇽', etf: 'EWW',  series: { cli: 'MEXLOLITOAASTSAM', unemployment: null, longRate: null, cpi: 'CPALTT01MXM657N' } },
  { code: 'TW', name: 'Taiwan',        flag: '🇹🇼', etf: 'EWT',  series: { cli: null, unemployment: null, longRate: null, cpi: null } },
  { code: 'ZA', name: 'South Africa',  flag: '🇿🇦', etf: 'EZA',  series: { cli: 'ZAFLOLITOAASTSAM', unemployment: null, longRate: null, cpi: 'CPALTT01ZAM657N' } },
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
