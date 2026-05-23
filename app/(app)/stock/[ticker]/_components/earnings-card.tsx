import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function EarningsCard({ ticker }: { ticker: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Earnings history</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Earnings history for {ticker} arrives in M11. Last 8 quarters of EPS will appear here.
        </p>
      </CardContent>
    </Card>
  );
}
