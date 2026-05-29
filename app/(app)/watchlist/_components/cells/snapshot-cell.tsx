import { getServiceDb } from '@/lib/db/client';
import { getRedisCache } from '@/lib/cache/redis';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { SnapshotService } from '@/lib/services/snapshot';
import { PricesService } from '@/lib/services/prices';
import { snapshotToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function SnapshotCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const redis = getRedisCache();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const yf = new YFinanceProvider();
  const snapshotSvc = new SnapshotService({ db, primary: fd, fallback: yf, redis });
  const pricesSvc = new PricesService({ db, primary: fd, fallback: yf, redis });

  const [snap, prices] = await Promise.all([
    snapshotSvc.get(ticker).catch(() => null),
    pricesSvc.get(ticker, '1Y').catch(() => [])
  ]);

  let changePct: number | null = null;
  if (prices.length >= 2) {
    const last = prices[prices.length - 1]!.close;
    const prev = prices[prices.length - 2]!.close;
    if (prev > 0) changePct = (last - prev) / prev;
  }

  const cell = snapshotToCell({
    price: snap?.price ?? null,
    changePct
  });
  return <CellChip cell={cell} href={`/stock/${ticker}`} align="right" />;
}
