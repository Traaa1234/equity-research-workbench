'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

export function FilingsEmptyState({ ticker }: { ticker: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const { toast } = useToast();

  async function loadFilings() {
    setBusy(true);
    setProgress('Resolving CIK + fetching filings index from SEC…');
    try {
      const res = await fetch(`/api/tickers/${ticker}/filings`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({
          title: 'Could not load filings',
          description: body.error ?? `HTTP ${res.status}`,
          variant: 'destructive'
        });
        setBusy(false);
        setProgress(null);
        return;
      }
      const summary = await res.json();
      toast({
        title: `Loaded ${summary.succeeded}/${summary.count} filings`,
        ...(summary.failed > 0 ? { description: `${summary.failed} failed (check logs)` } : {})
      });
      router.refresh();
    } catch (e: unknown) {
      toast({ title: 'Network error', description: String(e), variant: 'destructive' });
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>No filings loaded yet</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Click the button to fetch {ticker}&apos;s 10-K and 10-Q filings from SEC EDGAR (last 5 years).
          The first load takes 30–90 seconds. Subsequent visits are instant.
        </p>
        <Button onClick={loadFilings} disabled={busy}>
          {busy ? (progress ?? 'Loading…') : 'Load filings from SEC'}
        </Button>
      </CardContent>
    </Card>
  );
}
