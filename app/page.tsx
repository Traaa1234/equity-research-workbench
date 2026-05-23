import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { stackServerApp } from '@/stack';

export default async function HomePage() {
  const user = await stackServerApp.getUser();
  if (user) redirect('/watchlist');

  return (
    <main className="container mx-auto py-24 px-4 max-w-2xl">
      <h1 className="text-4xl font-bold tracking-tight">Equity Research Workbench</h1>
      <p className="mt-4 text-lg text-muted-foreground">
        Single-pane dossier for any US-listed equity. Snapshot, financials, watchlist, notes.
      </p>
      <div className="mt-8 flex gap-3">
        <Button asChild>
          <Link href="/handler/signup">Get started</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href="/handler/signin">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
