-- Existing IDs, batches, recipes, and barcode mappings are retained as recorded.
alter table public.ingredients
  add column aliases text[] not null default '{}' check (cardinality(aliases) <= 25),
  add column grams_per_cup numeric(20,8) check (grams_per_cup > 0 and grams_per_cup <= 1000000);
alter table public.recipe_ingredients
  add column preparation_notes text not null default '' check (length(preparation_notes) <= 500);
alter table public.products alter column barcode drop not null;

create or replace function kitchen_private.ingredient(p_kitchen uuid, p_name text, p_category text) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid; v_key text := lower(regexp_replace(trim(p_name), '[[:space:]]+', ' ', 'g'));
begin
  select id into v_id from public.ingredients where kitchen_id=p_kitchen and name_key=v_key;
  if found then return v_id; end if;
  select case when count(*)=1 then (array_agg(i.id))[1] end into v_id
  from public.ingredients i where i.kitchen_id=p_kitchen and exists (
    select 1 from unnest(i.aliases) as alias where lower(regexp_replace(trim(alias), '[[:space:]]+', ' ', 'g'))=v_key
  );
  if v_id is not null then return v_id; end if;
  insert into public.ingredients(kitchen_id,name,category) values(p_kitchen, trim(p_name), p_category)
  on conflict (kitchen_id,name_key) do update set name = public.ingredients.name
  returning id into v_id;
  return v_id;
end $$;

