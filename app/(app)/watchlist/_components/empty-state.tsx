import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { PlusIcon } from 'lucide-react';

export function EmptyState() {
  return (
    <div className="py-24 text-center">
      <h2 className="text-xl font-semibold">Your watchlist is empty</h2>
      <p className="mt-2 text-muted-foreground">Add a ticker to start tracking.</p>
      <Button asChild className="mt-6">
        <Link href="/watchlist?add=1">
          <PlusIcon className="w-4 h-4 mr-1" /> Add ticker
        </Link>
      </Button>
    </div>
  );
}
