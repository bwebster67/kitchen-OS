import { supabase } from './data'
import type { Product, Unit } from './model'

export type BarcodeFormat = 'UPC_E' | 'EAN_8' | 'UPC_A' | 'EAN_13' | 'GTIN'
export interface ProductMatch {
  name: string
  brand?: string | null
  package_label?: string | null
  net_quantity?: number | null
  net_unit?: Unit | null
  source: 'catalog' | 'open_food_facts'
}

export function normalizeBarcode(input: string, format: BarcodeFormat = 'GTIN'): string {
  let code = input.trim()
  if (!/^(?:\d{8}|\d{12,14})$/.test(code)) throw new Error('Enter an 8, 12, 13 or 14 digit barcode.')
  if (format === 'UPC_E') {
    if (!/^[01]\d{7}$/.test(code)) throw new Error('Enter all eight UPC-E digits.')
    const [system, a, b, c, d, e, last, check] = code
    if ('012'.includes(last)) code = `${system}${a}${b}${last}0000${c}${d}${e}${check}`
    else if (last === '3') code = `${system}${a}${b}${c}00000${d}${e}${check}`
    else if (last === '4') code = `${system}${a}${b}${c}${d}00000${e}${check}`
    else code = `${system}${a}${b}${c}${d}${e}0000${last}${check}`
  }
  if (code.length === 14 && code.startsWith('0')) code = code.slice(1)
  if (code.length === 12) code = `0${code}`
  return code
}

export function parsePackage(label: string | null | undefined): { net_quantity: number; net_unit: Unit } | null {
  if (!label) return null
  const match = label.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(g|kg|oz|lb|ml|l|fl\s*oz|gal)$/)
  if (!match) return null
  const quantity = Number(match[1].replace(',', '.'))
  const unit = match[2].replace(/\s/g, '')
  return quantity > 0 && quantity <= 1_000_000 ? { net_quantity: quantity, net_unit: unit === 'floz' ? 'fl oz' : unit as Unit } : null
}

export interface ProductProvider { lookup(barcode: string): Promise<ProductMatch | null> }

export const openFoodFacts: ProductProvider = {
  async lookup(barcode) {
    if (!supabase) throw new Error('Product lookup requires a connected kitchen.')
    const { data, error } = await supabase.functions.invoke<{ product: ProductMatch | null }>('product-lookup', { body: { barcode } })
    if (error) throw error
    const product = data?.product
    return product ? { ...product, ...parsePackage(product.package_label) } : null
  },
}

export async function lookupProduct(barcode: string, catalog: Product[], provider: ProductProvider = openFoodFacts) {
  const local = catalog.find((product) => product.barcode === barcode)
  if (local) return { product: { ...local, source: 'catalog' } as ProductMatch, message: 'Found in your kitchen catalog.' }
  try {
    const product = await provider.lookup(barcode)
    return { product, message: product ? 'Review the product details before adding it.' : 'Product not found. Add its details below.' }
  } catch {
    return { product: null, message: 'Product lookup is unavailable. You can still add this item manually.' }
  }
}
