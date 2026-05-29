import { getServiceDb } from '@/lib/db/client';
import { SecEdgarProviderImpl } from '@/lib/providers/sec-edgar';
import { FilingsService } from '@/lib/services/filings';
import { filingsToCell } from '@/lib/compute/watchlist-cells';
import { CellChip } from './cell-chip';

interface Props { ticker: string; }

export async function FilingsCell({ ticker }: Props) {
  const db = getServiceDb();
  const svc = new FilingsService({ db, provider: new SecEdgarProviderImpl() });

  const result = await svc.getList(ticker).catch(() => ({ filings: [], needsIngest: false }));
  const latest = result.filings[0] ?? null;
  const cell = filingsToCell(latest);
  return <CellChip cell={cell} href={`/stock/${ticker}/filings`} />;
}
