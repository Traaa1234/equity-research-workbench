'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function SearchBar() {
  const router = useRouter();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = q.trim();
    if (trimmed.length === 0) {
      router.push('/watchlist');
      return;
    }
    const sp = new URLSearchParams();
    sp.set('q', trimmed);
    router.push(`/watchlist?${sp.toString()}`);
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <label htmlFor="search-input" className="sr-only">Search filings</label>
      <Input
        id="search-input"
        type="text"
        placeholder="🔍 Search across your filings…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="flex-1"
        maxLength={500}
      />
      <Button type="submit" aria-label="Search filings">Search</Button>
    </form>
  );
}
