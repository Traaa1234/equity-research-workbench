export interface SectorDef {
  seriesId: string;
  label: string;
  shortLabel: string;
  isBenchmark?: true;
}

export const SECTOR_REGISTRY: SectorDef[] = [
  { seriesId: 'XLK',  label: 'Technology',             shortLabel: 'Tech'      },
  { seriesId: 'XLF',  label: 'Financials',             shortLabel: 'Fin'       },
  { seriesId: 'XLV',  label: 'Health Care',            shortLabel: 'Health'    },
  { seriesId: 'XLY',  label: 'Consumer Discretionary', shortLabel: 'Cons Disc' },
  { seriesId: 'XLP',  label: 'Consumer Staples',       shortLabel: 'Staples'   },
  { seriesId: 'XLE',  label: 'Energy',                 shortLabel: 'Energy'    },
  { seriesId: 'XLI',  label: 'Industrials',            shortLabel: 'Indus'     },
  { seriesId: 'XLU',  label: 'Utilities',              shortLabel: 'Util'      },
  { seriesId: 'XLB',  label: 'Materials',              shortLabel: 'Materials' },
  { seriesId: 'XLRE', label: 'Real Estate',            shortLabel: 'REITs'     },
  { seriesId: 'XLC',  label: 'Communication Services', shortLabel: 'Comm'      },
  { seriesId: 'SPY',  label: 'S&P 500',                shortLabel: 'SPY', isBenchmark: true },
];

/** All 12 series ids (11 sectors + SPY benchmark). */
export function sectorSeriesIds(): string[] {
  return SECTOR_REGISTRY.map((s) => s.seriesId);
}

/** 11 display sectors — excludes the SPY benchmark row. */
export function displaySectors(): SectorDef[] {
  return SECTOR_REGISTRY.filter((s) => !s.isBenchmark);
}
