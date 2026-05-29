import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { PricesService } from '@/lib/services/prices';
import { computeTechnical } from '@/lib/compute/technical';
import { technicalToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

export async function TechnicalCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const redis = getRedisCache();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });

  const prices = await pricesSvc.get(ticker, '1Y').catch(() => []);
  if (prices.length === 0) {
    return <CellChip cell={{ glyph: '—', color: 'muted' }} href={`/stock/${ticker}/technical`} />;
  }

  const tech = computeTechnical(prices);

  let recentCross: 'golden' | 'death' | null = null;
  const cutoff = Date.now() - TEN_DAYS_MS;
  for (const s of tech.signals) {
    const ms = Date.parse(s.date + 'T00:00:00Z');
    if (!Number.isFinite(ms) || ms < cutoff) break;
    if (s.kind === 'golden_cross') { recentCross = 'golden'; break; }
    if (s.kind === 'death_cross')  { recentCross = 'death';  break; }
  }

  const cell = technicalToCell({ rsi: tech.current.rsi, recentCross });
  return <CellChip cell={cell} href={`/stock/${ticker}/technical`} />;
}
