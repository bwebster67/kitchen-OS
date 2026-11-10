import { describe, expect, it, vi } from 'vitest'
import { barcodeDefaults, lookupProduct, normalizeBarcode, parsePackage } from './barcode'
import type { Product } from './model'

describe('barcode lookup', () => {
  it('normalizes UPC-A, UPC-E and their EAN equivalents and retains EAN-8', () => {
    expect(normalizeBarcode('012345000058', 'UPC_A')).toBe('0012345000058')
    expect(normalizeBarcode('01234558', 'UPC_E')).toBe('0012345000058')
    expect(normalizeBarcode('00012345000058')).toBe('0012345000058')
    expect(normalizeBarcode('0012345000058', 'EAN_13')).toBe('0012345000058')
    expect(normalizeBarcode('01234558', 'EAN_8')).toBe('01234558')
    expect(() => normalizeBarcode('12-34')).toThrow(/digit barcode/)
  })

  it('uses the catalog before any external request', async () => {
    const item: Product = { id: 'item', ingredient_id: 'rice', barcode: '0012345000058', name: 'Rice', brand: 'Brand', package_label: '1 kg', net_quantity: 1, net_unit: 'kg' }
    const lookup = vi.fn()
    const result = await lookupProduct(item.barcode, [item], { lookup })
    expect(result.product).toMatchObject({ name: 'Rice', source: 'catalog' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('returns the reviewed product data or a manual fallback when unknown or unavailable', async () => {
    const product = { name: 'Rice', brand: 'Brand', package_label: '1 kg', source: 'open_food_facts' as const }
    expect((await lookupProduct('0012345000058', [], { lookup: async () => product })).product).toEqual(product)
    expect(await lookupProduct('0012345000058', [], { lookup: async () => null })).toMatchObject({ product: null, message: expect.stringContaining('not found') })
    expect(await lookupProduct('0012345000058', [], { lookup: async () => { throw new Error('Offline') } })).toMatchObject({ product: null, message: expect.stringContaining('unavailable') })
  })

  it('extracts only unambiguous package measures', () => {
    expect(parsePackage('12 fl oz')).toEqual({ net_quantity: 12, net_unit: 'fl oz' })
    expect(parsePackage('2 × 400 g')).toBeNull()
  })

  it('keeps a bottle count and uses the label unit for its contents', () => {
    expect(barcodeDefaults({
      name: 'Milk', source: 'open_food_facts', package_label: '52 fl oz',
      product_quantity: '1538', product_quantity_unit: 'ml', category_tags: ['en:dairies', 'en:milks'],
      package_shapes: ['en:bottle'],
    })).toEqual({ mode: 'count', quantity: 1, unit: 'bottle', net_quantity: 52, net_unit: 'fl oz', category: 'Dairy & eggs' })
  })

  it('uses normalized weight when there is no packaging or usable printed measure', () => {
    expect(barcodeDefaults({
      name: 'Ground beef', source: 'open_food_facts', package_label: 'Family size',
      product_quantity: '450', product_quantity_unit: 'g', category_tags: ['en:meats'],
    })).toMatchObject({ mode: 'exact', quantity: 450, unit: 'g', category: 'Meat & seafood' })
  })

  it('uses individual quantities for an explicit multipack or item count', () => {
    expect(barcodeDefaults({
      name: 'Soda', source: 'open_food_facts', package_label: '6 × 25 cl', package_shapes: ['en:can'],
      product_quantity: 1500, product_quantity_unit: 'ml', category_tags: ['en:beverages'],
    })).toMatchObject({ mode: 'count', quantity: 6, unit: 'can', net_quantity: 250, net_unit: 'ml', category: 'Drinks' })
    expect(barcodeDefaults({
      name: 'Eggs', source: 'open_food_facts', package_label: '6 eggs', package_shapes: ['en:carton'],
      category_tags: ['en:eggs'],
    })).toEqual({ mode: 'count', quantity: 6, unit: 'count', category: 'Dairy & eggs' })
  })

  it('keeps known catalog settings and falls back when the lookup has no usable metadata', () => {
    expect(barcodeDefaults({ name: 'Water', source: 'catalog', net_quantity: 20, net_unit: 'fl oz' }, 'Drinks', 'bottle'))
      .toMatchObject({ mode: 'count', quantity: 1, unit: 'bottle', category: 'Drinks' })
    expect(barcodeDefaults({ name: 'Unknown', source: 'open_food_facts', product_quantity: 42, category_tags: ['en:foods'] }))
      .toEqual({ mode: 'count', quantity: 1, unit: 'package', category: undefined })
  })
})
