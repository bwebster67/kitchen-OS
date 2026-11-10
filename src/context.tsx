import { createContext, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { fetchKitchen, initializeKitchen, inventoryOperation, manageKitchen, saveKitchenRow, deletePlan } from './data'
import type { InventoryAction, ManageAction } from './data'
import type { Kitchen } from './model'
import { Alert, Button, errorMessage } from './ui'

interface KitchenContextValue {
  kitchen: Kitchen
  session: Session
  inventory: (action: InventoryAction, data: Record<string, unknown>) => Promise<Awaited<ReturnType<typeof inventoryOperation>>>
  manage: (action: ManageAction, data: Record<string, unknown>) => Promise<string>
  save: (table: Parameters<typeof saveKitchenRow>[0], data: Record<string, unknown>) => Promise<void>
  removePlan: (id: string) => Promise<void>
  busy: boolean
  feedback: { text: string; error?: boolean; undo?: string } | null
  dismiss: () => void
}
const Context = createContext<KitchenContextValue | null>(null)

export function useKitchen() {
  const context = useContext(Context)
  if (!context) throw new Error('Kitchen context is required.')
  return context
}

export function KitchenProvider({ session, children }: { session: Session; children: ReactNode }) {
  const queryClient = useQueryClient()
  const owner = session.user.id
  const init = useQuery({ queryKey: ['initialize', owner], queryFn: initializeKitchen, staleTime: Infinity })
  const queryKey = ['kitchen', owner, init.data]
  const data = useQuery({ queryKey, queryFn: () => fetchKitchen(init.data!), enabled: !!init.data, refetchInterval: 30_000 })
  const lock = useRef(false)
  const retries = useRef(new Map<string, string>())
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<KitchenContextValue['feedback']>(null)

  async function run<T>(operation: () => Promise<T>, message: (result: T) => KitchenContextValue['feedback']): Promise<T> {
    if (lock.current) throw new Error('Another change is being saved.')
    lock.current = true
    setBusy(true)
    setFeedback(null)
    try {
      const result = await operation()
      setFeedback(message(result))
      return result
    } catch (error) {
      setFeedback({ text: errorMessage(error), error: true })
      throw error
    } finally {
      await queryClient.invalidateQueries({ queryKey })
      lock.current = false
      setBusy(false)
    }
  }

  if (!data.data) {
    const error = init.error || data.error
    return <main className="auth-card" aria-busy={!error}>
      <h1>{error ? 'Couldn’t open your kitchen' : 'Opening your kitchen…'}</h1>
      {error && <><Alert>{errorMessage(error)}</Alert><Button onClick={() => void (init.error ? init.refetch() : data.refetch())}>Try again</Button></>}
    </main>
  }

  const id = data.data.id
  return <Context.Provider value={{
    kitchen: data.data, session, busy, feedback, dismiss: () => setFeedback(null),
    inventory: (action, payload) => {
      const fingerprint = JSON.stringify([action, payload])
      const key = retries.current.get(fingerprint) ?? crypto.randomUUID()
      retries.current.set(fingerprint, key)
      return run(async () => {
        const result = await inventoryOperation(id, action, payload, key)
        retries.current.delete(fingerprint)
        return result
      }, (result) => ({ text: action === 'undo' ? 'Change reversed.' : action === 'cook' ? 'Meal recorded.' : 'Inventory updated.', undo: action !== 'undo' ? result.transaction_id : undefined }))
    },
    manage: (action, payload) => run(() => manageKitchen(id, action, payload), () => ({ text: 'Changes saved.' })),
    save: (table, payload) => run(() => saveKitchenRow(table, id, payload), () => ({ text: 'Changes saved.' })),
    removePlan: (plan) => run(() => deletePlan(id, plan), () => ({ text: 'Plan removed.' })),
  }}>
    {data.isError && <div className="sync-alert"><Alert kind="info">Couldn’t refresh from the cloud. Showing the last loaded kitchen.</Alert></div>}
    {children}
  </Context.Provider>
}
