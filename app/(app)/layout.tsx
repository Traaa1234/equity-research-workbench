import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { stackServerApp } from '@/stack';
import { Nav } from './_components/nav';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await stackServerApp.getUser();
  if (!user) redirect('/handler/signin');

  return (
    <div className="min-h-screen flex flex-col">
      <Nav userEmail={user.primaryEmail ?? user.id} />
      <main className="container mx-auto py-6 px-4 flex-1">{children}</main>
      <footer className="container mx-auto py-4 px-4 text-xs text-muted-foreground border-t border-border">
        Not investment advice. Data from Financial Datasets and Yahoo Finance.
      </footer>
    </div>
  );
}
