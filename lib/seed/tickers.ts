/**
 * The 10 seed tickers pre-loaded into the companies table.
 * Picked to span sectors so the dashboard exercises a variety of metric shapes.
 */
export const SEED_TICKERS = [
  { ticker: 'AAPL',  name: 'Apple Inc.',                   sector: 'Technology'             },
  { ticker: 'MSFT',  name: 'Microsoft Corporation',        sector: 'Technology'             },
  { ticker: 'NVDA',  name: 'NVIDIA Corporation',           sector: 'Technology'             },
  { ticker: 'GOOG',  name: 'Alphabet Inc.',                sector: 'Communication Services' },
  { ticker: 'AMZN',  name: 'Amazon.com, Inc.',             sector: 'Consumer Cyclical'      },
  { ticker: 'META',  name: 'Meta Platforms, Inc.',         sector: 'Communication Services' },
  { ticker: 'BRK.B', name: 'Berkshire Hathaway Inc.',      sector: 'Financial Services'     },
  { ticker: 'JPM',   name: 'JPMorgan Chase & Co.',         sector: 'Financial Services'     },
  { ticker: 'XOM',   name: 'Exxon Mobil Corporation',      sector: 'Energy'                 },
  { ticker: 'UNH',   name: 'UnitedHealth Group Inc.',      sector: 'Healthcare'             }
] as const;

export type SeedTicker = (typeof SEED_TICKERS)[number]['ticker'];
