'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

interface Props { initialQuery?: string; }

export function DiscoverInput({ initialQuery = '' }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    const qs = new URLSearchParams({ tab: 'discover', q: trimmed }).toString();
    router.push(`/watchlist?${qs}`);
  }

  return (
    <form onSubmit={onSubmit} className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Describe what you're looking for — e.g. 'AI infrastructure'"
        className="flex-1 rounded border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        autoFocus
      />
      <Button type="submit" disabled={!value.trim()}>Search</Button>
    </form>
  );
}
