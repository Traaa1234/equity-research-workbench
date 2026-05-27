// app/(app)/watchlist/_components/watchlist-tabs.tsx
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Props {
  active: 'search' | 'ask';
}

export function WatchlistTabs({ active }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();

  function setMode(mode: 'search' | 'ask') {
    const sp = new URLSearchParams(params.toString());
    if (mode === 'search') sp.delete('mode');
    else sp.set('mode', 'ask');
    // Clear query when switching tabs to avoid running the wrong search
    sp.delete('q');
    const next = sp.toString();
    router.push(next ? `${pathname}?${next}` : pathname);
  }

  return (
    <Tabs value={active} onValueChange={(v) => setMode(v as 'search' | 'ask')}>
      <TabsList>
        <TabsTrigger value="search">Search</TabsTrigger>
        <TabsTrigger value="ask">Ask</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
