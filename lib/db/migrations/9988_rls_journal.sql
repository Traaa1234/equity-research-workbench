-- RLS for the trade journal. Same pattern as qa_history (user-scoped read,
-- service_role handles all writes via JournalService at the API layer).

alter table public.journal_positions enable row level security;
alter table public.journal_entries enable row level security;

drop policy if exists "users read own journal_positions" on public.journal_positions;
create policy "users read own journal_positions"
  on public.journal_positions for select to authenticated
  using (user_id::text = current_setting('request.jwt.claim.sub', true));

drop policy if exists "users read own journal_entries" on public.journal_entries;
create policy "users read own journal_entries"
  on public.journal_entries for select to authenticated
  using (position_id in (
    select id from public.journal_positions
    where user_id::text = current_setting('request.jwt.claim.sub', true)
  ));

grant select on public.journal_positions to authenticated;
grant select on public.journal_entries to authenticated;
