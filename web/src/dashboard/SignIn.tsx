import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { ApiError } from '../lib/api'
import { Mark } from '../components/Mark'
import { ShaderField } from '../components/ShaderField'
import { useDarkSurface } from '../lib/useDarkSurface'
import { useAuth } from './auth'

export function SignIn() {
  const { session, signIn, loading } = useAuth()
  useDarkSurface()
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
      <ShaderField speed={0.09} swirl={0.4} distortion={0.55} />
      <div className="auth-panel glass-dark">
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

        <button
          type="button"
          className="auth-demo t-sm"
          onClick={() => {
            setEmail('owner@smartchoice.demo')
            setPassword('convo-demo-2026')
          }}
        >
          Fill in the Smart Choice demo brand
        </button>
      </div>
    </main>
  )
}
