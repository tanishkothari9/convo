import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { Mark } from '../components/Mark'
import { useAuth } from './auth'

function slugPreview(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'your-brand'
}

export function SignUp() {
  const { session, signUp, loading } = useAuth()
  const navigate = useNavigate()
  const [brandName, setBrandName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <div className="boot" aria-busy="true" />
  if (session) return <Navigate to="/dashboard" replace />

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    try {
      await signUp({ brandName, email, password })
      navigate('/dashboard', { replace: true })
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : 'Could not create the account. Try again.',
      )
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <div className="auth-panel">
        <Link to="/" className="auth-mark" aria-label="Convo home">
          <Mark size={26} />
        </Link>
        <h1 className="t-title auth-title">Add your brand</h1>

        <form className="stack" style={{ gap: 'var(--space-4)' }} onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="brand">
              Brand name
            </label>
            <input
              id="brand"
              className="input"
              required
              maxLength={80}
              placeholder="Smart Choice"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
            />
            {/* The link is the product; show it forming as they type. */}
            <p className="field-hint">
              Your chat link will be <span className="slug-preview">/chat/{slugPreview(brandName)}</span>
            </p>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="field-hint">At least 8 characters.</p>
          </div>

          {error && (
            <p className="notice notice-danger" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? 'Creating' : 'Create brand'}
          </button>
        </form>

        <p className="auth-alt t-sm t-secondary">
          Already set up? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </main>
  )
}
