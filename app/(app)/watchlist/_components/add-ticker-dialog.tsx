'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

const TICKER_RE = /^[A-Z][A-Z.]{0,5}$/;

export function AddTickerDialog() {
  const router = useRouter();
  const params = useSearchParams();
  const open = params.get('add') === '1';

  const [ticker, setTicker] = useState('');
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  function close() {
    const p = new URLSearchParams(params);
    p.delete('add');
    router.push(`/watchlist${p.toString() ? '?' + p.toString() : ''}`);
  }

  async function submit() {
    const sym = ticker.toUpperCase().trim();
    if (!TICKER_RE.test(sym)) {
      toast({ title: 'Invalid ticker', description: 'Use 1–6 uppercase letters (optionally with dots).', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/tickers/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: sym })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        toast({ title: 'Could not add ticker', description: body.error ?? `HTTP ${res.status}`, variant: 'destructive' });
        return;
      }
      const data = (await res.json()) as { redirectTo?: string };
      toast({ title: `${sym} added to watchlist` });
      router.push(data.redirectTo ?? `/stock/${sym}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add ticker</DialogTitle>
          <DialogDescription>
            Enter a US-listed symbol. We'll ingest snapshot, financials, and prices, then add it to your watchlist.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={ticker}
          onChange={(e) => setTicker(e.target.value)}
          placeholder="AAPL"
          autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
