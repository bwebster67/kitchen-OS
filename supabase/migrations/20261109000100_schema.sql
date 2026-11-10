create schema if not exists kitchen_private;
revoke all on schema kitchen_private from public, anon, authenticated;
grant usage on schema kitchen_private to authenticated;
alter default privileges in schema kitchen_private revoke execute on functions from public;

create table public.kitchens (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users on delete cascade,
  name text not null default 'My Kitchen' check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create table public.kitchen_members (
  kitchen_id uuid references public.kitchens on delete cascade,
  user_id uuid references auth.users on delete cascade,
  primary key (kitchen_id, user_id)
);
create index kitchen_members_by_user on public.kitchen_members (user_id, kitchen_id);

create function kitchen_private.is_member(p_kitchen uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.kitchen_members where kitchen_id = p_kitchen and user_id = (select auth.uid()));
$$;
revoke all on function kitchen_private.is_member(uuid) from public, anon;
grant execute on function kitchen_private.is_member(uuid) to authenticated;

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  is_default boolean not null default false,
  unique (kitchen_id, id)
);
create unique index locations_name on public.locations (kitchen_id, lower(trim(name)));

create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  name_key text generated always as (lower(regexp_replace(trim(name), '[[:space:]]+', ' ', 'g'))) stored,
  category text not null check (length(trim(category)) between 1 and 60),
  restrictions text[] not null default '{}',
  low_quantity numeric(20,8) check (low_quantity between 0 and 1000000),
  low_unit text,
  unique (kitchen_id, id),
  unique (kitchen_id, name_key),
  check ((low_quantity is null) = (low_unit is null))
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  ingredient_id uuid not null,
  barcode text not null check (barcode ~ '^[0-9]{8,14}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  brand text,
  package_label text,
  net_quantity numeric(20,8) check (net_quantity > 0 and net_quantity <= 1000000),
  net_unit text,
  unique (kitchen_id, id),
  unique (kitchen_id, barcode),
  foreign key (kitchen_id, ingredient_id) references public.ingredients (kitchen_id, id),
  check ((net_quantity is null) = (net_unit is null))
);

create table public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  ingredient_id uuid not null,
  product_id uuid,
  location_id uuid not null,
  mode text not null check (mode in ('exact','count','approximate')),
  quantity numeric(20,8) not null check (quantity between 0 and 1000000),
  unit text not null check (unit in ('g','kg','oz','lb','ml','l','tsp','tbsp','cup','fl oz','gal','count','package','can','box','bottle','portion','level')),
  net_quantity numeric(20,8) check (net_quantity > 0 and net_quantity <= 1000000),
  net_unit text check (net_unit in ('g','kg','oz','lb','ml','l','tsp','tbsp','cup','fl oz','gal')),
  purchased_on date not null,
  printed_on date,
  printed_type text check (printed_type in ('expiration','best_before','use_by','sell_by')),
  estimated_on date,
  opened_on date,
  frozen_on date,
  thawed_on date,
  is_frozen boolean not null default false check (not is_frozen or frozen_on is not null),
  price numeric(12,2) check (price >= 0),
  notes text check (length(notes) <= 2000),
  archived boolean not null default false,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (kitchen_id, id),
  foreign key (kitchen_id, ingredient_id) references public.ingredients (kitchen_id, id),
  foreign key (kitchen_id, location_id) references public.locations (kitchen_id, id),
  foreign key (kitchen_id, product_id) references public.products (kitchen_id, id),
  check ((printed_on is null) = (printed_type is null)),
  check ((net_quantity is null) = (net_unit is null)),
  check (
    (mode = 'approximate' and unit = 'level' and quantity in (0,.25,.5,.75,1))
    or (mode = 'count' and unit in ('count','package','can','box','bottle','portion') and quantity = trunc(quantity))
    or (mode = 'exact' and unit in ('g','kg','oz','lb','ml','l','tsp','tbsp','cup','fl oz','gal','count'))
  )
);
create index inventory_by_ingredient on public.inventory_batches (kitchen_id, ingredient_id) where not archived;

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  description text not null default '',
  cuisine text not null default '',
  instructions text not null default '',
  prep_minutes integer not null default 0 check (prep_minutes between 0 and 1440),
  cook_minutes integer not null default 0 check (cook_minutes between 0 and 1440),
  servings integer not null check (servings between 1 and 1000),
  difficulty text not null default 'easy' check (difficulty in ('easy','moderate','project')),
  spice integer not null default 0 check (spice between 0 and 4),
  tags text[] not null default '{}',
  restrictions text[] not null default '{}',
  notes text not null default '',
  unique (kitchen_id, id)
);
create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  recipe_id uuid not null,
  ingredient_id uuid not null,
  quantity numeric(20,8) not null check (quantity > 0 and quantity <= 1000000),
  unit text not null check (unit in ('g','kg','oz','lb','ml','l','tsp','tbsp','cup','fl oz','gal','count','package','can','box','bottle','portion','level')),
  position integer not null check (position >= 0),
  foreign key (kitchen_id, recipe_id) references public.recipes (kitchen_id, id) on delete cascade,
  foreign key (kitchen_id, ingredient_id) references public.ingredients (kitchen_id, id),
  unique (kitchen_id, recipe_id, position)
);
create table public.planned_meals (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  recipe_id uuid,
  name text not null check (length(trim(name)) between 1 and 120),
  planned_for date not null,
  servings integer not null check (servings between 1 and 1000),
  foreign key (kitchen_id, recipe_id) references public.recipes (kitchen_id, id) on delete cascade
);