create or replace function kitchen_private.add_batch(p_kitchen uuid, p_tx uuid, p_data jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_ing uuid; v_prod uuid; v_existing_ingredient uuid; b public.inventory_batches;
  v_barcode text := nullif(p_data->>'barcode','');
  v_canonical_name text := nullif(trim(p_data->>'canonical_name'),'');
  v_product_name text := trim(p_data->>'name');
  v_brand text := nullif(trim(p_data->>'brand'),'');
begin
  if (p_data->>'quantity')::numeric <= 0 and p_data->>'mode' <> 'approximate' then
    raise exception 'Enter a positive quantity';
  end if;
  if v_barcode is not null then
    select ingredient_id into v_existing_ingredient from public.products
    where kitchen_id=p_kitchen and barcode=v_barcode;
  end if;
  -- A reviewed mapping may change future purchases. Existing batches retain their recorded ingredient.
  v_ing := coalesce(
    case when v_canonical_name is not null then coalesce((p_data->>'ingredient_id')::uuid,
      kitchen_private.ingredient(p_kitchen,v_canonical_name,coalesce(p_data->>'category','Other'))) end,
    v_existing_ingredient,
    (p_data->>'ingredient_id')::uuid,
    kitchen_private.ingredient(p_kitchen,v_product_name,coalesce(p_data->>'category','Other'))
  );
  if v_canonical_name is not null and p_data->>'category' is not null then
    -- Give a recipe-only ingredient its first reviewed category when it is stocked.
    update public.ingredients set category=p_data->>'category'
    where kitchen_id=p_kitchen and id=v_ing and category='Other'
      and not exists (select 1 from public.inventory_batches where kitchen_id=p_kitchen and ingredient_id=v_ing);
  end if;
  if v_barcode is not null then
    insert into public.products(kitchen_id,ingredient_id,barcode,name,brand,package_label,net_quantity,net_unit)
    values (p_kitchen,v_ing,v_barcode,v_product_name,v_brand,p_data->>'package_label',
      (p_data->>'net_quantity')::numeric,p_data->>'net_unit')
    on conflict (kitchen_id,barcode) do update set
      ingredient_id=excluded.ingredient_id, name=excluded.name, brand=excluded.brand,
      package_label=excluded.package_label, net_quantity=excluded.net_quantity, net_unit=excluded.net_unit
    returning id into v_prod;
  elsif v_brand is not null then
    select id into v_prod from public.products
    where kitchen_id=p_kitchen and ingredient_id=v_ing and barcode is null and name=v_product_name and brand=v_brand
      and package_label is not distinct from p_data->>'package_label'
      and net_quantity is not distinct from (p_data->>'net_quantity')::numeric
      and net_unit is not distinct from p_data->>'net_unit'
    order by id limit 1;
    if v_prod is null then
      insert into public.products(kitchen_id,ingredient_id,name,brand,package_label,net_quantity,net_unit)
      values(p_kitchen,v_ing,v_product_name,v_brand,p_data->>'package_label',(p_data->>'net_quantity')::numeric,p_data->>'net_unit')
      returning id into v_prod;
    end if;
  end if;
  insert into public.inventory_batches(kitchen_id,ingredient_id,product_id,location_id,mode,quantity,unit,
    net_quantity,net_unit,purchased_on,printed_on,printed_type,estimated_on,opened_on,frozen_on,thawed_on,is_frozen,price,notes)
  values(p_kitchen,v_ing,v_prod,(p_data->>'location_id')::uuid,p_data->>'mode',(p_data->>'quantity')::numeric,p_data->>'unit',
    (p_data->>'net_quantity')::numeric,p_data->>'net_unit',(p_data->>'purchased_on')::date,(p_data->>'printed_on')::date,
    case when p_data->>'printed_on' is not null then p_data->>'printed_type' end,(p_data->>'estimated_on')::date,
    (p_data->>'opened_on')::date,(p_data->>'frozen_on')::date,(p_data->>'thawed_on')::date,
    (p_data->>'frozen_on')::date is not null and ((p_data->>'thawed_on')::date is null or (p_data->>'thawed_on')::date < (p_data->>'frozen_on')::date),
    (p_data->>'price')::numeric,p_data->>'notes')
  returning * into b;
  perform kitchen_private.log_batch(p_kitchen,p_tx,null,b);
  return b.id;
end $$;

create or replace function kitchen_private.save_recipe(p_kitchen uuid,p_data jsonb) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid := coalesce((p_data->>'id')::uuid,gen_random_uuid()); v_line jsonb; v_pos integer := 0; v_ing uuid;
begin
  if jsonb_typeof(p_data->'ingredients') is distinct from 'array' or jsonb_array_length(p_data->'ingredients') not between 1 and 100 then
    raise exception 'A recipe needs between 1 and 100 ingredients';
  end if;
  insert into public.recipes(id,kitchen_id,name,description,cuisine,instructions,prep_minutes,cook_minutes,
    servings,difficulty,spice,tags,restrictions,notes)
  values(v_id,p_kitchen,trim(p_data->>'name'),coalesce(p_data->>'description',''),coalesce(p_data->>'cuisine',''),
    coalesce(p_data->>'instructions',''),coalesce((p_data->>'prep_minutes')::integer,0),coalesce((p_data->>'cook_minutes')::integer,0),
    (p_data->>'servings')::integer,coalesce(p_data->>'difficulty','easy'),coalesce((p_data->>'spice')::integer,0),
    array(select jsonb_array_elements_text(p_data->'tags')),array(select jsonb_array_elements_text(p_data->'restrictions')),
    coalesce(p_data->>'notes',''))
  on conflict (id) do update set name=excluded.name, description=excluded.description,cuisine=excluded.cuisine,
    instructions=excluded.instructions,prep_minutes=excluded.prep_minutes,cook_minutes=excluded.cook_minutes,servings=excluded.servings,
    difficulty=excluded.difficulty,spice=excluded.spice,tags=excluded.tags,restrictions=excluded.restrictions,notes=excluded.notes
  where public.recipes.kitchen_id=p_kitchen returning id into v_id;
  if v_id is null then raise exception 'Recipe unavailable' using errcode='42501'; end if;
  delete from public.recipe_ingredients where kitchen_id=p_kitchen and recipe_id=v_id;
  for v_line in select value from jsonb_array_elements(p_data->'ingredients')
  loop
    v_ing := coalesce((v_line->>'ingredient_id')::uuid,kitchen_private.ingredient(p_kitchen,v_line->>'name',coalesce(v_line->>'category','Other')));
    insert into public.recipe_ingredients(kitchen_id,recipe_id,ingredient_id,quantity,unit,position,preparation_notes)
    values(p_kitchen,v_id,v_ing,(v_line->>'quantity')::numeric,v_line->>'unit',v_pos,coalesce(v_line->>'preparation_notes',''));
    v_pos := v_pos+1;
  end loop;
  return v_id;
end $$;

create or replace function kitchen_private.manage_kitchen(p_kitchen uuid,p_action text,p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_entry jsonb; v_list uuid; v_unit text; v_aliases text[];
begin
  if not kitchen_private.is_member(p_kitchen) then raise exception 'Kitchen unavailable' using errcode='42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or pg_column_size(p_data) > 250000 then raise exception 'Invalid request'; end if;
  perform 1 from public.kitchens where id=p_kitchen for update;
  v_id := (p_data->>'id')::uuid;
  case p_action
  when 'recipe_save' then return kitchen_private.save_recipe(p_kitchen,p_data);
  when 'recipe_delete' then delete from public.recipes where kitchen_id=p_kitchen and id=v_id;
  when 'location_add' then insert into public.locations(kitchen_id,name) values(p_kitchen,trim(p_data->>'name')) returning id into v_id;
  when 'location_rename' then update public.locations set name=trim(p_data->>'name') where kitchen_id=p_kitchen and id=v_id and not is_default;
  when 'location_delete' then delete from public.locations where kitchen_id=p_kitchen and id=v_id and not is_default;
  when 'ingredient_settings' then
    v_unit := p_data->>'low_unit';
    if v_unit is not null and v_unit not in ('g','kg','oz','lb','ml','l','tsp','tbsp','cup','fl oz','gal','count','package','can','box','bottle','portion','level') then
      raise exception 'Unknown threshold unit';
    end if;
    if p_data ? 'aliases' then
      if jsonb_typeof(p_data->'aliases') is distinct from 'array' or jsonb_array_length(p_data->'aliases') > 25 then
        raise exception 'Enter up to 25 ingredient aliases';
      end if;
      select array(select min(trim(alias)) from jsonb_array_elements_text(p_data->'aliases') as alias
        group by lower(regexp_replace(trim(alias), '[[:space:]]+', ' ', 'g'))
        order by lower(regexp_replace(trim(alias), '[[:space:]]+', ' ', 'g'))) into v_aliases;
      if exists (select 1 from unnest(v_aliases) as alias where alias is null or length(alias) not between 1 and 120) then
        raise exception 'Enter between 1 and 120 characters per alias';
      end if;
      if exists (
        select 1 from unnest(v_aliases) as alias
        cross join lateral (select lower(regexp_replace(trim(alias), '[[:space:]]+', ' ', 'g')) as key) candidate
        join public.ingredients i on i.kitchen_id=p_kitchen and i.id<>v_id
        where i.name_key=candidate.key or exists (
          select 1 from unnest(i.aliases) as existing where lower(regexp_replace(trim(existing), '[[:space:]]+', ' ', 'g'))=candidate.key
        )
      ) then raise exception 'An alias already identifies another ingredient'; end if;
    end if;
    update public.ingredients set aliases=coalesce(v_aliases,aliases),
      grams_per_cup=case when p_data ? 'grams_per_cup' then (p_data->>'grams_per_cup')::numeric else grams_per_cup end,
      low_quantity=(p_data->>'low_quantity')::numeric,low_unit=v_unit,
      restrictions=array(select jsonb_array_elements_text(p_data->'restrictions')) where kitchen_id=p_kitchen and id=v_id;
  when 'list_add' then insert into public.shopping_lists(kitchen_id,name) values(p_kitchen,trim(p_data->>'name')) returning id into v_id;
  when 'list_rename' then update public.shopping_lists set name=trim(p_data->>'name') where kitchen_id=p_kitchen and id=v_id;
  when 'list_delete' then delete from public.shopping_lists where kitchen_id=p_kitchen and id=v_id;
  when 'shopping_add' then
    v_list := (p_data->>'list_id')::uuid;
    if jsonb_typeof(p_data->'items') is distinct from 'array' or jsonb_array_length(p_data->'items') not between 1 and 100 then
      raise exception 'Add between 1 and 100 shopping items';
    end if;
    for v_entry in select value from jsonb_array_elements(p_data->'items')
    loop
      insert into public.shopping_items(kitchen_id,list_id,ingredient_id,name,category,quantity,unit)
      values(p_kitchen,v_list,(v_entry->>'ingredient_id')::uuid,trim(v_entry->>'name'),coalesce(v_entry->>'category','Other'),
        (v_entry->>'quantity')::numeric,v_entry->>'unit') returning id into v_id;
    end loop;
  when 'shopping_edit' then
    update public.shopping_items set name=trim(p_data->>'name'),category=p_data->>'category',
      quantity=(p_data->>'quantity')::numeric,unit=p_data->>'unit',
      ingredient_id=case when lower(trim(name))=lower(trim(p_data->>'name')) then ingredient_id end
    where kitchen_id=p_kitchen and id=v_id and not stocked;
  when 'shopping_check' then
    update public.shopping_items set purchased=(p_data->>'purchased')::boolean where kitchen_id=p_kitchen and id=v_id and not stocked;
  when 'shopping_delete' then delete from public.shopping_items where kitchen_id=p_kitchen and id=v_id;
  else raise exception 'Unknown kitchen operation';
  end case;
  if not found then raise exception 'This item is unavailable or protected'; end if;
  return v_id;
end $$;

create function kitchen_private.deduct_package_contents(
  p_batch public.inventory_batches, p_amount numeric, p_unit text
) returns public.inventory_batches
language plpgsql set search_path = '' as $$
declare v_total numeric;
begin
  if p_batch.mode <> 'count' or p_batch.net_quantity is null or p_batch.net_unit is distinct from p_unit then
    raise exception 'Batch contents use a different unit. Check the amount per package.';
  end if;
  if p_amount is null or p_amount <= 0 or round(p_amount,8) <> p_amount then
    raise exception 'Insufficient or invalid quantity';
  end if;
  v_total := p_batch.quantity * p_batch.net_quantity - p_batch.contents_used - p_amount;
  if v_total < 0 then raise exception 'Not enough contents remaining'; end if;
  p_batch.quantity := div(v_total,p_batch.net_quantity) + case when mod(v_total,p_batch.net_quantity)>0 then 1 else 0 end;
  p_batch.contents_used := p_batch.quantity * p_batch.net_quantity - v_total;
  return p_batch;
end $$;
revoke execute on function kitchen_private.deduct_package_contents(public.inventory_batches,numeric,text)
  from public, anon, authenticated;

create or replace function kitchen_private.inventory_operation(p_kitchen uuid,p_key uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tx public.inventory_transactions; v_target public.inventory_transactions; v_line public.inventory_transaction_lines;
  v_batch public.inventory_batches; v_before public.inventory_batches; v_restore public.inventory_batches;
  v_data jsonb; v_entry jsonb; v_remaining numeric; v_amount numeric; v_event uuid; v_recipe uuid;
  v_batch_id uuid; v_shop uuid; v_shop_row public.shopping_items; v_name text; v_item_name text;
  v_prepared integer; v_eaten integer; v_contents_used numeric; v_content_unit text; v_result jsonb := '{}'; v_seen uuid[] := '{}';
begin
  if not kitchen_private.is_member(p_kitchen) then raise exception 'Kitchen unavailable' using errcode='42501'; end if;
  if p_key is null or jsonb_typeof(p_data) is distinct from 'object' or pg_column_size(p_data) > 250000 then
    raise exception 'Invalid request';
  end if;
  -- Serialize commands for a personal kitchen, including retries and reversals.
  perform 1 from public.kitchens where id=p_kitchen for update;
  select * into v_tx from public.inventory_transactions where kitchen_id=p_kitchen and request_key=p_key;
  if found then
    if v_tx.action is distinct from p_action or v_tx.request is distinct from p_data then raise exception 'Request key already used'; end if;
    return v_tx.result;
  end if;
  insert into public.inventory_transactions(kitchen_id,user_id,request_key,action,request)
  values(p_kitchen,auth.uid(),p_key,p_action,p_data) returning * into v_tx;

  case p_action
  when 'add', 'stock_shopping' then
    v_data := p_data;
    if p_action='stock_shopping' then
      select * into v_shop_row from public.shopping_items
      where kitchen_id=p_kitchen and id=(p_data->>'shopping_item_id')::uuid and purchased and not stocked;
      if not found then raise exception 'Only purchased items can be stocked once'; end if;
      v_data := v_data || jsonb_build_object('ingredient_id',v_shop_row.ingredient_id);
      update public.shopping_items set stocked=true where kitchen_id=p_kitchen and id=v_shop_row.id;
    end if;
    v_batch_id := kitchen_private.add_batch(p_kitchen,v_tx.id,v_data);
    v_result := jsonb_build_object('batch_id',v_batch_id,'shopping_item_id',v_shop_row.id);

  when 'edit', 'adjust', 'move', 'open', 'freeze', 'thaw', 'consume', 'discard' then
    select * into v_before from public.inventory_batches where kitchen_id=p_kitchen and id=(p_data->>'id')::uuid and not archived;
    if not found then raise exception 'Inventory batch unavailable'; end if;
    if v_before.revision is distinct from (p_data->>'revision')::bigint then raise exception 'Inventory changed. Refresh and try again.'; end if;
    v_batch := v_before;
    case p_action
    when 'edit' then
      -- Identity and quantity units of an existing batch are stable for its audit history.
      v_batch.quantity := (p_data->>'quantity')::numeric;
      if p_data->>'set_package_size' = 'true' and v_batch.mode = 'count' and v_batch.contents_used = 0 then
        v_batch.net_quantity := (p_data->>'net_quantity')::numeric;
        v_batch.net_unit := p_data->>'net_unit';
      end if;
      v_batch.location_id := (p_data->>'location_id')::uuid;
      v_batch.purchased_on := (p_data->>'purchased_on')::date;
      v_batch.printed_on := (p_data->>'printed_on')::date;
      v_batch.printed_type := case when v_batch.printed_on is not null then p_data->>'printed_type' end;
      v_batch.estimated_on := (p_data->>'estimated_on')::date;
      v_batch.opened_on := (p_data->>'opened_on')::date;
      v_batch.frozen_on := (p_data->>'frozen_on')::date;
      v_batch.thawed_on := (p_data->>'thawed_on')::date;
      if v_batch.frozen_on is distinct from v_before.frozen_on or v_batch.thawed_on is distinct from v_before.thawed_on then
        v_batch.is_frozen := v_batch.frozen_on is not null and (v_batch.thawed_on is null or v_batch.thawed_on < v_batch.frozen_on);
      end if;
      v_batch.price := (p_data->>'price')::numeric;
      v_batch.notes := p_data->>'notes';
    when 'adjust' then v_batch.quantity := (p_data->>'quantity')::numeric;
    when 'move' then v_batch.location_id := (p_data->>'location_id')::uuid;
    when 'open' then v_batch.opened_on := coalesce((p_data->>'date')::date,current_date);
    when 'freeze' then
      v_batch.frozen_on := coalesce((p_data->>'date')::date,current_date);
      v_batch.is_frozen := true;
      select id into v_batch.location_id from public.locations where kitchen_id=p_kitchen and is_default and name='Freezer';
    when 'thaw' then
      v_batch.thawed_on := coalesce((p_data->>'date')::date,current_date);
      v_batch.is_frozen := false;
      v_batch.location_id := (p_data->>'location_id')::uuid;
    when 'consume' then
      v_amount := (p_data->>'amount')::numeric;
      if v_amount is null or v_amount <= 0 or round(v_amount,8) <> v_amount then
        raise exception 'Insufficient or invalid quantity';
      end if;
      if p_data ? 'content_unit' then
        v_batch := kitchen_private.deduct_package_contents(v_batch,v_amount,p_data->>'content_unit');
      else
        if v_amount > v_batch.quantity then raise exception 'Insufficient or invalid quantity'; end if;
        v_batch.quantity := v_batch.quantity-v_amount;
        v_batch.contents_used := 0;
      end if;
    when 'discard' then
      v_batch.archived := true;
      v_batch.quantity := 0;
    end case;
    update public.inventory_batches set quantity=v_batch.quantity, location_id=v_batch.location_id,
      contents_used=case when v_batch.quantity=0 then 0 else v_batch.contents_used end,
      net_quantity=v_batch.net_quantity,net_unit=v_batch.net_unit,
      purchased_on=v_batch.purchased_on,printed_on=v_batch.printed_on,printed_type=v_batch.printed_type,
      estimated_on=v_batch.estimated_on,opened_on=v_batch.opened_on,frozen_on=v_batch.frozen_on,thawed_on=v_batch.thawed_on,
      is_frozen=v_batch.is_frozen,price=v_batch.price,notes=v_batch.notes,archived=v_batch.archived,revision=revision+1
    where kitchen_id=p_kitchen and id=v_batch.id returning * into v_batch;
    perform kitchen_private.log_batch(p_kitchen,v_tx.id,to_jsonb(v_before),v_batch);
    v_result := jsonb_build_object('batch_id',v_batch.id);

  when 'cook', 'consume_ingredients' then
    if jsonb_typeof(p_data->'deductions') is distinct from 'array' or jsonb_array_length(p_data->'deductions') > 250
      or (jsonb_array_length(p_data->'deductions')=0
        and (p_action<>'cook' or p_data->'allow_partial' is distinct from 'true'::jsonb)) then
      raise exception 'Review at least one inventory deduction';
    end if;
    if p_action='cook' then
      v_recipe := (p_data->>'recipe_id')::uuid;
      if v_recipe is not null and not exists(select 1 from public.recipes where kitchen_id=p_kitchen and id=v_recipe) then
        raise exception 'Recipe unavailable';
      end if;
      if p_data->'save_recipe' is not null and p_data->'save_recipe' <> 'null'::jsonb then
        if v_recipe is not null then raise exception 'This meal already has a recipe'; end if;
        v_recipe := kitchen_private.save_recipe(p_kitchen,p_data->'save_recipe');
      end if;
      v_name := trim(p_data->>'name');
      insert into public.cooking_events(kitchen_id,transaction_id,recipe_id,name,servings,notes)
      values(p_kitchen,v_tx.id,v_recipe,v_name,(p_data->>'servings')::integer,coalesce(p_data->>'notes',''))
      returning id into v_event;
    end if;
    for v_entry in select value from jsonb_array_elements(p_data->'deductions')
    loop
      v_batch_id := (v_entry->>'id')::uuid;
      if v_batch_id=any(v_seen) then raise exception 'Repeated batch in cooking request'; end if;
      v_seen := array_append(v_seen,v_batch_id);
      select * into v_before from public.inventory_batches
      where kitchen_id=p_kitchen and id=v_batch_id and not archived and quantity>0;
      if not found then raise exception 'Inventory batch unavailable'; end if;
      if v_before.revision is distinct from (v_entry->>'revision')::bigint then raise exception 'Inventory changed. Review the deductions again.'; end if;
      v_contents_used := 0;
      v_content_unit := v_entry->>'content_unit';
      if v_entry ? 'content_unit' then
        v_amount := (v_entry->>'amount')::numeric;
        v_batch := kitchen_private.deduct_package_contents(v_before,v_amount,v_content_unit);
        v_remaining := v_batch.quantity;
        v_contents_used := v_batch.contents_used;
      elsif v_before.mode='approximate' then
        v_remaining := (v_entry->>'remaining')::numeric;
        if v_remaining is null or v_remaining > v_before.quantity then raise exception 'Confirm the remaining approximate level'; end if;
        v_amount := null;
      else
        v_amount := (v_entry->>'amount')::numeric;
        if v_amount is null or v_amount <= 0 or v_amount > v_before.quantity or round(v_amount,8) <> v_amount then
          raise exception 'Insufficient or invalid quantity';
        end if;
        v_remaining := v_before.quantity-v_amount;
      end if;
      update public.inventory_batches set quantity=v_remaining,contents_used=v_contents_used,revision=revision+1
      where kitchen_id=p_kitchen and id=v_batch_id returning * into v_batch;
      if v_event is not null then
        select name into strict v_item_name from public.ingredients where kitchen_id=p_kitchen and id=v_before.ingredient_id;
        insert into public.cooking_event_ingredients(kitchen_id,event_id,ingredient_id,batch_id,name,quantity,unit,approximate_before,approximate_after)
        values(p_kitchen,v_event,v_before.ingredient_id,v_batch_id,v_item_name,v_amount,coalesce(v_content_unit,v_before.unit),
          case when v_before.mode='approximate' then v_before.quantity end,
          case when v_before.mode='approximate' then v_remaining end);
      end if;
      perform kitchen_private.log_batch(p_kitchen,v_tx.id,to_jsonb(v_before),v_batch);
    end loop;
    v_data := p_data->'leftovers';
    if v_event is not null and v_data is not null and v_data <> 'null'::jsonb then
      v_prepared := (v_data->>'prepared')::integer;
      v_eaten := (v_data->>'eaten')::integer;
      if v_prepared is null or v_eaten is null or v_prepared not between 1 and 1000 or v_eaten not between 0 and v_prepared then
        raise exception 'Check your prepared and eaten portions';
      end if;
      if v_prepared>v_eaten then
        v_batch_id := kitchen_private.add_batch(p_kitchen,v_tx.id,jsonb_build_object(
          'name',left(v_name,107)||' (leftovers)','category','Prepared food','mode','count','unit','portion',
          'quantity',v_prepared-v_eaten,'purchased_on',v_data->>'stored_on','location_id',v_data->>'location_id',
          'estimated_on',v_data->>'use_by'));
        insert into public.prepared_leftovers values(p_kitchen,v_batch_id,v_event,v_prepared,v_eaten);
      end if;
    end if;
    if v_event is not null then v_result := jsonb_build_object('event_id',v_event); end if;

  when 'undo' then
    select * into v_target from public.inventory_transactions where kitchen_id=p_kitchen and id=(p_data->>'transaction_id')::uuid
      and action <> 'undo';
    if not found or exists(select 1 from public.inventory_transactions where kitchen_id=p_kitchen and reverses_id=v_target.id) then
      raise exception 'This transaction cannot be reversed';
    end if;
    for v_line in select * from public.inventory_transaction_lines where kitchen_id=p_kitchen and transaction_id=v_target.id
    loop
      select * into v_before from public.inventory_batches where kitchen_id=p_kitchen and id=v_line.batch_id;
      if not found or (to_jsonb(v_before)-'revision') is distinct from ((jsonb_build_object('contents_used',0) || v_line.after_state)-'revision') then
        raise exception 'A batch changed since this action. Adjust it in Kitchen instead.';
      end if;
      if v_line.before_state is null then
        update public.inventory_batches set archived=true,quantity=0,contents_used=0,revision=revision+1
        where kitchen_id=p_kitchen and id=v_before.id returning * into v_batch;
      else
        v_restore := jsonb_populate_record(null::public.inventory_batches,v_line.before_state);
        update public.inventory_batches set quantity=v_restore.quantity,location_id=v_restore.location_id,
          contents_used=coalesce(v_restore.contents_used,0),net_quantity=v_restore.net_quantity,net_unit=v_restore.net_unit,
          purchased_on=v_restore.purchased_on,printed_on=v_restore.printed_on,printed_type=v_restore.printed_type,
          estimated_on=v_restore.estimated_on,opened_on=v_restore.opened_on,frozen_on=v_restore.frozen_on,thawed_on=v_restore.thawed_on,
          is_frozen=v_restore.is_frozen,price=v_restore.price,notes=v_restore.notes,archived=v_restore.archived,revision=revision+1
        where kitchen_id=p_kitchen and id=v_before.id returning * into v_batch;
      end if;
      perform kitchen_private.log_batch(p_kitchen,v_tx.id,to_jsonb(v_before),v_batch);
    end loop;
    if not found then raise exception 'This transaction has no inventory changes'; end if;
    v_shop := (v_target.result->>'shopping_item_id')::uuid;
    if v_shop is not null then update public.shopping_items set stocked=false where kitchen_id=p_kitchen and id=v_shop; end if;
    update public.cooking_events set reversed_at=now() where kitchen_id=p_kitchen and transaction_id=v_target.id;
    update public.inventory_transactions set reverses_id=v_target.id where id=v_tx.id;

  else raise exception 'Unknown inventory operation';
  end case;
  v_result := v_result || jsonb_build_object('transaction_id',v_tx.id);
  update public.inventory_transactions set result=v_result where id=v_tx.id;
  return v_result;
end $$;
