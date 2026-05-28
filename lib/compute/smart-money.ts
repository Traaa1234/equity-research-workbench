/**
 * Curated list of well-known active institutional managers used to highlight
 * "smart money" moves in 13F holdings. Each entry has:
 *   - cik:            10-digit zero-padded SEC CIK (when known)
 *   - canonicalNames: uppercase variants seen in FD/SEC responses
 *   - name:           display name
 *   - category:       investing style tag (value / macro / quant / growth / activist)
 *
 * The list lives in code (not the DB) because it changes rarely and only via
 * deliberate edit + deploy. Extend by adding a new entry with verified CIK.
 */

export type SmartMoneyCategory = 'value' | 'macro' | 'quant' | 'growth' | 'activist';

export interface SmartMoneyEntry {
  cik: string;
  canonicalNames: string[];     // normalized form (post-normalizeInvestorName)
  name: string;
  category: SmartMoneyCategory;
}

export const SMART_MONEY: ReadonlyArray<SmartMoneyEntry> = [
  // value
  { cik: '0001067983', canonicalNames: ['BERKSHIRE HATHAWAY'], name: 'Berkshire Hathaway', category: 'value' },
  { cik: '0000928054', canonicalNames: ['DAVIS SELECTED ADVISERS', 'DAVIS ADVISORS'], name: 'Davis Advisors', category: 'value' },
  { cik: '0001061768', canonicalNames: ['BAUPOST GROUP'], name: 'Baupost Group', category: 'value' },
  { cik: '0000846222', canonicalNames: ['SEQUOIA FUND'], name: 'Sequoia Fund', category: 'value' },
  { cik: '0001162091', canonicalNames: ['GREENLIGHT CAPITAL'], name: 'Greenlight Capital', category: 'value' },
  { cik: '0001656456', canonicalNames: ['APPALOOSA MANAGEMENT', 'APPALOOSA LP'], name: 'Appaloosa Management', category: 'value' },
  { cik: '0001138298', canonicalNames: ['GLENVIEW CAPITAL MANAGEMENT', 'GLENVIEW CAPITAL'], name: 'Glenview Capital', category: 'value' },
  // macro
  { cik: '0001350694', canonicalNames: ['BRIDGEWATER ASSOCIATES'], name: 'Bridgewater Associates', category: 'macro' },
  { cik: '0001029160', canonicalNames: ['SOROS FUND MANAGEMENT'], name: 'Soros Fund Management', category: 'macro' },
  { cik: '0001148775', canonicalNames: ['LANSDOWNE PARTNERS'], name: 'Lansdowne Partners', category: 'macro' },
  // quant
  { cik: '0001037389', canonicalNames: ['RENAISSANCE TECHNOLOGIES'], name: 'Renaissance Technologies', category: 'quant' },
  { cik: '0001179392', canonicalNames: ['TWO SIGMA INVESTMENTS', 'TWO SIGMA ADVISERS'], name: 'Two Sigma', category: 'quant' },
  { cik: '0001423053', canonicalNames: ['CITADEL ADVISORS'], name: 'Citadel Advisors', category: 'quant' },
  { cik: '0001009207', canonicalNames: ['D E SHAW', 'D. E. SHAW'], name: 'D. E. Shaw & Co.', category: 'quant' },
  { cik: '0001273087', canonicalNames: ['MILLENNIUM MANAGEMENT'], name: 'Millennium Management', category: 'quant' },
  { cik: '0001167557', canonicalNames: ['AQR CAPITAL MANAGEMENT'], name: 'AQR Capital Management', category: 'quant' },
  { cik: '0001603466', canonicalNames: ['POINT72 ASSET MANAGEMENT'], name: 'Point72 Asset Management', category: 'quant' },
  { cik: '0001268197', canonicalNames: ['MARSHALL WACE'], name: 'Marshall Wace', category: 'quant' },
  // growth
  { cik: '0001167483', canonicalNames: ['TIGER GLOBAL MANAGEMENT'], name: 'Tiger Global Management', category: 'growth' },
  { cik: '0001577300', canonicalNames: ['ARK INVESTMENT MANAGEMENT', 'ARK INVEST'], name: 'ARK Investment Management', category: 'growth' },
  { cik: '0001135730', canonicalNames: ['LONE PINE CAPITAL'], name: 'Lone Pine Capital', category: 'growth' },
  { cik: '0001540531', canonicalNames: ['COATUE MANAGEMENT'], name: 'Coatue Management', category: 'growth' },
  { cik: '0001103804', canonicalNames: ['VIKING GLOBAL INVESTORS'], name: 'Viking Global Investors', category: 'growth' },
  { cik: '0001167139', canonicalNames: ['MAVERICK CAPITAL'], name: 'Maverick Capital', category: 'growth' },
  { cik: '0001572687', canonicalNames: ['HOUND PARTNERS'], name: 'Hound Partners', category: 'growth' },
  { cik: '0001370101', canonicalNames: ['EMINENCE CAPITAL'], name: 'Eminence Capital', category: 'growth' },
  // activist
  { cik: '0001336528', canonicalNames: ['PERSHING SQUARE CAPITAL', 'PERSHING SQUARE'], name: 'Pershing Square Capital', category: 'activist' },
  { cik: '0001040273', canonicalNames: ['THIRD POINT'], name: 'Third Point', category: 'activist' },
  { cik: '0001536411', canonicalNames: ['ELLIOTT INVESTMENT MANAGEMENT', 'ELLIOTT MANAGEMENT'], name: 'Elliott Investment Management', category: 'activist' },
  { cik: '0001637087', canonicalNames: ['CHILDRENS INVESTMENT FUND MANAGEMENT', 'TCI FUND MANAGEMENT'], name: "Children's Investment Fund Management", category: 'activist' }
];