create table public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (kitchen_id, id)
);
create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  list_id uuid not null,
  ingredient_id uuid,
  name text not null check (length(trim(name)) between 1 and 120),
  category text not null check (length(trim(category)) between 1 and 60),
  quantity numeric(20,8) not null check (quantity > 0 and quantity <= 1000000),
  unit text not null check (unit in ('g','kg','oz','lb','ml','l','tsp','tbsp','cup','fl oz','gal','count','package','can','box','bottle','portion')),
  purchased boolean not null default false,
  stocked boolean not null default false check (not stocked or purchased),
  foreign key (kitchen_id, list_id) references public.shopping_lists (kitchen_id, id) on delete cascade,
  foreign key (kitchen_id, ingredient_id) references public.ingredients (kitchen_id, id),
  unique (kitchen_id, id)
);

create table public.taste_preferences (
  kitchen_id uuid primary key references public.kitchens on delete cascade,
  favorite_cuisines text[] not null default '{}',
  disliked_ingredients text[] not null default '{}',
  dietary_restrictions text[] not null default '{}',
  allergies text[] not null default '{}',
  spice integer not null default 2 check (spice between 0 and 4),
  max_minutes integer not null default 45 check (max_minutes between 1 and 2880),
  complexity text not null default 'moderate' check (complexity in ('easy','moderate','project')),
  adventurous boolean not null default true,
  freshness_days integer not null default 5 check (freshness_days between 1 and 90)
);

