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
