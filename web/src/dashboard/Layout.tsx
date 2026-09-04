import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Mark'
import { useAuth } from './auth'

const NAV = [
  { to: '/dashboard', label: 'Overview', end: true },
  { to: '/dashboard/catalog', label: 'Catalogue' },
  { to: '/dashboard/provider', label: 'Provider' },
  { to: '/dashboard/audit', label: 'Audit trail' },
  { to: '/dashboard/settings', label: 'Settings' },
]

export function DashboardLayout() {
  const { session, signOut } = useAuth()
  const navigate = useNavigate()
  const [navOpen, setNavOpen] = useState(false)

  async function leave() {
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="shell">
      <header className="shell-bar">
        <button
          className="shell-nav-toggle btn btn-ghost btn-sm"
          onClick={() => setNavOpen((open) => !open)}
          aria-expanded={navOpen}
          aria-controls="dashboard-nav"
        >
          <MenuIcon />
          Menu
        </button>
        <span className="wordmark wordmark-sm">
          <Mark size={20} />
          <span>Convo</span>
        </span>
      </header>

      <aside className="shell-side" id="dashboard-nav" data-open={navOpen}>
        <div className="shell-side-top">
          <span className="wordmark">
            <Mark />
            <span>Convo</span>
          </span>
        </div>

        <nav className="shell-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `shell-link${isActive ? ' is-active' : ''}`}
              onClick={() => setNavOpen(false)}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="shell-side-foot">
          <p className="t-sm shell-brand-name">{session?.tenant.name}</p>
          <p className="t-xs t-muted shell-email">{session?.user.email}</p>
          <button className="btn btn-ghost btn-sm shell-signout" onClick={leave}>
            Sign out
          </button>
        </div>
      </aside>

      {navOpen && (
        <button className="shell-scrim" onClick={() => setNavOpen(false)} aria-label="Close menu" />
      )}

      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  )
}

function MenuIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 4h12M2 8h12M2 12h12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** A page header, shared by every dashboard screen so the rhythm is identical. */
export function PageHead({
  title,
  lede,
  actions,
}: {
  title: string
  lede?: string
  actions?: React.ReactNode
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h1 className="t-title">{title}</h1>
        {lede && <p className="page-lede t-secondary">{lede}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  )
}
