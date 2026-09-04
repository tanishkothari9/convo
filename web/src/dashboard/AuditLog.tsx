import { useEffect, useMemo, useState } from 'react'
import { api, type AuditEntry } from '../lib/api'
import { money, when } from '../lib/format'
import { PageHead } from './Layout'
import { outcomeClass } from './Overview'

/** Plain names for the actions. The customer-facing product never shows these. */
export const ACTION_LABELS: Record<string, string> = {
  'cart.locked': 'Cart locked',
  'order.created': 'Order created',
  'payment.attempted': 'Payment attempted',
  'payment.confirmed': 'Payment confirmed',
  'payment.failed': 'Payment failed',
  'payment.signature_rejected': 'Signature rejected',
  'order.refunded': 'Order refunded',
  'checkout.blocked': 'Checkout stopped',
  'catalog.synced': 'Catalogue synced',
  'agent.tool_held': 'Agent action held',
}

const FILTERS = [
  { key: 'all', label: 'Everything' },
  { key: 'ok', label: 'Completed' },
  { key: 'blocked', label: 'Stopped' },
  { key: 'failed', label: 'Failed' },
] as const

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    api
      .get<{ entries: AuditEntry[] }>('/dashboard/audit')
      .then((r) => setEntries(r.entries))
      .catch(() => setEntries([]))
  }, [])

  const visible = useMemo(
    () => (entries ?? []).filter((e) => filter === 'all' || e.outcome === filter),
    [entries, filter],
  )

  if (!entries) return <div className="boot" aria-busy="true" />

  return (
    <>
      <PageHead
        title="Audit trail"
        lede="Every money action the agent took, what it was worth, and whether it went through. Append-only."
      />

      {entries.length === 0 ? (
        <div className="empty">
          <p className="empty-title">Nothing logged yet</p>
          <p className="empty-body">
            The first cart lock, order, or payment attempt on your chat link will appear here with
            its amount, its outcome, and the reason the agent gave.
          </p>
        </div>
      ) : (
        <>
          <div className="filter-row" role="group" aria-label="Filter by outcome">
            {FILTERS.map((option) => (
              <button
                key={option.key}
                className={`chip${filter === option.key ? ' is-selected' : ''}`}
                onClick={() => setFilter(option.key)}
                aria-pressed={filter === option.key}
              >
                {option.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="t-secondary" style={{ padding: 'var(--space-6) 0' }}>
              Nothing {FILTERS.find((f) => f.key === filter)?.label.toLowerCase()} yet.
            </p>
          ) : (
            <div className="table-scroll">
              <table className="table audit-table">
                <thead>
                  <tr>
                    <th>Action</th>
                    <th>Outcome</th>
                    <th className="cell-right">Amount</th>
                    <th>Order</th>
                    <th className="cell-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((entry) => (
                    <>
                      <tr
                        key={entry.id}
                        className="audit-row"
                        onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                        data-expanded={expanded === entry.id}
                      >
                        <td className="cell-strong">{ACTION_LABELS[entry.actionType] ?? entry.actionType}</td>
                        <td>
                          <span className={`badge badge-dot ${outcomeClass(entry.outcome)}`}>
                            {entry.outcome}
                          </span>
                        </td>
                        <td className="cell-right t-num">
                          {entry.amountMinor === null ? '—' : money(entry.amountMinor, entry.currency ?? 'INR')}
                        </td>
                        <td className="t-id">{entry.orderId ?? entry.cartId ?? '—'}</td>
                        <td className="cell-right t-muted">{when(entry.createdAt)}</td>
                      </tr>
                      {expanded === entry.id && (
                        <tr key={`${entry.id}-detail`} className="audit-detail-row">
                          <td colSpan={5}>
                            <div className="audit-detail">
                              {entry.reasoning && (
                                <div>
                                  <p className="t-xs t-muted">What the agent said it was doing</p>
                                  <p className="t-sm">{entry.reasoning}</p>
                                </div>
                              )}
                              {entry.detail && (
                                <div>
                                  <p className="t-xs t-muted">Detail</p>
                                  <pre className="audit-json">{JSON.stringify(entry.detail, null, 2)}</pre>
                                </div>
                              )}
                              <div>
                                <p className="t-xs t-muted">Recorded</p>
                                <p className="t-sm t-num">{new Date(entry.createdAt).toLocaleString('en-IN')}</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  )
}
