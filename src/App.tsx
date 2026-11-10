import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Barcode, ShoppingBasket as Basket, ChefHat, ChevronRight, House, Plus, Settings, ShoppingCart, X } from 'lucide-react'
import { Link, NavLink, Route, Routes, useLocation } from 'react-router'
import { supabase } from './data'
import { KitchenProvider, useKitchen } from './context'
import { Alert, Brand, Button, errorMessage, Field, PageTitle } from './ui'
import { Home } from './Home'
import { AddGrocery, Inventory } from './Inventory'
import { Scanner } from './Scanner'
import { Cook, EventDetail, Meals, RecipeEditor } from './Meals'
import { Shopping } from './Shopping'
import { Settings as Profile } from './Settings'

const nav = [
  { to: '/', label: 'Home', icon: House },
  { to: '/kitchen', label: 'Kitchen', icon: Basket },
  { to: '/meals', label: 'Meals', icon: ChefHat },
  { to: '/shopping', label: 'Shopping', icon: ShoppingCart },
  { to: '/settings', label: 'Settings', icon: Settings },
]
const shortcuts = [
  { to: '/kitchen/add', label: 'Add grocery', icon: Basket },
  { to: '/kitchen/scan', label: 'Scan barcode', icon: Barcode },
  { to: '/meals/cook', label: 'Create meal', icon: ChefHat },
  { to: '/shopping?add=1', label: 'Add shopping item', icon: ShoppingCart },
]

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [failed, setFailed] = useState('')
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine)
    window.addEventListener('online', sync)
    window.addEventListener('offline', sync)
    return () => {
      window.removeEventListener('online', sync)
      window.removeEventListener('offline', sync)
    }
  }, [])
  useEffect(() => {
    if (!supabase) return
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    void supabase.auth.getSession().then(({ data: current, error }) => {
      if (error) setFailed(error.message)
      setSession(current.session)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  return <>
    {!online && <div className="sync-alert"><Alert kind="info">You’re offline. Connect to refresh your kitchen or save changes.</Alert></div>}
    {!supabase ? <div className="auth"><Brand /><main className="auth-card">
      <h1>Connect your kitchen</h1>
      <p>Set the Supabase project URL and publishable key in <code>.env.local</code>, then restart the app. The README walks through setup.</p>
    </main></div> : session === undefined ? <main className="auth-card" aria-busy="true">Checking your session…</main>
      : session ? <KitchenProvider key={session.user.id} session={session}><Shell /></KitchenProvider>
        : <SignIn initialError={failed} />}
  </>
}

function SignIn({ initialError }: { initialError: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [pending, setPending] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      const result = await supabase!.auth.signInWithPassword({ email: email.trim(), password })
      if (result.error) throw result.error
    } catch (error) { setError(errorMessage(error)) }
    finally { setPending(false) }
  }

  return <div className="auth"><Brand /><main className="auth-card"><p className="eyebrow">Your personal kitchen</p>
    <h1>Welcome home.</h1><p>Sign in to pick up where you left off.</p>
    <form onSubmit={submit} className="stack">
      <Field label="Email"><input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
      <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></Field>
      {error && <Alert>{error}</Alert>}
      <Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}<ChevronRight size={18} /></Button>
    </form>
  </main></div>
}

function Shell() {
  const { busy, feedback, dismiss, inventory, kitchen } = useKitchen()
  const [menu, setMenu] = useState(false)
  const location = useLocation()
  useEffect(() => {
    setMenu(false)
    window.scrollTo(0, 0)
  }, [location.pathname, location.search])

  return <div className="shell">
    <a className="skip" href="#main">Skip to content</a>
    <aside className="rail"><Link to="/" aria-label="Kitchen OS home"><Brand /></Link>
      <p className="rail-label">Workspace</p>
      <nav aria-label="Main navigation">{nav.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'}><Icon size={20} aria-hidden="true" /><span>{label}</span></NavLink>)}</nav>
      <div className="rail-foot"><span className="status-dot" />{kitchen.name}</div>
    </aside>
    <div className="workspace">
      <div className="toolbar"><Link className="mobile-brand" to="/" aria-label="Kitchen OS home"><Brand /></Link><span className="desktop-label">PERSONAL WORKSPACE</span>
        <div className="add-wrap" onKeyDown={(event) => { if (event.key === 'Escape') setMenu(false) }}>
          <Button aria-expanded={menu} aria-controls="add-menu" onClick={() => setMenu(!menu)}><Plus size={19} aria-hidden="true" /> Add</Button>
          {menu && <div className="add-menu" id="add-menu">{shortcuts.map(({ to, label, icon: Icon }) => <Link key={to} to={to} onClick={() => setMenu(false)}><Icon size={18} aria-hidden="true" />{label}</Link>)}</div>}
        </div>
      </div>
      <main id="main" className="content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/kitchen" element={<Inventory key={location.search} />} />
          <Route path="/kitchen/add" element={<AddGrocery />} />
          <Route path="/kitchen/scan" element={<Scanner />} />
          <Route path="/meals" element={<Meals />} />
          <Route path="/meals/new" element={<RecipeEditor />} />
          <Route path="/meals/edit/:id" element={<RecipeEditor />} />
          <Route path="/meals/cook" element={<Cook />} />
          <Route path="/meals/cook/:id" element={<Cook />} />
          <Route path="/meals/history/:id" element={<EventDetail />} />
          <Route path="/shopping" element={<Shopping />} />
          <Route path="/settings" element={<Profile />} />
          <Route path="*" element={<PageTitle label="Kitchen OS" title="Page not found"><Link to="/">Return home</Link></PageTitle>} />
        </Routes>
      </main>
    </div>
    {feedback && <div className="toast"><Alert kind={feedback.error ? 'error' : 'success'}>
      <span>{feedback.text}</span>
      {feedback.undo && <Button variant="quiet" disabled={busy} onClick={() => void inventory('undo', { transaction_id: feedback.undo }).catch(() => {})}>Undo</Button>}
      <Button variant="quiet" aria-label="Dismiss message" onClick={dismiss}><X size={16} /></Button>
    </Alert></div>}
  </div>
}
