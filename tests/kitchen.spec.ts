import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PGlite } from '@electric-sql/pglite'

const user = { id: '00000000-0000-4000-8000-000000000001', email: 'cook@example.test', app_metadata: {}, user_metadata: {}, aud: 'authenticated' }
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const fakeToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, role: user.aud, exp: Math.floor(Date.now() / 1000) + 3600 })}.dGVzdA`
const session = { access_token: fakeToken, refresh_token: 'local-test-refresh', token_type: 'bearer', expires_in: 3600, user }
const tables = new Set(['kitchens', 'locations', 'ingredients', 'products', 'inventory_batches', 'recipes',
  'recipe_ingredients', 'planned_meals', 'cooking_events', 'cooking_event_ingredients', 'prepared_leftovers',
  'recipe_feedback', 'shopping_lists', 'shopping_items', 'taste_preferences', 'inventory_transactions',
  'inventory_transaction_lines', 'kitchen_members', 'pending_commands'])
const orderColumns = new Set(['id', 'batch_id', 'event_id', 'user_id'])

async function setup(page: Page) {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as 'select ''${user.id}''::uuid';
    grant usage on schema auth to authenticated;
    insert into auth.users values ('${user.id}');
  `)
  for (const file of ['20261109000100_schema.sql', '20261109000200_operations.sql', '20261109000300_product_cache.sql', '20261109000400_package_contents.sql']) {
    await db.exec(await readFile(new URL(`../supabase/migrations/${file}`, import.meta.url), 'utf8'))
  }
  await db.exec('set role authenticated')
  let lookups = 0
  let adds = 0
  let signedIn = false
  await page.route(/\/(?:auth|rest|functions)\/v1\//, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const respond = (json: unknown, status = 200) => route.fulfill({ json, status })
    try {
      if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
        signedIn = true
        return respond(session)
      }
      if (path === '/auth/v1/logout') {
        signedIn = false
        return route.fulfill({ status: 204 })
      }
      if (path === '/auth/v1/user') return signedIn ? respond(user) : respond({ message: 'Not signed in' }, 401)
      if (!signedIn) return respond({ message: 'Not signed in' }, 401)
      if (path === '/functions/v1/product-lookup') {
        lookups += 1
        const { barcode } = request.postDataJSON()
        if (barcode === '99999999') return respond({ error: 'Unavailable' }, 503)
        if (barcode === '4006381333931') return respond({ product: {
          name: 'Ground beef', source: 'open_food_facts', product_quantity: 450, product_quantity_unit: 'g',
          category_tags: ['en:meats'],
        } })
        return respond({ product: barcode === '0036000291452' ? {
          name: 'Canned tomatoes', brand: 'Test Pantry', source: 'open_food_facts',
          product_quantity: '400', product_quantity_unit: 'g', category_tags: ['en:canned-vegetables'],
          package_shapes: ['en:can'],
        } : null })
      }
      if (path === '/rest/v1/rpc/initialize_kitchen') {
        const result = await db.query<{ value: string }>('select public.initialize_kitchen() as value')
        return respond(result.rows[0].value)
      }
      if (path === '/rest/v1/rpc/inventory_operation') {
        const { p_kitchen, p_key, p_action, p_data } = request.postDataJSON()
        if (p_action === 'add') adds += 1
        const result = await db.query<{ value: unknown }>('select public.inventory_operation($1::uuid,$2::uuid,$3,$4::jsonb) as value',
          [p_kitchen, p_key, p_action, JSON.stringify(p_data)])
        return respond(result.rows[0].value)
      }
      if (path === '/rest/v1/rpc/manage_kitchen') {
        const { p_kitchen, p_action, p_data } = request.postDataJSON()
        const result = await db.query<{ value: string }>('select public.manage_kitchen($1::uuid,$2,$3::jsonb) as value', [p_kitchen, p_action, JSON.stringify(p_data)])
        return respond(result.rows[0].value)
      }
      const table = path.split('/').at(-1) ?? ''
      if (table === 'recipe_feedback' && request.method() === 'POST') {
        const row = request.postDataJSON()
        await db.query(`insert into public.recipe_feedback(kitchen_id,event_id,rating,make_again,flags,notes)
          values($1,$2,$3,$4,$5,$6) on conflict(kitchen_id,event_id)
          do update set rating=excluded.rating,make_again=excluded.make_again,flags=excluded.flags,notes=excluded.notes`,
        [row.kitchen_id, row.event_id, row.rating, row.make_again, row.flags, row.notes])
        return route.fulfill({ status: 201 })
      }
      if (tables.has(table) && request.method() === 'GET') {
        const filter = table === 'kitchens' ? 'id' : 'kitchen_id'
        const id = url.searchParams.get(filter)?.slice(3)
        const column = url.searchParams.get('order')?.split('.')[0] ?? ''
        const order = orderColumns.has(column) ? ` order by ${column}` : ''
        const result = await db.query(`select * from public.${table} where ${filter}=$1::uuid${order}`, [id])
        const numeric = ['quantity', 'price', 'net_quantity', 'contents_used', 'low_quantity', 'approximate_before', 'approximate_after']
        const data = result.rows.map((raw) => {
          const row = { ...raw } as Record<string, unknown>
          for (const key of numeric) if (typeof row[key] === 'string') row[key] = Number(row[key])
          for (const [key, value] of Object.entries(row)) {
            if (value instanceof Date && (key.endsWith('_on') || key === 'planned_for')) row[key] = value.toISOString().slice(0, 10)
          }
          return row
        })
        return respond(request.headers().accept?.includes('object+json') ? data[0] : data)
      }
      return respond({ message: `Unhandled test request ${request.method()} ${path}` }, 404)
    } catch (error) {
      return respond({ message: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  return { db, lookups: () => lookups, adds: () => adds }
}

async function signIn(page: Page) {
  await page.goto('/')
  await page.getByLabel('Email').fill(user.email)
  await page.getByLabel('Password').fill('test-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'What’s in the kitchen?' })).toBeVisible()
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
}

async function expectDateInputsToFit(page: Page) {
  const dateFields = await page.locator('form .form-grid > .field > input[type=date]:visible').evaluateAll((inputs) =>
    inputs.map((input) => {
      const control = input.getBoundingClientRect()
      const field = input.parentElement!.getBoundingClientRect()
      const grid = input.parentElement!.parentElement!.getBoundingClientRect()
      return {
        label: (input as HTMLInputElement).labels?.[0]?.textContent,
        contained: control.left >= field.left && control.right <= field.right + 1,
        spansGrid: field.width >= grid.width - 1,
        horizontalPadding: getComputedStyle(input).paddingInline,
      }
    }),
  )
  expect(dateFields.length).toBeGreaterThanOrEqual(6)
  const phone = (page.viewportSize()?.width ?? 0) <= 480
  for (const { label, contained, spansGrid, horizontalPadding } of dateFields) {
    expect(contained, `${label} fits its field`).toBe(true)
    expect(horizontalPadding, `${label} has no outer horizontal padding`).toBe('0px')
    if (phone) expect(spansGrid, `${label} has its own row on phones`).toBe(true)
  }
  await noHorizontalScroll(page)
}

const authenticated = test.extend({ serviceWorkers: 'block' })

authenticated('signs in, stocks and cooks from inventory, then eats leftovers', async ({ page }, testInfo) => {
  const app = await setup(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto('/kitchen')
    await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible()
    await signIn(page)
    await noHorizontalScroll(page)
    if (process.env.KITCHEN_TEST_SCREENSHOTS === '1') await page.screenshot({ path: testInfo.outputPath('dashboard.png'), fullPage: true })
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Kitchen' }).click()
    await expect(page.getByRole('heading', { name: 'Your shelves are empty' })).toBeVisible()
    await page.getByRole('link', { name: 'Add groceries', exact: true }).first().click()
    await page.getByText('Package, freshness and notes', { exact: true }).click()
    await expectDateInputsToFit(page)
    await page.getByLabel('Item name').fill('Ground beef')
    await page.getByLabel('Tracking mode').selectOption('exact')
    await page.getByLabel('Quantity', { exact: true }).fill('2')
    await page.getByLabel('Unit', { exact: true }).selectOption('lb')
    await page.getByLabel('Category').selectOption('Meat & seafood')
    await page.getByLabel('Storage location').selectOption({ label: 'Refrigerator' })
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Add grocery', exact: true }).click()
    await expect(page.getByText('1 grocery added this session.')).toBeVisible()

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Meals' }).click()
    await page.getByRole('link', { name: 'New recipe' }).click()
    await page.getByLabel('Recipe name').fill('Beef tacos')
    await page.getByLabel('Ingredient 1', { exact: true }).fill('Ground beef')
    await page.getByLabel('Amount', { exact: true }).fill('0.25')
    await page.getByLabel('Unit', { exact: true }).selectOption('lb')
    await page.getByRole('button', { name: 'Save recipe' }).click()
    await expect(page.getByRole('heading', { name: 'Beef tacos' })).toBeVisible()
    await page.getByLabel('Servings', { exact: true }).fill('4')
    await expect(page.getByText('0.5 lb from Refrigerator')).toBeVisible()
    await page.getByLabel('Record portions and leftovers').check()
    await expect(page.getByLabel('Portions remaining')).toHaveValue('3')
    await noHorizontalScroll(page)
    await page.getByRole('button', { name: 'Confirm cooking' }).click()
    await expect(page.getByRole('heading', { name: 'Ingredients used' })).toBeVisible()
    await expect(page.getByText('3 portions originally stored as leftovers.')).toBeVisible()
    await page.getByLabel('Rating', { exact: true }).selectOption('5')
    await page.getByLabel('Would make again').selectOption('true')
    await page.getByRole('button', { name: 'Save feedback' }).click()
    await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible()

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Kitchen' }).click()
    await expect(page.getByRole('heading', { name: 'Refrigerator · 1.5 lb' })).toBeVisible()
    await page.getByRole('button', { name: 'Eat leftovers' }).click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Refrigerator · 2 portions' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Refrigerator · 1.5 lb' })).toBeVisible()

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Shopping' }).click()
    await page.getByRole('button', { name: 'Add item', exact: true }).click()
    await page.getByLabel('Shopping item', { exact: true }).fill('Onions')
    await page.getByLabel('Quantity', { exact: true }).fill('3')
    await page.getByRole('button', { name: 'Add shopping item' }).click()
    await page.getByLabel('Mark Onions purchased').check()
    await page.getByRole('link', { name: 'Stock item' }).click()
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('3')
    await page.getByRole('button', { name: 'Add grocery', exact: true }).click()
    await expect(page.getByText('In kitchen', { exact: true })).toBeVisible()
    await noHorizontalScroll(page)

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByRole('heading', { name: 'Account and data' })).toBeVisible()
    await noHorizontalScroll(page)
    const exportReady = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export kitchen data' }).click()
    const exportFile = await exportReady
    const exported = JSON.parse(await readFile(await exportFile.path(), 'utf8'))
    expect(exported.recipe_feedback[0].rating).toBe(5)
    expect(exported.inventory_batches).toHaveLength(3)
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Account and data' })).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible()
    expect(errors).toEqual([])
  } finally { await app.db.close() }
})

