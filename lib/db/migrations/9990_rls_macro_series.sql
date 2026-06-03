-- RLS for the macro weather dashboard. Catalog data: any authenticated user can
-- SELECT; writes go through service_role (BYPASSRLS).

alter table public.macro_series enable row level security;
alter table public.macro_freshness enable row level security;

drop policy if exists "auth read macro_series" on public.macro_series;
create policy "auth read macro_series"
  on public.macro_series for select to authenticated using (true);

drop policy if exists "auth read macro_freshness" on public.macro_freshness;
create policy "auth read macro_freshness"
  on public.macro_freshness for select to authenticated using (true);

grant select on public.macro_series to authenticated;
grant select on public.macro_freshness to authenticated;
