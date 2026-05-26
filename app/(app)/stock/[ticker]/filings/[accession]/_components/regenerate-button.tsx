'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface Props {
  ticker: string;
  accession: string;
}

export function RegenerateButton({ ticker, accession }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  async function regenerate() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/tickers/${ticker}/filings/${accession}/summary?regenerate=1`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({
          title: 'Regeneration failed',
          ...(body.error ? { description: body.error } : { description: `HTTP ${res.status}` })
        });
        setBusy(false);
        return;
      }
      toast({ title: 'Briefing regenerated' });
      router.refresh();
    } catch (e: unknown) {
      toast({ title: 'Network error', description: String(e), variant: 'destructive' });
      setBusy(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={regenerate} disabled={busy}>
      {busy ? 'Regenerating…' : 'Regenerate'}
    </Button>
  );
}
