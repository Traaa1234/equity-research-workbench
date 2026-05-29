import { getServiceDb } from '@/lib/db/client';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { InsidersService } from '@/lib/services/insiders';
import { insidersToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function InsidersCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const svc = new InsidersService({ db, fdProvider: fd });

  const agg = await svc.getAggregate(ticker, 90).catch(() => null);
  const cell = insidersToCell(agg ? {
    hasClusterBuy: agg.hasClusterBuy,
    netShares: agg.netShares,
    buyCount: agg.buyCount,
    sellCount: agg.sellCount
  } : null);
  return <CellChip cell={cell} href={`/stock/${ticker}/insiders`} />;
}
