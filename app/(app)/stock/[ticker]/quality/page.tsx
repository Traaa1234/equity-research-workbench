import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireUserId } from '@/lib/auth/current-user';
import { getServiceDb } from '@/lib/db/client';
import { loadQuality } from '@/lib/services/quality';
import { DashboardTabs } from '../_components/dashboard-tabs';
import { QualityView } from './_components/quality-view';

interface PageProps {
  params: { ticker: string };
}

export default async function QualityPage({ params }: PageProps) {
  await requireUserId();
  const ticker = params.ticker.toUpperCase();
  const quality = await loadQuality(getServiceDb(), ticker);

  return (
    <div className="container py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{ticker}</h1>
        <DashboardTabs ticker={ticker} active="quality" />
      </div>

      <Card>
        <CardHeader><CardTitle>Quality Scores</CardTitle></CardHeader>
        <CardContent>
          <QualityView quality={quality} />
        </CardContent>
      </Card>
    </div>
  );
}
