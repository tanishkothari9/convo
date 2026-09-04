import { useEffect, useState } from 'react'
import { api, ApiError, type Product, type ProviderConnection } from '../lib/api'
import { when } from '../lib/format'
import { Toaster, useToast } from '../components/Toast'
import { Link } from 'react-router-dom'
import { IconArrow } from '../components/icons'
import { PageHead } from './Layout'

const PROVIDER_LABELS: Record<string, string> = {
  manual: 'Convo',
  razorpay: 'Razorpay',
  shopify: 'Shopify',
}

interface ProvidersPayload {
  available: Array<{ type: string; displayName: string; capabilities: { catalog: boolean; payment: boolean } }>
  connections: ProviderConnection[]
  active: ProviderConnection | null
}

export function Providers() {
  const [data, setData] = useState<ProvidersPayload | null>(null)
  const [keyId, setKeyId] = useState('')
  const [keySecret, setKeySecret] = useState('')
  const [shop, setShop] = useState('')
  const [accessToken, setAccessToken] = useState('')
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [busy, setBusy] = useState<string | null>(null)
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
  const shopify = data?.connections.find((c) => c.providerType === 'shopify')
  const catalogSource =
    data?.connections.find((c) => c.isCatalogSource)?.providerType ?? 'manual'
  const paymentProcessor =
    data?.connections.find((c) => c.isPaymentProcessor)?.providerType ?? 'manual'

  function credentialsFor(provider: string) {
    return provider === 'razorpay' ? { keyId, keySecret } : { shop, accessToken }
  }

  async function test(provider: string) {
    setBusy(`test-${provider}`)
    try {
      const result = await api.post<{ ok: boolean; detail: string }>(
        `/dashboard/providers/${provider}/test`,
        credentialsFor(provider),
      )
      setTestResult((current) => ({ ...current, [provider]: result }))
    } catch (error) {
      setTestResult((current) => ({
        ...current,
        [provider]: {
          ok: false,
          detail: error instanceof ApiError ? error.message : 'Could not reach that provider.',
        },
      }))
    } finally {
      setBusy(null)
    }
  }

  async function connect(provider: string, label: string) {
    setBusy(`connect-${provider}`)
    try {
      await api.post(`/dashboard/providers/${provider}/connect`, credentialsFor(provider))
      setKeySecret('')
      setAccessToken('')
      await load()
      show(`${label} connected. Sync your catalogue to pull items across.`)
    } catch (error) {
      show(error instanceof ApiError ? error.message : `Could not connect ${label}.`, 'danger')
    } finally {
      setBusy(null)
    }
  }

  async function sync(provider: string) {
    setBusy(`sync-${provider}`)
    try {
      const result = await api.post<{
        result: { created: number; updated: number; deactivated: number }
        products: Product[]
      }>(`/dashboard/providers/${provider}/sync`)
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

  async function disconnect(provider: string, label: string) {
    if (
      !confirm(
        `Disconnect ${label}? Your synced products stay, but Convo stops pulling from it.`,
      )
    ) {
      return
    }
    setBusy('switch')
    try {
      await api.delete(`/dashboard/providers/${provider}`)
      await load()
      show(`${label} disconnected.`)
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
        lede="Where your catalogue comes from and where payments are processed. They can be different."
      />

      {/* Two roles, stated plainly, because "which provider am I on" is the
          question this page exists to answer. */}
      <section className="role-row">
        <div className="role">
          <p className="role-label t-sm t-muted">Catalogue from</p>
          <p className="role-value">{PROVIDER_LABELS[catalogSource]}</p>
        </div>
        <div className="role">
          <p className="role-label t-sm t-muted">Payments through</p>
          <p className="role-value">{PROVIDER_LABELS[paymentProcessor]}</p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Convo catalogue</h2>
          {catalogSource === 'manual' && <span className="badge badge-ok badge-dot">Catalogue</span>}
          {paymentProcessor === 'manual' && <span className="badge badge-ok badge-dot">Payments</span>}
        </div>
        <p className="t-secondary panel-body">
          Products you add here or push through the API, with checkout on Convo&rsquo;s built-in
          test processor. It signs and verifies payments the way a live provider does, but it moves
          no money &mdash; connect a payment provider before taking real orders.
        </p>
        <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          {catalogSource !== 'manual' && (
            <button className="btn btn-secondary" onClick={() => activate('manual')} disabled={busy !== null}>
              Use the Convo catalogue
            </button>
          )}
          <Link className="btn btn-secondary" to="/dashboard/developers">
            Push products by API
            <IconArrow size={15} />
          </Link>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Shopify</h2>
          {shopify && catalogSource === 'shopify' && (
            <span className="badge badge-ok badge-dot">Catalogue</span>
          )}
          {shopify && catalogSource !== 'shopify' && <span className="badge">Connected</span>}
        </div>

        <p className="t-secondary panel-body">
          Pulls your products from the Admin API. Catalogue only &mdash; Shopify&rsquo;s checkout
          belongs to Shopify, and a customer buying inside a Convo conversation is not in it, so
          pair it with a payment provider below.
        </p>

        {shopify ? (
          <>
            <dl className="detail-grid">
              <div>
                <dt className="t-sm t-muted">Store</dt>
                <dd className="t-id">{shopify.credentialsHint ?? '—'}</dd>
              </div>
              <div>
                <dt className="t-sm t-muted">Catalogue</dt>
                <dd>
                  {shopify.syncStatus === 'ok' && shopify.lastSyncedAt
                    ? `Synced ${when(shopify.lastSyncedAt)}`
                    : shopify.syncStatus === 'error'
                      ? 'Last sync failed'
                      : 'Not synced yet'}
                </dd>
              </div>
            </dl>
            {shopify.syncError && (
              <p className="notice notice-danger" role="alert">
                {shopify.syncError}
              </p>
            )}
            <div className="row" style={{ gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={() => sync('shopify')} disabled={busy !== null}>
                {busy === 'sync-shopify' && <span className="spinner" />}
                Sync catalogue
              </button>
              {catalogSource !== 'shopify' && (
                <button className="btn btn-secondary" onClick={() => activate('shopify')} disabled={busy !== null}>
                  Use as catalogue
                </button>
              )}
              <button className="btn btn-danger" onClick={() => disconnect('shopify', 'Shopify')} disabled={busy !== null}>
                Disconnect
              </button>
            </div>
          </>
        ) : (
          <div className="connect-form">
            <div className="field-pair">
              <div className="field">
                <label className="field-label" htmlFor="shopify-shop">
                  Store name
                </label>
                <input
                  id="shopify-shop"
                  className="input"
                  value={shop}
                  onChange={(e) => setShop(e.target.value)}
                  placeholder="smart-choice"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="field-hint">The subdomain from your admin URL, before .myshopify.com</p>
              </div>
              <div className="field">
                <label className="field-label" htmlFor="shopify-token">
                  Admin API access token
                </label>
                <input
                  id="shopify-token"
                  className="input"
                  type="password"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="shpat_…"
                  autoComplete="off"
                />
                <p className="field-hint">A custom app token with read_products.</p>
              </div>
            </div>

            {testResult.shopify && (
              <p className={`notice ${testResult.shopify.ok ? 'notice-ok' : 'notice-danger'}`} role="status">
                {testResult.shopify.detail}
              </p>
            )}

            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button className="btn btn-secondary" onClick={() => test('shopify')} disabled={busy !== null}>
                {busy === 'test-shopify' && <span className="spinner" />}
                Test connection
              </button>
              <button
                className="btn btn-primary"
                onClick={() => connect('shopify', 'Shopify')}
                disabled={busy !== null}
              >
                {busy === 'connect-shopify' && <span className="spinner" />}
                Connect Shopify
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Razorpay</h2>
          {razorpay && paymentProcessor === 'razorpay' && (
            <span className="badge badge-ok badge-dot">Payments</span>
          )}
          {razorpay && paymentProcessor !== 'razorpay' && <span className="badge">Connected</span>}
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
              <button className="btn btn-primary" onClick={() => sync('razorpay')} disabled={busy !== null}>
                {busy === 'sync-razorpay' && <span className="spinner" />}
                Sync catalogue
              </button>
              {paymentProcessor !== 'razorpay' && (
                <button className="btn btn-secondary" onClick={() => activate('razorpay')} disabled={busy !== null}>
                  Take payments through Razorpay
                </button>
              )}
              <button className="btn btn-danger" onClick={() => disconnect('razorpay', 'Razorpay')} disabled={busy !== null}>
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

            {testResult.razorpay && (
              <p className={`notice ${testResult.razorpay.ok ? 'notice-ok' : 'notice-danger'}`} role="status">
                {testResult.razorpay.detail}
              </p>
            )}

            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button className="btn btn-secondary" onClick={() => test('razorpay')} disabled={busy !== null}>
                {busy === 'test-razorpay' && <span className="spinner" />}
                Test connection
              </button>
              <button
                className="btn btn-primary"
                onClick={() => connect('razorpay', 'Razorpay')}
                disabled={busy !== null}
              >
                {busy === 'connect-razorpay' && <span className="spinner" />}
                Connect Razorpay
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Something else</h2>
        </div>
        <p className="t-secondary panel-body">
          WooCommerce, or any system of your own, is three methods away &mdash;
          <code className="t-id"> fetchCatalog</code>,{' '}
          <code className="t-id">createPaymentOrder</code> and{' '}
          <code className="t-id">verifyPayment</code>. If you would rather not wait, push your
          products straight in with the API.
        </p>
        <Link className="btn btn-secondary" to="/dashboard/developers">
          Use the API instead
          <IconArrow size={15} />
        </Link>
      </section>

      <Toaster toasts={toasts} />
    </>
  )
}
