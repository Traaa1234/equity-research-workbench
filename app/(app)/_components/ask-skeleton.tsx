// app/(app)/_components/ask-skeleton.tsx
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function AskSkeleton() {
  return (
    <Card>
      <CardContent className="py-6 space-y-3">
        <p className="text-sm text-muted-foreground">Retrieving sources…</p>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}
