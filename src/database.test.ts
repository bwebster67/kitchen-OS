import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const owner = '00000000-0000-4000-8000-000000000001'
const stranger = '00000000-0000-4000-8000-000000000002'
let db: PGlite
let kitchen: string
let fridge: string
let freezer: string
let beef: string
let secondBatch: string
let legacyKitchen: string
let legacyRows: unknown[]

async function actor(user: string, role = 'authenticated') {
  await db.exec(`reset role; set role ${role};`)
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
}

async function rpc(action: string, data: Record<string, unknown>, key = crypto.randomUUID(), target = kitchen) {
  const result = await db.query<{ result: Record<string, string> }>(
    'select public.inventory_operation($1::uuid,$2::uuid,$3,$4::jsonb) as result',
    [target, key, action, JSON.stringify(data)],
  )
  return result.rows[0].result
}

async function batches() {
  return (await db.query<{ id: string; quantity: string; location_id: string; revision: number; archived: boolean; frozen_on: string | null }>(
    'select id,quantity,location_id,revision,archived,frozen_on::text from public.inventory_batches',
  )).rows
}

function add(location: string, quantity: number, other: Record<string, unknown> = {}) {
  return rpc('add', {
    name: 'Ground beef', category: 'Meat & seafood', mode: 'exact', unit: 'lb',
    quantity, location_id: location, purchased_on: '2026-11-08', ...other,
  })
}

async function manage(action: string, payload: Record<string, unknown>, target = kitchen) {
  return (await db.query<{ id: string }>('select public.manage_kitchen($1::uuid,$2,$3::jsonb) as id',
    [target, action, JSON.stringify(payload)])).rows[0].id
}

