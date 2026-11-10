import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, CirclePlus, ListChecks, PackagePlus, Plus } from 'lucide-react'
import { Link, useSearchParams } from 'react-router'
import { useKitchen } from './context'
import { categories, formatQuantity, lowStock, nameKey, units } from './domain'
import { UnitOptions } from './Inventory'
import type { ShoppingItem, Unit } from './model'
import { Alert, Button, Empty, Field, PageTitle, Section, errorMessage } from './ui'

export function Shopping() {
  const { kitchen, manage, busy } = useKitchen()
  const [params, setParams] = useSearchParams()
  const listId = params.get('list')
  const selected = kitchen.shopping_lists.find((list) => list.id === listId) ?? kitchen.shopping_lists[0]
  const [addItem, setAddItem] = useState(params.get('add') === '1')
  const [newList, setNewList] = useState(false)
  const [listName, setListName] = useState('')
  const [rename, setRename] = useState(false)
  const [editing, setEditing] = useState('')
  const [checking, setChecking] = useState<{ id: string; purchased: boolean } | null>(null)
  const items = kitchen.shopping_items.filter((item) => item.list_id === selected?.id)
  const groups = [...new Set(items.map((item) => item.category))].sort()
  const suggestions = lowStock(kitchen).filter(({ ingredient }) => !items.some((item) => !item.stocked
    && (item.ingredient_id === ingredient.id || nameKey(item.name) === ingredient.name_key)))

  useEffect(() => { if (params.get('add') === '1') setAddItem(true) }, [params])

  function choose(id: string) {
    setParams(id ? { list: id } : {})
    setEditing('')
    setRename(false)
  }

  async function saveList(event: FormEvent) {
    event.preventDefault()
    if (!listName.trim()) return
    try {
      const id = await manage(rename ? 'list_rename' : 'list_add', { id: rename ? selected?.id : undefined, name: listName })
      choose(id)
      setListName('')
      setNewList(false)
    } catch { /* Operation errors appear in the workspace. */ }
  }

  return <>
    <PageTitle label="Shopping" title="Next grocery run" action={<Button onClick={() => { setRename(false); setListName(''); setNewList(!newList) }}><Plus size={19} />New list</Button>}>
      Keep track of what you need, then put purchased items straight into your kitchen.
    </PageTitle>
    {(newList || rename) && <form className="card row" onSubmit={saveList}>
      <div className="grow"><Field label="List name"><input required maxLength={80} value={listName} onChange={(event) => setListName(event.target.value)} /></Field></div>
      <Button type="submit" disabled={busy}>{rename ? 'Save name' : 'Create list'}</Button><Button variant="quiet" onClick={() => { setNewList(false); setRename(false) }}>Cancel</Button>
    </form>}
    {!selected ? <Empty title="Create your first shopping list">Make a list for groceries, a specific shop, or your next meal.</Empty> : <>
      <div className="card row between">
        <div className="grow"><Field label="Shopping list"><select value={selected.id} onChange={(event) => choose(event.target.value)}>{kitchen.shopping_lists.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field></div>
        <div className="row">
          <Button variant="secondary" onClick={() => setAddItem(!addItem)}><CirclePlus size={18} />Add item</Button>
          <Button variant="quiet" onClick={() => { setNewList(false); setRename(true); setListName(selected.name) }}>Rename</Button>
          <Button variant="danger" disabled={busy} onClick={() => {
            if (confirm(`Delete ${selected.name} and all its shopping items?`)) void manage('list_delete', { id: selected.id }).then(() => choose('')).catch(() => {})
          }}>Delete list</Button>
        </div>
      </div>
      {addItem && <ItemForm key={selected.id} list={selected.id} onClose={() => { setAddItem(false); if (params.get('add')) setParams({ list: selected.id }) }} />}
      <Section title={selected.name} action={<span className="badge"><ListChecks size={16} />&nbsp;{items.filter((item) => item.purchased).length} of {items.length} purchased</span>}>
        {!items.length && <Empty title="This list is empty">Add an item, use a low-stock suggestion, or import missing ingredients from a recipe.</Empty>}
        {groups.map((category) => <div className="card stack" key={category}><h3>{category}</h3>
          {items.filter((item) => item.category === category).sort((a, b) => Number(a.purchased) - Number(b.purchased) || a.name.localeCompare(b.name)).map((item) => <article className="shop-item" key={item.id}>
            <div className="row between">
              <label className="check grow"><input type="checkbox" checked={checking?.id === item.id ? checking.purchased : item.purchased} disabled={item.stocked || busy || checking !== null} aria-label={`Mark ${item.name} purchased`}
                onChange={(event) => {
                  const purchased = event.target.checked
                  setChecking({ id: item.id, purchased })
                  void manage('shopping_check', { id: item.id, purchased }).catch(() => {}).finally(() => setChecking(null))
                }} />
                <span><strong>{item.name}</strong><small className="block">{formatQuantity(item.quantity, item.unit)}</small></span></label>
              <div className="row">
                {item.stocked ? <span className="badge"><Check size={14} /> In kitchen</span> : <>
                  {item.purchased && <Link className="button primary" to={`/kitchen/add?shopping=${item.id}`}><PackagePlus size={16} /> Stock item</Link>}
                  <Button variant="quiet" onClick={() => setEditing(editing === item.id ? '' : item.id)}>Edit</Button>
                </>}
                <Button variant="quiet" disabled={busy} onClick={() => {
                  if (confirm(`Remove ${item.name} from this list?`)) void manage('shopping_delete', { id: item.id }).catch(() => {})
                }}>Remove</Button>
              </div>
            </div>
            {editing === item.id && !item.stocked && <ItemForm item={item} list={selected.id} onClose={() => setEditing('')} />}
          </article>)}
        </div>)}
      </Section>
      <Section title="Replenish staples">
        {suggestions.length ? <div className="card stack">{suggestions.map(({ ingredient, quantity, unit }) => <div className="row between" key={ingredient.id}>
          <div><strong>{ingredient.name}</strong><p className="muted">{formatQuantity(quantity, unit)} suggested</p></div>
          <Button variant="secondary" disabled={busy} onClick={() => void manage('shopping_add', {
            list_id: selected.id, items: [{ ingredient_id: ingredient.id, name: ingredient.name, category: ingredient.category, quantity, unit }],
          }).catch(() => {})}>Add to list</Button>
        </div>)}</div> : <Empty title="No replenishment suggestions" to="/settings" action="Manage thresholds">Suggestions appear when a tracked staple reaches its low-stock threshold.</Empty>}
      </Section>
    </>}
  </>
}

function ItemForm({ list, item, onClose }: { list: string; item?: ShoppingItem; onClose: () => void }) {
  const { kitchen, manage, busy } = useKitchen()
  const [name, setName] = useState(item?.name ?? '')
  const [quantity, setQuantity] = useState(item?.quantity.toString() ?? '1')
  const [unit, setUnit] = useState<Unit>(item?.unit ?? 'count')
  const [category, setCategory] = useState(item?.category ?? 'Other')
  const [error, setError] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      const ingredient = kitchen.ingredients.find((row) => row.name_key === nameKey(name))
      if (!name.trim()) throw new Error('Enter the shopping item name.')
      const payload = { name, quantity: Number(quantity), unit, category, ingredient_id: ingredient?.id }
      if (item) await manage('shopping_edit', { id: item.id, ...payload })
      else await manage('shopping_add', { list_id: list, items: [payload] })
      onClose()
    } catch (error) { setError(errorMessage(error)) }
  }
  return <form className="card stack" onSubmit={submit}>
    <h3>{item ? 'Edit item' : 'Add to this list'}</h3>
    <div className="form-grid">
      <Field label="Shopping item"><input maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} onBlur={() => {
        const ingredient = kitchen.ingredients.find((row) => row.name_key === nameKey(name))
        if (ingredient && category === 'Other') setCategory(ingredient.category)
      }} /></Field>
      <Field label="Quantity"><input type="number" inputMode="decimal" min=".00000001" max="1000000" step=".00000001" required value={quantity} onChange={(event) => setQuantity(event.target.value)} /></Field>
      <Field label="Unit"><select value={unit} onChange={(event) => setUnit(event.target.value as Unit)}><UnitOptions options={units.filter((option) => option !== 'level')} /></select></Field>
      <Field label="Category"><select value={category} onChange={(event) => setCategory(event.target.value)}>{[...new Set([...categories, category])].map((value) => <option key={value}>{value}</option>)}</select></Field>
    </div>
    {error && <Alert>{error}</Alert>}
    <div className="row"><Button type="submit" disabled={busy}>{item ? 'Save item' : 'Add shopping item'}</Button><Button variant="quiet" onClick={onClose}>Cancel</Button></div>
  </form>
}
