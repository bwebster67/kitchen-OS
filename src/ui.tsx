import { cloneElement, useId } from 'react'
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
import { AlertCircle, ArrowRight, Check, Leaf } from 'lucide-react'
import { Link } from 'react-router'

export function Brand() {
  return <div className="brand"><img src="/icon.svg" alt="" width="42" height="42" /><span>Kitchen <strong>OS</strong><small>YOUR KITCHEN, IN ORDER</small></span></div>
}

export function PageTitle({ label, title, children, action }: { label: string; title: string; children: ReactNode; action?: ReactNode }) {
  return <header className="page-title"><div><p className="eyebrow">{label}</p><h1>{title}</h1><p className="lede">{children}</p></div>{action}</header>
}

export function Button({ variant = 'primary', className = '', type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger' }) {
  return <button type={type} className={`button ${variant} ${className}`} {...props} />
}

export function Field({ label, hint, icon, children }: {
  label: string; hint?: string; icon?: ReactNode
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>
}) {
  const id = useId()
  const control = cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })
  return <div className="field">
    <label htmlFor={id}>{label}</label>
    {icon ? <div className="search-field">{icon}{control}</div> : control}
    {hint && <small id={`${id}-hint`}>{hint}</small>}
  </div>
}

export function Alert({ children, kind = 'error' }: { children: ReactNode; kind?: 'error' | 'info' | 'success' }) {
  const Icon = kind === 'success' ? Check : AlertCircle
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><Icon size={18} aria-hidden="true" /><div>{children}</div></div>
}

export function Empty({ title, children, to, action }: { title: string; children: ReactNode; to?: string; action?: string }) {
  return <div className="empty"><span className="empty-icon"><Leaf size={23} /></span><h3>{title}</h3><p>{children}</p>{to && action && <Link className="button secondary" to={to}>{action}<ArrowRight size={16} /></Link>}</div>
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  const id = useId()
  return <section className="section" aria-labelledby={id}><div className="section-title"><h2 id={id}>{title}</h2>{action}</div>{children}</section>
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return 'Something went wrong. Please try again.'
}
