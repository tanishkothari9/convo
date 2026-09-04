import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError } from '../lib/api'
import { when } from '../lib/format'
import { Toaster, useToast } from '../components/Toast'
import { IconArrow, IconCheck, IconCopy, IconGate, IconTrash } from '../components/icons'
import { PageHead } from './Layout'

interface ApiKey {
  id: string
  name: string
  prefix: string
  scope: 'read' | 'write'
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export function Developers() {
  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'read' | 'write'>('write')
  const [minted, setMinted] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const { toasts, show } = useToast()

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      setKeys((await api.get<{ keys: ApiKey[] }>('/dashboard/api-keys')).keys)
    } catch {
      setKeys([])
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const result = await api.post<{ secret: string }>('/dashboard/api-keys', {
        name: name.trim() || 'API key',
        scope,
      })
      setMinted(result.secret)
      setName('')
      await load()
    } catch (error) {
      show(error instanceof ApiError ? error.message : 'Could not create a key.', 'danger')
    } finally {
      setBusy(false)
    }
  }

  async function revoke(key: ApiKey) {
    if (!confirm(`Revoke "${key.name}"? Anything using it stops working immediately.`)) return
    try {
      await api.delete(`/dashboard/api-keys/${key.id}`)
      await load()
      show(`Revoked ${key.name}.`)
    } catch (error) {
      show(error instanceof ApiError ? error.message : 'Could not revoke that key.', 'danger')
    }
  }

  if (!keys) return <div className="boot" aria-busy="true" />

  const active = keys.filter((key) => key.revokedAt === null)

  return (
    <>
      <PageHead
        title="Developers"
        lede="Load your catalogue from whatever system already holds it, and read back what the agent sold."
        actions={
          <Link className="btn btn-secondary" to="/docs">
            API reference
            <IconArrow size={15} />
          </Link>
        }
      />

      {/*
        The one moment the secret exists. It is shown once and then only its
        prefix is ever available again, because Convo stores a digest rather
        than the key.
      */}
      {minted && (
        <section className="minted">
          <div className="minted-head">
            <span className="minted-icon">
              <IconGate size={16} />
            </span>
            <div>
              <p className="minted-title">Your new key</p>
              <p className="t-sm t-secondary">
                Copy it now. Convo stores a digest, not the key, so this is the only time it can be
                shown.
              </p>
            </div>
          </div>
          <div className="minted-value">
            <code>{minted}</code>
            <button
              className="btn btn-primary btn-sm"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(minted)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1800)
                } catch {
                  show('Could not copy. Select the key and copy it manually.', 'danger')
                }
              }}
            >
              {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button className="btn btn-ghost btn-sm minted-dismiss" onClick={() => setMinted(null)}>
            I have saved it
          </button>
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Create a key</h2>
        </div>
        <form className="key-form" onSubmit={create}>
          <div className="field">
            <label className="field-label" htmlFor="key-name">
              Name
            </label>
            <input
              id="key-name"
              className="input"
              value={name}
              maxLength={60}
              placeholder="Nightly inventory sync"
              onChange={(e) => setName(e.target.value)}
            />
            <p className="field-hint">So you can tell your keys apart later.</p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="key-scope">
              Access
            </label>
            <select
              id="key-scope"
              className="select"
              value={scope}
              onChange={(e) => setScope(e.target.value as 'read' | 'write')}
            >
              <option value="write">Read and write</option>
              <option value="read">Read only</option>
            </select>
            <p className="field-hint">
              {scope === 'write'
                ? 'Can create, update and delete products.'
                : 'Can read products, orders and the audit trail. Cannot change anything.'}
            </p>
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            Create key
          </button>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Your keys</h2>
          {active.length > 0 && <span className="badge">{active.length} active</span>}
        </div>

        {keys.length === 0 ? (
          <div className="empty">
            <span className="empty-mark">
              <IconGate size={20} />
            </span>
            <p className="empty-title">No keys yet</p>
            <p className="empty-body">
              Create one above, then push your catalogue with a single call. The reference has a
              copyable example with your key already filled in.
            </p>
            <Link className="btn btn-secondary" to="/docs">
              Read the API reference
              <IconArrow size={15} />
            </Link>
          </div>
        ) : (
          <ul className="key-list">
            {keys.map((key) => (
              <li key={key.id} className="key-row" data-revoked={key.revokedAt !== null}>
                <div className="key-main">
                  <p className="key-name">
                    {key.name}
                    {key.revokedAt && <span className="badge badge-danger">Revoked</span>}
                    {!key.revokedAt && key.scope === 'read' && <span className="badge">Read only</span>}
                  </p>
                  <p className="t-sm t-muted">
                    <code className="t-id">{key.prefix}…</code>
                    {' · '}
                    {key.lastUsedAt ? `last used ${when(key.lastUsedAt)}` : 'never used'}
                    {' · '}
                    created {when(key.createdAt)}
                  </p>
                </div>
                {!key.revokedAt && (
                  <button className="btn btn-ghost btn-sm key-revoke" onClick={() => revoke(key)}>
                    <IconTrash size={15} />
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Toaster toasts={toasts} />
    </>
  )
}
