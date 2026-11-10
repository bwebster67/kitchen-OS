import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, Barcode, CalendarClock, PackagePlus, Search } from 'lucide-react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useKitchen } from './context'
import { activeBatches, categories, combinedQuantities, displayDate, formatQuantity, freshness, freshnessDate, levels, localDate, measureUnits, modeUnits, nameKey, sortBatches, unitLabels } from './domain'
import { normalizeBarcode } from './barcode'
import type { ProductMatch } from './barcode'
import type { Batch, DateType, Mode, ShoppingItem, Unit } from './model'
import { Alert, Button, Empty, Field, PageTitle, Section, errorMessage } from './ui'

const dateNames: Record<DateType, string> = { expiration: 'Expiration', best_before: 'Best before', use_by: 'Use by', sell_by: 'Sell by' }
export const dateStatus = { past: 'Past entered date', soon: 'Due soon', later: 'Date recorded', unknown: 'Unknown' }
type Values = ReturnType<typeof newValues>

export function UnitOptions({ options }: { options: Unit[] }) {
  return <>{options.map((unit) => <option value={unit} key={unit}>{unitLabels[unit] ?? unit}</option>)}</>
}

function newValues(location: string, barcode?: string, product?: ProductMatch | null, item?: ShoppingItem) {
  const quantity = item ? String(item.quantity) : '1'
  const unit: Unit = item?.unit ?? (barcode ? 'package' : 'count')
  const mode: Mode = measureUnits.includes(unit) || (unit === 'count' && !Number.isInteger(Number(quantity))) ? 'exact' : 'count'
  return {
    name: item?.name ?? product?.name ?? '', category: item?.category ?? 'Other', location_id: location,
    quantity, unit, mode: mode as Mode,
    purchased_on: localDate(), printed_on: '', printed_type: 'best_before' as DateType, estimated_on: '',
    opened_on: '', frozen_on: '', thawed_on: '', price: '', notes: '', barcode: barcode ?? '',
    brand: product?.brand ?? '', package_label: product?.package_label ?? '',
    net_quantity: product?.net_quantity ? String(product.net_quantity) : '',
    net_unit: product?.net_unit ?? 'g' as Unit,
  }
}

function fromBatch(batch: Batch, name: string, category: string): Values {
  return {
    ...newValues(batch.location_id), name, category, quantity: String(batch.quantity), mode: batch.mode, unit: batch.unit,
    purchased_on: batch.purchased_on, printed_on: batch.printed_on ?? '', printed_type: batch.printed_type ?? 'best_before',
    estimated_on: batch.estimated_on ?? '', opened_on: batch.opened_on ?? '', frozen_on: batch.frozen_on ?? '', thawed_on: batch.thawed_on ?? '',
    price: batch.price === null ? '' : String(batch.price), notes: batch.notes ?? '',
  }
}