function barcodePattern(left: string, right: string, evenParity = 0) {
  const odd = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
  const invert = (bits: string) => bits.replace(/[01]/g, (bit) => bit === '0' ? '1' : '0')
  const start = [...left].map((digit, index) => {
    const bits = odd[Number(digit)]
    return evenParity & (1 << (left.length - 1 - index)) ? [...invert(bits)].reverse().join('') : bits
  }).join('')
  return '101' + start + (right ? '01010' + [...right].map((digit) => invert(odd[Number(digit)])).join('') + '101' : '010101')
}

async function installTestCamera(page: Page, pattern: string, rotated = false) {
  await page.evaluate(({ pattern, rotated }) => {
    async function getUserMedia() {
      const canvas = document.createElement('canvas')
      canvas.width = rotated ? 320 : 640
      canvas.height = rotated ? 640 : 320
      const ctx = canvas.getContext('2d')!
      function draw() {
        ctx.fillStyle = 'white'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.fillStyle = 'black'
        ctx.save()
        if (rotated) ctx.setTransform(0, 1, -1, 0, 320, 0)
        for (const [index, bit] of [...pattern].entries()) {
          if (bit === '1') ctx.fillRect(82 + index * 5, 75, 5, 170)
        }
        ctx.restore()
      }
      draw()
      const stream = canvas.captureStream(15)
      const timer = setInterval(() => {
        if (stream.getTracks().every((track) => track.readyState === 'ended')) clearInterval(timer)
        else draw()
      }, 60)
      return stream
    }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } })
  }, { pattern, rotated })
}

