import { useState } from 'react'
import type { FormEvent } from 'react'
import { Download, LogOut, MapPin, Plus } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useKitchen } from './context'
import { exportKitchen, supabase } from './data'
import { levels, splitList, units } from './domain'
import { UnitOptions } from './Inventory'
import type { Difficulty, Ingredient, Location, Unit } from './model'
import { Alert, Button, Empty, Field, PageTitle, Section, errorMessage } from './ui'

export function Settings() {
  const { kitchen } = useKitchen()
  return <>
    <PageTitle label="Profile and settings" title="Make it yours">Set how your kitchen works, what you like to cook and when to restock.</PageTitle>
    <Preferences />
    <Locations />
    <Section title="Stock and ingredient labels">
      {kitchen.ingredients.length ? <div className="card stack"><p className="muted">Set a minimum quantity and record labels you’ve checked on the ingredient or packaging. Add <code>reviewed</code> after checking allergens and use labels such as <code>contains:milk</code>.</p>
        {[...kitchen.ingredients].sort((a, b) => a.name.localeCompare(b.name)).map((item) => <Threshold key={item.id} item={item} />)}
      </div> : <Empty title="No ingredients yet" to="/kitchen/add" action="Add groceries">Add an item or recipe ingredient before configuring stock thresholds.</Empty>}
    </Section>
    <InventoryHistory />
    <Account />
  </>
}

function Preferences() {
  const { kitchen, save, busy } = useKitchen()
  const p = kitchen.preferences
  const [values, setValues] = useState({
    favorite_cuisines: p.favorite_cuisines.join(', '), disliked_ingredients: p.disliked_ingredients.join(', '),
    dietary_restrictions: p.dietary_restrictions.join(', '), allergies: p.allergies.join(', '),
    spice: p.spice, max_minutes: p.max_minutes, complexity: p.complexity, adventurous: p.adventurous, freshness_days: p.freshness_days,
  })
  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) { setValues((previous) => ({ ...previous, [key]: value })) }
  function submit(event: FormEvent) {
    event.preventDefault()
    void save('taste_preferences', {
      ...values, favorite_cuisines: splitList(values.favorite_cuisines), disliked_ingredients: splitList(values.disliked_ingredients),
      dietary_restrictions: splitList(values.dietary_restrictions), allergies: splitList(values.allergies),
    }).catch(() => {})
  }
  return <Section title="Taste and reminders">
    <form className="card stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Favorite cuisines" hint="Separate entries with commas."><input value={values.favorite_cuisines} maxLength={500} onChange={(event) => set('favorite_cuisines', event.target.value)} /></Field>
        <Field label="Disliked ingredients"><input value={values.disliked_ingredients} maxLength={500} onChange={(event) => set('disliked_ingredients', event.target.value)} /></Field>
        <Field label="Dietary restrictions" hint="Example: vegan, gluten-free"><input value={values.dietary_restrictions} maxLength={500} onChange={(event) => set('dietary_restrictions', event.target.value)} /></Field>
        <Field label="Allergies" hint="Example: milk, peanuts"><input value={values.allergies} maxLength={500} onChange={(event) => set('allergies', event.target.value)} /></Field>
        <Field label="Spice tolerance"><select value={values.spice} onChange={(event) => set('spice', Number(event.target.value))}>{['None', 'Mild', 'Medium', 'Hot', 'Very hot'].map((item, index) => <option key={item} value={index}>{item}</option>)}</select></Field>
        <Field label="Preferred time (minutes)"><input type="number" min="1" max="2880" required value={values.max_minutes || ''} onChange={(event) => set('max_minutes', Number(event.target.value))} /></Field>
        <Field label="Preferred complexity"><select value={values.complexity} onChange={(event) => set('complexity', event.target.value as Difficulty)}><option value="easy">Easy</option><option value="moderate">Moderate</option><option value="project">Project</option></select></Field>
        <Field label="Freshness reminder (days)"><input type="number" min="1" max="90" required value={values.freshness_days || ''} onChange={(event) => set('freshness_days', Number(event.target.value))} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={values.adventurous} onChange={(event) => set('adventurous', event.target.checked)} />Include unfamiliar cuisines</label>
      <p className="muted">Recommendations require a matching <code>suitable:</code> recipe label for each diet and reviewed allergen labels when you enter allergies. Check packaging before cooking.</p>
      <div><Button type="submit" disabled={busy}>Save preferences</Button></div>
    </form>
  </Section>
}

