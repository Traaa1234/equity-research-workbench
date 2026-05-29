'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import type { HoldingsAggregate } from '@/lib/compute/holdings-aggregate';
import type { EnrichedHolding } from '@/lib/services/holdings';
import { HoldingsAggregatePanel } from './holdings-aggregate-panel';
import { SmartMoneyCallout } from './smart-money-callout';
import { HolderRow } from './holder-row';

type FilterMode = 'all' | 'new' | 'exits' | 'additions' | 'reductions';

interface Props {
  ticker: string;
  holdings: EnrichedHolding[];
  aggregate: HoldingsAggregate;
  availablePeriods: string[];
  selectedPeriod: string | null;
}

const FILTERS: Array<{ value: FilterMode; label: string }> = [
  { value: 'all',          label: 'All holders' },
  { value: 'additions',    label: 'Additions only' },
  { value: 'reductions',   label: 'Reductions only' },
  { value: 'new',          label: 'New positions only' },
  { value: 'exits',        label: 'Exits only' }
];

function applyFilter(rows: EnrichedHolding[], mode: FilterMode): EnrichedHolding[] {
  switch (mode) {
    case 'all':         return rows;
    case 'additions':   return rows.filter((r) => r.delta === 'added' || r.delta === 'new');
    case 'reductions':  return rows.filter((r) => r.delta === 'reduced' || r.delta === 'sold-out');
    case 'new':         return rows.filter((r) => r.delta === 'new');
    case 'exits':       return rows.filter((r) => r.delta === 'sold-out');
  }
}

export function HoldingsView({ ticker, holdings, aggregate, availablePeriods, selectedPeriod }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterMode>('all');

  const filtered = applyFilter(holdings, filter);

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/holdings/refresh-tracked`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 429) setError('Refreshing too quickly — try again in an hour.');
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

  function onPeriodChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const p = e.target.value;
    const url = p === availablePeriods[0]
      ? `/stock/${ticker}/holdings`
      : `/stock/${ticker}/holdings?period=${p}`;
    startTransition(() => router.push(url));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <HoldingsAggregatePanel aggregate={aggregate} />
        <div className="flex items-center gap-2">
          {availablePeriods.length > 1 && (
            <select
              value={selectedPeriod ?? availablePeriods[0] ?? ''}
              onChange={onPeriodChange}
              className="text-xs rounded border border-border bg-background px-2 py-1"
            >
              {availablePeriods.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          )}
          <Button
            onClick={refresh}
            disabled={refreshing || isPending}
            title="Updates all tracked managers across all watchlist tickers (~10s)"
          >
            {refreshing ? 'Refreshing…' : 'Refresh tracked investors'}
          </Button>
        </div>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <SmartMoneyCallout aggregate={aggregate} />

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-medium">All tracked holders</h3>
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
            {holdings.length === 0
              ? 'No tracked investor data yet. Click Refresh to pull the latest 13F filings.'
              : 'No holders match the current filter.'}
          </p>
        ) : (
          <ul className="space-y-0">
            {filtered.map((h) => (
              <HolderRow
                key={h.id}
                investorId={h.investorId}
                investorName={h.investorName}
                shares={h.shares}
                marketValue={h.marketValue}
                sharesChange={h.sharesPrev != null ? h.shares - h.sharesPrev : h.shares}
                sharesPrev={h.sharesPrev}
                delta={h.delta}
                isSmartMoney={h.isSmartMoney}
                smartMoneyCategory={h.smartMoneyCategory}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