/**
 * The "passive giants" — index funds + ETF sponsors that don't make
 * conviction calls but dominate 13F filings by AUM. Included so the
 * holdings refresh fetches their positions for correct top-10
 * concentration math. Not flagged as "smart money" in the UI; they
 * are not in SMART_MONEY's smart-money matcher.
 */
export const INDEX_GIANTS: ReadonlyArray<{ cik: string; name: string }> = [
  { cik: '0000102909', name: 'Vanguard Group' },
  { cik: '0001364742', name: 'BlackRock' },
  { cik: '0000093751', name: 'State Street' },
  { cik: '0000315066', name: 'Fidelity (FMR)' },
  { cik: '0000080424', name: 'T. Rowe Price' },
  { cik: '0000895421', name: 'Morgan Stanley' },
  { cik: '0000886982', name: 'Goldman Sachs' },
  { cik: '0000019617', name: 'JPMorgan Chase' },
  { cik: '0000050166', name: 'Wells Fargo & Co.' },
  { cik: '0000895646', name: 'Bank of America' },
  { cik: '0000034088', name: 'Northern Trust' },
  { cik: '0000037996', name: 'Bank of New York Mellon' },
  { cik: '0001039765', name: 'Capital Research Global Investors' },
  { cik: '0000866787', name: 'Wellington Management' },
  { cik: '0000800240', name: 'Geode Capital Management' }
];

/**
 * All investors to fetch from SEC EDGAR during a holdings refresh.
 * Union of SMART_MONEY (30 active managers) + INDEX_GIANTS (15
 * passive giants). Deduplicated by CIK. Every CIK is 10-digit
 * zero-padded.
 */
export function getReverseLookupCiks(): string[] {
  const ciks = new Set<string>();
  for (const e of SMART_MONEY) ciks.add(e.cik);
  for (const g of INDEX_GIANTS) ciks.add(g.cik);
  return Array.from(ciks);
}

// Quick lookups built at module load.
const BY_CIK = new Map<string, SmartMoneyEntry>(
  SMART_MONEY.map((e) => [e.cik, e])
);
const BY_NAME = new Map<string, SmartMoneyEntry>();
for (const e of SMART_MONEY) {
  for (const n of e.canonicalNames) BY_NAME.set(n, e);
}

/**
 * Normalize an investor name to a stable canonical form.
 * Uppercase, collapse whitespace, drop common legal suffixes & punctuation.
 */
export function normalizeInvestorName(raw: string): string {
  let s = raw.toUpperCase().trim();
  // Strip common suffixes (order matters — longer first)
  const suffixes = [
    ', L.P.', ' L.P.', ', LP', ' LP',
    ', LLC', ' LLC', ', INC.', ' INC.', ', INC', ' INC',
    ' & CO', ' & CO.', ' & COMPANY',
    ', PARTNERS', ' PARTNERS',
    ', ADVISERS', ', ADVISORS',
    ', LTD', ' LTD',
    '.', ','
  ];
  for (const sfx of suffixes) {
    while (s.endsWith(sfx)) s = s.slice(0, -sfx.length).trim();
  }
  // Strip inline punctuation, collapse whitespace
  s = s.replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Look up a smart-money entry by CIK first (zero-padded), then by canonical name.
 * Returns null if no match.
 */
export function matchSmartMoney(
  investorId: string,
  investorName: string
): SmartMoneyEntry | null {
  // Try CIK match first (zero-pad just in case input lacks leading zeros)
  const padded = investorId.padStart(10, '0');
  const byCik = BY_CIK.get(padded);
  if (byCik) return byCik;
  // Fall back to normalized name
  const normalized = normalizeInvestorName(investorName);
  return BY_NAME.get(normalized) ?? null;
}