function Locations() {
  const { kitchen, manage, busy } = useKitchen()
  const [name, setName] = useState('')
  return <Section title="Storage locations"><div className="card stack">
    <div className="row">{kitchen.locations.filter((row) => row.is_default).map((row) => <span className="badge" key={row.id}><MapPin size={14} />&nbsp;{row.name}</span>)}</div>
    {kitchen.locations.filter((row) => !row.is_default).map((location) => <CustomLocation key={location.id} location={location} />)}
    <form className="row" onSubmit={(event) => {
      event.preventDefault()
      if (name.trim()) void manage('location_add', { name }).then(() => setName('')).catch(() => {})
    }}>
      <div className="grow"><Field label="Custom location"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Garage freezer" maxLength={60} required /></Field></div>
      <Button type="submit" disabled={busy}><Plus size={17} />Add location</Button>
    </form>
  </div></Section>
}

function CustomLocation({ location }: { location: Location }) {
  const { kitchen, manage, busy } = useKitchen()
  const [name, setName] = useState(location.name)
  const used = kitchen.inventory_batches.some((batch) => batch.location_id === location.id)
  return <form className="row" onSubmit={(event) => {
    event.preventDefault()
    if (name.trim()) void manage('location_rename', { id: location.id, name }).catch(() => {})
  }}>
    <div className="grow"><Field label={`Name for ${location.name}`}><input value={name} maxLength={60} onChange={(event) => setName(event.target.value)} required /></Field></div>
    <Button variant="secondary" type="submit" disabled={busy || name === location.name}>Rename</Button>
    <Button variant="quiet" disabled={busy || used} title={used ? 'Existing batch history uses this location' : undefined} onClick={() => {
      if (confirm(`Delete ${location.name}?`)) void manage('location_delete', { id: location.id }).catch(() => {})
    }}>Delete</Button>
  </form>
}

function Threshold({ item }: { item: Ingredient }) {
  const { manage, busy } = useKitchen()
  const [quantity, setQuantity] = useState(item.low_quantity?.toString() ?? '')
  const [unit, setUnit] = useState<Unit>(item.low_unit ?? 'count')
  const [restrictions, setRestrictions] = useState(item.restrictions.join(', '))
  const [aliases, setAliases] = useState(item.aliases?.join(', ') ?? '')
  const [gramsPerCup, setGramsPerCup] = useState(item.grams_per_cup?.toString() ?? '')
  return <details className="batch"><summary>{item.name}{item.low_quantity !== null ? ' · threshold set' : ''}</summary>
    <form className="stack form-details" onSubmit={(event) => {
      event.preventDefault()
      void manage('ingredient_settings', {
        id: item.id, low_quantity: quantity === '' ? null : Number(quantity), low_unit: quantity === '' ? null : unit,
        restrictions: splitList(restrictions), aliases: splitList(aliases), grams_per_cup: gramsPerCup === '' ? null : Number(gramsPerCup),
      }).catch(() => {})
    }}>
      <div className="form-grid">
        <Field label="Threshold unit"><select value={unit} onChange={(event) => { setUnit(event.target.value as Unit); setQuantity('') }}><UnitOptions options={units} /></select></Field>
        <Field label="Low-stock threshold" hint="Leave blank to disable.">{unit === 'level' ? <select value={quantity} onChange={(event) => setQuantity(event.target.value)}>
          <option value="">Disabled</option>{levels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select> : <input type="number" min="0" max="1000000" step=".00000001" value={quantity} onChange={(event) => setQuantity(event.target.value)} />}</Field>
        <Field label="Allergen and ingredient labels"><input maxLength={500} value={restrictions} onChange={(event) => setRestrictions(event.target.value)} /></Field>
        <Field label="Ingredient aliases" hint="Enter equivalent names separated by commas."><input maxLength={500} value={aliases} onChange={(event) => setAliases(event.target.value)} /></Field>
        <Field label="Grams per US cup" hint="Optional. Use a reliable weight for one cup of this specific ingredient.">
          <input type="number" inputMode="decimal" min=".00000001" max="1000000" step=".00000001" value={gramsPerCup} onChange={(event) => setGramsPerCup(event.target.value)} />
        </Field>
      </div>
      <div><Button type="submit" variant="secondary" disabled={busy}>Save {item.name} settings</Button></div>
    </form>
  </details>
}

const actionLabels: Record<string, string> = {
  add: 'Grocery added', stock_shopping: 'Purchased item stocked', edit: 'Batch edited', adjust: 'Quantity adjusted',
  move: 'Batch moved', open: 'Marked opened', freeze: 'Batch frozen', thaw: 'Batch thawed', consume: 'Quantity consumed',
  consume_ingredients: 'Ingredients consumed', discard: 'Batch discarded', cook: 'Meal cooked', undo: 'Change reversed',
}

function InventoryHistory() {
  const { kitchen, inventory, busy } = useKitchen()
  const reversed = new Set(kitchen.inventory_transactions.map((row) => row.reverses_id))
  const recent = [...kitchen.inventory_transactions].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 20)
  return <Section title="Inventory activity">
    {recent.length ? <details className="card"><summary>Recent changes ({recent.length})</summary><div className="stack form-details">
      {recent.map((row) => <div className="row between" key={row.id}><div><strong>{actionLabels[row.action] ?? row.action}</strong>
        <p className="muted">{new Date(row.created_at).toLocaleString()}{reversed.has(row.id) ? ' · Reversed' : ''}</p></div>
        {row.action !== 'undo' && !reversed.has(row.id) && <Button variant="secondary" disabled={busy} onClick={() => {
          if (confirm('Undo this inventory change?')) void inventory('undo', { transaction_id: row.id }).catch(() => {})
        }}>Undo</Button>}
      </div>)}
    </div></details> : <Empty title="No changes yet">Your grocery and cooking transactions appear here.</Empty>}
  </Section>
}

