import { useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowLeft, CalendarDays, ChefHat, CirclePlus, CookingPot, History, Plus, Star, Trash2 } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useKitchen } from './context'
import { activeBatches, deductionsFor, displayDate, findIngredient, formatQuantity, freshness, getRecipeAvailability, levels, localDate, recipeAllowed, recommendations, scaleNeeds, sortBatches, splitList, units } from './domain'
import type { Availability, Need } from './domain'
import { UnitOptions } from './Inventory'
import type { CookingEvent, Difficulty, Recipe, Unit } from './model'
import { Alert, Button, Empty, Field, PageTitle, Section, errorMessage } from './ui'

const feedbackFlags = [
  ['too_spicy', 'Too spicy'], ['not_spicy_enough', 'Not spicy enough'], ['too_sweet', 'Too sweet'],
  ['too_salty', 'Too salty'], ['too_much_effort', 'Too much effort'],
]

export function Meals() {
  const { kitchen } = useKitchen()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('recipes')
  const recipes = kitchen.recipes.filter((recipe) =>
    [recipe.name, recipe.cuisine, ...recipe.tags].join(' ').toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  const ranked = new Map(recommendations(kitchen).map((item) => [item.recipe.id, item]))
  return <>
    <PageTitle label="Recipes and cooking" title="What’s cooking?" action={<div className="row">
      <Link className="button secondary" to="/meals/new"><Plus size={18} />New recipe</Link>
      <Link className="button primary" to="/meals/cook"><ChefHat size={18} />Create meal</Link>
    </div>}>Build a meal from what’s on hand, or save a recipe to cook again.</PageTitle>
    <nav className="row" aria-label="Meals views">
      <Button variant={tab === 'recipes' ? 'primary' : 'secondary'} aria-pressed={tab === 'recipes'} onClick={() => setTab('recipes')}><CookingPot size={18} />Recipes</Button>
      <Button variant={tab === 'planned' ? 'primary' : 'secondary'} aria-pressed={tab === 'planned'} onClick={() => setTab('planned')}><CalendarDays size={18} />Planned</Button>
      <Button variant={tab === 'history' ? 'primary' : 'secondary'} aria-pressed={tab === 'history'} onClick={() => setTab('history')}><History size={18} />History</Button>
    </nav>
    {tab === 'recipes' && <Section title="Saved recipes">
      <Field label="Find a recipe"><input type="search" placeholder="Search by name, cuisine or tag" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
      {recipes.length ? <div className="tile-grid">{recipes.map((recipe) => {
        const lines = kitchen.recipe_ingredients.filter((item) => item.recipe_id === recipe.id)
        const plan = getRecipeAvailability(lines, kitchen.inventory_batches, {}, kitchen.ingredients)
        const missing = plan.filter((item) => item.missing > 0).length
        return <article className="card stack recipe-card" key={recipe.id}>
          <div className="row between"><span className="badge">{recipe.cuisine || 'My recipe'}</span><span className={`badge ${missing ? 'warn' : ''}`}>{missing ? `${missing} short` : 'Available'}</span></div>
          <h3>{recipe.name}</h3><p className="muted">{recipe.description || `${recipe.servings} servings · ${recipe.prep_minutes + recipe.cook_minutes} min · ${recipe.difficulty}`}</p>
          <div className="row">{ranked.get(recipe.id)?.reasons.slice(1, 3).map((reason) => <span key={reason} className="badge">{reason}</span>)}</div>
          <div className="row"><Link className="button primary" to={`/meals/cook/${recipe.id}`}>View and cook</Link><Link className="button quiet" to={`/meals/edit/${recipe.id}`}>Edit</Link></div>
        </article>
      })}</div> : <Empty title={search ? 'No recipes match' : 'Your recipe book is empty'} to="/meals/new" action="Write a recipe">Save a favorite, or start from the ingredients you already have.</Empty>}
    </Section>}
    {tab === 'planned' && <PlannedMeals />}
    {tab === 'history' && <MealHistory />}
  </>
}

export function RecipeEditor() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { kitchen } = useKitchen()
  const original = kitchen.recipes.find((recipe) => recipe.id === (id ?? params.get('copy')))
  return (id || params.has('copy')) && !original
    ? <Alert>Recipe unavailable. <Link className="underline" to="/meals">Return to Meals</Link></Alert>
    : <RecipeForm key={id ?? params.get('copy') ?? 'new'} original={original} editing={!!id} />
}

