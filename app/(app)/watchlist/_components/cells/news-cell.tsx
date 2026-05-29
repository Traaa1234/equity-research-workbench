import { getServiceDb } from '@/lib/db/client';
import { loadServerEnv } from '@/lib/env';
import { FinancialDatasetsProvider } from '@/lib/providers/financial-datasets';
import { QwenProviderImpl } from '@/lib/providers/qwen';
import { NewsService } from '@/lib/services/news';
import { newsToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function NewsCell({ ticker }: Props) {
  const db = getServiceDb();
  const env = loadServerEnv();
  const fd = new FinancialDatasetsProvider({ apiKey: env.FINANCIAL_DATASETS_API_KEY });
  const qwen = new QwenProviderImpl();
  const newsSvc = new NewsService({ db, fdProvider: fd, qwenProvider: qwen });

  const articles = await newsSvc.getList(ticker, 50).catch(() => []);

  const cell = newsToCell(
    articles.map((a) => ({
      publishedAt: a.publishedAt,
      sentiment: a.sentiment
    }))
  );
  return <CellChip cell={cell} href={`/stock/${ticker}/news`} />;
}
