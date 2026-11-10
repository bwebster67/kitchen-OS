import type { ReactNode } from 'react'
import type { PendingCommand } from './model'
import { Alert, Button, Section } from './ui'

interface CommandReviewProps {
  command: PendingCommand
  children: ReactNode
  canApprove: boolean
  busy?: boolean
  onApprove: () => void
  onReject: () => void
}

/** A future integration supplies editable proposed operations and server-backed review handlers. */
export function CommandReview({ command, children, canApprove, busy, onApprove, onReject }: CommandReviewProps) {
  return <Section title="Review kitchen command">
    <div className="card stack">
      <p>{command.type.replaceAll('_', ' ')} · version {command.version} · {command.status}</p>
      {!!command.issues.length && <Alert kind="info"><ul>{command.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></Alert>}
      {children}
      {command.status === 'pending' && <div className="row">
        <Button disabled={busy || !canApprove} onClick={onApprove}>Confirm changes</Button>
        <Button variant="secondary" disabled={busy} onClick={onReject}>Reject command</Button>
      </div>}
    </div>
  </Section>
}