authenticated('reviews barcodes once and handles local, unknown and failed lookups', async ({ page }) => {
  const app = await setup(page)
  try {
    await signIn(page)
    await page.getByRole('link', { name: 'Scan barcode' }).click()
    const canSimulate = await page.evaluate(() => typeof HTMLCanvasElement.prototype.captureStream === 'function')
    if (canSimulate) await installTestCamera(page, barcodePattern('036000', '291452'))
    await page.getByRole('button', { name: 'Open camera' }).click()
    if (!canSimulate) {
      await expect(page.getByText('Camera scanning requires a supported browser', { exact: false })).toBeVisible()
      await page.getByLabel('Barcode', { exact: true }).fill('036000291452')
      await page.getByRole('button', { name: 'Look up barcode' }).click()
    }
    await expect(page.getByRole('heading', { name: 'Review grocery' })).toBeVisible({ timeout: 12_000 })
    await expect(page.getByLabel('Item name')).toHaveValue('Canned tomatoes')
    await expect(page.getByLabel('Brand')).toHaveValue('Test Pantry')
    await expect(page.getByLabel('Tracking mode')).toHaveValue('count')
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('1')
    await expect(page.getByLabel('Unit', { exact: true })).toHaveValue('can')
    await expect(page.getByLabel('Category')).toHaveValue('Canned goods')
    await expect(page.getByLabel('Net amount per package')).toHaveValue('400')
    await expect(page.getByLabel('Net amount unit')).toHaveValue('g')
    const viewport = page.viewportSize()
    if (viewport && viewport.width <= 480) await page.setViewportSize({ ...viewport, width: 430 })
    await expectDateInputsToFit(page)
    if (viewport && viewport.width <= 480) await page.setViewportSize(viewport)
    expect(app.lookups()).toBe(1)
    expect(app.adds()).toBe(0)
    await page.getByRole('button', { name: 'Add and scan another' }).click()
    await expect(page.getByRole('heading', { name: 'Scan a barcode' })).toBeVisible()
    expect(app.adds()).toBe(1)
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getUserMedia: async () => { throw new DOMException('Permission denied', 'NotAllowedError') } },
      })
    })
    await page.getByRole('button', { name: 'Open camera' }).click()
    await expect(page.getByText('Camera access was denied.', { exact: false })).toBeVisible()
    await page.getByLabel('Barcode', { exact: true }).fill('036000291452')
    await page.getByRole('button', { name: 'Look up barcode' }).click()
    await expect(page.getByText('Found in your kitchen catalog.')).toBeVisible()
    await expect(page.getByLabel('Unit', { exact: true })).toHaveValue('can')
    await expect(page.getByLabel('Category')).toHaveValue('Canned goods')
    expect(app.lookups()).toBe(1)
    await page.getByRole('button', { name: 'Cancel review' }).click()
    if (canSimulate) {
      const fixtures = [
        { barcode: '4006381333931', pattern: barcodePattern('006381', '333931', 0x13), rotated: true }, // Portrait EAN-13
        { barcode: '96385074', pattern: barcodePattern('9638', '5074') }, // EAN-8
        { barcode: '0012345000058', pattern: barcodePattern('123455', '', 0x29) }, // UPC-E, number system 0
        { barcode: '0112345000055', pattern: barcodePattern('123455', '', 0x19) }, // UPC-E, number system 1
      ]
      for (const { barcode, pattern, rotated } of fixtures) {
        await installTestCamera(page, pattern, rotated)
        await page.getByRole('button', { name: 'Open camera' }).click()
        await expect(page.getByRole('heading', { name: 'Review grocery' })).toBeVisible()
        await expect(page.getByLabel('Barcode', { exact: true }), `Decoded barcode ${barcode}`).toHaveValue(barcode)
        await page.getByRole('button', { name: 'Cancel review' }).click()
      }
      expect(app.lookups()).toBe(1 + fixtures.length)
    }
    await page.getByLabel('Barcode', { exact: true }).fill('12345670')
    await page.getByRole('button', { name: 'Look up barcode' }).click()
    await expect(page.getByText('Product not found.', { exact: false })).toBeVisible()
    await expect(page.getByLabel('Barcode', { exact: true })).toHaveValue('12345670')
    await expect(page.getByLabel('Item name')).toHaveValue('')
    await page.getByRole('button', { name: 'Cancel review' }).click()
    await page.getByLabel('Barcode', { exact: true }).fill('99999999')
    await page.getByRole('button', { name: 'Look up barcode' }).click()
    await expect(page.getByText('Product lookup is unavailable.', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel review' }).click()
    await page.getByLabel('Barcode', { exact: true }).fill('4006381333931')
    await page.getByRole('button', { name: 'Look up barcode' }).click()
    await expect(page.getByLabel('Tracking mode')).toHaveValue('exact')
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('450')
    await expect(page.getByLabel('Unit', { exact: true })).toHaveValue('g')
    await expect(page.getByLabel('Category')).toHaveValue('Meat & seafood')
    await page.getByLabel('Quantity', { exact: true }).fill('500')
    await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('500')
    await page.getByRole('button', { name: 'Cancel review' }).click()
    await page.evaluate(() => { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined }) })
    await page.getByRole('button', { name: 'Open camera' }).click()
    await expect(page.getByText('Camera scanning requires a supported browser', { exact: false })).toBeVisible()
    await noHorizontalScroll(page)
    expect(app.adds()).toBe(1)
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Kitchen' }).click()
    await page.getByRole('button', { name: 'Consume', exact: true }).click()
    await page.getByLabel('Consumption unit').selectOption('g')
    await page.getByLabel('Amount to consume').fill('100')
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(page.getByText('300 g remaining')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pantry · 1 can' })).toBeVisible()
  } finally { await app.db.close() }
})

test('ships a standalone manifest, icons and an offline application shell', async ({ page, context }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible()
  const manifestResponse = await page.request.get('/manifest.webmanifest')
  expect(manifestResponse.ok()).toBe(true)
  const manifest = await manifestResponse.json()
  expect(manifest).toMatchObject({ name: 'Kitchen OS', start_url: '/', display: 'standalone' })
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true)
  expect((await page.request.get('/apple-touch-icon.png')).ok()).toBe(true)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  await page.goto('/kitchen')
  await expect(page.getByText('You’re offline.', { exact: false })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible()
})
