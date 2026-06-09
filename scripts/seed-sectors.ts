import { config } from 'dotenv';
config({ path: '.env.local', override: false });

import { getServiceDb } from '@/lib/db/client';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { SectorRotationService } from '@/lib/services/sector-rotation';

const svc = new SectorRotationService({ db: getServiceDb(), yf: new YFinanceProvider() });
const summary = await svc.refreshAll('backfill');
console.log('sectors backfill:', JSON.stringify(summary));
process.exit(summary.failed > 0 ? 1 : 0);
