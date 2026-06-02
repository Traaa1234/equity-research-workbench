'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

export function JournalFilters() {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value == null || value === '') next.delete(key);
    else next.set(key, value);
    startTransition(() => router.push(`/journal?${next.toString()}`));
  }

  return (
    <form className="flex flex-wrap gap-3 items-baseline bg-muted/50 px-3 py-2 rounded mb-4">
      <label className="text-sm">
        Status:{' '}
        <select
          value={params.get('status') ?? ''}
          onChange={(e) => setParam('status', e.currentTarget.value || null)}
          className="border border-border rounded px-2 py-1 text-sm"
        >
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="closed">Closed</option>
        </select>
      </label>
      <label className="text-sm">
        Ticker:{' '}
        <input
          type="text"
          defaultValue={params.get('ticker') ?? ''}
          onBlur={(e) => setParam('ticker', e.currentTarget.value.toUpperCase() || null)}
          className="border border-border rounded px-2 py-1 text-sm font-mono w-24 uppercase"
          placeholder="AAPL"
        />
      </label>
      <label className="text-sm">
        Min conviction:{' '}
        <input
          type="number" min={1} max={10}
          defaultValue={params.get('minConviction') ?? ''}
          onBlur={(e) => setParam('minConviction', e.currentTarget.value || null)}
          className="border border-border rounded px-2 py-1 text-sm w-16"
        />
      </label>
    </form>
  );
}