create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  user_id uuid references auth.users on delete set null,
  request_key uuid not null,
  action text not null,
  request jsonb not null,
  reverses_id uuid,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (kitchen_id, id),
  unique (kitchen_id, request_key),
  unique (kitchen_id, reverses_id),
  foreign key (kitchen_id, reverses_id) references public.inventory_transactions (kitchen_id, id)
);
create table public.inventory_transaction_lines (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  transaction_id uuid not null,
  batch_id uuid not null,
  before_state jsonb,
  after_state jsonb not null,
  foreign key (kitchen_id, transaction_id) references public.inventory_transactions (kitchen_id, id) on delete cascade,
  unique (kitchen_id, transaction_id, batch_id)
);
create table public.cooking_events (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  transaction_id uuid not null,
  recipe_id uuid,
  name text not null check (length(trim(name)) between 1 and 120),
  servings integer not null check (servings between 1 and 1000),
  notes text not null default '',
  cooked_at timestamptz not null default now(),
  reversed_at timestamptz,
  unique (kitchen_id, id),
  unique (kitchen_id, transaction_id),
  foreign key (kitchen_id, transaction_id) references public.inventory_transactions (kitchen_id, id)
);
create table public.cooking_event_ingredients (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  event_id uuid not null,
  ingredient_id uuid not null,
  batch_id uuid not null,
  name text not null,
  quantity numeric(20,8),
  unit text not null,
  approximate_before numeric(20,8),
  approximate_after numeric(20,8),
  foreign key (kitchen_id, event_id) references public.cooking_events (kitchen_id, id) on delete cascade
);
create table public.prepared_leftovers (
  kitchen_id uuid not null references public.kitchens on delete cascade,
  batch_id uuid not null,
  event_id uuid not null,
  portions_prepared integer not null check (portions_prepared > 0),
  portions_eaten integer not null check (portions_eaten >= 0 and portions_eaten < portions_prepared),
  primary key (kitchen_id, batch_id),
  foreign key (kitchen_id, batch_id) references public.inventory_batches (kitchen_id, id),
  foreign key (kitchen_id, event_id) references public.cooking_events (kitchen_id, id)
);
create table public.recipe_feedback (
  kitchen_id uuid not null references public.kitchens on delete cascade,
  event_id uuid not null,
  rating integer check (rating between 1 and 5),
  make_again boolean,
  flags text[] not null default '{}',
  notes text not null default '' check (length(notes) <= 2000),
  primary key (kitchen_id, event_id),
  foreign key (kitchen_id, event_id) references public.cooking_events (kitchen_id, id) on delete cascade
);
create table public.pending_commands (
  id uuid primary key default gen_random_uuid(),
  kitchen_id uuid not null references public.kitchens on delete cascade,
  user_id uuid references auth.users on delete set null,
  request_key uuid not null,
  version integer not null check (version > 0),
  type text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  proposed_changes jsonb,
  issues text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','applied','rejected')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  unique (kitchen_id, request_key)
);

alter table public.kitchens enable row level security;
alter table public.kitchen_members enable row level security;
revoke all on public.kitchens, public.kitchen_members from public, anon, authenticated;
grant select on public.kitchens, public.kitchen_members to authenticated;
create policy kitchen_read on public.kitchens for select to authenticated using (kitchen_private.is_member(id));
create policy membership_read on public.kitchen_members for select to authenticated using (user_id = (select auth.uid()));

do $$
declare table_name text;
begin
  foreach table_name in array array['locations','ingredients','products','inventory_batches','recipes','recipe_ingredients',
    'planned_meals','shopping_lists','shopping_items','taste_preferences','inventory_transactions','inventory_transaction_lines',
    'cooking_events','cooking_event_ingredients','prepared_leftovers','recipe_feedback','pending_commands']
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('create policy member_read on public.%I for select to authenticated using (kitchen_private.is_member(kitchen_id))', table_name);
  end loop;
end $$;

grant insert, update, delete on public.planned_meals, public.recipe_feedback to authenticated;
grant insert, update on public.taste_preferences to authenticated;
do $$
declare table_name text;
begin
  foreach table_name in array array['planned_meals','recipe_feedback','taste_preferences']
  loop
    execute format('create policy member_insert on public.%I for insert to authenticated with check (kitchen_private.is_member(kitchen_id))', table_name);
    execute format('create policy member_update on public.%I for update to authenticated using (kitchen_private.is_member(kitchen_id)) with check (kitchen_private.is_member(kitchen_id))', table_name);
  end loop;
  foreach table_name in array array['planned_meals','recipe_feedback']
  loop
    execute format('create policy member_delete on public.%I for delete to authenticated using (kitchen_private.is_member(kitchen_id))', table_name);
  end loop;
end $$;
