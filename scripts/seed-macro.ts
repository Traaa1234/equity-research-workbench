import { config } from 'dotenv';
config({ path: '.env.local', override: false });

import { getServiceDb } from '@/lib/db/client';
import { FredProvider } from '@/lib/providers/fred';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { MacroService } from '@/lib/services/macro';

const svc = new MacroService({ db: getServiceDb(), fred: new FredProvider(), yf: new YFinanceProvider() });
const summary = await svc.refreshAll('backfill');
console.log('macro backfill:', JSON.stringify(summary));
process.exit(summary.failed > 0 ? 1 : 0);
