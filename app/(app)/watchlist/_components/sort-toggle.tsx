'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';

const OPTIONS = [
  { value: 'default',  label: 'Alphabetical' },
  { value: 'insider',  label: 'Has insider activity' },
  { value: 'news',     label: 'Has news' },
  { value: 'cluster',  label: 'Has cluster buy' }
] as const;

export function SortToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const current = params.get('sort') ?? 'default';

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const newParams = new URLSearchParams(params.toString());
    if (next === 'default') newParams.delete('sort');
    else newParams.set('sort', next);
    const qs = newParams.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <select
      value={current}
      onChange={onChange}
      className="text-xs rounded border border-border bg-background px-2 py-1"
      aria-label="Sort tickers"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
