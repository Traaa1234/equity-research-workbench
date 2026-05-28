'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { type HoldingsAggregate, type HolderDelta } from '@/lib/compute/holdings-aggregate';
import { matchSmartMoney, type SmartMoneyCategory } from '@/lib/compute/smart-money';
import type { InstitutionalHolding } from '@/lib/services/holdings';
import { HoldingsAggregatePanel } from './holdings-aggregate-panel';
import { SmartMoneyCallout } from './smart-money-callout';
import { HolderRow } from './holder-row';

type FilterMode = 'all' | 'smart-money' | 'new' | 'exits' | 'additions' | 'reductions';

interface Props {
  ticker: string;
  holdings: InstitutionalHolding[];
  aggregate: HoldingsAggregate;
  availablePeriods: string[];
  selectedPeriod: string | null;
}

const FILTERS: Array<{ value: FilterMode; label: string }> = [
  { value: 'all',          label: 'All holders' },
  { value: 'smart-money',  label: 'Smart money only' },
  { value: 'additions',    label: 'Additions only' },
  { value: 'reductions',   label: 'Reductions only' },
  { value: 'new',          label: 'New positions only' },
  { value: 'exits',        label: 'Exits only' }
];

interface HoldingPlus extends InstitutionalHolding {
  delta: HolderDelta;
  sharesPrev: number | null;
  isSmartMoney: boolean;
  smartMoneyCategory: SmartMoneyCategory | null;
}

function applyFilter(rows: HoldingPlus[], mode: FilterMode): HoldingPlus[] {
  switch (mode) {
    case 'all':         return rows;
    case 'smart-money': return rows.filter((r) => r.isSmartMoney);
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

  // Build "holdings with delta info" by referencing the aggregate's joined view.
  // The joined view lives inside aggregate.smartMoneyMoves only for smart-money
  // entries. We compute isSmartMoney + category for ALL rows here; delta + sharesPrev
  // come from the aggregate's joined view when available (for smart-money holders).
  // Non-smart-money rows default to delta='unchanged' (we don't ship the full join
  // to the client for performance; a deeper "all-holders-with-delta" view is a
  // possible follow-up).
  const enriched: HoldingPlus[] = holdings.map((h) => {
    const sm = matchSmartMoney(h.investorId, h.investorName);
    const joined = [...aggregate.smartMoneyMoves.additions, ...aggregate.smartMoneyMoves.reductions]
      .find((j) => j.investorId === h.investorId);
    return {
      ...h,
      delta: joined?.delta ?? 'unchanged',
      sharesPrev: joined?.sharesPrev ?? null,
      isSmartMoney: sm !== null,
      smartMoneyCategory: sm?.category ?? null
    };
  });

  const filtered = applyFilter(enriched, filter);

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      const res = await fetch(`/api/tickers/${ticker}/holdings`, { method: 'POST' });
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
          <Button onClick={refresh} disabled={refreshing || isPending}>
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {error && <div className="text-xs text-red-600">{error}</div>}

      <SmartMoneyCallout aggregate={aggregate} />

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-medium">
            All holders
            {holdings.length === 200 && (
              <span className="ml-2 text-xs text-muted-foreground font-normal">
                · showing top 200 by shares
              </span>
            )}
          </h3>
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
              ? 'No holdings fetched yet. Click Refresh to pull from the latest 13F filings.'
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
