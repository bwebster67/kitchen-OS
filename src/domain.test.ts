import { describe, expect, it } from 'vitest'
import { combinedQuantities, convert, deductionsFor, freshness, getRecipeAvailability, recipeAllowed, recommendations, scaleNeeds } from './domain'
import type { Batch, Ingredient, Kitchen, Recipe } from './model'

function batch(data: Partial<Batch> = {}): Batch {
  return {
    id: 'a', ingredient_id: 'beef', location_id: 'fridge', product_id: null, mode: 'exact', quantity: 2, unit: 'lb',
    net_quantity: null, net_unit: null, purchased_on: '2026-11-08', printed_on: null, printed_type: null, estimated_on: null,
    opened_on: null, frozen_on: null, thawed_on: null, is_frozen: false, price: null, notes: null, archived: false, revision: 0,
    created_at: '2026-11-08T00:00:00Z', ...data,
  }
}

const recipe: Recipe = {
  id: 'dinner', name: 'Dinner', description: '', cuisine: 'Mexican', instructions: '', prep_minutes: 5, cook_minutes: 20,
  servings: 2, difficulty: 'easy', spice: 1, tags: [], restrictions: ['reviewed', 'suitable:gluten-free'], notes: '',
}
const beef: Ingredient = { id: 'beef', name: 'Beef', name_key: 'beef', category: 'Meat', low_quantity: null, low_unit: null, restrictions: ['reviewed'] }
const kitchen = {
  ingredients: [beef], recipes: [recipe], inventory_batches: [batch()],
  recipe_ingredients: [{ id: 'line', recipe_id: 'dinner', ingredient_id: 'beef', quantity: .5, unit: 'lb', position: 0 }],
  preferences: { favorite_cuisines: ['Mexican'], disliked_ingredients: [], dietary_restrictions: [], allergies: [], max_minutes: 30, spice: 2, complexity: 'easy', adventurous: true, freshness_days: 5 },
  cooking_events: [], recipe_feedback: [],
} as unknown as Kitchen