function Account() {
  const { kitchen, session } = useKitchen()
  const query = useQueryClient()
  const [email, setEmail] = useState(session.user.email ?? '')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null)
  const [pending, setPending] = useState(false)

  async function run(operation: () => Promise<string>) {
    setMessage(null)
    setPending(true)
    try { setMessage({ text: await operation() }) }
    catch (error) { setMessage({ text: errorMessage(error), error: true }) }
    finally { setPending(false) }
  }
  return <Section title="Account and data">
    <div className="card stack">
      <p>Signed in as <strong>{session.user.email}</strong></p>
      <details><summary>Change email or password</summary><div className="stack form-details">
        <form className="row" onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            const { error } = await supabase!.auth.updateUser({ email: email.trim() })
            if (error) throw error
            return 'Check your inbox for the email change confirmation.'
          })
        }}><div className="grow"><Field label="New email"><input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field></div>
          <Button type="submit" variant="secondary" disabled={pending || email === session.user.email}>Change email</Button>
        </form>
        <form className="row" onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            const { error } = await supabase!.auth.updateUser({ password })
            if (error) throw error
            setPassword('')
            return 'Password updated.'
          })
        }}><div className="grow"><Field label="New password"><input type="password" minLength={8} autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></Field></div>
          <Button type="submit" variant="secondary" disabled={pending}>Change password</Button>
        </form>
      </div></details>
      <div className="row">
        <Button variant="secondary" disabled={pending} onClick={() => void run(async () => {
          const snapshot = { account: { id: session.user.id, email: session.user.email }, ...await exportKitchen(kitchen.id) }
          const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }))
          const link = document.createElement('a')
          link.href = url
          link.download = `kitchen-os-${new Date().toISOString().slice(0, 10)}.json`
          document.body.append(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
          return 'Kitchen export downloaded.'
        })}><Download size={17} />Export kitchen data</Button>
        <Button variant="quiet" disabled={pending} onClick={() => void run(async () => {
          const { error } = await supabase!.auth.signOut({ scope: 'local' })
          if (error) throw error
          query.clear()
          return 'Signed out.'
        })}><LogOut size={17} />Sign out</Button>
      </div>
      {message && <Alert kind={message.error ? 'error' : 'success'}>{message.text}</Alert>}
    </div>
  </Section>
}
