import { Link } from 'react-router-dom'
import { Mark } from './components/Mark'
import { useAuth } from './dashboard/auth'

/**
 * The platform's own front door. Deliberately short: Convo's real surfaces are
 * the dashboard and a brand's chat link, and this page's only job is to send
 * you to one of them.
 */
export function Landing() {
  const { session } = useAuth()

  return (
    <main className="landing">
      <header className="landing-head">
        <span className="wordmark">
          <Mark />
          <span>Convo</span>
        </span>
        <nav className="row" style={{ gap: 'var(--space-2)' }}>
          {session ? (
            <Link className="btn btn-secondary btn-sm" to="/dashboard">
              Open dashboard
            </Link>
          ) : (
            <>
              <Link className="btn btn-ghost btn-sm" to="/login">
                Sign in
              </Link>
              <Link className="btn btn-primary btn-sm" to="/signup">
                Add your brand
              </Link>
            </>
          )}
        </nav>
      </header>

      <section className="landing-hero">
        <h1 className="t-display landing-headline">
          Your catalogue, as a conversation your customers can buy from.
        </h1>
        <p className="landing-lede">
          Add your products or connect the provider you already use. Convo gives you a link that
          opens an AI storefront in your brand&rsquo;s own voice — one that searches the catalogue,
          keeps a cart, and takes payment, with every total computed on our side and every
          money action written to an audit trail you can read.
        </p>
        <div className="landing-actions">
          <Link className="btn btn-primary btn-lg" to="/signup">
            Add your brand
          </Link>
          <Link className="btn btn-secondary btn-lg" to="/chat/smart-choice">
            See a live storefront
          </Link>
        </div>
      </section>

      <section className="landing-steps">
        <div className="landing-step">
          <h2 className="t-heading">Bring a catalogue</h2>
          <p className="t-secondary">
            Add products in the dashboard, or connect Razorpay and Convo pulls your items across.
            Either way it is the same catalogue underneath.
          </p>
        </div>
        <div className="landing-step">
          <h2 className="t-heading">Share the link</h2>
          <p className="t-secondary">
            Every brand gets its own address. Put it in a bio, a broadcast, or a website — the page
            that opens carries your name and your voice, not ours.
          </p>
        </div>
        <div className="landing-step">
          <h2 className="t-heading">Watch the ledger</h2>
          <p className="t-secondary">
            Every cart lock, order, payment attempt, and refusal is logged with its amount and its
            outcome. The agent proposes; the server decides what gets charged.
          </p>
        </div>
      </section>

      <footer className="landing-foot t-sm t-muted">
        Convo &mdash; a conversational commerce platform.
      </footer>
    </main>
  )
}
