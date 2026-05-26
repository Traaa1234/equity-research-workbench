-- RLS for Slice 2B: filing_summaries.
-- Same pattern as filings/filing_chunks: any authenticated user can SELECT,
-- writes go through service_role (BYPASSRLS).

alter table public.filing_summaries enable row level security;

drop policy if exists "auth read filing_summaries" on public.filing_summaries;
create policy "auth read filing_summaries"
  on public.filing_summaries for select to authenticated using (true);

grant select on public.filing_summaries to authenticated;
