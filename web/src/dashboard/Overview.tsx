import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AuditEntry, type Overview as OverviewData } from '../lib/api'
import { money, plural, when } from '../lib/format'
import { Toaster, useToast } from '../components/Toast'
import { PageHead } from './Layout'
import { ACTION_LABELS } from './AuditLog'

export function Overview() {
  const [data, setData] = useState<OverviewData | null>(null)
  const [recent, setRecent] = useState<AuditEntry[]>([])
  const [copied, setCopied] = useState(false)
  const { toasts, show } = useToast()

  useEffect(() => {
    api.get<OverviewData>('/dashboard/overview').then(setData).catch(() => setData(null))
    api
      .get<{ entries: AuditEntry[] }>('/dashboard/audit')
      .then((r) => setRecent(r.entries.slice(0, 6)))
      .catch(() => setRecent([]))
  }, [])

  if (!data) return <div className="boot" aria-busy="true" />

  const { tenant, chatUrl, stats, provider, model } = data

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(chatUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      show('Could not copy the link. Select it and copy manually.', 'danger')
    }
  }

  return (
    <>
      <PageHead
        title={tenant.name}
        lede="Everything a customer sees comes from what is set up here."
      />

      {/* The link is the product. It gets the page's one piece of colour. */}
      <section
        className="link-card"
        style={{ ['--brand' as string]: tenant.accentColor }}
      >
        <div className="link-card-text">
          <p className="t-sm link-card-label">Your chat link</p>
          <p className="link-card-url">{chatUrl}</p>
        </div>
        <div className="link-card-actions">
          <button className="btn btn-secondary btn-sm" onClick={copyLink}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <a
            className="btn btn-primary btn-sm"
            href={`/chat/${tenant.slug}`}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
        </div>
      </section>

      <section className="stat-row">
        <Stat label="Products" value={String(stats.products)} note={stats.outOfStock > 0 ? `${stats.outOfStock} out of stock` : 'all in stock'} />
        <Stat label="Conversations" value={String(stats.conversations)} />
        <Stat label="Paid orders" value={String(stats.orders)} />
        <Stat label="Taken" value={money(stats.revenueMinor, tenant.currency)} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Setup</h2>
        </div>
        <ul className="setup-list">
          <SetupRow
            done={stats.products > 0}
            title={stats.products > 0 ? `${plural(stats.products, 'product')} in the catalogue` : 'Add your first product'}
            body={
              stats.products > 0
                ? 'The agent searches this catalogue and nothing else.'
                : 'Until there is a catalogue, the agent has nothing to show a customer.'
            }
            to="/dashboard/catalog"
            action={stats.products > 0 ? 'Manage' : 'Add products'}
          />
          <SetupRow
            done={Boolean(provider)}
            title={provider ? `Taking payment through ${providerLabel(provider.providerType)}` : 'Connect a payment provider'}
            body={
              provider?.providerType === 'razorpay'
                ? `Razorpay test mode${provider.credentialsHint ? ` · ${provider.credentialsHint}` : ''}. Catalogue and payments both come from it.`
                : 'Products live in Convo and checkout runs on the built-in test processor. Connect Razorpay to take real test-mode payments.'
            }
            to="/dashboard/provider"
            action={provider?.providerType === 'razorpay' ? 'Manage' : 'Connect'}
          />
          <SetupRow
            done
            title={`Agent running on ${model.active}`}
            body={
              model.active === 'scripted'
                ? 'The built-in deterministic provider. Set an API key and switch to Claude or GPT in Settings — the skills, gates, and audit trail do not change.'
                : `Model calls go to ${model.active}. The skills, gates, and audit trail are the same on every provider.`
            }
            to="/dashboard/settings"
            action="Change"
          />
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Recent activity</h2>
          <Link className="t-sm" to="/dashboard/audit">
            Full audit trail
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Nothing has happened yet</p>
            <p className="empty-body">
              Open your chat link and buy something. Every cart lock, order, and payment lands
              here with its amount and outcome.
            </p>
            <a className="btn btn-secondary" href={`/chat/${tenant.slug}`} target="_blank" rel="noreferrer">
              Open the storefront
            </a>
          </div>
        ) : (
          <ul className="activity">
            {recent.map((entry) => (
              <li key={entry.id} className="activity-row">
                <span className={`badge badge-dot ${outcomeClass(entry.outcome)}`}>
                  {entry.outcome}
                </span>
                <span className="activity-action">{ACTION_LABELS[entry.actionType] ?? entry.actionType}</span>
                <span className="activity-amount t-num t-secondary">
                  {entry.amountMinor === null ? '' : money(entry.amountMinor, entry.currency ?? 'INR')}
                </span>
                <span className="activity-time t-sm t-muted">{when(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Toaster toasts={toasts} />
    </>
  )
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <p className="stat-label t-sm t-muted">{label}</p>
      <p className="stat-value t-num">{value}</p>
      {note && <p className="stat-note t-xs t-muted">{note}</p>}
    </div>
  )
}

function SetupRow({
  done,
  title,
  body,
  to,
  action,
}: {
  done: boolean
  title: string
  body: string
  to: string
  action: string
}) {
  return (
    <li className="setup-row" data-done={done}>
      <span className="setup-tick" aria-hidden="true">
        {done ? <TickIcon /> : <span className="setup-ring" />}
      </span>
      <div className="setup-text">
        <p className="setup-title">{title}</p>
        <p className="t-sm t-secondary">{body}</p>
      </div>
      <Link className="btn btn-secondary btn-sm" to={to}>
        {action}
      </Link>
    </li>
  )
}

function TickIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M2.5 7.5L5.5 10.5L11.5 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function outcomeClass(outcome: string): string {
  if (outcome === 'ok') return 'badge-ok'
  if (outcome === 'blocked') return 'badge-warn'
  return 'badge-danger'
}

export function providerLabel(type: string): string {
  return type === 'razorpay' ? 'Razorpay' : 'the Convo catalogue'
}
