-- RLS for Slice 2C: chunk_embeddings.
-- Same pattern as filings/filing_chunks/filing_summaries: any authenticated
-- user can SELECT, writes go through service_role (BYPASSRLS). The
-- user-scoping for search is enforced by the application layer via the
-- watchlist subquery in SearchService.

alter table public.chunk_embeddings enable row level security;

drop policy if exists "auth read chunk_embeddings" on public.chunk_embeddings;
create policy "auth read chunk_embeddings"
  on public.chunk_embeddings for select to authenticated using (true);

grant select on public.chunk_embeddings to authenticated;
