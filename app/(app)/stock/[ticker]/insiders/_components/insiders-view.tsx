'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { classifyTransaction, type InsiderAggregate, type TransactionClass } from '@/lib/compute/insider-aggregate';
import type { InsiderTrade } from '@/lib/services/insiders';
import { InsiderAggregatePanel } from './insider-aggregate-panel';
import { InsiderTransactionRow } from './insider-transaction-row';

type FilterMode = 'all' | 'buys-and-sells' | 'buys' | 'sells' | 'no-comp';

interface Props {
  ticker: string;
  transactions: InsiderTrade[];
  aggregate: InsiderAggregate;
}

const FILTERS: Array<{ value: FilterMode; label: string }> = [
  { value: 'buys-and-sells', label: 'Buys & sells only' },
  { value: 'all',            label: 'All transactions' },
  { value: 'buys',           label: 'Buys only' },
  { value: 'sells',          label: 'Sells only' },
  { value: 'no-comp',        label: 'Excludes compensation' }
];

function matches(cls: TransactionClass, mode: FilterMode): boolean {
  switch (mode) {
    case 'all':            return true;
    case 'buys-and-sells': return cls === 'buy' || cls === 'sell';
    case 'buys':           return cls === 'buy';
    case 'sells':          return cls === 'sell';
    case 'no-comp':        return cls !== 'award';
  }
}

export function InsidersView({ ticker, transactions, aggregate }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('buys-and-sells');

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tickers/${ticker}/insiders`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 429) setError('Refreshing too quickly — try again in a minute.');
        else {
          const body = await res.json().catch(() => ({}));
          setError((body as { error?: string }).error ?? `Refresh failed (HTTP ${res.status})`);
        }
        return;
      }
      startTransition(() => router.refresh());
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setRefreshing(false);
    }
  }

  const filtered = transactions.filter((t) => matches(classifyTransaction(t.transactionType), filter));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <InsiderAggregatePanel aggregate={aggregate} />
        <Button onClick={refresh} disabled={refreshing || isPending}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-medium">All transactions</h3>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as FilterMode)}
            className="text-xs rounded border border-border bg-background px-2 py-1"
          >
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>

        {filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {transactions.length === 0
              ? 'No transactions fetched yet. Click Refresh to pull from SEC Form 4 filings.'
              : 'No transactions match the current filter.'}
          </p>
        ) : (
          <ul className="space-y-0">
            {filtered.map((t) => (
              <InsiderTransactionRow key={t.id} trade={t} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