async function legacySnapshot() {
  return (await db.query(`select i.id as ingredient_id, i.name as ingredient_name, p.id as product_id, p.barcode,
    b.id as batch_id, b.quantity, b.contents_used, r.id as recipe_id, l.quantity as recipe_amount, l.unit
    from public.ingredients i join public.products p on p.ingredient_id=i.id
    join public.inventory_batches b on b.ingredient_id=i.id and b.product_id=p.id
    join public.recipe_ingredients l on l.ingredient_id=i.id join public.recipes r on r.id=l.recipe_id
    where i.kitchen_id=$1`, [legacyKitchen])).rows
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
    'select nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
    grant usage on schema auth to anon, authenticated, service_role;
    insert into auth.users values ('${owner}'),('${stranger}');
  `)
  const migrations = ['20261109000100_schema.sql', '20261109000200_operations.sql', '20261109000300_product_cache.sql', '20261109000400_package_contents.sql']
  for (const file of migrations) await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'))
  await actor(stranger)
  legacyKitchen = (await db.query<{ id: string }>('select public.initialize_kitchen() as id')).rows[0].id
  const legacyLocation = (await db.query<{ id: string }>("select id from public.locations where name='Pantry'")).rows[0].id
  const legacyBatch = await rpc('add', { name: 'Legacy Brand Rice', barcode: '4006381333931', brand: 'Legacy Brand',
    mode: 'count', unit: 'package', net_quantity: 400, net_unit: 'g', quantity: 2, purchased_on: '2026-11-01', location_id: legacyLocation },
  crypto.randomUUID(), legacyKitchen)
  await rpc('consume', { id: legacyBatch.batch_id, revision: 0, amount: 100, content_unit: 'g' }, crypto.randomUUID(), legacyKitchen)
  await manage('recipe_save', { name: 'Legacy rice recipe', servings: 2, ingredients: [{ name: 'Legacy Brand Rice', quantity: 200, unit: 'g' }] }, legacyKitchen)
  legacyRows = await legacySnapshot()
  await db.exec('reset role')
  await db.exec(await readFile(new URL('../supabase/migrations/20261110000100_canonical_ingredients.sql', import.meta.url), 'utf8'))
  await actor(owner)
  kitchen = (await db.query<{ id: string }>('select public.initialize_kitchen() as id')).rows[0].id
  const locations = (await db.query<{ id: string; name: string }>('select id,name from public.locations')).rows
  fridge = locations.find((item) => item.name === 'Refrigerator')!.id
  freezer = locations.find((item) => item.name === 'Freezer')!.id
}, 30_000)

afterAll(async () => { await db?.close() })

describe('PostgreSQL migrations and inventory RPC', () => {
  it('initializes one member kitchen with five locations and is safe to repeat', async () => {
    expect((await db.query<{ id: string }>('select public.initialize_kitchen() as id')).rows[0].id).toBe(kitchen)
    expect((await db.query('select * from public.locations')).rows).toHaveLength(5)
    expect((await db.query('select * from public.shopping_lists')).rows).toHaveLength(1)
  })

  it('adds 2 lb and preserves a second batch', async () => {
    beef = (await add(fridge, 2)).batch_id
    secondBatch = (await add(freezer, .75, { frozen_on: '2026-11-08' })).batch_id
    expect(await batches()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: beef, quantity: '2.00000000', location_id: fridge }),
      expect.objectContaining({ id: secondBatch, quantity: '0.75000000', location_id: freezer }),
    ]))
    expect((await db.query('select * from public.ingredients')).rows).toHaveLength(1)
  })

  it('moves a batch without changing its quantity and reverses the move', async () => {
    const move = await rpc('move', { id: beef, revision: 0, location_id: freezer })
    expect((await batches()).find((row) => row.id === beef)).toMatchObject({ quantity: '2.00000000', location_id: freezer })
    await rpc('undo', { transaction_id: move.transaction_id })
    expect((await batches()).find((row) => row.id === beef)).toMatchObject({ quantity: '2.00000000', location_id: fridge, revision: 2 })
    await expect(rpc('undo', { transaction_id: move.transaction_id })).rejects.toThrow(/cannot be reversed/i)
  })

  it('rejects negative quantities, fractional package counts and incompatible units', async () => {
    await expect(add(fridge, -2)).rejects.toThrow(/positive quantity/i)
    await expect(add(fridge, .5, { mode: 'count', unit: 'can' })).rejects.toThrow(/check constraint/i)
    await expect(add(fridge, 1, { mode: 'approximate', unit: 'g' })).rejects.toThrow(/check constraint/i)
    expect(await batches()).toHaveLength(2)
  })

  it('rolls back a cooking request if a later deduction is invalid', async () => {
    const deductions = [{ id: beef, revision: 2, amount: .5 }, { id: secondBatch, revision: 0, amount: 1 }]
    await expect(rpc('cook', { name: 'Test meal', servings: 4, deductions })).rejects.toThrow(/insufficient/i)
    expect((await batches()).find((row) => row.id === beef)?.quantity).toBe('2.00000000')
    expect((await db.query('select * from public.cooking_events')).rows).toHaveLength(0)
  })

  it('cooks once, records the actual 0.5 lb used, and creates three portions', async () => {
    const key = crypto.randomUUID()
    const payload = {
      name: 'Beef curry', servings: 4, deductions: [{ id: beef, revision: 2, amount: .5 }],
      leftovers: { prepared: 4, eaten: 1, location_id: fridge, stored_on: '2026-11-09' },
    }
    const result = await rpc('cook', payload, key)
    expect(await rpc('cook', payload, key)).toEqual(result)
    await expect(rpc('cook', { ...payload, name: 'Different request' }, key)).rejects.toThrow(/already used/)
    expect((await batches()).find((row) => row.id === beef)?.quantity).toBe('1.50000000')
    const event = await db.query('select name,quantity,unit from public.cooking_event_ingredients')
    expect(event.rows).toEqual([{ name: 'Ground beef', quantity: '0.50000000', unit: 'lb' }])
    const leftovers = await db.query<{ batch_id: string; portions_prepared: number; portions_eaten: number }>('select * from public.prepared_leftovers')
    expect(leftovers.rows[0]).toMatchObject({ portions_prepared: 4, portions_eaten: 1 })
    const batch = leftovers.rows[0].batch_id
    expect((await batches()).find((row) => row.id === batch)?.quantity).toBe('3.00000000')
    await rpc('consume', { id: batch, revision: 0, amount: 1 })
    expect((await batches()).find((row) => row.id === batch)?.quantity).toBe('2.00000000')
    expect((await batches()).find((row) => row.id === beef)?.quantity).toBe('1.50000000')
    await expect(rpc('undo', { transaction_id: result.transaction_id })).rejects.toThrow(/changed since/i)
    expect((await batches()).find((row) => row.id === beef)?.quantity).toBe('1.50000000')
  })

  it('stores an approximate level separately from exact usage', async () => {
    const { batch_id } = await add(fridge, 1, { name: 'Soy sauce', mode: 'approximate', unit: 'level' })
    await expect(rpc('cook', { name: 'Stir fry', servings: 1, deductions: [{ id: batch_id, revision: 0, amount: .5 }] })).rejects.toThrow(/remaining approximate/i)
    const { event_id } = await rpc('cook', { name: 'Stir fry', servings: 1, deductions: [{ id: batch_id, revision: 0, remaining: .5 }] })
    const result = await db.query('select quantity,approximate_before,approximate_after from public.cooking_event_ingredients where event_id=$1', [event_id])
    expect(result.rows[0]).toEqual({ quantity: null, approximate_before: '1.00000000', approximate_after: '0.50000000' })
  })

  it('saves normalized recipes and stocks a purchased item only once', async () => {
    const manage = (action: string, payload: Record<string, unknown>) => db.query<{ id: string }>(
      'select public.manage_kitchen($1::uuid,$2,$3::jsonb) as id', [kitchen, action, JSON.stringify(payload)],
    )
    const recipe = await manage('recipe_save', { name: 'Tacos', servings: 2, ingredients: [{ name: 'Ground  beef', quantity: .5, unit: 'lb' }] })
    expect(recipe.rows[0].id).toBeTruthy()
    const list = (await manage('list_add', { name: 'Market' })).rows[0].id
    const item = (await manage('shopping_add', { list_id: list, items: [{ name: 'Eggs', quantity: 6, unit: 'count' }] })).rows[0].id
    const payload = { shopping_item_id: item, name: 'Eggs', mode: 'count', quantity: 6, unit: 'count', location_id: fridge, purchased_on: '2026-11-09' }
    await expect(rpc('stock_shopping', payload)).rejects.toThrow(/purchased/)
    await manage('shopping_check', { id: item, purchased: true })
    const stocked = await rpc('stock_shopping', payload)
    await expect(rpc('stock_shopping', payload)).rejects.toThrow(/once/)
    await rpc('undo', { transaction_id: stocked.transaction_id })
    expect((await db.query('select stocked,purchased from public.shopping_items where id=$1', [item])).rows[0]).toEqual({ stocked: false, purchased: true })
  })

  it('keeps entered dates through freezing and thawing, and supports atomic general consumption', async () => {
    const { batch_id } = await add(fridge, 1, { name: 'Bread', printed_on: '2026-11-11', printed_type: 'best_before' })
    await rpc('open', { id: batch_id, revision: 0, date: '2026-11-09' })
    await rpc('freeze', { id: batch_id, revision: 1, date: '2026-11-10' })
    await rpc('thaw', { id: batch_id, revision: 2, date: '2026-11-15', location_id: fridge })
    const records = await db.query('select location_id,printed_on::text,opened_on::text,frozen_on::text,thawed_on::text from public.inventory_batches where id=$1', [batch_id])
    expect(records.rows[0]).toEqual({ location_id: fridge, printed_on: '2026-11-11', opened_on: '2026-11-09', frozen_on: '2026-11-10', thawed_on: '2026-11-15' })
    await rpc('freeze', { id: batch_id, revision: 3, date: '2026-11-15' })
    expect((await db.query('select is_frozen from public.inventory_batches where id=$1', [batch_id])).rows[0]).toEqual({ is_frozen: true })
    const result = await rpc('consume_ingredients', { deductions: [{ id: batch_id, revision: 4, amount: .25 }] })
    expect((await batches()).find((row) => row.id === batch_id)?.quantity).toBe('0.75000000')
    expect(result.event_id).toBeUndefined()
    await rpc('undo', { transaction_id: result.transaction_id })
    expect((await batches()).find((row) => row.id === batch_id)?.quantity).toBe('1.00000000')
  })

  it('uses measured contents, retains the open carton, and reverses consumption', async () => {
    const milk = await add(fridge, 1, { name: 'Milk', category: 'Dairy & eggs', mode: 'count', unit: 'bottle', net_quantity: 52, net_unit: 'fl oz' })
    const read = async () => (await db.query('select quantity::float8 as count, (quantity * net_quantity - contents_used)::float8 as remaining, revision from public.inventory_batches where id=$1', [milk.batch_id])).rows[0]
    const payload = { id: milk.batch_id, revision: 0, amount: 8, content_unit: 'fl oz' }
    const key = crypto.randomUUID()
    const used = await rpc('consume', payload, key)
    expect(await rpc('consume', payload, key)).toEqual(used)
    expect(await read()).toMatchObject({ count: 1, remaining: 44 })
    await expect(rpc('consume', { ...payload, revision: 1, amount: 45 })).rejects.toThrow(/not enough/i)
    const finished = await rpc('consume', { ...payload, revision: 1, amount: 44 })
    expect(await read()).toMatchObject({ count: 0, remaining: 0 })
    await rpc('undo', { transaction_id: finished.transaction_id })
    expect(await read()).toMatchObject({ count: 1, remaining: 44 })
  })

  it('preserves legacy recipe links, barcode associations, counts and used contents during migration', async () => {
    await actor(stranger)
    try {
      expect(legacyRows).toHaveLength(1)
      expect(await legacySnapshot()).toEqual(legacyRows)
    } finally { await actor(owner) }
  })

  it('changes a barcode mapping for future additions only when explicitly confirmed', async () => {
    await actor(stranger)
    try {
      const barcode = '4006381333931'
      const lookup = async () => (await db.query<{ id: string; ingredient_id: string }>(
        'select id,ingredient_id from public.products where barcode=$1', [barcode])).rows[0]
      const location = (await db.query<{ id: string }>("select id from public.locations where name='Pantry'")).rows[0].id
      const original = await lookup()
      const payload = { name: 'New label for the legacy product', barcode, mode: 'count', unit: 'package',
        quantity: 1, net_quantity: 400, net_unit: 'g', purchased_on: '2026-11-02', location_id: location }
      const unchanged = await rpc('add', payload, crypto.randomUUID(), legacyKitchen)
      expect(await lookup()).toEqual(original)
      const relinked = await rpc('add', { ...payload, canonical_name: 'White Rice' }, crypto.randomUUID(), legacyKitchen)
      const current = await lookup()
      expect(current.id).toBe(original.id)
      expect(current.ingredient_id).not.toBe(original.ingredient_id)
      expect((await db.query('select ingredient_id from public.inventory_batches where id=$1', [unchanged.batch_id])).rows[0])
        .toEqual({ ingredient_id: original.ingredient_id })
      expect((await db.query('select ingredient_id from public.inventory_batches where id=$1', [relinked.batch_id])).rows[0])
        .toEqual({ ingredient_id: current.ingredient_id })
      expect((await db.query('select ingredient_id from public.recipe_ingredients')).rows[0])
        .toEqual({ ingredient_id: original.ingredient_id })
    } finally { await actor(owner) }
  })

  it('reuses a recipe-only ingredient across brands and atomically deducts and reverses measured contents', async () => {
    const recipe = await manage('recipe_save', { name: 'Rice', servings: 2,
      ingredients: [{ name: 'White Rice', quantity: 600, unit: 'g', preparation_notes: 'Rinse first' }] })
    const line = (await db.query<{ ingredient_id: string; preparation_notes: string }>(
      'select ingredient_id,preparation_notes from public.recipe_ingredients where recipe_id=$1', [recipe])).rows[0]
    expect(line.preparation_notes).toBe('Rinse first')
    expect((await db.query('select id from public.inventory_batches where ingredient_id=$1', [line.ingredient_id])).rows).toEqual([])
    await manage('ingredient_settings', { id: line.ingredient_id, restrictions: [], aliases: ['Plain rice', 'plain  rice'], grams_per_cup: 190 })
    expect((await db.query('select cardinality(aliases) as alias_count, grams_per_cup::float8 from public.ingredients where id=$1', [line.ingredient_id])).rows[0])
      .toEqual({ alias_count: 1, grams_per_cup: 190 })
    await expect(manage('ingredient_settings', { id: line.ingredient_id, restrictions: [], aliases: ['Ground Beef'] }))
      .rejects.toThrow(/already identifies another ingredient/i)
    await manage('recipe_save', { name: 'Alias recipe', servings: 2, ingredients: [{ name: 'plain rice', quantity: 1, unit: 'cup' }] })
    expect((await db.query('select ingredient_id from public.recipe_ingredients where ingredient_id=$1', [line.ingredient_id])).rows).toHaveLength(2)
    const first = await add(fridge, 1, { name: 'Mahatma White Rice', brand: 'Mahatma', barcode: '11111111',
      canonical_name: 'White Rice', ingredient_id: line.ingredient_id, mode: 'count', unit: 'package', net_quantity: 400, net_unit: 'g' })
    const second = await add(fridge, 1, { name: 'Great Value White Rice', brand: 'Great Value', barcode: '22222222',
      canonical_name: 'Plain rice', mode: 'count', unit: 'package', net_quantity: 500, net_unit: 'g' })
    expect((await db.query('select brand from public.products where ingredient_id=$1 order by brand', [line.ingredient_id])).rows)
      .toEqual([{ brand: 'Great Value' }, { brand: 'Mahatma' }])
    const read = async () => (await db.query(`select quantity::float8, contents_used::float8 from public.inventory_batches
      where id in ($1,$2) order by net_quantity`, [first.batch_id, second.batch_id])).rows
    const key = crypto.randomUUID()
    const payload = { name: 'Rice', recipe_id: recipe, servings: 2, deductions: [
      { id: first.batch_id, revision: 0, amount: 400, content_unit: 'g' },
      { id: second.batch_id, revision: 0, amount: 200, content_unit: 'g' },
    ] }
    await expect(rpc('cook', { ...payload, deductions: [payload.deductions[0], { ...payload.deductions[1], content_unit: 'cup' }] })).rejects.toThrow(/different unit/i)
    await expect(rpc('cook', { ...payload, deductions: [payload.deductions[0], { ...payload.deductions[1], amount: 501 }] })).rejects.toThrow(/not enough/i)
    expect(await read()).toEqual([{ quantity: 1, contents_used: 0 }, { quantity: 1, contents_used: 0 }])
    const cooked = await rpc('cook', payload, key)
    expect(await rpc('cook', payload, key)).toEqual(cooked)
    expect(await read()).toEqual([{ quantity: 0, contents_used: 0 }, { quantity: 1, contents_used: 200 }])
    expect((await db.query('select quantity::float8,unit from public.cooking_event_ingredients where event_id=$1 order by quantity', [cooked.event_id])).rows)
      .toEqual([{ quantity: 200, unit: 'g' }, { quantity: 400, unit: 'g' }])
    await rpc('undo', { transaction_id: cooked.transaction_id })
    expect(await read()).toEqual([{ quantity: 1, contents_used: 0 }, { quantity: 1, contents_used: 0 }])
  })

  it('rejects direct writes and protects another kitchen even with its exact ID', async () => {
    await expect(db.query('update public.inventory_batches set quantity=500')).rejects.toThrow(/permission denied/i)
    await actor(stranger)
    const other = (await db.query<{ id: string }>('select public.initialize_kitchen() as id')).rows[0].id
    expect(other).not.toBe(kitchen)
    expect((await db.query('select * from public.kitchens where id=$1', [kitchen])).rows).toEqual([])
    expect((await db.query('select * from public.inventory_batches where kitchen_id=$1', [kitchen])).rows).toEqual([])
    await expect(rpc('discard', { id: beef, revision: 3 })).rejects.toThrow(/kitchen unavailable/i)
    await expect(rpc('discard', { id: beef, revision: 3 }, crypto.randomUUID(), other)).rejects.toThrow(/batch unavailable/i)
    await actor('', 'anon')
    await expect(db.query('select * from public.kitchens')).rejects.toThrow(/permission denied/i)
    await expect(db.query('select public.initialize_kitchen()')).rejects.toThrow(/permission denied/i)
    await expect(rpc('discard', { id: beef, revision: 3 })).rejects.toThrow(/permission denied/i)
  })

  it('restricts the third-party lookup budget to the server role and caps it', async () => {
    await expect(db.query('select public.reserve_off_lookup()')).rejects.toThrow(/permission denied/i)
    await actor('', 'service_role')
    for (let i = 0; i < 12; i++) {
      expect((await db.query('select public.reserve_off_lookup() as reserved')).rows[0]).toEqual({ reserved: true })
    }
    expect((await db.query('select public.reserve_off_lookup() as reserved')).rows[0]).toEqual({ reserved: false })
  })
})
