import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AuditEntry, type Overview as OverviewData } from '../lib/api'
import { money, plural, when } from '../lib/format'
import { useCountUp } from '../lib/useCountUp'
import { Toaster, useToast } from '../components/Toast'
import {
  IconArrow,
  IconBolt,
  IconCatalogue,
  IconCheck,
  IconCopy,
  IconExternal,
  IconLink,
  IconRupee,
  IconSpark,
} from '../components/icons'
import { PageHead } from './Layout'
import { ACTION_LABELS, ACTION_ICONS } from './AuditLog'

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
        eyebrow={
          <>
            <span className="live-dot" />
            Live storefront
          </>
        }
        lede="Everything a customer sees comes from what is set up here."
      />

      {/*
        The link is the product, so it gets the one lit surface on the page —
        the tenant's own colour, which is also how the theming explains itself
        without a paragraph about it.
      */}
      <section className="link-panel" style={{ ['--brand' as string]: tenant.accentColor }}>
        <div className="link-panel-glow" aria-hidden="true" />
        <div className="link-panel-body">
          <span className="link-panel-icon">
            <IconLink size={18} />
          </span>
          <div className="link-panel-text">
            <p className="link-panel-label">Your chat link</p>
            <p className="link-panel-url">{chatUrl}</p>
          </div>
          <div className="link-panel-actions">
            <button className="btn btn-secondary btn-sm" onClick={copyLink}>
              {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <a className="btn btn-primary btn-sm" href={`/chat/${tenant.slug}`} target="_blank" rel="noreferrer">
              Open
              <IconExternal size={15} />
            </a>
          </div>
        </div>
      </section>

      <section className="stat-grid">
        <Stat
          label="Products"
          value={stats.products}
          icon={<IconCatalogue size={16} />}
          note={
            stats.products === 0
              ? undefined
              : stats.outOfStock > 0
                ? `${stats.outOfStock} out of stock`
                : 'all in stock'
          }
        />
        <Stat label="Conversations" value={stats.conversations} icon={<IconSpark size={16} />} />
        <Stat label="Paid orders" value={stats.orders} icon={<IconCheck size={16} />} />
        <Stat
          label="Taken"
          value={stats.revenueMinor}
          icon={<IconRupee size={16} />}
          format={(n) => money(n, tenant.currency)}
          accent
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Setup</h2>
        </div>
        <ul className="setup-list">
          <SetupRow
            done={stats.products > 0}
            title={
              stats.products > 0
                ? `${plural(stats.products, 'product')} in the catalogue`
                : 'Add your first product'
            }
            body={
              stats.products > 0
                ? 'The agent searches this catalogue and nothing else.'
                : 'Until there is a catalogue, the agent has nothing to show a customer.'
            }
            to="/dashboard/catalog"
            action={stats.products > 0 ? 'Manage' : 'Add products'}
          />
          <SetupRow
            done={provider?.providerType === 'razorpay'}
            title={
              provider?.providerType === 'razorpay'
                ? 'Taking payment through Razorpay'
                : 'Connect a payment provider'
            }
            body={
              provider?.providerType === 'razorpay'
                ? `Razorpay test mode${provider.credentialsHint ? `, key ${provider.credentialsHint}` : ''}. Your catalogue and your payments both come from it.`
                : 'Checkout runs on the built-in test processor, which signs and verifies payments the way a live provider does but moves no money.'
            }
            to="/dashboard/provider"
            action={provider?.providerType === 'razorpay' ? 'Manage' : 'Connect'}
          />
          <SetupRow
            done
            title={`Agent running on ${modelLabel(model.active)}`}
            body={
              model.active === 'scripted'
                ? 'Convo answers without calling out to anyone. Add an API key and switch to Claude or GPT in Settings — the skills, the gates, and the audit trail are the same either way.'
                : `Model calls go to ${modelLabel(model.active)}. The skills, the gates, and the audit trail are the same on every provider.`
            }
            to="/dashboard/settings"
            action="Change"
          />
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Recent activity</h2>
          <Link className="link-arrow t-sm" to="/dashboard/audit">
            Full audit trail
            <IconArrow size={14} />
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="empty">
            <span className="empty-mark">
              <IconBolt size={20} />
            </span>
            <p className="empty-title">Nothing has happened yet</p>
            <p className="empty-body">
              Open your chat link and buy something. Every cart lock, order, and payment lands here
              with its amount and outcome.
            </p>
            <a className="btn btn-secondary" href={`/chat/${tenant.slug}`} target="_blank" rel="noreferrer">
              Open the storefront
              <IconExternal size={15} />
            </a>
          </div>
        ) : (
          <ul className="activity">
            {recent.map((entry, index) => {
              const Icon = ACTION_ICONS[entry.actionType] ?? IconSpark
              return (
                <li
                  key={entry.id}
                  className="activity-row"
                  data-outcome={entry.outcome}
                  style={{ animationDelay: `${Math.min(index, 6) * 40}ms` }}
                >
                  <span className="activity-icon">
                    <Icon size={15} />
                  </span>
                  <span className="activity-action">{ACTION_LABELS[entry.actionType] ?? entry.actionType}</span>
                  <span className="activity-amount t-num">
                    {entry.amountMinor === null ? '' : money(entry.amountMinor, entry.currency ?? 'INR')}
                  </span>
                  <span className="activity-time t-sm t-muted">{when(entry.createdAt)}</span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Toaster toasts={toasts} />
    </>
  )
}

function Stat({
  label,
  value,
  icon,
  note,
  format,
  accent,
}: {
  label: string
  value: number
  icon: React.ReactNode
  note?: string
  format?: (n: number) => string
  accent?: boolean
}) {
  const shown = useCountUp(value)
  return (
    <div className="stat" data-accent={accent}>
      <span className="stat-icon">{icon}</span>
      <p className="stat-label t-sm">{label}</p>
      <p className="stat-value t-num">{format ? format(shown) : shown.toLocaleString('en-IN')}</p>
      {note && <p className="stat-note t-xs">{note}</p>}
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
        {done ? <IconCheck size={13} /> : <span className="setup-ring" />}
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

export function outcomeClass(outcome: string): string {
  if (outcome === 'ok') return 'badge-ok'
  if (outcome === 'blocked') return 'badge-warn'
  return 'badge-danger'
}

export function providerLabel(type: string): string {
  return type === 'razorpay' ? 'Razorpay' : 'the Convo catalogue'
}

/** Provider keys are configuration values; people read names. */
export function modelLabel(provider: string): string {
  if (provider === 'anthropic') return 'Claude'
  if (provider === 'openai') return 'GPT'
  if (provider === 'scripted') return "Convo's built-in model"
  return provider
}
