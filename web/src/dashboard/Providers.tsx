import { useEffect, useState } from 'react'
import { api, ApiError, type Product, type ProviderConnection } from '../lib/api'
import { when } from '../lib/format'
import { Toaster, useToast } from '../components/Toast'
import { PageHead } from './Layout'

interface ProvidersPayload {
  available: Array<{ type: string; displayName: string; capabilities: { catalog: boolean; payment: boolean } }>
  connections: ProviderConnection[]
  active: ProviderConnection | null
}

export function Providers() {
  const [data, setData] = useState<ProvidersPayload | null>(null)
  const [keyId, setKeyId] = useState('')
  const [keySecret, setKeySecret] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(null)
  const [busy, setBusy] = useState<'test' | 'connect' | 'sync' | 'switch' | null>(null)
  const { toasts, show } = useToast()

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      setData(await api.get<ProvidersPayload>('/dashboard/providers'))
    } catch {
      show('Could not load your providers.', 'danger')
    }
  }

  const razorpay = data?.connections.find((c) => c.providerType === 'razorpay')
  const activeType = data?.active?.providerType ?? 'manual'

  async function test() {
    setBusy('test')
    setTestResult(null)
    try {
      setTestResult(await api.post<{ ok: boolean; detail: string }>('/dashboard/providers/razorpay/test', { keyId, keySecret }))
    } catch (error) {
      setTestResult({
        ok: false,
        detail: error instanceof ApiError ? error.message : 'Could not reach Razorpay.',
      })
    } finally {
      setBusy(null)
    }
  }

  async function connect() {
    setBusy('connect')
    try {
      await api.post('/dashboard/providers/razorpay/connect', { keyId, keySecret })
      setKeySecret('')
      await load()
      show('Razorpay connected. Sync your catalogue to pull items across.')
    } catch (error) {
      show(error instanceof ApiError ? error.message : 'Could not connect Razorpay.', 'danger')
    } finally {
      setBusy(null)
    }
  }

  async function sync() {
    setBusy('sync')
    try {
      const result = await api.post<{
        result: { created: number; updated: number; deactivated: number }
        products: Product[]
      }>('/dashboard/providers/razorpay/sync')
      await load()
      const { created, updated, deactivated } = result.result
      show(
        `Synced: ${created} added, ${updated} updated${deactivated > 0 ? `, ${deactivated} hidden` : ''}.`,
      )
    } catch (error) {
      show(error instanceof ApiError ? error.message : 'Sync failed.', 'danger')
      await load()
    } finally {
      setBusy(null)
    }
  }

  async function activate(type: string) {
    setBusy('switch')
    try {
      await api.post(`/dashboard/providers/${type}/activate`)
      await load()
      show(type === 'razorpay' ? 'Selling through Razorpay.' : 'Selling through the Convo catalogue.')
    } catch (error) {
      show(error instanceof ApiError ? error.message : 'Could not switch provider.', 'danger')
    } finally {
      setBusy(null)
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect Razorpay? Your synced products stay, but checkout moves back to the Convo test processor.')) return
    setBusy('switch')
    try {
      await api.delete('/dashboard/providers/razorpay')
      await load()
      show('Razorpay disconnected.')
    } catch (error) {
      show(error instanceof ApiError ? error.message : 'Could not disconnect.', 'danger')
    } finally {
      setBusy(null)
    }
  }

  if (!data) return <div className="boot" aria-busy="true" />

  return (
    <>
      <PageHead
        title="Provider"
        lede="Where your catalogue comes from and where payments are processed."
      />

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Convo catalogue</h2>
          {activeType === 'manual' && <span className="badge badge-ok badge-dot">In use</span>}
        </div>
        <p className="t-secondary panel-body">
          Products you add in the dashboard, with checkout on Convo&rsquo;s built-in test
          processor. It signs and verifies payments the same way a live provider does, but it
          moves no money — connect a payment provider before taking real orders.
        </p>
        {activeType !== 'manual' && (
          <button className="btn btn-secondary" onClick={() => activate('manual')} disabled={busy !== null}>
            Use the Convo catalogue
          </button>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Razorpay</h2>
          {razorpay && activeType === 'razorpay' && <span className="badge badge-ok badge-dot">In use</span>}
          {razorpay && activeType !== 'razorpay' && <span className="badge">Connected</span>}
        </div>

        <p className="t-secondary panel-body">
          Pulls your catalogue from the Items API and processes payments through the Orders API,
          with every payment signature verified on Convo&rsquo;s side before an order is marked
          paid. Test keys only.
        </p>

        {razorpay ? (
          <>
            <dl className="detail-grid">
              <div>
                <dt className="t-sm t-muted">Key</dt>
                <dd className="t-id">{razorpay.credentialsHint ?? 'Convo test sandbox'}</dd>
              </div>
              <div>
                <dt className="t-sm t-muted">Catalogue</dt>
                <dd>
                  {razorpay.syncStatus === 'ok' && razorpay.lastSyncedAt
                    ? `Synced ${when(razorpay.lastSyncedAt)}`
                    : razorpay.syncStatus === 'error'
                      ? 'Last sync failed'
                      : 'Not synced yet'}
                </dd>
              </div>
            </dl>

            {razorpay.syncError && (
              <p className="notice notice-danger" role="alert">
                {razorpay.syncError}
              </p>
            )}

            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={sync} disabled={busy !== null}>
                {busy === 'sync' && <span className="spinner" />}
                {busy === 'sync' ? 'Syncing' : 'Sync catalogue'}
              </button>
              {activeType !== 'razorpay' && (
                <button className="btn btn-secondary" onClick={() => activate('razorpay')} disabled={busy !== null}>
                  Sell through Razorpay
                </button>
              )}
              <button className="btn btn-danger" onClick={disconnect} disabled={busy !== null}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <div className="connect-form">
            <div className="field-pair">
              <div className="field">
                <label className="field-label" htmlFor="rzp-key">
                  Key ID
                </label>
                <input
                  id="rzp-key"
                  className="input"
                  value={keyId}
                  onChange={(e) => setKeyId(e.target.value)}
                  placeholder="rzp_test_…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="field">
                <label className="field-label" htmlFor="rzp-secret">
                  Key secret
                </label>
                <input
                  id="rzp-secret"
                  className="input"
                  type="password"
                  value={keySecret}
                  onChange={(e) => setKeySecret(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>

            <p className="field-hint">
              Leave both blank to connect Convo&rsquo;s built-in Razorpay test sandbox, which
              answers with the same request and response shapes as the live API. Your keys are
              encrypted before they are stored and are never sent back to this page.
            </p>

            {testResult && (
              <p className={`notice ${testResult.ok ? 'notice-ok' : 'notice-danger'}`} role="status">
                {testResult.detail}
              </p>
            )}

            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button className="btn btn-secondary" onClick={test} disabled={busy !== null}>
                {busy === 'test' && <span className="spinner" />}
                Test connection
              </button>
              <button className="btn btn-primary" onClick={connect} disabled={busy !== null}>
                {busy === 'connect' && <span className="spinner" />}
                Connect Razorpay
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Other providers</h2>
        </div>
        <p className="t-secondary panel-body">
          Shopify, WooCommerce, and a generic REST catalogue are three methods away —
          <code className="t-id"> fetchCatalog</code>, <code className="t-id">createPaymentOrder</code>,
          and <code className="t-id">verifyPayment</code>. Nothing in the agent changes when one is
          added.
        </p>
      </section>

      <Toaster toasts={toasts} />
    </>
  )
}