describe('inventory and recipe planning', () => {
  it('uses compatible decimal conversions and keeps count and weight separate', () => {
    expect(convert(2, 'lb', 'g')?.toString()).toBe('907.18474')
    expect(convert(8, 'fl oz', 'cup')?.toString()).toBe('1')
    expect(convert(1, 'g', 'ml')).toBeNull()
    expect(convert(1, 'can', 'count')).toBeNull()
    expect(combinedQuantities([batch(), batch({ id: 'b', quantity: 12, unit: 'oz' })])).toBe('2.75 lb')
  })

  it('scales servings and plans the exact amount in the batch unit', () => {
    const requirements = scaleNeeds([{ ingredient_id: 'beef', quantity: .25, unit: 'lb' }], 2, 4)
    expect(requirements[0].quantity).toBe(.5)
    expect(deductionsFor(getRecipeAvailability(requirements, [batch()]), {})).toEqual([{ id: 'a', revision: 0, amount: .5 }])
    expect(deductionsFor(getRecipeAvailability([{ ingredient_id: 'beef', quantity: 226.796185, unit: 'g' }], [batch()]), {})).toEqual([{ id: 'a', revision: 0, amount: .5 }])
  })

  it('reserves a batch across multiple lines and detects shortages', () => {
    const need = { ingredient_id: 'beef', quantity: 1.5, unit: 'lb' as const }
    const result = getRecipeAvailability([need, need], [batch()])
    expect(result.map((line) => line.missing)).toEqual([0, 1])
    expect(() => deductionsFor(result, {})).toThrow(/missing/i)
  })

  it('honors preferred batches and preserves separate batch deductions', () => {
    const other = batch({ id: 'b', quantity: .25, purchased_on: '2026-11-09' })
    const result = getRecipeAvailability([{ ingredient_id: 'beef', quantity: .5, unit: 'lb' }], [batch(), other], { 0: 'b' })
    expect(deductionsFor(result, {})).toEqual([{ id: 'b', revision: 0, amount: .25 }, { id: 'a', revision: 0, amount: .25 }])
  })

  it('deducts only the measured contents of a package', () => {
    const item = batch({ mode: 'count', unit: 'can', net_quantity: 400, net_unit: 'g' })
    const result = getRecipeAvailability([{ ingredient_id: 'beef', quantity: 100, unit: 'g' }], [item])
    expect(result[0].allocations[0]).toMatchObject({ amount: 100, contentUnit: 'g' })
    expect(result[0].missing).toBe(0)
    expect(deductionsFor(result, {})).toEqual([{ id: 'a', revision: 0, amount: 100, content_unit: 'g' }])
  })

  it('combines compatible stock oldest first and only deducts available amounts after confirmation', () => {
    const older = batch({ id: 'z', product_id: 'brand-a', quantity: 1, unit: 'package', mode: 'count',
      net_quantity: 400, net_unit: 'g', contents_used: 100, purchased_on: '2026-11-01' })
    const newer = batch({ id: 'a', product_id: 'brand-b', quantity: .25, unit: 'kg', purchased_on: '2026-11-02' })
    const volume = batch({ id: 'volume', quantity: 2, unit: 'cup' })
    const plan = getRecipeAvailability([{ ingredient_id: 'beef', quantity: 600, unit: 'g' }], [newer, older, volume])
    expect(plan[0]).toMatchObject({ missing: 50, incompatible: true })
    expect(() => deductionsFor(plan, {})).toThrow(/missing/i)
    expect(deductionsFor(plan, {}, true)).toEqual([
      { id: 'z', revision: 0, amount: 300, content_unit: 'g' }, { id: 'a', revision: 0, amount: .25 },
    ])
    expect(getRecipeAvailability([{ ingredient_id: 'beef', quantity: 1, unit: 'cup' }], [older])[0])
      .toMatchObject({ missing: 1, incompatible: true, allocations: [] })
  })

  it('reserves package counts and measured contents together without double deduction', () => {
    const item = batch({ mode: 'count', unit: 'can', net_quantity: 400, net_unit: 'g', quantity: 2 })
    const plan = getRecipeAvailability([
      { ingredient_id: 'beef', quantity: 100, unit: 'g' }, { ingredient_id: 'beef', quantity: 1, unit: 'can' },
    ], [item])
    expect(plan.map((row) => row.missing)).toEqual([0, 0])
    expect(deductionsFor(plan, {})).toEqual([{ id: 'a', revision: 0, amount: 400, content_unit: 'g' }])
  })

  it('uses a conversion for the specified ingredient only', () => {
    const flour = { ...beef, id: 'flour', name: 'Flour', grams_per_cup: 120 }
    const flourBag = batch({ ingredient_id: flour.id, mode: 'count', unit: 'package', net_quantity: 500, net_unit: 'g', quantity: 1 })
    const byCup = getRecipeAvailability([{ ingredient_id: flour.id, quantity: 1, unit: 'cup' }], [flourBag], {}, [flour])
    expect(deductionsFor(byCup, {})).toEqual([{ id: 'a', revision: 0, amount: 120, content_unit: 'g' }])
    const byGram = getRecipeAvailability([{ ingredient_id: flour.id, quantity: 60, unit: 'g' }],
      [batch({ ingredient_id: flour.id, unit: 'cup' })], {}, [flour])
    expect(deductionsFor(byGram, {})).toEqual([{ id: 'a', revision: 0, amount: .5 }])
    const unrelated = getRecipeAvailability([{ ingredient_id: 'beef', quantity: 1, unit: 'cup' }], [batch()], {}, [flour])
    expect(unrelated[0]).toMatchObject({ missing: 1, incompatible: true })
  })

  it('requires a new approximate level and never treats it as a measure', () => {
    const item = batch({ quantity: .75, mode: 'approximate', unit: 'level' })
    const need = { ingredient_id: 'beef', quantity: 1, unit: 'g' as const }
    expect(getRecipeAvailability([need], [item])[0].missing).toBe(1)
    const plan = getRecipeAvailability([{ ...need, unit: 'level' }], [item])
    expect(() => deductionsFor(plan, {})).toThrow(/remaining/)
    expect(() => deductionsFor(plan, { a: '1' })).toThrow(/remaining/)
    expect(deductionsFor(plan, { a: '.5' })).toEqual([{ id: 'a', revision: 0, remaining: .5 }])
  })

  it('keeps unknown, past and estimated dates distinct', () => {
    expect(freshness(batch(), 5, '2026-11-09')).toBe('unknown')
    expect(freshness(batch({ printed_on: '2026-11-08' }), 5, '2026-11-09')).toBe('past')
    expect(freshness(batch({ estimated_on: '2026-11-14' }), 5, '2026-11-09')).toBe('soon')
  })
})

describe('recommendations', () => {
  it('explains the available, quick and preferred-cuisine recipe', () => {
    expect(recommendations(kitchen)[0].reasons).toEqual(['Can make now', 'Quick meals', 'Favorite cuisine'])
  })

  it('enforces dietary requirements and fails closed on unreviewed allergen data', () => {
    const constrained = { ...kitchen, preferences: { ...kitchen.preferences, allergies: ['milk'], dietary_restrictions: ['gluten-free'] } }
    expect(recipeAllowed(recipe, [beef], constrained)).toBe(true)
    expect(recipeAllowed(recipe, [{ ...beef, restrictions: [] }], constrained)).toBe(false)
    expect(recipeAllowed(recipe, [{ ...beef, restrictions: ['reviewed', 'contains:milk'] }], constrained)).toBe(false)
    expect(recipeAllowed(recipe, [{ ...beef, restrictions: ['reviewed', 'contains:dairy'] }], constrained)).toBe(false)
    expect(recipeAllowed(recipe, [{ ...beef, restrictions: ['reviewed', 'unsuitable:gluten-free'] }], constrained)).toBe(false)
    expect(recipeAllowed({ ...recipe, restrictions: ['reviewed'] }, [beef], constrained)).toBe(false)
  })
})
