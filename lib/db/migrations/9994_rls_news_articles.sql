-- RLS for Slice 5B: news_articles.
-- Same pattern as filings/filing_chunks: authenticated users read,
-- service role writes (BYPASSRLS).

ALTER TABLE public.news_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated read news_articles" ON public.news_articles;
CREATE POLICY "authenticated read news_articles"
  ON public.news_articles FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.news_articles TO authenticated;
