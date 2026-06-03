import { config } from 'dotenv'; config({ path: '.env.local', override: false });
import { getServiceDb } from '@/lib/db/client';
import { FredProvider } from '@/lib/providers/fred';
import { YFinanceProvider } from '@/lib/providers/yfinance';
import { CountryScorecardService } from '@/lib/services/country-scorecard';

const svc = new CountryScorecardService({ db: getServiceDb(), fred: new FredProvider(), yf: new YFinanceProvider() });
const r = await svc.refreshAll('backfill');
console.log('country backfill:', JSON.stringify(r));
process.exit(r.fredFailed > 0 ? 1 : 0);
