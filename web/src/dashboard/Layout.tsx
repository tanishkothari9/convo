import { useState } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import { Mark } from '../components/Mark'
import {
  IconAudit,
  IconBolt,
  IconCatalogue,
  IconClose,
  IconMenu,
  IconOverview,
  IconProvider,
  IconSettings,
} from '../components/icons'
import { useAuth } from './auth'

const NAV = [
  { to: '/dashboard', label: 'Overview', icon: IconOverview, end: true },
  { to: '/dashboard/catalog', label: 'Catalogue', icon: IconCatalogue },
  { to: '/dashboard/provider', label: 'Provider', icon: IconProvider },
  { to: '/dashboard/audit', label: 'Audit trail', icon: IconAudit },
  { to: '/dashboard/developers', label: 'Developers', icon: IconBolt },
  { to: '/dashboard/settings', label: 'Settings', icon: IconSettings },
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
          {navOpen ? <IconClose size={16} /> : <IconMenu size={16} />}
          Menu
        </button>
        <span className="wordmark wordmark-sm">
          <Mark size={20} />
          <span>Convo</span>
        </span>
      </header>

      <aside className="shell-side" id="dashboard-nav" data-open={navOpen}>
        <div className="shell-side-top">
          <Link to="/" className="wordmark" aria-label="Convo home">
            <Mark />
            <span>Convo</span>
          </Link>
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
              <item.icon size={17} />
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

/** A page header, shared by every dashboard screen so the rhythm is identical. */
export function PageHead({
  title,
  lede,
  eyebrow,
  actions,
}: {
  title: string
  lede?: string
  eyebrow?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
        <h1 className="page-title">{title}</h1>
        {lede && <p className="page-lede t-secondary">{lede}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  )
}
