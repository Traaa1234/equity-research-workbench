import { config } from 'dotenv'; config({ path: '.env.local', override: false });
import { getServiceDb } from '@/lib/db/client';
import { FredProvider } from '@/lib/providers/fred';
import { YieldCurveService } from '@/lib/services/yield-curve';

const svc = new YieldCurveService({ db: getServiceDb(), fred: new FredProvider() });
const r = await svc.refreshAll('backfill');
console.log('curve backfill:', JSON.stringify(r));
process.exit(r.failed > 0 ? 1 : 0);
