import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="py-24 text-center">
      <h2 className="text-xl font-semibold">Ticker not found</h2>
      <p className="mt-2 text-muted-foreground">It may be invalid or not yet ingested.</p>
      <Button asChild className="mt-6">
        <Link href="/watchlist?add=1">Add it now</Link>
      </Button>
    </div>
  );
}
