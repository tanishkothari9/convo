import { useEffect, useState } from 'react'
import { api, ApiError, type Overview, type Tenant } from '../lib/api'
import { Toaster, useToast } from '../components/Toast'
import { PageHead } from './Layout'
import { useAuth } from './auth'
import { modelLabel } from './Overview'

const PROVIDER_NOTES: Record<string, string> = {
  scripted:
    'Built into Convo. Deterministic, no network call, no API key — and the same skills, gates, and audit trail as any other provider.',
  anthropic: 'Claude, through the Anthropic Messages API.',
  openai: 'GPT, through the OpenAI Chat Completions API.',
}

export function Settings() {
  const { session, setTenant } = useAuth()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [form, setForm] = useState({
    name: '',
    slug: '',
    description: '',
    assistantName: '',
    brandVoice: '',
    accentColor: '#1B6B54',
    llmProvider: '',
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
        assistantName: data.tenant.assistantName,
        brandVoice: data.tenant.brandVoice,
        accentColor: data.tenant.accentColor,
        llmProvider: data.tenant.llmProvider ?? '',
      })
    })
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const result = await api.patch<{ tenant: Tenant }>('/dashboard/tenant', {
        ...form,
        llmProvider: form.llmProvider === '' ? null : form.llmProvider,
      })
      setTenant(result.tenant)
      show('Settings saved.')
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save your settings.')
    } finally {
      setBusy(false)
    }
  }

  if (!overview || !session) return <div className="boot" aria-busy="true" />

  const activeModel = form.llmProvider === '' ? overview.model.platformDefault : form.llmProvider

  return (
    <>
      <PageHead title="Settings" lede="How your brand and its assistant present themselves." />

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
                Chat link
              </label>
              <div className="input-prefixed">
                <span className="input-prefix slug-prefix">/chat/</span>
                <input
                  id="s-slug"
                  className="input slug-input"
                  value={form.slug}
                  maxLength={48}
                  onChange={(e) =>
                    setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })
                  }
                />
              </div>
              <p className="field-hint">Changing this breaks any link you have already shared.</p>
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
            <p className="field-hint">Shown under your name when a customer opens the chat.</p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="s-accent">
              Accent colour
            </label>
            <div className="colour-row">
              <input
                id="s-accent"
                type="color"
                className="colour-swatch"
                value={form.accentColor}
                onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
              />
              <input
                className="input t-id colour-hex"
                value={form.accentColor}
                onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
                maxLength={7}
                aria-label="Accent colour hex value"
              />
              <span
                className="colour-preview"
                style={{ ['--brand' as string]: form.accentColor }}
              >
                <span className="btn btn-primary btn-sm">Add to cart</span>
              </span>
            </div>
            <p className="field-hint">Used on your chat page. Convo&rsquo;s own chrome stays neutral so it never clashes.</p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="t-heading">Assistant</h2>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="s-assistant">
              Name
            </label>
            <input
              id="s-assistant"
              className="input"
              value={form.assistantName}
              maxLength={60}
              onChange={(e) => setForm({ ...form, assistantName: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="s-voice">
              Voice
            </label>
            <textarea
              id="s-voice"
              className="textarea"
              maxLength={200}
              value={form.brandVoice}
              onChange={(e) => setForm({ ...form, brandVoice: e.target.value })}
            />
            <p className="field-hint">
              Describe how your shop talks, not what it should say. This changes the register, never
              what is true — prices, stock, and totals come from your catalogue either way.
            </p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="s-model">
              Model
            </label>
            <select
              id="s-model"
              className="select"
              value={form.llmProvider}
              onChange={(e) => setForm({ ...form, llmProvider: e.target.value })}
            >
              <option value="">
                Platform default — {modelLabel(overview.model.platformDefault)}
              </option>
              {overview.model.providers.map((provider) => (
                <option key={provider.name} value={provider.name} disabled={!provider.available}>
                  {modelLabel(provider.name)} — {provider.model}
                  {provider.available ? '' : ' (no API key set)'}
                </option>
              ))}
            </select>
            <p className="field-hint">{PROVIDER_NOTES[activeModel] ?? ''}</p>
          </div>
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
