import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}
function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: cors })
}
const day = 86_400_000

function serverKey() {
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}')
    const secret = Object.values(keys).find((value): value is string => typeof value === 'string' && value.startsWith('sb_secret_'))
    if (secret) return secret
  } catch {
    // Local and older projects can provide the legacy service-role key.
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors })
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405)
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/i)?.[1]
  if (!token) return json({ error: 'Sign in first.' }, 401)

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = serverKey()
  const contact = Deno.env.get('OFF_CONTACT_EMAIL')
  if (!url || !serviceKey || !contact || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return json({ error: 'Product lookup is not configured.' }, 503)
  }

  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: { user }, error: authError } = await client.auth.getUser(token)
  if (authError || !user) return json({ error: 'Sign in first.' }, 401)
  const { data: memberships, error: membershipError } = await client.from('kitchen_members').select('kitchen_id').eq('user_id', user.id).limit(1)
  if (membershipError) return json({ error: 'Could not check kitchen access.' }, 503)
  if (!memberships.length) return json({ error: 'Initialize your kitchen first.' }, 403)

  let legacyProduct: unknown
  try {
    const body = await request.json()
    const barcode = body?.barcode
    if (typeof barcode !== 'string' || !/^(?:\d{8}|\d{12,14})$/.test(barcode)) {
      return json({ error: 'Enter a valid grocery barcode.' }, 400)
    }
    const cached = await client.from('off_product_cache').select('product').eq('barcode', barcode)
      .gt('expires_at', new Date().toISOString()).maybeSingle()
    if (cached.error) return json({ error: 'The product cache is unavailable.' }, 503)
    if (cached.data) {
      const product = cached.data.product
      if (!product || Array.isArray(product.category_tags)) return json({ product })
      legacyProduct = product
    }
    const budget = await client.rpc('reserve_off_lookup')
    if (budget.error || !budget.data) return legacyProduct ? json({ product: legacyProduct })
      : json({ error: 'Lookup is busy. Enter details manually or try again shortly.' }, 429)

    const staging = Deno.env.get('OFF_USE_STAGING') === 'true'
    const host = staging ? 'https://world.openfoodfacts.net' : 'https://world.openfoodfacts.org'
    const lookup = new URL(`/api/v3.6/product/${barcode}.json`, host)
    lookup.searchParams.set('fields', 'product_name,product_name_en,brands,quantity,product_quantity,product_quantity_unit,categories_tags,packagings')
    const headers = new Headers({ 'User-Agent': `KitchenOS/1.0 (${contact})`, Accept: 'application/json' })
    if (staging) headers.set('Authorization', 'Basic ' + btoa('off:off'))
    const response = await fetch(lookup, { headers, signal: AbortSignal.timeout(6000) })
    if (!response.ok && response.status !== 404) return legacyProduct ? json({ product: legacyProduct })
      : json({ error: 'Open Food Facts is unavailable.' }, 503)
    let product = null
    if (response.ok) {
      const result = await response.json()
      const food = result.product
      const text = (value: unknown, length: number) => typeof value === 'string' ? value.trim().slice(0, length) : ''
      const name = text(food?.product_name_en, 120) || text(food?.product_name, 120)
      if (name) product = {
        name, brand: text(food.brands, 120), package_label: text(food.quantity, 120), source: 'open_food_facts',
        product_quantity: typeof food.product_quantity === 'number' ? food.product_quantity : text(food.product_quantity, 32),
        product_quantity_unit: text(food.product_quantity_unit, 16),
        category_tags: Array.isArray(food.categories_tags)
          ? food.categories_tags.filter((tag: unknown): tag is string => typeof tag === 'string' && tag.length <= 120)
          : [],
        package_shapes: Array.isArray(food.packagings)
          ? food.packagings.map((entry: { shape?: { id?: unknown } | string } | null) =>
            text(typeof entry?.shape === 'string' ? entry.shape : entry?.shape?.id, 80)).filter(Boolean)
          : [],
      }
    }
    await client.from('off_product_cache').upsert({
      barcode, product, expires_at: new Date(Date.now() + (product ? 30 : 1) * day).toISOString(),
    })
    return json({ product })
  } catch {
    return legacyProduct ? json({ product: legacyProduct }) : json({ error: 'Product lookup is temporarily unavailable.' }, 503)
  }
})
