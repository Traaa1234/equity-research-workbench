-- Helper: read the current user id from a session-local JWT claim.
create or replace function current_user_id() returns uuid as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ language sql stable;

-- Enable RLS on all app tables.
alter table public.companies     enable row level security;
alter table public.snapshots     enable row level security;
alter table public.fundamentals  enable row level security;
alter table public.prices        enable row level security;
alter table public.earnings      enable row level security;
alter table public.refresh_runs  enable row level security;
alter table public.watchlist     enable row level security;
alter table public.notes         enable row level security;

-- User-owned: see only your own rows.
create policy "own watchlist read"
  on public.watchlist for select using (user_id = current_user_id());
create policy "own watchlist write"
  on public.watchlist for all using (user_id = current_user_id())
  with check (user_id = current_user_id());

create policy "own notes read"
  on public.notes for select using (user_id = current_user_id());
create policy "own notes write"
  on public.notes for all using (user_id = current_user_id())
  with check (user_id = current_user_id());

-- Reference data: any authenticated session can read.
-- Writes happen only via service_role (BYPASSRLS).
create policy "auth read companies"    on public.companies    for select to authenticated using (true);
create policy "auth read snapshots"    on public.snapshots    for select to authenticated using (true);
create policy "auth read fundamentals" on public.fundamentals for select to authenticated using (true);
create policy "auth read prices"       on public.prices       for select to authenticated using (true);
create policy "auth read earnings"     on public.earnings     for select to authenticated using (true);
-- refresh_runs intentionally has no SELECT policy for authenticated.

-- Grant the runtime SELECT permission on reference tables (RLS does the row-level filtering).
grant select on public.companies, public.snapshots, public.fundamentals, public.prices, public.earnings to authenticated;
grant select, insert, update, delete on public.watchlist, public.notes to authenticated;

-- For app DB connections that come in as the OWNER role (which is what
-- DATABASE_URL is), we need to switch to the `authenticated` role inside the
-- per-request transaction so RLS policies apply. The withUserContext helper
-- does this via `set local role authenticated`. The owner role already has all
-- privileges; this is just so RLS evaluates as `authenticated`.
grant authenticated to current_user;
