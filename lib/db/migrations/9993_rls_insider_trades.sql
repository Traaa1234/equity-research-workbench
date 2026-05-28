-- RLS for insider trades: authenticated users read, service role writes.
ALTER TABLE public.insider_trades ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read insider_trades" ON public.insider_trades;
CREATE POLICY "authenticated read insider_trades"
  ON public.insider_trades FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.insider_trades TO authenticated;
