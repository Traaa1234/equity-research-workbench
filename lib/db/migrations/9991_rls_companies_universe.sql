-- RLS for the discovery universe: authenticated users read, service role writes.
ALTER TABLE public.companies_universe ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read companies_universe" ON public.companies_universe;
CREATE POLICY "authenticated read companies_universe"
  ON public.companies_universe FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.companies_universe TO authenticated;
