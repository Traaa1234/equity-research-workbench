-- RLS for Slice 3: qa_history.
-- DIFFERENT pattern from existing tables — this is USER-SCOPED.
-- Each row belongs to one user; users can SELECT only their own rows.
-- Writes still go through service_role (BYPASSRLS).

alter table public.qa_history enable row level security;

drop policy if exists "users read own qa_history" on public.qa_history;
create policy "users read own qa_history"
  on public.qa_history for select to authenticated
  using (user_id::text = current_setting('request.jwt.claim.sub', true));

grant select on public.qa_history to authenticated;
