-- RLS for Slice 2A reference data: filings + filing_chunks.
-- Same pattern as companies/snapshots/etc: any authenticated user can SELECT,
-- writes go through service_role (BYPASSRLS).

alter table public.filings        enable row level security;
alter table public.filing_chunks  enable row level security;

drop policy if exists "auth read filings" on public.filings;
create policy "auth read filings"
  on public.filings for select to authenticated using (true);

drop policy if exists "auth read filing_chunks" on public.filing_chunks;
create policy "auth read filing_chunks"
  on public.filing_chunks for select to authenticated using (true);

grant select on public.filings, public.filing_chunks to authenticated;
