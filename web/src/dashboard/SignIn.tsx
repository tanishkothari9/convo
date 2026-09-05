import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { Mark } from '../components/Mark'
import { useAuth } from './auth'

const DEMO_BRANDS = [
  { name: 'Smart Choice', email: 'owner@smartchoice.demo' },
  { name: 'Kalaa Studio', email: 'owner@kalaa.demo' },
]

export function SignIn() {
  const { session, signIn, loading } = useAuth()
  const navigate = useNavigate()
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
      await signIn(email, password)
      navigate('/dashboard', { replace: true })
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not sign in. Try again.')
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <div className="auth-panel">
        <Link to="/" className="auth-mark" aria-label="Convo home">
          <Mark size={26} />
        </Link>
        <h1 className="t-title auth-title">Sign in to Convo</h1>

        <form className="stack" style={{ gap: 'var(--space-4)' }} onSubmit={submit}>
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
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <p className="notice notice-danger" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? 'Signing in' : 'Sign in'}
          </button>
        </form>

        <p className="auth-alt t-sm t-secondary">
          No account yet? <Link to="/signup">Add your brand</Link>
        </p>

        {/* Both, because the interesting thing about the demo data is seeing
            one purchase land in two brands' dashboards and nowhere else. */}
        <div className="auth-demos">
          <span className="t-sm t-muted">Demo brands</span>
          {DEMO_BRANDS.map((brand) => (
            <button
              key={brand.email}
              type="button"
              className="auth-demo t-sm"
              onClick={() => {
                setEmail(brand.email)
                setPassword('convo-demo-2026')
              }}
            >
              {brand.name}
            </button>
          ))}
        </div>
      </div>
    </main>
  )
}
