import { ArrowRight, Barcode, CalendarClock, ChefHat, CookingPot, History, PackagePlus, ShoppingBag, ShoppingCart, Sprout, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { useKitchen } from './context'
import { activeBatches, formatQuantity, freshness, freshnessDate, localDate, lowStock, recommendations } from './domain'
import { FreshnessBadge } from './Inventory'
import { Empty, Section } from './ui'

const quickActions = [
  { to: '/kitchen/add', label: 'Add groceries', detail: 'Log what you brought home', icon: PackagePlus, tone: 'peach' },
  { to: '/kitchen/scan', label: 'Scan barcode', detail: 'Look up a packaged item', icon: Barcode, tone: 'blue' },
  { to: '/meals/cook', label: 'Create a meal', detail: 'Cook with what you have', icon: ChefHat, tone: 'lilac' },
  { to: '/shopping', label: 'Shopping lists', detail: 'Plan the next grocery run', icon: ShoppingCart, tone: 'mint' },
]

export function Home() {
  const { kitchen } = useKitchen()
  const batches = activeBatches(kitchen).filter((batch) => batch.quantity > 0)
  const total = new Set(batches.map((batch) => batch.ingredient_id)).size
  const window = kitchen.preferences.freshness_days
  const due = batches.filter((batch) => freshness(batch, window) === 'soon')
    .sort((a, b) => (freshnessDate(a) ?? '').localeCompare(freshnessDate(b) ?? ''))
  const low = lowStock(kitchen)
  const ideas = recommendations(kitchen).slice(0, 6)
  const recent = kitchen.cooking_events.filter((event) => !event.reversed_at).sort((a, b) => b.cooked_at.localeCompare(a.cooked_at)).slice(0, 4)
  const itemName = (id: string) => kitchen.ingredients.find((row) => row.id === id)?.name ?? 'Item'
  return <>
    <header className="home-hero">
      <div className="stack hero-copy">
        <p className="eyebrow">{new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p>
        <h1>What’s in the kitchen?</h1>
        <p>See what you have, use what’s due soon, and make a plan for dinner.</p>
        <div className="row"><Link className="button hero-button" to="/kitchen/add"><PackagePlus size={18} /> Add groceries</Link><Link className="button hero-link" to="/kitchen">Open kitchen <ArrowRight size={17} /></Link></div>
      </div>
      <div className="hero-art" aria-hidden="true"><svg viewBox="0 0 316 254" fill="none" stroke="var(--dark-ink)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="169" cy="134" r="106" fill="var(--dark-ink)" />
        <circle cx="160" cy="126" r="106" fill="#f8eedb" />
        <circle cx="160" cy="126" r="87" stroke="#8b759a" strokeDasharray="3 8" />
        <path d="M85 130c0-23 14-39 34-39 12 0 15 5 25 3 17-4 32 11 32 32 0 26-18 47-45 47-26 0-46-16-46-43Z" fill="var(--peach)" />
        <path d="M130 100c-4-13-15-18-25-17 3 9 10 15 24 17-13 2-16 8-19 15 12 0 18-5 22-12 6 6 13 8 20 7-3-8-7-12-15-13 8-5 10-10 11-17-9 2-15 7-18 20Z" fill="var(--lime)" />
        <path d="M99 133c1 11 8 19 17 22" />
        <path d="M191 116c-22 4-37-14-33-31 15-1 30 4 36 19-4-22 6-39 25-46 10 17 6 38-10 55Z" fill="var(--mint)" />
        <path d="M200 109l13-35m-19 35-23-17" />
        <path d="M193 108c15-9 31 4 25 21-7 20-34 52-52 66-7 5-11 2-9-5 5-26 18-69 36-82Z" fill="var(--amber)" />
        <path d="m182 124 12 6m-23 14 11 6m-17 14 7 4" />
        <path d="M41 51v28M27 65h28m225 99v25m-12-12h25" />
        <circle cx="279" cy="77" r="6" fill="var(--lime)" /><circle cx="43" cy="190" r="5" fill="var(--peach)" />
      </svg></div>
    </header>
    <div className="stats">
      <Stat to="/kitchen" tone="peach" icon={<ShoppingBag size={21} />} number={total} label="Inventory items" detail={`${batches.length} active batches`} />
      <Stat to="/kitchen?fresh=soon" tone="amber" icon={<CalendarClock size={21} />} number={due.length} label="Due soon" detail={`Within ${window} days`} />
      <Stat to="/shopping" tone="mint" icon={<TriangleAlert size={21} />} number={low.length} label="Low stock" detail="Ingredients to replenish" />
    </div>
    <Section title="Quick actions"><div className="quick-grid">{quickActions.map(({ to, label, detail, icon: Icon, tone }) => <Link className="card quick-action" to={to} data-tone={tone} key={to}>
      <span className="quick-icon"><Icon size={21} /></span><div><strong>{label}</strong><small>{detail}</small></div><ArrowRight className="quick-arrow" size={17} />
    </Link>)}</div></Section>
    <div className="dashboard-grid">
      <Section title="Use soon" action={<Link className="text-link" to="/kitchen?fresh=soon">View dates <ArrowRight size={15} /></Link>}>
        {due.length ? <div className="card stack">{due.slice(0, 5).map((batch) => <div className="row between" key={batch.id}>
          <div><h3>{itemName(batch.ingredient_id)}</h3><p className="muted">{formatQuantity(batch.quantity, batch.unit)}</p></div><FreshnessBadge batch={batch} window={window} />
        </div>)}</div> : <Empty title="Nothing due soon">Batches with entered dates appear here when they’re within your reminder window.</Empty>}
      </Section>
      <Section title="Low-stock ingredients" action={<Link className="text-link" to="/shopping">Shopping <ArrowRight size={15} /></Link>}>
        {low.length ? <div className="card stack">{low.slice(0, 5).map(({ ingredient, quantity, unit }) => <div className="row between" key={ingredient.id}><div><h3>{ingredient.name}</h3><p className="muted">{ingredient.category}</p></div><span className="badge warn">Add {formatQuantity(quantity, unit)}</span></div>)}</div>
          : <Empty title="No low-stock alerts" to="/settings" action="Manage thresholds">Set stock thresholds for the ingredients you use most.</Empty>}
      </Section>
    </div>
    <Section title="Meal ideas" action={<Link className="text-link" to="/meals">Recipe book <ArrowRight size={15} /></Link>}>
      {ideas.length ? <div className="tile-grid">{ideas.map(({ recipe, reasons }) => <article className="card stack" key={recipe.id}>
        <span className="quick-icon" data-tone="lilac"><CookingPot size={21} /></span><h3>{recipe.name}</h3><div className="row">{reasons.map((reason) => <span className="badge" key={reason}>{reason}</span>)}</div>
        <Link className="text-link" to={`/meals/cook/${recipe.id}`}>Review recipe <ArrowRight size={16} /></Link>
      </article>)}</div> : <Empty title={kitchen.recipes.length ? 'No recipes match your restrictions' : 'Start with a favorite recipe'} to="/meals" action="Open recipe book">
        {kitchen.recipes.length ? 'Review diet and allergen labels on your recipes and ingredients.' : 'Saved recipes turn into suggestions based on your pantry and preferences.'}
      </Empty>}
    </Section>
    <Section title="Recently cooked"><div className="card stack">
      {recent.length ? recent.map((meal) => <Link className="row between recent" key={meal.id} to={`/meals/history/${meal.id}`}><span className="row"><History size={17} />{meal.name}</span>
        <small>{localDate(new Date(meal.cooked_at))} · {meal.servings} servings <ArrowRight size={15} /></small></Link>)
        : <div className="row muted"><Sprout size={19} /> Your first cooked meal will appear here.</div>}
    </div></Section>
  </>
}

function Stat({ to, tone, number, label, detail, icon }: { to: string; tone: string; number: number; label: string; detail: string; icon: React.ReactNode }) {
  return <Link className="card stat" to={to} data-tone={tone}><span className="quick-icon">{icon}</span><strong>{number}</strong><span>{label}</span><small>{detail}</small></Link>
}
