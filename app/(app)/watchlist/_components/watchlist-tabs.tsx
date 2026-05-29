// app/(app)/watchlist/_components/watchlist-tabs.tsx
'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type WatchlistTab = 'rollup' | 'list' | 'search' | 'ask';

interface Props {
  active: WatchlistTab;
}

export function WatchlistTabs({ active }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();

  function setTab(tab: WatchlistTab) {
    const sp = new URLSearchParams(params.toString());
    // Reset cross-tab state when switching to avoid stale params bleeding
    // between tabs (e.g. ?q= from Search showing up under Roll-up).
    sp.delete('q');
    sp.delete('mode');
    sp.delete('sort');

    if (tab === 'rollup') {
      sp.set('tab', 'rollup');
    } else if (tab === 'list') {
      sp.set('tab', 'list');
    } else if (tab === 'search') {
      sp.set('tab', 'search');
    } else {
      sp.set('tab', 'ask');
    }
    const next = sp.toString();
    router.push(next ? `${pathname}?${next}` : pathname);
  }

  return (
    <Tabs value={active} onValueChange={(v) => setTab(v as WatchlistTab)}>
      <TabsList>
        <TabsTrigger value="rollup">Roll-up</TabsTrigger>
        <TabsTrigger value="list">List</TabsTrigger>
        <TabsTrigger value="search">Search</TabsTrigger>
        <TabsTrigger value="ask">Ask</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
