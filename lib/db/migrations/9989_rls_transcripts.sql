-- RLS for transcripts slice. Same pattern as filings/chunk_embeddings: any
-- authenticated user can SELECT, writes go through service_role (BYPASSRLS).

alter table public.transcripts enable row level security;
alter table public.transcript_chunks enable row level security;
alter table public.transcript_freshness enable row level security;

drop policy if exists "auth read transcripts" on public.transcripts;
create policy "auth read transcripts"
  on public.transcripts for select to authenticated using (true);

drop policy if exists "auth read transcript_chunks" on public.transcript_chunks;
create policy "auth read transcript_chunks"
  on public.transcript_chunks for select to authenticated using (true);

drop policy if exists "auth read transcript_freshness" on public.transcript_freshness;
create policy "auth read transcript_freshness"
  on public.transcript_freshness for select to authenticated using (true);

grant select on public.transcripts to authenticated;
grant select on public.transcript_chunks to authenticated;
grant select on public.transcript_freshness to authenticated;
