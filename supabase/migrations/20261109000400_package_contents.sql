-- Keep the package count whole and track the amount used from the first package.
alter table public.inventory_batches
  add column contents_used numeric(20,8) not null default 0
  check (contents_used = 0 or (
    mode = 'count' and quantity > 0 and net_quantity is not null
    and contents_used > 0 and contents_used < net_quantity
  ));

create or replace function kitchen_private.inventory_operation(p_kitchen uuid,p_key uuid,p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_tx public.inventory_transactions; v_target public.inventory_transactions; v_line public.inventory_transaction_lines;
  v_batch public.inventory_batches; v_before public.inventory_batches; v_restore public.inventory_batches;
  v_data jsonb; v_entry jsonb; v_remaining numeric; v_amount numeric; v_total numeric; v_event uuid; v_recipe uuid;
  v_batch_id uuid; v_shop uuid; v_shop_row public.shopping_items; v_name text; v_item_name text;
  v_prepared integer; v_eaten integer; v_result jsonb := '{}'; v_seen uuid[] := '{}';
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
        if v_batch.mode <> 'count' or v_batch.net_quantity is null
          or v_batch.net_unit is distinct from p_data->>'content_unit' then
          raise exception 'Set the amount per package before consuming its contents';
        end if;
        v_total := v_batch.quantity * v_batch.net_quantity - v_batch.contents_used - v_amount;
        if v_total < 0 then raise exception 'Not enough contents remaining'; end if;
        v_batch.quantity := div(v_total, v_batch.net_quantity) + case when mod(v_total, v_batch.net_quantity) > 0 then 1 else 0 end;
        v_batch.contents_used := v_batch.quantity * v_batch.net_quantity - v_total;
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
    if jsonb_typeof(p_data->'deductions') is distinct from 'array' or jsonb_array_length(p_data->'deductions') not between 1 and 250 then
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
      if v_before.mode='approximate' then
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
      update public.inventory_batches set quantity=v_remaining,contents_used=0,revision=revision+1
      where kitchen_id=p_kitchen and id=v_batch_id returning * into v_batch;
      if v_event is not null then
        select name into strict v_item_name from public.ingredients where kitchen_id=p_kitchen and id=v_before.ingredient_id;
        insert into public.cooking_event_ingredients(kitchen_id,event_id,ingredient_id,batch_id,name,quantity,unit,approximate_before,approximate_after)
        values(p_kitchen,v_event,v_before.ingredient_id,v_batch_id,v_item_name,v_amount,v_before.unit,
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
