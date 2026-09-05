import { useEffect, useState } from 'react'
import { api, ApiError, type Overview, type Tenant } from '../lib/api'
import { Toaster, useToast } from '../components/Toast'
import { PageHead } from './Layout'
import { useAuth } from './auth'

export function Settings() {
  const { session, setTenant } = useAuth()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [form, setForm] = useState({
    name: '',
    slug: '',
    description: '',
    requiresShipping: true,
    isListed: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { toasts, show } = useToast()

  useEffect(() => {
    api.get<Overview>('/dashboard/overview').then((data) => {
      setOverview(data)
      setForm({
        name: data.tenant.name,
        slug: data.tenant.slug,
        description: data.tenant.description ?? '',
        requiresShipping: data.tenant.requiresShipping,
        isListed: data.tenant.isListed,
      })
    })
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await api.patch<{ tenant: Tenant }>('/dashboard/tenant', form)
      setTenant(result.tenant)
      show('Settings saved.')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save your settings.')
    } finally {
      setBusy(false)
    }
  }

  if (!overview || !session) return <div className="boot" aria-busy="true" />

  const blockers = overview.listing.blockers

  return (
    <>
      <PageHead
        title="Settings"
        lede="How your brand appears to shoppers, and whether it appears at all."
      />

      <form onSubmit={save}>
        <section className="panel">
          <div className="panel-head">
            <h2 className="t-heading">Brand</h2>
          </div>

          <div className="field-pair">
            <div className="field">
              <label className="field-label" htmlFor="s-name">
                Name
              </label>
              <input
                id="s-name"
                className="input"
                value={form.name}
                maxLength={80}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="field">
              <label className="field-label" htmlFor="s-slug">
                Identifier
              </label>
              <input
                id="s-slug"
                className="input t-id"
                value={form.slug}
                maxLength={48}
                onChange={(e) =>
                  setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
                }
              />
              <p className="field-hint">
                How your brand is named in API responses and webhooks. Changing it breaks anything
                already matching on the old value.
              </p>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="s-description">
              Description
            </label>
            <textarea
              id="s-description"
              className="textarea"
              maxLength={500}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
            <p className="field-hint">
              What you sell, in a line. Convo uses it to tell your goods apart from another
              brand&rsquo;s when a shopper asks something open-ended.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="t-heading">Selling</h2>
          </div>

          <label className="switch-row">
            <input
              type="checkbox"
              className="switch"
              checked={form.requiresShipping}
              onChange={(e) => setForm({ ...form, requiresShipping: e.target.checked })}
            />
            <span className="switch-text">
              <span className="switch-label">These goods need delivering</span>
              <span className="field-hint">
                On, an order cannot be paid for until the shopper has given a delivery address. Turn
                it off only if you sell something that arrives without a parcel.
              </span>
            </span>
          </label>

          <label className="switch-row">
            <input
              type="checkbox"
              className="switch"
              checked={form.isListed}
              disabled={!form.isListed && blockers.length > 0}
              onChange={(e) => setForm({ ...form, isListed: e.target.checked })}
            />
            <span className="switch-text">
              <span className="switch-label">List my catalogue on the marketplace</span>
              <span className="field-hint">
                Your products appear alongside other brands, and shoppers pay you directly on your
                own payment account. Convo never holds the money. Turning this off takes your
                catalogue down immediately; nothing else changes.
              </span>
              {!form.isListed && blockers.length > 0 && (
                <span className="field-hint field-hint-blocked">{blockers[0]}</span>
              )}
            </span>
          </label>
        </section>

        {error && (
          <p className="notice notice-danger" role="alert" style={{ marginBottom: 'var(--space-4)' }}>
            {error}
          </p>
        )}

        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            Save changes
          </button>
        </div>
      </form>

      <Toaster toasts={toasts} />
    </>
  )
}
