import { ArrowRight, Barcode, CalendarClock, ChefHat, CookingPot, History, PackagePlus, ShoppingBag, ShoppingCart, Sprout, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router'
import { useKitchen } from './context'
import { activeBatches, formatQuantity, freshness, freshnessDate, localDate, lowStock, recommendations } from './domain'
import { FreshnessBadge } from './Inventory'
import { Empty, Section } from './ui'

const quickActions = [
  { to: '/kitchen/add', label: 'Add groceries', detail: 'Log what you brought home', icon: PackagePlus },
  { to: '/kitchen/scan', label: 'Scan barcode', detail: 'Look up a packaged item', icon: Barcode },
  { to: '/meals/cook', label: 'Create a meal', detail: 'Cook with what you have', icon: ChefHat },
  { to: '/shopping', label: 'Shopping lists', detail: 'Plan the next grocery run', icon: ShoppingCart },
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
      <div className="hero-art" aria-hidden="true"><svg viewBox="0 0 310 260" fill="none">
        <circle cx="180" cy="125" r="109" fill="#48634a" /><circle cx="180" cy="125" r="83" stroke="#83947a" strokeDasharray="2 7" />
        <path d="M68 141h224c-11 50-54 84-112 84s-101-34-112-84Z" fill="#a7b892" stroke="#dce8cb" strokeWidth="2"/>
        <path d="M84 155h192M151 225h58" stroke="#2c5038" strokeWidth="2" strokeLinecap="round"/>
        <path d="M179 140c-4-53 16-84 58-106-2 46-21 75-58 92M179 137c-23-31-44-43-80-42 12 31 38 45 80 42Z" fill="#d9e5c6" stroke="#d9e5c6" strokeWidth="2" strokeLinejoin="round"/>
        <path d="M178 140c15-43 29-59 49-88M174 136c-19-15-42-29-62-32" stroke="#73916a" strokeWidth="2" strokeLinecap="round"/>
        <path d="M66 83v18m-9-9h18m189-33v24m-12-12h24m13 42v12m-6-6h12" stroke="#dbe6c9" strokeWidth="1.5" strokeLinecap="round"/>
        <circle cx="60" cy="128" r="3" fill="#dbe6c9"/><circle cx="246" cy="104" r="4" fill="#dbe6c9"/>
      </svg></div>
    </header>
    <div className="stats">
      <Stat to="/kitchen" icon={<ShoppingBag size={21} />} number={total} label="Inventory items" detail={`${batches.length} active batches`} />
      <Stat to="/kitchen?fresh=soon" icon={<CalendarClock size={21} />} number={due.length} label="Due soon" detail={`Within ${window} days`} />
      <Stat to="/shopping" icon={<TriangleAlert size={21} />} number={low.length} label="Low stock" detail="Ingredients to replenish" />
    </div>
    <Section title="Quick actions"><div className="quick-grid">{quickActions.map(({ to, label, detail, icon: Icon }) => <Link className="card quick-action" to={to} key={to}>
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
        <span className="quick-icon"><CookingPot size={21} /></span><h3>{recipe.name}</h3><div className="row">{reasons.map((reason) => <span className="badge" key={reason}>{reason}</span>)}</div>
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

function Stat({ to, number, label, detail, icon }: { to: string; number: number; label: string; detail: string; icon: React.ReactNode }) {
  return <Link className="card stat" to={to}><span className="quick-icon">{icon}</span><strong>{number}</strong><span>{label}</span><small>{detail}</small></Link>
}