function RecipeForm({ original, editing }: { original?: Recipe; editing: boolean }) {
  const { kitchen, manage, busy } = useKitchen()
  const navigate = useNavigate()
  const listId = useId()
  const [form, setForm] = useState({
    name: original ? `${original.name}${editing ? '' : ' (copy)'}`.slice(0, 120) : '', description: original?.description ?? '',
    cuisine: original?.cuisine ?? '', instructions: original?.instructions ?? '',
    prep_minutes: original?.prep_minutes ?? 0, cook_minutes: original?.cook_minutes ?? 0, servings: original?.servings ?? 2,
    difficulty: original?.difficulty ?? 'easy', spice: original?.spice ?? 0, tags: original?.tags.join(', ') ?? '',
    restrictions: original?.restrictions.join(', ') ?? '', notes: original?.notes ?? '',
  })
  const blank = () => ({ key: crypto.randomUUID(), name: '', quantity: '1', unit: 'count' as Unit, preparation_notes: '' })
  const [lines, setLines] = useState(() => original ? kitchen.recipe_ingredients.filter((line) => line.recipe_id === original.id)
    .sort((a, b) => a.position - b.position).map((line) => ({
      key: line.id, name: kitchen.ingredients.find((row) => row.id === line.ingredient_id)?.name ?? '',
      quantity: String(line.quantity), unit: line.unit, preparation_notes: line.preparation_notes ?? '',
    })) : [blank()])
  const [error, setError] = useState('')
  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) { setForm((previous) => ({ ...previous, [key]: value })) }
  function lineChange(key: string, change: Partial<(typeof lines)[number]>) {
    setLines((previous) => previous.map((line) => line.key === key ? { ...line, ...change } : line))
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      const ingredients = lines.map((line) => {
        const ingredient = findIngredient(kitchen.ingredients, line.name)
        if (!line.name.trim()) throw new Error('Enter a name for every ingredient.')
        return { ingredient_id: ingredient?.id, name: line.name.trim(), unit: line.unit,
          quantity: line.unit === 'level' ? 1 : Number(line.quantity), preparation_notes: line.preparation_notes.trim() }
      })
      const id = await manage('recipe_save', { ...form, id: editing ? original?.id : undefined, tags: splitList(form.tags), restrictions: splitList(form.restrictions), ingredients })
      navigate(`/meals/cook/${id}`)
    } catch (error) { setError(errorMessage(error)) }
  }

  return <>
    <PageTitle label="Recipe book" title={editing ? 'Edit recipe' : 'New recipe'} action={<Link className="button secondary" to="/meals"><ArrowLeft size={17} />Meals</Link>}>
      Search for a generic ingredient or type a new name. Saving a recipe never adds groceries to your inventory.
    </PageTitle>
    <form className="card stack" onSubmit={submit}>
      <div className="form-grid">
        <div className="full"><Field label="Recipe name"><input required maxLength={120} value={form.name} onChange={(event) => set('name', event.target.value)} /></Field></div>
        <Field label="Cuisine"><input value={form.cuisine} maxLength={80} onChange={(event) => set('cuisine', event.target.value)} /></Field>
        <Field label="Servings"><input type="number" min="1" max="1000" required value={form.servings} onChange={(event) => set('servings', event.target.valueAsNumber)} /></Field>
        <Field label="Prep minutes"><input type="number" min="0" max="1440" required value={form.prep_minutes} onChange={(event) => set('prep_minutes', event.target.valueAsNumber)} /></Field>
        <Field label="Cook minutes"><input type="number" min="0" max="1440" required value={form.cook_minutes} onChange={(event) => set('cook_minutes', event.target.valueAsNumber)} /></Field>
        <Field label="Difficulty"><select value={form.difficulty} onChange={(event) => set('difficulty', event.target.value as Difficulty)}><option value="easy">Easy</option><option value="moderate">Moderate</option><option value="project">Project</option></select></Field>
        <Field label="Spice level"><select value={form.spice} onChange={(event) => set('spice', Number(event.target.value))}>{['None', 'Mild', 'Medium', 'Hot', 'Very hot'].map((label, index) => <option key={label} value={index}>{label}</option>)}</select></Field>
        <div className="full"><Field label="Description"><input value={form.description} maxLength={500} onChange={(event) => set('description', event.target.value)} /></Field></div>
      </div>
      <fieldset className="stack"><legend>Ingredients</legend>
        <datalist id={listId}>{[...new Set(kitchen.ingredients.flatMap((row) => [row.name, ...(row.aliases ?? [])]))].map((name) => <option key={name} value={name} />)}</datalist>
        {lines.map((line, index) => <div className="stack" key={line.key}><div className="line-grid">
          <Field label={`Ingredient ${index + 1}`}><input list={listId} required maxLength={120} value={line.name} onChange={(event) => lineChange(line.key, { name: event.target.value })} /></Field>
          {line.unit === 'level' ? <span className="muted">Confirm after cooking</span> : <Field label="Amount"><input type="number" min=".00000001" max="1000000" step=".00000001" required inputMode="decimal" value={line.quantity} onChange={(event) => lineChange(line.key, { quantity: event.target.value })} /></Field>}
          <Field label="Unit"><select value={line.unit} onChange={(event) => lineChange(line.key, { unit: event.target.value as Unit })}><UnitOptions options={units} /></select></Field>
          <Button variant="quiet" disabled={lines.length <= 1} aria-label={`Remove ingredient ${index + 1}`} onClick={() => setLines((previous) => previous.filter((row) => row.key !== line.key))}><Trash2 size={18} /></Button>
        </div>
          <Field label={`Preparation notes for ingredient ${index + 1}`}><input maxLength={500} value={line.preparation_notes} onChange={(event) => lineChange(line.key, { preparation_notes: event.target.value })} /></Field>
        </div>)}
        <div><Button variant="secondary" disabled={lines.length >= 100} onClick={() => setLines((previous) => [...previous, blank()])}><CirclePlus size={17} />Add ingredient</Button></div>
      </fieldset>
      <div className="form-grid">
        <div className="full"><Field label="Instructions"><textarea value={form.instructions} maxLength={10000} onChange={(event) => set('instructions', event.target.value)} /></Field></div>
        <Field label="Tags" hint="Separate tags with commas."><input value={form.tags} maxLength={500} onChange={(event) => set('tags', event.target.value)} /></Field>
        <Field label="Diet and allergen labels" hint="Use reviewed, contains:milk or suitable:vegan after checking the recipe."><input value={form.restrictions} maxLength={500} onChange={(event) => set('restrictions', event.target.value)} /></Field>
        <div className="full"><Field label="Notes"><textarea value={form.notes} maxLength={2000} onChange={(event) => set('notes', event.target.value)} /></Field></div>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="row"><Button type="submit" disabled={busy}>Save recipe</Button>{editing && original && <>
        <Link className="button secondary" to={`/meals/new?copy=${original.id}`}>Duplicate</Link>
        <Button variant="danger" disabled={busy} onClick={() => {
          if (confirm(`Delete ${original.name}? Its cooking history will be kept.`)) void manage('recipe_delete', { id: original.id }).then(() => navigate('/meals')).catch(() => {})
        }}>Delete recipe</Button>
      </>}</div>
    </form>
  </>
}

