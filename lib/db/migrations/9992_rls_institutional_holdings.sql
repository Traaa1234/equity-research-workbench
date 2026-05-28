-- RLS for institutional holdings: authenticated users read, service role writes.
ALTER TABLE public.institutional_holdings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read institutional_holdings" ON public.institutional_holdings;
CREATE POLICY "authenticated read institutional_holdings"
  ON public.institutional_holdings FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.institutional_holdings TO authenticated;
