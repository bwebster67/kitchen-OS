import { describe, expect, it, vi } from 'vitest'
import { lookupProduct, normalizeBarcode, parsePackage } from './barcode'
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
})