export function GroceryForm({ barcode, product, item, batch, onSaved, submitLabel }: {
  barcode?: string; product?: ProductMatch | null; item?: ShoppingItem; batch?: Batch; onSaved?: () => void; submitLabel?: string
}) {
  const { kitchen, inventory, busy } = useKitchen()
  const ingredient = kitchen.ingredients.find((row) => row.id === batch?.ingredient_id)
  const fallback = kitchen.locations.find((row) => row.name === 'Pantry')?.id ?? kitchen.locations[0]?.id ?? ''
  const [values, setValues] = useState(() => batch && ingredient ? fromBatch(batch, ingredient.name, ingredient.category) : newValues(fallback, barcode, product, item))
  const [error, setError] = useState('')
  const [added, setAdded] = useState(0)
  const [barcodeFormat, setBarcodeFormat] = useState<'GTIN' | 'UPC_E'>('GTIN')
  const suggestionsId = useId()
  const nameInput = useRef<HTMLInputElement>(null)
  const categoryOptions = [...new Set([...categories, values.category])]
  const nameChanged = !batch && !item
  function update<K extends keyof Values>(key: K, value: Values[K]) { setValues((previous) => ({ ...previous, [key]: value })) }

  function recall() {
    const known = kitchen.ingredients.find((row) => row.name_key === nameKey(values.name))
    if (!known || batch || item) return
    const previous = kitchen.inventory_batches.filter((row) => row.ingredient_id === known.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    setValues((current) => ({
      ...current, name: known.name, category: known.category,
      ...(previous && !barcode ? {
        location_id: previous.location_id, mode: previous.mode, unit: previous.unit,
        quantity: previous.mode === 'approximate' ? '1' : current.quantity,
      } : previous ? { location_id: previous.location_id } : {}),
    }))
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const payload = {
        ...values, quantity: Number(values.quantity), purchased_on: values.purchased_on,
        printed_on: values.printed_on || null, estimated_on: values.estimated_on || null, opened_on: values.opened_on || null,
        frozen_on: values.frozen_on || null, thawed_on: values.thawed_on || null, price: values.price === '' ? null : Number(values.price),
        notes: values.notes.trim() || null, brand: values.brand.trim() || null, package_label: values.package_label.trim() || null,
        net_quantity: values.net_quantity ? Number(values.net_quantity) : null, net_unit: values.net_quantity ? values.net_unit : null,
        barcode: values.barcode ? normalizeBarcode(values.barcode, barcodeFormat) : null,
      }
      if (!values.name.trim()) throw new Error('Enter an item name.')
      if (batch) await inventory('edit', { ...payload, id: batch.id, revision: batch.revision })
      else if (item) await inventory('stock_shopping', { ...payload, shopping_item_id: item.id })
      else await inventory('add', payload)
      if (onSaved) onSaved()
      else if (!batch) {
        setAdded((count) => count + 1)
        setValues({ ...newValues(values.location_id), purchased_on: values.purchased_on })
        setBarcodeFormat('GTIN')
        nameInput.current?.focus()
      }
    } catch (error) { setError(errorMessage(error)) }
  }

  return <form className="card stack" onSubmit={submit}>
    {added > 0 && <p role="status" className="muted">{added} {added === 1 ? 'grocery' : 'groceries'} added this session.</p>}
    <div className="form-grid">
      <div className="full">
        <Field label="Item name"><input ref={nameInput} value={values.name} list={nameChanged ? suggestionsId : undefined} maxLength={120} autoComplete="off" onChange={(event) => update('name', event.target.value)} onBlur={recall} required readOnly={!nameChanged} /></Field>
        {nameChanged && <datalist id={suggestionsId}>{kitchen.ingredients.map((row) => <option key={row.id} value={row.name} />)}</datalist>}
      </div>
      <Field label="Tracking mode"><select value={values.mode} disabled={!!batch} onChange={(event) => {
        const mode = event.target.value as Mode
        setValues((current) => ({ ...current, mode, unit: modeUnits[mode][0], quantity: '1' }))
      }}><option value="count">Count</option><option value="exact">Exact measurement</option><option value="approximate">Approximate level</option></select></Field>
      {values.mode === 'approximate'
        ? <Field label="Remaining level"><select value={values.quantity} onChange={(event) => update('quantity', event.target.value)}>{levels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
        : <>
          <Field label="Quantity"><input value={values.quantity} onChange={(event) => update('quantity', event.target.value)} type="number" inputMode={values.mode === 'count' ? 'numeric' : 'decimal'} min={batch ? 0 : values.mode === 'count' ? 1 : .00000001} max={1000000} step={values.mode === 'count' ? 1 : .00000001} required /></Field>
          <Field label="Unit"><select value={values.unit} disabled={!!batch} onChange={(event) => update('unit', event.target.value as Unit)}><UnitOptions options={modeUnits[values.mode]} /></select></Field>
        </>}
      <Field label="Category"><select value={values.category} disabled={!!batch} onChange={(event) => update('category', event.target.value)}>{categoryOptions.map((category) => <option key={category}>{category}</option>)}</select></Field>
      <Field label="Storage location"><select value={values.location_id} onChange={(event) => update('location_id', event.target.value)} required>{kitchen.locations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
      <Field label="Purchase date"><input type="date" value={values.purchased_on} onChange={(event) => update('purchased_on', event.target.value)} required /></Field>
      <Field label="Printed date" hint="Leave blank when the package has no date."><input type="date" value={values.printed_on} onChange={(event) => update('printed_on', event.target.value)} /></Field>
      {values.printed_on && <Field label="Printed date type"><select value={values.printed_type} onChange={(event) => update('printed_type', event.target.value as DateType)}>{Object.entries(dateNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
    </div>
    <details open={barcode || product ? true : undefined}>
      <summary>Package, freshness and notes</summary>
      <div className="form-grid form-details">
        {!batch && <>
          <Field label="Barcode"><input inputMode="numeric" value={values.barcode} maxLength={14} pattern="[0-9]{8,14}" onChange={(event) => update('barcode', event.target.value)} /></Field>
          {values.barcode.length === 8 && !barcode && <Field label="Barcode format"><select value={barcodeFormat} onChange={(event) => setBarcodeFormat(event.target.value as 'GTIN' | 'UPC_E')}><option value="GTIN">EAN-8</option><option value="UPC_E">UPC-E</option></select></Field>}
          <Field label="Brand"><input value={values.brand} maxLength={120} onChange={(event) => update('brand', event.target.value)} /></Field>
          <Field label="Package size on label"><input value={values.package_label} maxLength={120} onChange={(event) => update('package_label', event.target.value)} /></Field>
          {values.mode === 'count' && <>
            <Field label="Net amount per package"><input type="number" inputMode="decimal" min=".00000001" max="1000000" step=".00000001" value={values.net_quantity} onChange={(event) => update('net_quantity', event.target.value)} /></Field>
            {values.net_quantity && <Field label="Net amount unit"><select value={values.net_unit} onChange={(event) => update('net_unit', event.target.value as Unit)}><UnitOptions options={measureUnits} /></select></Field>}
          </>}
        </>}
        <Field label="Estimated freshness date" hint="A reminder you enter yourself."><input type="date" value={values.estimated_on} onChange={(event) => update('estimated_on', event.target.value)} /></Field>
        <Field label="Price"><input type="number" min="0" max="9999999999.99" step=".01" value={values.price} onChange={(event) => update('price', event.target.value)} /></Field>
        <Field label="Opened on"><input type="date" value={values.opened_on} onChange={(event) => update('opened_on', event.target.value)} /></Field>
        <Field label="Frozen on"><input type="date" value={values.frozen_on} onChange={(event) => update('frozen_on', event.target.value)} /></Field>
        <Field label="Thawed on"><input type="date" value={values.thawed_on} onChange={(event) => update('thawed_on', event.target.value)} /></Field>
        <div className="full"><Field label="Notes"><textarea value={values.notes} maxLength={2000} onChange={(event) => update('notes', event.target.value)} /></Field></div>
      </div>
    </details>
    {error && <Alert>{error}</Alert>}
    <div className="row"><Button type="submit" disabled={busy}><PackagePlus size={18} />{busy ? 'Saving…' : submitLabel ?? (batch ? 'Save batch' : 'Add grocery')}</Button></div>
  </form>
}

export function AddGrocery() {
  const { kitchen } = useKitchen()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const itemId = params.get('shopping')
  const item = kitchen.shopping_items.find((row) => row.id === itemId && row.purchased && !row.stocked)
  return <>
    <PageTitle label="Grocery intake" title={item ? 'Stock a purchased item' : 'Add groceries'} action={<Link className="button secondary" to="/kitchen/scan"><Barcode size={19} />Scan barcode</Link>}>
      {item ? 'Confirm the purchased quantity and where you put it away.' : 'Add one grocery at a time. The form stays open while you put everything away.'}
    </PageTitle>
    {itemId && !item ? <Alert>This item is no longer available to stock. <Link className="underline" to="/shopping">Go to Shopping</Link></Alert>
      : <GroceryForm key={item?.id ?? 'new'} item={item} onSaved={item ? () => navigate(`/shopping?list=${item.list_id}`) : undefined} />}
    <Link className="button quiet justify-self-start" to={item ? '/shopping' : '/kitchen'}><ArrowLeft size={17} />{item ? 'Shopping' : 'Back to Kitchen'}</Link>
  </>
}

export function FreshnessBadge({ batch, window }: { batch: Batch; window: number }) {
  const status = freshness(batch, window)
  const date = freshnessDate(batch)
  return <span className={`badge ${status === 'past' ? 'late' : status === 'soon' ? 'warn' : ''}`}>{date ? `${dateStatus[status]} · ${displayDate(date)}` : 'Date unknown'}</span>
}

export function Inventory() {
  const { kitchen } = useKitchen()
  const [params] = useSearchParams()
  const [query, setQuery] = useState('')
  const [location, setLocation] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState(params.get('fresh') === 'soon' ? 'soon' : '')
  const [order, setOrder] = useState(params.get('fresh') ? 'date' : 'name')
  const ingredients = new Map(kitchen.ingredients.map((ingredient) => [ingredient.id, ingredient]))
  const locations = new Map(kitchen.locations.map((item) => [item.id, item.name]))
  const results = new Map<string, Batch[]>()
  const window = kitchen.preferences.freshness_days
  const selected = activeBatches(kitchen).filter((batch) => {
    const ingredient = ingredients.get(batch.ingredient_id)
    const product = kitchen.products.find((row) => row.id === batch.product_id)
    const text = [ingredient?.name, product?.brand, product?.barcode, batch.notes].join(' ').toLowerCase()
    return (!location || batch.location_id === location) && (!category || ingredient?.category === category)
      && (!status || freshness(batch, window) === status) && text.includes(query.trim().toLowerCase())
  })
  for (const batch of sortBatches(selected)) results.set(batch.ingredient_id, [...(results.get(batch.ingredient_id) ?? []), batch])
  const nextDate = (batches: Batch[]) => batches.map(freshnessDate).filter(Boolean).sort()[0] ?? '9999'
  const groups = [...results].sort(([a, batchesA], [b, batchesB]) =>
    (order === 'date' ? nextDate(batchesA).localeCompare(nextDate(batchesB)) : 0)
    || (ingredients.get(a)?.name ?? '').localeCompare(ingredients.get(b)?.name ?? ''))
  const freshnessItems = activeBatches(kitchen).filter((batch) => batch.quantity > 0)
  const soon = freshnessItems.filter((batch) => freshness(batch, window) === 'soon').length
  const past = freshnessItems.filter((batch) => freshness(batch, window) === 'past').length

  return <>
    <PageTitle label="Inventory" title="Your kitchen" action={<div className="row">
      <Link className="button secondary" to="/kitchen/scan"><Barcode size={18} /> Scan</Link>
      <Link className="button primary" to="/kitchen/add"><PackagePlus size={18} /> Add groceries</Link>
    </div>}>See what you have, where it’s stored and which batches to use first.</PageTitle>
    <section className="card row between" aria-label="Freshness overview">
      <div className="row"><CalendarClock size={22} /><div><h3>Freshness overview</h3><p className="muted">Entered dates are reminders. Check the food and its label.</p></div></div>
      <div className="row">
        <Button variant={status === 'soon' ? 'primary' : 'secondary'} onClick={() => { setStatus(status === 'soon' ? '' : 'soon'); setOrder('date') }}>{soon} due in {window} days</Button>
        <Button variant={status === 'past' ? 'primary' : 'secondary'} onClick={() => { setStatus(status === 'past' ? '' : 'past'); setOrder('date') }}>{past} past date</Button>
      </div>
    </section>
    <section className="card form-grid" aria-label="Inventory filters">
      <Field label="Search inventory" icon={<Search size={17} aria-hidden="true" />}><input type="search" placeholder="Name, brand or barcode" value={query} onChange={(event) => setQuery(event.target.value)} /></Field>
      <Field label="Location"><select value={location} onChange={(event) => setLocation(event.target.value)}><option value="">All locations</option>{kitchen.locations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
      <Field label="Category"><select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All categories</option>{[...new Set(kitchen.ingredients.map((row) => row.category))].sort().map((row) => <option key={row}>{row}</option>)}</select></Field>
      <Field label="Freshness"><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All dates</option>{Object.entries(dateStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <Field label="Sort by"><select value={order} onChange={(event) => setOrder(event.target.value)}><option value="name">Item name</option><option value="date">Earliest entered date</option></select></Field>
    </section>
    <Section title={`Ingredients and products (${groups.length})`}>
      {!groups.length && <Empty title={kitchen.inventory_batches.length ? 'No matching batches' : 'Your shelves are empty'} to="/kitchen/add" action="Add groceries">Add a grocery or change the filters to see more items.</Empty>}
      {groups.map(([id, batches]) => {
        const ingredient = ingredients.get(id)
        return <details className="card batch-group" key={id} open={groups.length <= 4 ? true : undefined}>
          <summary><div className="row between"><div><h3>{ingredient?.name}</h3><p className="muted">{ingredient?.category} · {batches.length} {batches.length === 1 ? 'batch' : 'batches'}</p></div><span className="badge">{combinedQuantities(batches)}</span></div></summary>
          <div className="stack form-details">{batches.map((batch) => <BatchCard key={batch.id} batch={batch} name={ingredient?.name ?? 'Item'} location={locations.get(batch.location_id) ?? 'Unknown'} window={window} />)}</div>
        </details>
      })}
    </Section>
  </>
}

function BatchCard({ batch, name, location, window }: { batch: Batch; name: string; location: string; window: number }) {
  const { inventory, kitchen, busy } = useKitchen()
  const [panel, setPanel] = useState<'' | 'adjust' | 'edit' | 'consume' | 'move' | 'thaw'>('')
  const [amount, setAmount] = useState('')
  const [destination, setDestination] = useState('')
  const product = kitchen.products.find((row) => row.id === batch.product_id)
  const leftover = kitchen.prepared_leftovers.find((row) => row.batch_id === batch.id)
  async function change(action: 'adjust' | 'consume' | 'move' | 'open' | 'freeze' | 'thaw' | 'discard', data: Record<string, unknown> = {}) {
    try {
      await inventory(action, { id: batch.id, revision: batch.revision, ...data })
      setPanel('')
    } catch { /* The workspace shows the operation error. */ }
  }
  function show(next: typeof panel) {
    setPanel(panel === next ? '' : next)
    setAmount(next === 'adjust' ? String(batch.quantity) : batch.mode === 'approximate' ? '0' : '1')
    setDestination(next === 'thaw' ? kitchen.locations.find((row) => row.name === 'Refrigerator')?.id ?? batch.location_id : batch.location_id)
  }
  return <article className="batch">
    <div className="row between"><h3>{location} · {formatQuantity(batch.quantity, batch.unit)}</h3><FreshnessBadge batch={batch} window={window} /></div>
    <p className="muted">Purchased {displayDate(batch.purchased_on)}{batch.printed_on && batch.printed_type ? ` · ${dateNames[batch.printed_type]} ${displayDate(batch.printed_on)}` : ''}{batch.estimated_on ? ` · Estimated ${displayDate(batch.estimated_on)}` : ''}</p>
    {(batch.opened_on || batch.frozen_on || batch.thawed_on) && <p className="muted">{[
      batch.opened_on && `Opened ${displayDate(batch.opened_on)}`, batch.frozen_on && `Frozen ${displayDate(batch.frozen_on)}`, batch.thawed_on && `Thawed ${displayDate(batch.thawed_on)}`,
    ].filter(Boolean).join(' · ')}</p>}
    {product && <p className="muted">{[product.brand, product.package_label, product.barcode].filter(Boolean).join(' · ')}</p>}
    {leftover && <p className="muted">Prepared food · {leftover.portions_prepared} portions made, {leftover.portions_eaten} eaten when cooked</p>}
    {batch.notes && <p>{batch.notes}</p>}
    <div className="row">
      <Button variant="secondary" onClick={() => show('adjust')}>Adjust quantity</Button>
      <Button variant="quiet" onClick={() => show('edit')}>Edit batch</Button>
      <Button variant="quiet" onClick={() => show('move')}>Move</Button>
      {batch.quantity > 0 && <Button variant="quiet" onClick={() => show('consume')}>{leftover ? 'Eat leftovers' : 'Consume'}</Button>}
      {!batch.opened_on && <Button variant="quiet" disabled={busy} onClick={() => void change('open', { date: localDate() })}>Mark opened</Button>}
      {!batch.is_frozen && <Button variant="quiet" disabled={busy} onClick={() => void change('freeze', { date: localDate() })}>Freeze</Button>}
      {batch.is_frozen && <Button variant="quiet" onClick={() => show('thaw')}>Thaw</Button>}
      <Button variant="danger" disabled={busy} onClick={() => { if (confirm(`Discard this batch of ${name}?`)) void change('discard') }}>Discard</Button>
    </div>
    {panel === 'edit' && <GroceryForm batch={batch} onSaved={() => setPanel('')} />}
    {(panel === 'move' || panel === 'thaw') && <form className="row" onSubmit={(event) => { event.preventDefault(); void change(panel, { location_id: destination, date: localDate() }) }}>
      <div className="grow"><Field label="Destination"><select value={destination} onChange={(event) => setDestination(event.target.value)} required>{kitchen.locations.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field></div>
      <Button type="submit" disabled={busy}>{panel === 'thaw' ? 'Confirm thaw' : 'Confirm move'}</Button>
    </form>}
    {(panel === 'adjust' || panel === 'consume') && <form className="row" onSubmit={(event) => {
      event.preventDefault()
      if (panel === 'consume') {
        if (batch.mode === 'approximate') void change('adjust', { quantity: Number(amount) })
        else void change('consume', { amount: Number(amount) })
      } else void change('adjust', { quantity: Number(amount) })
    }}>
      <div className="grow">
        {batch.mode === 'approximate' ? <Field label="New level"><select value={amount} onChange={(event) => setAmount(event.target.value)}>{levels.filter(([value]) => panel === 'adjust' || value <= batch.quantity).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          : <Field label={panel === 'adjust' ? 'New quantity' : 'Amount to consume'}><input type="number" inputMode="decimal" min={panel === 'adjust' ? 0 : batch.mode === 'count' ? 1 : .00000001} max={panel === 'adjust' ? 1000000 : batch.quantity} step={batch.mode === 'count' ? 1 : .00000001} value={amount} onChange={(event) => setAmount(event.target.value)} required /></Field>}
      </div>
      <Button type="submit" disabled={busy}>Confirm</Button>
    </form>}
  </article>
}
