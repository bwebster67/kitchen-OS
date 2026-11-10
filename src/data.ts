import { createClient } from '@supabase/supabase-js'
import type { Kitchen } from './model'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const supabase = url && key ? createClient(url, key) : null

function client() {
  if (!supabase) throw new Error('Connect a Supabase project first.')
  return supabase
}

export async function initializeKitchen(): Promise<string> {
  const { data, error } = await client().rpc('initialize_kitchen')
  if (error) throw error
  return data
}

async function rows(table: string, kitchen: string, order = 'id'): Promise<unknown[]> {
  const result: unknown[] = []
  const size = 500
  for (let offset = 0; ; offset += size) {
    const response = await client().from(table).select('*').eq('kitchen_id', kitchen).order(order).range(offset, offset + size - 1)
    if (response.error) throw response.error
    result.push(...response.data)
    if (response.data.length < size) return result
  }
}

const tables = {
  locations: 'id', ingredients: 'id', products: 'id', inventory_batches: 'id',
  recipes: 'id', recipe_ingredients: 'id', planned_meals: 'id', cooking_events: 'id',
  cooking_event_ingredients: 'id', prepared_leftovers: 'batch_id', recipe_feedback: 'event_id',
  shopping_lists: 'id', shopping_items: 'id', inventory_transactions: 'id',
} as const

export async function fetchKitchen(id: string): Promise<Kitchen> {
  const [kitchen, preferences, ...results] = await Promise.all([
    client().from('kitchens').select('id,name').eq('id', id).single(),
    client().from('taste_preferences').select('*').eq('kitchen_id', id).single(),
    ...Object.entries(tables).map(([table, order]) => rows(table, id, order)),
  ])
  if (kitchen.error) throw kitchen.error
  if (preferences.error) throw preferences.error
  return {
    ...kitchen.data, preferences: preferences.data,
    ...Object.fromEntries(Object.keys(tables).map((table, index) => [table, results[index]])),
  } as Kitchen
}

export type InventoryAction = 'add' | 'edit' | 'adjust' | 'move' | 'open' | 'freeze' | 'thaw' | 'consume' | 'consume_ingredients' | 'discard' | 'cook' | 'stock_shopping' | 'undo'
export type ManageAction = 'recipe_save' | 'recipe_delete' | 'location_add' | 'location_rename' | 'location_delete' | 'ingredient_settings' | 'list_add' | 'list_rename' | 'list_delete' | 'shopping_add' | 'shopping_edit' | 'shopping_check' | 'shopping_delete'
export interface OperationResult { transaction_id: string; event_id?: string; batch_id?: string }

export async function inventoryOperation(kitchen: string, action: InventoryAction, payload: Record<string, unknown>, key: string): Promise<OperationResult> {
  const { data, error } = await client().rpc('inventory_operation', { p_kitchen: kitchen, p_key: key, p_action: action, p_data: payload })
  if (error) throw error
  return data
}

export async function manageKitchen(kitchen: string, action: ManageAction, payload: Record<string, unknown>) {
  const { data, error } = await client().rpc('manage_kitchen', { p_kitchen: kitchen, p_action: action, p_data: payload })
  if (error) throw error
  return data as string
}

export async function saveKitchenRow(table: 'taste_preferences' | 'recipe_feedback' | 'planned_meals', kitchen: string, payload: Record<string, unknown>) {
  const conflict = { taste_preferences: 'kitchen_id', recipe_feedback: 'kitchen_id,event_id', planned_meals: 'id' }[table]
  const { error } = await client().from(table).upsert({ ...payload, kitchen_id: kitchen }, { onConflict: conflict })
  if (error) throw error
}

export async function deletePlan(kitchen: string, id: string) {
  const { error } = await client().from('planned_meals').delete().eq('kitchen_id', kitchen).eq('id', id)
  if (error) throw error
}

export async function exportKitchen(kitchen: string) {
  const [snapshot, membership, lines, commands] = await Promise.all([
    fetchKitchen(kitchen), rows('kitchen_members', kitchen, 'user_id'),
    rows('inventory_transaction_lines', kitchen), rows('pending_commands', kitchen),
  ])
  return { version: 1, exported_at: new Date().toISOString(), ...snapshot, membership, inventory_transaction_lines: lines, pending_commands: commands }
}
