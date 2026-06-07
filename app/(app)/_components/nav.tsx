'use client';

import Link from 'next/link';
import { UserButton } from '@stackframe/stack';
import { Button } from '@/components/ui/button';
import { PlusIcon } from 'lucide-react';

export function Nav({ userEmail }: { userEmail: string }) {
  return (
    <header className="border-b border-border">
      <div className="container mx-auto px-4 h-14 flex items-center justify-between">
        <nav className="flex items-center gap-6">
          <Link href="/watchlist" className="font-semibold tracking-tight">
            ERW
          </Link>
          <Link href="/watchlist" className="text-sm text-muted-foreground hover:text-foreground">
            Watchlist
          </Link>
          <Link href="/macro" className="text-sm text-muted-foreground hover:text-foreground">
            Macro
          </Link>
          <Link href="/macro/countries" className="text-sm text-muted-foreground hover:text-foreground">
            Countries
          </Link>
          <Link href="/macro/curve" className="text-sm text-muted-foreground hover:text-foreground">
            Curve
          </Link>
          <Link href="/macro/correlations" className="text-sm text-muted-foreground hover:text-foreground">
            Correlations
          </Link>
        </nav>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" asChild>
            <Link href="/watchlist?add=1">
              <PlusIcon className="w-4 h-4 mr-1" /> Add ticker
            </Link>
          </Button>
          <UserButton />
        </div>
      </div>
    </header>
  );
}