export function Cook() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { kitchen } = useKitchen()
  const recipe = kitchen.recipes.find((item) => item.id === id)
  if (id && !recipe) return <Alert>Recipe unavailable. <Link className="underline" to="/meals">Return to Meals</Link></Alert>
  const requested = Number(params.get('servings'))
  return <CookForm key={id ?? 'manual'} recipe={recipe} initialServings={requested >= 1 && requested <= 1000 && Number.isInteger(requested) ? requested : recipe?.servings ?? 2} />
}

function CookForm({ recipe, initialServings }: { recipe?: Recipe; initialServings: number }) {
  const { kitchen, inventory, manage, save, busy } = useKitchen()
  const navigate = useNavigate()
  const listId = useId()
  const [servings, setServings] = useState(initialServings)
  const original = recipe ? kitchen.recipe_ingredients.filter((line) => line.recipe_id === recipe.id).sort((a, b) => a.position - b.position) : []
  const ingredientName = (id: string) => kitchen.ingredients.find((ingredient) => ingredient.id === id)?.name ?? ''
  const recipeNeeds = (count: number) => scaleNeeds(original, recipe?.servings ?? 1, count)
    .map((need) => ({ ...need, name: ingredientName(need.ingredient_id) }))
  const [needs, setNeeds] = useState<Need[]>(() => recipeNeeds(initialServings))
  const [preferred, setPreferred] = useState<Record<number, string>>({})
  const [remaining, setRemaining] = useState<Record<string, string>>({})
  const [partialReview, setPartialReview] = useState('')
  const submitted = useRef(false)
  const [name, setName] = useState(recipe?.name ?? '')
  const [notes, setNotes] = useState('')
  const [saveRecipe, setSaveRecipe] = useState(false)
  const [storeLeftovers, setStoreLeftovers] = useState(false)
  const [prepared, setPrepared] = useState(initialServings)
  const [eaten, setEaten] = useState(1)
  const [storage, setStorage] = useState(kitchen.locations.find((location) => location.name === 'Refrigerator')?.id ?? kitchen.locations[0]?.id ?? '')
  const [storedOn, setStoredOn] = useState(localDate())
  const [useBy, setUseBy] = useState('')
  const [plannedFor, setPlannedFor] = useState(localDate())
  const [error, setError] = useState('')
  const batches = activeBatches(kitchen).filter((batch) => batch.quantity > 0)
  const reviewedNeeds = needs.map((need) => ({
    ...need, ingredient_id: findIngredient(kitchen.ingredients, need.name ?? '')?.id ?? '',
  }))
  const plan = getRecipeAvailability(reviewedNeeds, batches, preferred, kitchen.ingredients)
  const missing = plan.filter((row) => row.missing > 0)
  const shortageKey = missing.length ? JSON.stringify(plan.map(({ need, missing, allocations }) =>
    [need, missing, allocations.map(({ batch, amount, contentUnit }) => [batch.id, batch.revision, amount, contentUnit])])) : ''
  const allowPartial = !!shortageKey && partialReview === shortageKey
  const selectedIngredients = kitchen.ingredients.filter((item) => reviewedNeeds.some((need) => need.ingredient_id === item.id))
  const productNames = new Map(kitchen.products.map((product) => [product.id, product.name]))
  const locationName = (id: string) => kitchen.locations.find((location) => location.id === id)?.name ?? 'Unknown'
  const names = [...new Set(kitchen.ingredients.flatMap((item) => [item.name, ...(item.aliases ?? [])]))]
  const validServings = Number.isInteger(servings) && servings >= 1 && servings <= 1000
  const validIngredients = needs.length > 0 && needs.every((need) => need.name?.trim() && need.quantity > 0 && need.quantity <= 1_000_000)
  const recipeIngredients = (lines: Need[]) => lines.map((need) => ({
    ingredient_id: need.ingredient_id || undefined, name: need.name?.trim(),
    quantity: need.quantity, unit: need.unit, preparation_notes: need.preparation_notes ?? '',
  }))
  const scaledRecipe = recipeNeeds(servings)
  const hasIngredientChanges = JSON.stringify(recipeIngredients(reviewedNeeds)) !== JSON.stringify(recipeIngredients(scaledRecipe))

  function changeNeed(index: number, update: Partial<Need>) {
    setNeeds((previous) => previous.map((row, i) => i === index ? { ...row, ...update } : row))
    if (update.name !== undefined || update.unit !== undefined) setPreferred((previous) => ({ ...previous, [index]: '' }))
  }
  function resolveIngredient(index: number) {
    const known = findIngredient(kitchen.ingredients, needs[index].name ?? '')
    if (!known || known.id === needs[index].ingredient_id) return
    const batch = sortBatches(batches.filter((row) => row.ingredient_id === known.id))[0]
    changeNeed(index, { name: known.name, ingredient_id: known.id, preparation_notes: undefined,
      ...(batch ? { unit: batch.unit, quantity: 1 } : {}) })
  }
  async function saveIngredients() {
    if (!recipe || !validIngredients || !validServings) return
    setError('')
    try {
      // The review may use a different serving count than the saved recipe.
      const ingredients = recipeIngredients(scaleNeeds(reviewedNeeds, servings, recipe.servings))
      await manage('recipe_save', { ...recipe, ingredients })
    } catch (error) { setError(errorMessage(error)) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitted.current) return
    submitted.current = true
    setError('')
    try {
      if (!name.trim() || !validServings) throw new Error('Enter a meal name and a valid number of servings.')
      if (!validIngredients) throw new Error('Name and quantify each ingredient.')
      const deductions = deductionsFor(plan, remaining, allowPartial)
      const result = await inventory('cook', {
        name, notes, servings, recipe_id: recipe?.id,
        deductions, ...(allowPartial ? { allow_partial: true } : {}),
        save_recipe: !recipe && saveRecipe ? { name, servings, notes, ingredients: recipeIngredients(reviewedNeeds) } : null,
        leftovers: storeLeftovers ? { prepared, eaten, location_id: storage, stored_on: storedOn, use_by: useBy || null } : null,
      })
      navigate(`/meals/history/${result.event_id}`)
    } catch (error) {
      submitted.current = false
      setError(errorMessage(error))
    }
  }

  return <>
    <PageTitle label={recipe ? 'Recipe review' : 'Cook from your kitchen'} title={recipe?.name ?? 'Create a meal'} action={<Link className="button secondary" to="/meals"><ArrowLeft size={17} />Meals</Link>}>
      {recipe?.description || 'Review the amounts and batches before recording the meal.'}
    </PageTitle>
    {recipe && <>
      <section className="card stack"><div className="row">
        <span className="badge">{recipe.prep_minutes + recipe.cook_minutes} minutes</span>
        <span className="badge">{recipe.difficulty}</span>{recipe.tags.map((tag) => <span className="badge" key={tag}>{tag}</span>)}
      </div>
      {recipe.instructions && <div><h2>Instructions</h2><p className="preserve">{recipe.instructions}</p></div>}
      {recipe.notes && <p className="muted preserve">{recipe.notes}</p>}
      <div className="row"><Link className="button secondary" to={`/meals/edit/${recipe.id}`}>Edit recipe</Link>
        <Field label="Plan for"><input type="date" value={plannedFor} onChange={(event) => setPlannedFor(event.target.value)} /></Field>
        <Button variant="quiet" disabled={busy || !plannedFor || !servings} onClick={() => void save('planned_meals', {
          id: crypto.randomUUID(), recipe_id: recipe.id, name: recipe.name, planned_for: plannedFor, servings,
        }).catch(() => {})}>Save plan</Button>
      </div></section>
      {!recipeAllowed(recipe, selectedIngredients, kitchen) && <Alert kind="info">This meal does not meet the dietary or allergen labels in your preferences. Review the ingredients and package labels before cooking.</Alert>}
    </>}
    <form className="card stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Meal name"><input value={name} maxLength={120} required onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="Servings" hint={recipe ? 'Changing servings resets the amounts to the scaled recipe.' : undefined}>
          <input type="number" min="1" max="1000" required value={Number.isNaN(servings) ? '' : servings} onChange={(event) => {
            const value = event.target.valueAsNumber
            setServings(value)
            if (Number.isInteger(value) && value > 0) setPrepared(value)
            if (recipe && value > 0 && value <= 1000 && Number.isInteger(value)) {
              setNeeds(recipeNeeds(value))
              setPreferred({})
            }
          }} />
        </Field>
      </div>
      <fieldset className="stack"><legend>Ingredients and deductions</legend>
        <p className="muted">Choose a saved ingredient or type a new one.</p>
        <datalist id={listId}>{names.map((ingredient) => <option key={ingredient} value={ingredient} />)}</datalist>
        {plan.map(({ need, allocations, missing, incompatible }, index) => {
          const matches = sortBatches(batches.filter((batch) => batch.ingredient_id === need.ingredient_id))
          return <div className="batch stack" key={index}>
            <div className="line-grid">
              <Field label={`Ingredient ${index + 1}`}><input list={listId} value={need.name ?? ''} maxLength={120} required
                onChange={(event) => changeNeed(index, { name: event.target.value, preparation_notes: undefined })}
                onBlur={() => resolveIngredient(index)} /></Field>
              {need.unit === 'level' ? <span className="muted">Approximate</span> : <Field label="Amount"><input type="number" inputMode="decimal" min=".00000001" max="1000000" step=".00000001" value={need.quantity || ''} required onChange={(event) => changeNeed(index, { quantity: Number(event.target.value) })} /></Field>}
              <Field label="Unit"><select value={need.unit} onChange={(event) => changeNeed(index, { unit: event.target.value as Unit, ...(event.target.value === 'level' ? { quantity: 1 } : {}) })}><UnitOptions options={units} /></select></Field>
              <Button variant="quiet" aria-label={`Remove meal ingredient ${index + 1}`} onClick={() => {
                setNeeds((previous) => previous.filter((_, i) => i !== index))
                setPreferred({})
              }}><Trash2 size={17} /></Button>
            </div>
            {matches.length > 1 && <Field label="Prefer batch"><select value={preferred[index] ?? ''} onChange={(event) => setPreferred((previous) => ({ ...previous, [index]: event.target.value }))}>
              <option value="">Automatic batch order</option>{matches.map((batch) => <option value={batch.id} key={batch.id}>
                {[batch.product_id ? productNames.get(batch.product_id) : null, locationName(batch.location_id),
                  formatQuantity(batch.quantity, batch.unit), displayDate(batch.purchased_on)].filter(Boolean).join(' · ')}
              </option>)}
            </select></Field>}
            {need.preparation_notes && <p className="muted">{need.preparation_notes}</p>}
            {need.name?.trim() && missing > 0 && <Alert kind="info">{need.unit === 'level'
              ? 'No approximate batch available.' : `Short by ${formatQuantity(missing, need.unit)}. ${incompatible
                ? 'Some stock uses incompatible units. Measure it in a compatible unit, choose a substitute, or set a known grams-per-cup conversion in Settings.'
                : 'Choose a substitute, change the amount, or confirm a partial deduction.'}`}</Alert>}
            {allocations.map(({ batch, amount, contentUnit }) => <div key={batch.id} className="row between">
              <span>{amount === undefined ? formatQuantity(batch.quantity, 'level') : formatQuantity(amount, contentUnit ?? batch.unit)} from {locationName(batch.location_id)}
                {batch.product_id && productNames.has(batch.product_id) && ` · ${productNames.get(batch.product_id)}`}
                {freshness(batch, kitchen.preferences.freshness_days) === 'past' ? ' · Past entered date' : ''}
                {batch.is_frozen ? ' · Frozen' : ''}</span>
              {amount === undefined && <Field label={`Remaining ${ingredientName(batch.ingredient_id)}`}><select required value={remaining[batch.id] ?? ''} onChange={(event) => setRemaining((previous) => ({ ...previous, [batch.id]: event.target.value }))}>
                <option value="">Confirm level</option>{levels.filter(([value]) => value <= batch.quantity).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select></Field>}
            </div>)}
          </div>
        })}
        <div className="row">
          <Button variant="secondary" disabled={needs.length >= 100} onClick={() => setNeeds((previous) => [...previous, { ingredient_id: '', name: '', quantity: 1, unit: 'count' }])}><Plus size={18} />Add meal ingredient</Button>
          {recipe && hasIngredientChanges && <Button variant="secondary" disabled={busy || !validIngredients || !validServings} onClick={() => void saveIngredients()}>Save ingredients to recipe</Button>}
        </div>
      </fieldset>
      {missing.some(({ need }) => need.name?.trim()) && <MissingShopping rows={missing} />}
      {validIngredients && !!missing.length && <label className="check"><input type="checkbox" checked={allowPartial} onChange={(event) => setPartialReview(event.target.checked ? shortageKey : '')} />
        {plan.some((row) => row.allocations.length) ? 'Record this meal and deduct only the available amounts' : 'Record this meal without deducting inventory'}
      </label>}
      <label className="check"><input type="checkbox" checked={storeLeftovers} onChange={(event) => setStoreLeftovers(event.target.checked)} />Record portions and leftovers</label>
      {storeLeftovers && <fieldset className="form-grid"><legend>Leftovers</legend>
        <Field label="Portions prepared"><input type="number" min="1" max="1000" required value={prepared || ''} onChange={(event) => setPrepared(Number(event.target.value))} /></Field>
        <Field label="Portions eaten"><input type="number" min="0" max={prepared} required value={eaten} onChange={(event) => setEaten(Number(event.target.value))} /></Field>
        <Field label="Portions remaining"><input readOnly value={Math.max(0, prepared - eaten)} /></Field>
        {prepared > eaten && <>
          <Field label="Leftovers location"><select required value={storage} onChange={(event) => setStorage(event.target.value)}>{kitchen.locations.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Storage date"><input type="date" required value={storedOn} onChange={(event) => setStoredOn(event.target.value)} /></Field>
          <Field label="Use-by reminder"><input type="date" value={useBy} onChange={(event) => setUseBy(event.target.value)} /></Field>
        </>}
      </fieldset>}
      {!recipe && <label className="check"><input type="checkbox" checked={saveRecipe} onChange={(event) => setSaveRecipe(event.target.checked)} />Save this meal as a reusable recipe</label>}
      <Field label="Cooking notes"><textarea value={notes} maxLength={2000} onChange={(event) => setNotes(event.target.value)} /></Field>
      {error && <Alert>{error}</Alert>}
      <div className="row"><Button type="submit" disabled={busy || !validIngredients || (!!missing.length && !allowPartial)}><ChefHat size={18} />Confirm cooking</Button><span className="muted">Confirmation applies all reviewed deductions together.</span></div>
    </form>
  </>
}

function MissingShopping({ rows }: { rows: Availability[] }) {
  const { kitchen, manage, busy } = useKitchen()
  const [list, setList] = useState(kitchen.shopping_lists[0]?.id ?? '')
  const items = rows.flatMap(({ need, missing }) => {
    const ingredient = kitchen.ingredients.find((row) => row.id === need.ingredient_id)
    const name = ingredient?.name ?? need.name?.trim()
    return !name ? [] : [{ ingredient_id: ingredient?.id, name, category: ingredient?.category ?? 'Other',
      quantity: need.unit === 'level' ? 1 : missing, unit: need.unit === 'level' ? 'package' : need.unit }]
  })
  const selected = kitchen.shopping_lists.some((row) => row.id === list) ? list : kitchen.shopping_lists[0]?.id
  return <div className="card row">
    {selected ? <>
      <div className="grow"><Field label="Shopping list"><select value={selected} onChange={(event) => setList(event.target.value)}>
        {kitchen.shopping_lists.map((row) => <option value={row.id} key={row.id}>{row.name}</option>)}
      </select></Field></div>
      <Button variant="secondary" disabled={busy || !items.length} onClick={() => void manage('shopping_add', { list_id: selected, items }).catch(() => {})}>Add missing ingredients</Button>
    </> : <Link to="/shopping" className="button secondary">Create a shopping list</Link>}
  </div>
}

function PlannedMeals() {
  const { kitchen, removePlan, busy } = useKitchen()
  return <Section title="Planned meals">
    {kitchen.planned_meals.length ? [...kitchen.planned_meals].sort((a, b) => a.planned_for.localeCompare(b.planned_for)).map((meal) => <article className="card row between" key={meal.id}>
      <div><h3>{meal.name}</h3><p className="muted">{displayDate(meal.planned_for)} · {meal.servings} servings</p></div>
      <div className="row">{meal.recipe_id && <Link to={`/meals/cook/${meal.recipe_id}?servings=${meal.servings}`} className="button secondary">Review meal</Link>}
        <Button variant="quiet" disabled={busy} onClick={() => { if (confirm('Remove this meal plan?')) void removePlan(meal.id).catch(() => {}) }}>Remove</Button></div>
    </article>) : <Empty title="Nothing planned yet">Open a saved recipe to plan it for another day.</Empty>}
  </Section>
}

function MealHistory() {
  const { kitchen } = useKitchen()
  const [search, setSearch] = useState('')
  const history = [...kitchen.cooking_events].filter((item) => [item.name, item.notes, new Date(item.cooked_at).toLocaleDateString(),
    ...kitchen.cooking_event_ingredients.filter((row) => row.event_id === item.id).map((row) => row.name)].join(' ').toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => b.cooked_at.localeCompare(a.cooked_at))
  return <Section title="Cooking history">
    <Field label="Search cooking history"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
    {!history.length && <Empty title="No matching cooking events">Confirmed meals appear here with the ingredients actually used.</Empty>}
    {history.map((event) => {
      const rating = kitchen.recipe_feedback.find((row) => row.event_id === event.id)?.rating
      return <article className="card row between" key={event.id}><div><h3>{event.name}</h3><p className="muted">{new Date(event.cooked_at).toLocaleDateString()} · {event.servings} servings{event.reversed_at ? ' · Reversed' : ''}</p></div>
        <div className="row">{rating && <span className="badge"><Star size={13} /> {rating}/5</span>}<Link className="button secondary" to={`/meals/history/${event.id}`}>View meal</Link></div></article>
    })}
  </Section>
}

export function EventDetail() {
  const { id } = useParams()
  const { kitchen } = useKitchen()
  const meal = kitchen.cooking_events.find((row) => row.id === id)
  if (!meal) return <Alert>Meal unavailable. <Link className="underline" to="/meals">Return to Meals</Link></Alert>
  const leftovers = kitchen.prepared_leftovers.find((row) => row.event_id === id)
  return <>
    <PageTitle label="Cooking history" title={meal.name} action={<Link className="button secondary" to="/meals"><ArrowLeft size={17} />Meals</Link>}>
      {new Date(meal.cooked_at).toLocaleString()} · {meal.servings} servings{meal.reversed_at ? ' · Reversed' : ''}
    </PageTitle>
    <Section title="Ingredients used">
      <div className="card stack">{kitchen.cooking_event_ingredients.filter((row) => row.event_id === id).map((row) => <div className="row between" key={row.id}>
        <strong>{row.name}</strong><span>{row.quantity === null
          ? `${formatQuantity(row.approximate_before ?? 0, 'level')} → ${formatQuantity(row.approximate_after ?? 0, 'level')}`
          : formatQuantity(row.quantity, row.unit)}</span>
      </div>)}
      {leftovers && <p>{leftovers.portions_prepared - leftovers.portions_eaten} portions originally stored as leftovers.</p>}
      {meal.notes && <p className="preserve">{meal.notes}</p>}</div>
    </Section>
    {!meal.reversed_at && <MealFeedback key={meal.id} meal={meal} />}
  </>
}

function MealFeedback({ meal }: { meal: CookingEvent }) {
  const { kitchen, save, busy } = useKitchen()
  const previous = kitchen.recipe_feedback.find((row) => row.event_id === meal.id)
  const [rating, setRating] = useState(previous?.rating?.toString() ?? '')
  const [again, setAgain] = useState(previous?.make_again?.toString() ?? '')
  const [flags, setFlags] = useState(previous?.flags ?? [])
  const [notes, setNotes] = useState(previous?.notes ?? '')
  return <Section title="How was it?">
    <form className="card stack" onSubmit={(event) => {
      event.preventDefault()
      void save('recipe_feedback', { event_id: meal.id, rating: rating ? Number(rating) : null, make_again: again ? again === 'true' : null, flags, notes }).catch(() => {})
    }}>
      <div className="form-grid">
        <Field label="Rating"><select value={rating} onChange={(event) => setRating(event.target.value)}><option value="">Unrated</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} / 5</option>)}</select></Field>
        <Field label="Would make again"><select value={again} onChange={(event) => setAgain(event.target.value)}><option value="">Unanswered</option><option value="true">Yes</option><option value="false">No</option></select></Field>
      </div>
      <div className="row">{feedbackFlags.map(([value, label]) => <label className="check" key={value}><input type="checkbox" checked={flags.includes(value)} onChange={(event) => setFlags((previous) => event.target.checked ? [...previous, value] : previous.filter((flag) => flag !== value))} />{label}</label>)}</div>
      <Field label="Feedback notes"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} /></Field>
      <div><Button type="submit" disabled={busy}>Save feedback</Button></div>
    </form>
  </Section>
}
