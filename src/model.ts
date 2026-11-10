export type Unit = 'g' | 'kg' | 'oz' | 'lb' | 'ml' | 'l' | 'tsp' | 'tbsp' | 'cup' | 'fl oz' | 'gal' | 'count' | 'package' | 'can' | 'box' | 'bottle' | 'portion' | 'level'
export type Mode = 'exact' | 'count' | 'approximate'
export type Difficulty = 'easy' | 'moderate' | 'project'
export type DateType = 'expiration' | 'best_before' | 'use_by' | 'sell_by'
export interface Location { id: string; name: string; is_default: boolean }
export interface Ingredient { id: string; name: string; name_key: string; category: string; restrictions: string[]; low_quantity: number | null; low_unit: Unit | null }
export interface Product {
  id: string; ingredient_id: string; barcode: string; name: string; brand: string | null
  package_label: string | null; net_quantity: number | null; net_unit: Unit | null
}
export interface Batch {
  id: string; ingredient_id: string; location_id: string; product_id: string | null
  mode: Mode; quantity: number; unit: Unit; net_quantity: number | null; net_unit: Unit | null
  contents_used?: number
  purchased_on: string; printed_on: string | null; printed_type: DateType | null; estimated_on: string | null
  opened_on: string | null; frozen_on: string | null; thawed_on: string | null
  is_frozen: boolean
  price: number | null; notes: string | null; archived: boolean; revision: number; created_at: string
}
export interface Recipe {
  id: string; name: string; description: string; cuisine: string; instructions: string; prep_minutes: number
  cook_minutes: number; servings: number; difficulty: Difficulty; spice: number; tags: string[]; restrictions: string[]; notes: string
}
export interface RecipeLine { id: string; recipe_id: string; ingredient_id: string; quantity: number; unit: Unit; position: number }
export interface PlannedMeal { id: string; recipe_id: string | null; name: string; planned_for: string; servings: number }
export interface CookingEvent { id: string; transaction_id: string; recipe_id: string | null; name: string; servings: number; notes: string; cooked_at: string; reversed_at: string | null }
export interface EventIngredient { id: string; event_id: string; name: string; quantity: number | null; unit: Unit; approximate_before: number | null; approximate_after: number | null }
export interface Leftover { batch_id: string; event_id: string; portions_prepared: number; portions_eaten: number }
export interface Feedback { event_id: string; rating: number | null; make_again: boolean | null; flags: string[]; notes: string }
export interface List { id: string; name: string; created_at: string }
export interface ShoppingItem { id: string; list_id: string; ingredient_id: string | null; name: string; category: string; quantity: number; unit: Unit; purchased: boolean; stocked: boolean }
export interface Preferences {
  favorite_cuisines: string[]; disliked_ingredients: string[]; dietary_restrictions: string[]; allergies: string[]
  spice: number; max_minutes: number; complexity: Difficulty; adventurous: boolean; freshness_days: number
}
export interface Transaction { id: string; request_key: string; action: string; reverses_id: string | null; created_at: string; result: Record<string, string | null> }
export interface Kitchen {
  id: string; name: string; locations: Location[]; ingredients: Ingredient[]; products: Product[]; inventory_batches: Batch[]
  recipes: Recipe[]; recipe_ingredients: RecipeLine[]; planned_meals: PlannedMeal[]; cooking_events: CookingEvent[]
  cooking_event_ingredients: EventIngredient[]; prepared_leftovers: Leftover[]; recipe_feedback: Feedback[]
  shopping_lists: List[]; shopping_items: ShoppingItem[]; preferences: Preferences; inventory_transactions: Transaction[]
}
export interface PendingCommand { id: string; type: string; version: number; issues: string[]; status: 'pending' | 'applied' | 'rejected' }
