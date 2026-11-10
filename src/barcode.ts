import { supabase } from './data'
import type { Mode, Product, Unit } from './model'

export type BarcodeFormat = 'UPC_E' | 'EAN_8' | 'UPC_A' | 'EAN_13' | 'GTIN'
export interface ProductMatch {
  name: string
  brand?: string | null
  package_label?: string | null
  net_quantity?: number | null
  net_unit?: Unit | null
  product_quantity?: number | string | null
  product_quantity_unit?: string | null
  category_tags?: string[]
  package_shapes?: string[]
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
  const match = label.trim().toLowerCase().match(/^(\d+(?:[.,]\d+)?)\s*(g|kg|oz|lbs?|ml|cl|dl|l|fl\.?\s*oz\.?|gal)\s*℮?$/)
  if (!match) return null
  const unit = match[2].replace(/[.\s]/g, '')
  const quantity = Number(match[1].replace(',', '.')) * (unit === 'cl' ? 10 : unit === 'dl' ? 100 : 1)
  if (quantity < .00000001 || quantity > 1_000_000) return null
  const net_unit = unit === 'floz' ? 'fl oz' : unit === 'lbs' ? 'lb' : unit === 'cl' || unit === 'dl' ? 'ml' : unit as Unit
  return { net_quantity: Number(quantity.toFixed(8)), net_unit }
}

const categoryByTag = new Map([
  ['frozen-foods', 'Frozen'], ['ice-creams', 'Frozen'],
  ['fresh-fruits', 'Produce'], ['fresh-vegetables', 'Produce'], ['fruits', 'Produce'], ['vegetables', 'Produce'],
  ['meats', 'Meat & seafood'], ['poultries', 'Meat & seafood'], ['fish', 'Meat & seafood'], ['seafood', 'Meat & seafood'],
  ['dairies', 'Dairy & eggs'], ['milks', 'Dairy & eggs'], ['eggs', 'Dairy & eggs'], ['cheeses', 'Dairy & eggs'],
  ['breads', 'Grains & bread'], ['pastas', 'Grains & bread'], ['rices', 'Grains & bread'], ['cereals', 'Grains & bread'],
  ['snacks', 'Pantry'], ['dried-products', 'Pantry'], ['nuts', 'Pantry'], ['flours', 'Pantry'],
  ['canned-foods', 'Canned goods'], ['canned-vegetables', 'Canned goods'], ['canned-fishes', 'Canned goods'],
  ['condiments', 'Condiments & spices'], ['spices', 'Condiments & spices'], ['sauces', 'Condiments & spices'],
  ['beverages', 'Drinks'], ['waters', 'Drinks'], ['fruit-juices', 'Drinks'], ['soft-drinks', 'Drinks'],
  ['meals', 'Prepared food'], ['ready-made-meals', 'Prepared food'],
])
const unitByShape = new Map<string, Unit>([
  ['en:bottle', 'bottle'], ['en:can', 'can'], ['en:beverage-can', 'can'], ['en:metal-tin', 'can'],
  ['en:box', 'box'], ['en:carton', 'package'], ['en:beverage-carton', 'package'],
  ['en:bag', 'package'], ['en:pouch', 'package'], ['en:jar', 'package'],
  ['en:pot', 'package'], ['en:tray', 'package'], ['en:tub', 'package'], ['en:packet', 'package'],
])

export function barcodeDefaults(product: ProductMatch, catalogCategory?: string, savedUnit?: Unit) {
  const mapped = (product.category_tags ?? []).flatMap((tag) => {
    const category = tag.startsWith('en:') ? categoryByTag.get(tag.slice(3)) : undefined
    return category ? [category] : []
  })
  const category = catalogCategory ?? mapped.find((value) => value === 'Frozen' || value === 'Canned goods') ?? mapped.at(-1)
  const label = product.package_label?.trim() ?? ''
  const multi = label.match(/^(\d+)\s*[x×]\s*(.+)$/i)
  const count = label.match(/^(\d+)\s*(?:[- ]?\s*(ct|count|pieces?|eggs?|packs?|bottles?|cans?|boxes?))$/i)
  const perPackage = multi ? parsePackage(multi[2]) : null
  const normalized = product.product_quantity && product.product_quantity_unit
    ? parsePackage(`${product.product_quantity} ${product.product_quantity_unit}`) : null
  const savedSize = product.net_quantity && product.net_unit
    ? { net_quantity: product.net_quantity, net_unit: product.net_unit } : null
  const size = savedSize ?? parsePackage(label) ?? normalized
  const container = (product.package_shapes ?? []).map((shape) => unitByShape.get(shape)).find(Boolean)
  const countUnit = count?.[2].toLowerCase()
  const labelUnit = countUnit?.startsWith('bottle') ? 'bottle' : countUnit?.startsWith('can') ? 'can'
    : countUnit?.startsWith('box') ? 'box' : undefined
  const packCount = Number(count?.[1] ?? (perPackage ? multi?.[1] : undefined))
  const hasCount = Number.isInteger(packCount) && packCount > 0 && packCount <= 1_000_000
  const volume = size && ['ml', 'l', 'fl oz', 'gal'].includes(size.net_unit)
  const packaged = container || hasCount || category === 'Canned goods' || (volume && (category === 'Drinks' || category === 'Dairy & eggs'))
  const catalogPackage = savedUnit && ['package', 'box', 'can', 'bottle'].includes(savedUnit)
  const mode: Mode = size && !packaged && !catalogPackage ? 'exact' : 'count'
  const itemCount = countUnit && !countUnit.startsWith('pack')
  const unit: Unit = mode === 'exact' && size ? size.net_unit
    : labelUnit ?? (itemCount ? 'count' : undefined) ?? (catalogPackage ? savedUnit : undefined) ?? container
      ?? (category === 'Canned goods' ? 'can' : 'package')
  const quantity = mode === 'exact' && size ? size.net_quantity : hasCount ? packCount : 1
  const netSize = hasCount ? savedSize ?? perPackage : size
  return { category, mode, unit, quantity, ...netSize }
}

export interface ProductProvider { lookup(barcode: string): Promise<ProductMatch | null> }

export const openFoodFacts: ProductProvider = {
  async lookup(barcode) {
    if (!supabase) throw new Error('Product lookup requires a connected kitchen.')
    const { data, error } = await supabase.functions.invoke<{ product: ProductMatch | null }>('product-lookup', { body: { barcode } })
    if (error) throw error
    return data?.product ?? null
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
