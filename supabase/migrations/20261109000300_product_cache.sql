-- Keep Open Food Facts data separate from personal records.
create table public.off_product_cache (
  barcode text primary key check (barcode ~ '^[0-9]{8,14}$'),
  product jsonb,
  expires_at timestamptz not null
);
create table public.off_lookup_budget (requested_at timestamptz not null);
alter table public.off_product_cache enable row level security;
alter table public.off_lookup_budget enable row level security;
revoke all on public.off_product_cache, public.off_lookup_budget from public, anon, authenticated;
grant select, insert, update on public.off_product_cache to service_role;
grant select on public.kitchen_members to service_role;

create function public.reserve_off_lookup() returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(90312249);
  delete from public.off_lookup_budget where requested_at < clock_timestamp() - interval '1 minute';
  if (select count(*) from public.off_lookup_budget) >= 12 then return false; end if;
  insert into public.off_lookup_budget values (clock_timestamp());
  return true;
end $$;
grant select, insert, delete on public.off_lookup_budget to service_role;
revoke all on function public.reserve_off_lookup() from public, anon, authenticated;
grant execute on function public.reserve_off_lookup() to service_role;
