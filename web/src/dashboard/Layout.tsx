import { useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  IconAudit,
  IconBolt,
  IconCatalogue,
  IconClose,
  IconMenu,
  IconOverview,
  IconProvider,
  IconReceipt,
  IconSettings,
} from "../components/icons";
import { useAuth } from "./auth";
import { PixelHorizon } from "../components/PixelHorizon";
import { PixelYard } from "../components/PixelYard";
import { Wordmark } from "../components/Wordmark";

const NAV = [
  { to: "/dashboard", label: "Overview", icon: IconOverview, end: true },
  { to: "/dashboard/catalog", label: "Catalogue", icon: IconCatalogue },
  { to: "/dashboard/provider", label: "Provider", icon: IconProvider },
  { to: "/dashboard/orders", label: "Orders", icon: IconReceipt },
  { to: "/dashboard/audit", label: "Audit trail", icon: IconAudit },
  { to: "/dashboard/developers", label: "Developers", icon: IconBolt },
  { to: "/dashboard/settings", label: "Settings", icon: IconSettings },
];

export function DashboardLayout() {
  const { session, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);

  /*
   * Which section the bar should name.
   *
   * Longest match rather than first, so /dashboard/catalog picks Catalogue
   * instead of Overview, whose path is a prefix of every other one.
   */
  const here = NAV.reduce(
    (best, item) =>
      pathname === item.to || (!item.end && pathname.startsWith(`${item.to}/`))
        ? !best || item.to.length > best.to.length
          ? item
          : best
        : best,
    null as (typeof NAV)[number] | null,
  );

  async function leave() {
    await signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="shell">
      {/*
       * The bar was the hamburger labelled "Menu" on the left and the wordmark
       * pushed to the right, which is the brand on the wrong side and a word
       * doing a job the icon already does. Now it reads left to right the way
       * every other application does — control, then who you are, then where
       * you are. The section name is the useful part: on this width the rail
       * is hidden, so without it nothing on screen says which page you are on.
       */}
      <header className="shell-bar">
        <div className="shell-bar-lead">
          <button
            className="shell-nav-toggle"
            onClick={() => setNavOpen((open) => !open)}
            aria-expanded={navOpen}
            aria-controls="dashboard-nav"
            aria-label={navOpen ? "Close the menu" : "Open the menu"}
          >
            {navOpen ? <IconClose size={18} /> : <IconMenu size={18} />}
          </button>
          <Link to="/dashboard" aria-label="Dashboard">
            <Wordmark size="sm" />
          </Link>
        </div>
        {here && <span className="shell-bar-where">{here.label}</span>}
      </header>

      <aside className="shell-side" id="dashboard-nav" data-open={navOpen}>
        <div className="shell-side-top">
          <Link to="/" aria-label="Convo home">
            <Wordmark />
          </Link>
        </div>

        <nav className="shell-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `shell-link${isActive ? " is-active" : ""}`
              }
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
          <button
            className="btn btn-ghost btn-sm shell-signout"
            onClick={leave}
          >
            Sign out
          </button>
        </div>

        {/* Round the back of the shop, at the very bottom of the panel. Below
            the brand and the sign-out, not above them: it is the floor of the
            drawer, and art wedged between two blocks of text is a divider. */}
        <PixelYard />
      </aside>

      {navOpen && (
        <button
          className="shell-scrim"
          onClick={() => setNavOpen(false)}
          aria-label="Close menu"
        />
      )}

      <main className="shell-main">
        {/* The page, in a box that takes all the slack — so on a screen with
            little on it (an empty filter, say) the horizon below is pushed to
            the foot of the window rather than stopping wherever the content
            happened to end, with dead page underneath it. */}
        <div className="shell-page">
          <Outlet />
        </div>

        {/* The far edge of town, at the foot of the page. Edgeless and
            full-bleed: it has to arrive out of the page rather than start at a
            line, or it lands on whatever the screen ended with — on Settings
            that was the Save button — and reads as a sticker. */}
        <PixelHorizon />
      </main>
    </div>
  );
}

/** A page header, shared by every dashboard screen so the rhythm is identical. */
export function PageHead({
  title,
  lede,
  eyebrow,
  actions,
}: {
  title: string;
  lede?: string;
  eyebrow?: React.ReactNode;
  actions?: React.ReactNode;
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
  );
}
