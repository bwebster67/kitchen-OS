import Decimal from 'decimal.js'
import type { Batch, Ingredient, Kitchen, Mode, Recipe, Unit } from './model'

const D = Decimal.clone({ precision: 36, rounding: Decimal.ROUND_HALF_UP })
const measure: Partial<Record<Unit, [string, string]>> = {
  g: ['weight', '1'], kg: ['weight', '1000'], oz: ['weight', '28.349523125'], lb: ['weight', '453.59237'],
  ml: ['volume', '1'], l: ['volume', '1000'], tsp: ['volume', '4.92892159375'], tbsp: ['volume', '14.78676478125'],
  cup: ['volume', '236.5882365'], 'fl oz': ['volume', '29.5735295625'], gal: ['volume', '3785.411784'],
}
export const measureUnits = Object.keys(measure) as Unit[]
export const countUnits: Unit[] = ['count', 'package', 'can', 'box', 'bottle', 'portion']
export const units = [...measureUnits, ...countUnits, 'level'] as Unit[]
export const modeUnits: Record<Mode, Unit[]> = { exact: [...measureUnits, 'count'], count: countUnits, approximate: ['level'] }
export const unitLabels: Partial<Record<Unit, string>> = { count: 'items', package: 'packages', can: 'cans', box: 'boxes', bottle: 'bottles', portion: 'portions', level: 'approximate' }
export const levels = [[1, 'Full'], [.75, 'Mostly full'], [.5, 'Half'], [.25, 'Low'], [0, 'Empty']] as const
export const categories = ['Produce', 'Meat & seafood', 'Dairy & eggs', 'Grains & bread', 'Pantry', 'Canned goods', 'Condiments & spices', 'Frozen', 'Drinks', 'Prepared food', 'Other']

export function roundQuantity(quantity: Decimal.Value, precision = 8) {
  return new D(quantity).toDecimalPlaces(precision).toNumber()
}

export function convert(quantity: Decimal.Value, from: Unit, to: Unit): Decimal | null {
  if (from === to) return new D(quantity)
  const source = measure[from]
  const target = measure[to]
  if (!source || !target || source[0] !== target[0]) return null
  return new D(quantity).times(source[1]).dividedBy(target[1])
}

export function formatQuantity(quantity: number, unit: Unit) {
  if (unit === 'level') return levels.find(([value]) => value === quantity)?.[1] ?? 'Unknown level'
  const amount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(quantity)
  const label = quantity === 1 && countUnits.includes(unit) ? unit === 'count' ? 'item' : unit : unitLabels[unit] ?? unit
  return `${amount} ${label}`
}

export function nameKey(name: string) { return name.trim().replace(/\s+/g, ' ').toLowerCase() }
export function splitList(text: string) { return [...new Set(text.split(',').map((item) => item.trim()).filter(Boolean))] }
export function localDate(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
export function displayDate(date: string | null) {
  const timestamp = date ? Date.parse(date) : NaN
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(timestamp) : 'Unknown'
}
export function daysUntil(date: string, today = localDate()) {
  return (Date.parse(date) - Date.parse(today)) / 86_400_000
}
export function freshnessDate(batch: Batch) {
  return [batch.printed_on, batch.estimated_on].filter((date): date is string => !!date).sort()[0] ?? null
}
export function freshness(batch: Batch, window: number, today = localDate()): 'past' | 'soon' | 'later' | 'unknown' {
  const date = freshnessDate(batch)
  if (!date) return 'unknown'
  const days = daysUntil(date, today)
  return days < 0 ? 'past' : days <= window ? 'soon' : 'later'
}

export function sortBatches(batches: Batch[], today = localDate()) {
  return [...batches].sort((a, b) => {
    // Favor usable non-expired batches, then earlier entered dates, then oldest purchases.
    const rank = (batch: Batch) => {
      const date = freshnessDate(batch)
      return batch.is_frozen ? 1 : date && date < today ? 2 : 0
    }
    return rank(a) - rank(b)
      || (freshnessDate(a) ?? '9999').localeCompare(freshnessDate(b) ?? '9999')
      || a.purchased_on.localeCompare(b.purchased_on) || a.id.localeCompare(b.id)
  })
}

function asBatchQuantity(batch: Batch, quantity: Decimal.Value, target: Unit): Decimal | null {
  if (batch.mode === 'approximate' || target === 'level') return null
  const direct = convert(quantity, batch.unit, target)
  if (direct) return direct
  if (batch.mode === 'count' && batch.net_quantity && batch.net_unit) {
    return convert(new D(quantity).times(batch.net_quantity), batch.net_unit, target)
  }
  return null
}

export function combinedQuantities(batches: Batch[]) {
  const totals = new Map<Unit, Decimal>()
  const approximate: string[] = []
  for (const batch of batches) {
    if (batch.archived) continue
    if (batch.mode === 'approximate') { approximate.push(formatQuantity(batch.quantity, 'level')); continue }
    const unit = [...totals.keys()].find((candidate) => convert(1, batch.unit, candidate) !== null) ?? batch.unit
    const value = convert(batch.quantity, batch.unit, unit)!
    totals.set(unit, (totals.get(unit) ?? new D(0)).plus(value))
  }
  return [...totals].map(([unit, quantity]) => formatQuantity(quantity.toNumber(), unit)).concat(approximate).join(' + ') || 'Empty'
}

export interface Need { ingredient_id: string; quantity: number; unit: Unit }
export interface Allocation { batch: Batch; amount?: number; wholePackage?: boolean }
export interface Availability { need: Need; allocations: Allocation[]; missing: number }

export function scaleNeeds(needs: Need[], base: number, servings: number): Need[] {
  if (!Number.isInteger(servings) || servings < 1 || !Number.isInteger(base) || base < 1) return []
  return needs.map((need) => ({
    ...need,
    quantity: need.unit === 'level' ? 1 : Math.max(0.00000001, roundQuantity(new D(need.quantity).times(servings).dividedBy(base))),
  }))
}

export function getRecipeAvailability(needs: Need[], batches: Batch[], preferred: Record<number, string> = {}): Availability[] {
  const ordered = sortBatches(batches.filter((batch) => !batch.archived && batch.quantity > 0))
  const remaining = new Map(ordered.map((batch) => [batch.id, new D(batch.quantity)]))
  return needs.map((need, index) => {
    const candidates = ordered.filter((batch) => batch.ingredient_id === need.ingredient_id)
    const first = preferred[index]
    if (first) candidates.sort((a, b) => Number(b.id === first) - Number(a.id === first))
    const allocations: Allocation[] = []
    let missing = new D(need.quantity)
    for (const batch of candidates) {
      if (missing.lte(0)) break
      const available = remaining.get(batch.id)!
      if (available.lte(0)) continue
      if (need.unit === 'level') {
        if (batch.mode !== 'approximate') continue
        allocations.push({ batch })
        missing = new D(0)
        break
      }
      const perUnit = asBatchQuantity(batch, 1, need.unit)
      if (!perUnit || perUnit.lte(0)) continue
      const wholePackage = batch.mode === 'count' && batch.unit !== need.unit
      // A unit that cannot be divided is consumed in whole numbers. Show that deduction in the review.
      const raw = missing.dividedBy(perUnit)
      const demand = batch.mode === 'count'
        ? raw.ceil()
        : raw.toDecimalPlaces(8, Decimal.ROUND_HALF_UP)
      const amount = D.min(available, demand)
      if (amount.lte(0)) continue
      remaining.set(batch.id, available.minus(amount))
      allocations.push({ batch, amount: amount.toNumber(), wholePackage })
      missing = missing.minus(amount.times(perUnit))
      if (batch.mode === 'exact' && amount.eq(demand)) missing = new D(0)
    }
    return { need, allocations, missing: D.max(0, missing).toDecimalPlaces(8, Decimal.ROUND_UP).toNumber() }
  })
}

export function deductionsFor(plan: Availability[], levelsByBatch: Record<string, string>) {
  const combined = new Map<string, { id: string; revision: number; amount?: number; remaining?: number }>()
  for (const row of plan) {
    if (row.missing > 0) throw new Error('Resolve missing ingredients before cooking.')
    for (const { batch, amount } of row.allocations) {
      if (amount === undefined) {
        const input = levelsByBatch[batch.id]
        const remaining = Number(input)
        if (input === undefined || input === '' || !levels.some(([level]) => level === remaining && level <= batch.quantity)) {
          throw new Error('Confirm a remaining level for each approximate ingredient.')
        }
        combined.set(batch.id, { id: batch.id, revision: batch.revision, remaining })
      } else {
        const previous = combined.get(batch.id)?.amount ?? 0
        combined.set(batch.id, { id: batch.id, revision: batch.revision, amount: roundQuantity(new D(previous).plus(amount)) })
      }
    }
  }
  return [...combined.values()]
}

export function activeBatches(kitchen: Kitchen) { return kitchen.inventory_batches.filter((batch) => !batch.archived) }

export function lowStock(kitchen: Kitchen) {
  return kitchen.ingredients.flatMap((ingredient) => {
    const unit = ingredient.low_unit
    const threshold = ingredient.low_quantity
    if (!unit || threshold === null) return []
    const batches = activeBatches(kitchen).filter((batch) => batch.ingredient_id === ingredient.id)
    if (unit === 'level') {
      const approximate = batches.filter((batch) => batch.mode === 'approximate')
      const level = Math.max(0, ...approximate.map((batch) => batch.quantity))
      return level <= threshold ? [{ ingredient, quantity: 1, unit: 'package' as Unit }] : []
    }
    const amount = batches.reduce((total, batch) => total.plus(asBatchQuantity(batch, batch.quantity, unit) ?? 0), new D(0))
    if (amount.gt(threshold)) return []
    const needed = D.max(1, new D(threshold).minus(amount))
    return [{ ingredient, quantity: roundQuantity(countUnits.includes(unit) ? needed.ceil() : needed), unit }]
  })
}

const difficulty = { easy: 0, moderate: 1, project: 2 }
export interface Recommendation { recipe: Recipe; score: number; reasons: string[]; missing: Availability[] }

const allergenAliases: Record<string, string> = {
  dairy: 'milk', eggs: 'egg', peanuts: 'peanut', nuts: 'nut', soybeans: 'soy', soybean: 'soy', soya: 'soy',
  fishes: 'fish', crustaceans: 'crustacean', mollusks: 'mollusk', molluscs: 'mollusk',
}

function matchesRestriction(label: string, restriction: string) {
  const words = (value: string) => nameKey(value).split(/[^a-z0-9]+/).filter(Boolean).map((word) => allergenAliases[word] ?? word).join(' ')
  const a = words(label)
  const b = words(restriction)
  return !!b && ` ${a} `.includes(` ${b} `)
}

export function recipeAllowed(recipe: Recipe, ingredients: Ingredient[], kitchen: Kitchen) {
  const { allergies, dietary_restrictions: diets } = kitchen.preferences
  const foodLabels = [...recipe.restrictions, ...ingredients.flatMap((item) => [item.name, ...item.restrictions])]
  if (allergies.some((allergy) => foodLabels.some((label) => !label.startsWith('suitable:') && matchesRestriction(label, allergy)))) return false
  if (allergies.length && (!recipe.restrictions.includes('reviewed') || ingredients.some((item) => !item.restrictions.includes('reviewed')))) return false
  return diets.every((diet) => {
    const key = nameKey(diet)
    return recipe.restrictions.some((tag) => nameKey(tag) === `suitable:${key}`)
      && !foodLabels.some((label) => nameKey(label) === `unsuitable:${key}`)
  })
}

export function recommendations(kitchen: Kitchen): Recommendation[] {
  const { preferences } = kitchen
  const batches = activeBatches(kitchen)
  const results: Recommendation[] = []
  for (const recipe of kitchen.recipes) {
    const lines = kitchen.recipe_ingredients.filter((line) => line.recipe_id === recipe.id)
    if (!lines.length) continue
    const ingredients = kitchen.ingredients.filter((item) => lines.some((line) => line.ingredient_id === item.id))
    if (!recipeAllowed(recipe, ingredients, kitchen)) continue
    const plan = getRecipeAvailability(lines, batches)
    const missing = plan.filter((row) => row.missing > 0)
    const reasons: string[] = []
    let score = 45 * (1 - missing.length / lines.length)
    if (!missing.length) { reasons.push('Can make now'); score += 22 }
    else if (missing.length <= 2 && missing.length < lines.length) reasons.push(`Almost available · ${missing.length} short`)
    else reasons.push(`${missing.length} missing or short`)
    const soon = plan.some((row) => row.allocations.some(({ batch }) => freshness(batch, preferences.freshness_days) === 'soon'))
    if (soon) { reasons.push('Use ingredients soon'); score += 15 }
    if (recipe.prep_minutes + recipe.cook_minutes <= preferences.max_minutes) { reasons.push('Quick meals'); score += 8 }
    if (preferences.favorite_cuisines.map(nameKey).includes(nameKey(recipe.cuisine))) { reasons.push('Favorite cuisine'); score += 9 }
    else if (!preferences.adventurous && preferences.favorite_cuisines.length) score -= 8
    score -= Math.max(0, difficulty[recipe.difficulty] - difficulty[preferences.complexity]) * 5
    score -= Math.max(0, recipe.spice - preferences.spice) * 3
    score -= ingredients.filter((ingredient) => preferences.disliked_ingredients.some((item) => matchesRestriction(ingredient.name, item))).length * 15
    const history = kitchen.cooking_events.filter((event) => event.recipe_id === recipe.id && !event.reversed_at)
    const feedback = kitchen.recipe_feedback.filter((item) => history.some((event) => event.id === item.event_id))
    const ratings = feedback.flatMap((item) => item.rating === null ? [] : [item.rating])
    if (ratings.length) {
      const rating = ratings.reduce((a, b) => a + b, 0) / ratings.length
      score += (rating - 3) * 6
      if (rating >= 4) reasons.push('Your favorites')
    }
    score += feedback.filter((item) => item.make_again === true).length * 2
    score -= feedback.filter((item) => item.make_again === false || item.flags.includes('too_much_effort')).length * 3
    if (history.some((event) => daysUntil(event.cooked_at.slice(0, 10)) >= -3)) score -= 10
    results.push({ recipe, score, reasons, missing })
  }
  return results.sort((a, b) => b.score - a.score || a.recipe.name.localeCompare(b.recipe.name))
}
