import { Link } from 'react-router-dom'
import { Mark } from './components/Mark'
import { LiveDemo } from './components/LiveDemo'
import { ShaderField } from './components/ShaderField'
import {
  IconAgent,
  IconArrow,
  IconAudit,
  IconBolt,
  IconCatalogue,
  IconGate,
  IconLink,
  IconProvider,
  IconRupee,
} from './components/icons'
import { useDarkSurface } from './lib/useDarkSurface'
import { useAuth } from './dashboard/auth'

const CAPABILITIES = [
  {
    icon: IconCatalogue,
    title: 'A catalogue it cannot invent',
    body: 'The agent searches your products and nothing else. Every price, image, and stock level on screen is joined from your records after the model has spoken, so it can choose what to show but never what it costs.',
  },
  {
    icon: IconGate,
    title: 'Gates, not good intentions',
    body: 'A cart write only accepts a product the agent actually looked up this conversation. Quantities are capped in the schema. An item that sells out between the cart and the till stops the charge.',
  },
  {
    icon: IconRupee,
    title: 'The server decides the total',
    body: 'Checkout takes no amount argument — it cannot be told what to charge. The figure is recomputed from live catalogue prices at the moment of payment, and the signature is verified before an order is ever marked paid.',
  },
  {
    icon: IconAudit,
    title: 'A ledger you can read',
    body: 'Every cart lock, order, payment attempt, confirmation, and refusal is appended with its amount, its outcome, and the reason the agent gave. Nothing in it is edited or removed.',
  },
]

const STEPS = [
  {
    icon: IconCatalogue,
    label: 'Bring a catalogue',
    body: 'Add products here, or connect the provider you already sell through and Convo pulls your items across.',
  },
  {
    icon: IconLink,
    label: 'Share one link',
    body: 'Your own address, in your own voice. The page that opens carries your name and your colour, not ours.',
  },
  {
    icon: IconAgent,
    label: 'It sells',
    body: 'Search, cart, checkout, payment — inside the conversation, with the ledger writing itself behind it.',
  },
]

export function Landing() {
  const { session } = useAuth()
  useDarkSurface()

  return (
    <main className="landing">
      <section className="hero">
        <ShaderField />

        <div className="hero-inner">
          <header className="hero-nav">
            <span className="wordmark wordmark-invert">
              <Mark />
              <span>Convo</span>
            </span>
            <nav className="hero-nav-actions">
              {session ? (
                <Link className="btn btn-glass btn-sm" to="/dashboard">
                  Open dashboard
                </Link>
              ) : (
                <>
                  <Link className="btn btn-quiet btn-sm" to="/login">
                    Sign in
                  </Link>
                  <Link className="btn btn-glass btn-sm" to="/signup">
                    Add your brand
                  </Link>
                </>
              )}
            </nav>
          </header>

          <div className="hero-grid">
            <div className="hero-copy">
              <span className="pill">
                <span className="pill-dot" />
                Conversational commerce, multi-tenant
              </span>

              <h1 className="hero-headline">
                Your catalogue, as a conversation
                <br />
                your customers can <em>buy</em> from.
              </h1>

              <p className="hero-lede">
                Convo turns a product list into an AI storefront that searches, carries a cart, and
                takes payment — in your brand&rsquo;s voice, on one shareable link. Every chargeable
                figure is computed on our side, and every money action lands in an audit trail.
              </p>

              <div className="hero-actions">
                <Link className="btn btn-primary btn-lg" to="/signup">
                  Add your brand
                  <IconArrow size={16} />
                </Link>
                <Link className="btn btn-glass btn-lg" to="/chat/smart-choice">
                  Open a live storefront
                </Link>
              </div>

              <dl className="hero-facts">
                <div>
                  <dt>Set-up</dt>
                  <dd>One link</dd>
                </div>
                <div>
                  <dt>Providers</dt>
                  <dd>Three methods</dd>
                </div>
                <div>
                  <dt>Models</dt>
                  <dd>Swappable</dd>
                </div>
              </dl>
            </div>

            <div className="hero-demo">
              <LiveDemo />
            </div>
          </div>
        </div>
      </section>

      <section className="band">
        <div className="band-inner">
          {STEPS.map((step, index) => (
            <article key={step.label} className="step">
              <span className="step-mark">
                <step.icon size={18} />
              </span>
              <div>
                <h2 className="step-label">
                  <span className="step-index">{index + 1}</span>
                  {step.label}
                </h2>
                <p className="t-secondary">{step.body}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-inner">
          <header className="section-head">
            <span className="eyebrow">
              <IconGate size={14} />
              What holds when the model is wrong
            </span>
            <h2 className="section-title">
              An agent that proposes.
              <br />A server that <span className="t-gradient">decides</span>.
            </h2>
            <p className="section-lede t-secondary">
              A shopping agent is only as trustworthy as what happens when it is confidently
              mistaken. Convo answers that in code, not in the prompt — so the rules hold whichever
              model is running behind them.
            </p>
          </header>

          <div className="capability-grid">
            {CAPABILITIES.map((item) => (
              <article key={item.title} className="capability">
                <span className="capability-icon">
                  <item.icon size={20} />
                </span>
                <h3 className="capability-title">{item.title}</h3>
                <p className="t-secondary">{item.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-tight">
        <div className="section-inner swap">
          <div className="swap-copy">
            <span className="eyebrow">
              <IconBolt size={14} />
              Model-agnostic by construction
            </span>
            <h2 className="section-title">Change the model. Keep the rules.</h2>
            <p className="t-secondary">
              The skills, the gates, the tool contracts, and the audit trail all sit above one
              interface. Nothing in the agent imports a vendor SDK, so moving between Claude and GPT
              is a line of configuration — and a brand can run on a different model from the brand
              next to it.
            </p>
            <Link className="btn btn-secondary" to="/signup">
              Start with your catalogue
              <IconArrow size={16} />
            </Link>
          </div>

          <div className="swap-visual">
            <p className="swap-caption swap-caption-top">Swap the model</p>
            <div className="swap-rail">
              {['Claude', 'GPT', 'Built-in'].map((name, i) => (
                <div key={name} className="swap-chip" style={{ animationDelay: `${i * 90}ms` }}>
                  <span className="swap-chip-dot" data-active={i === 0} />
                  {name}
                </div>
              ))}
            </div>
            <p className="swap-caption">Everything under it stays put</p>

            <div className="swap-stack">
              <span className="swap-bracket" aria-hidden="true" />
              {[
                { label: 'Skills', icon: IconAgent },
                { label: 'Gates', icon: IconGate },
                { label: 'Tool contracts', icon: IconProvider },
                { label: 'Audit trail', icon: IconAudit },
              ].map((layer, i) => (
                <div key={layer.label} className="swap-layer" style={{ animationDelay: `${i * 70}ms` }}>
                  <span className="swap-layer-icon">
                    <layer.icon size={16} />
                  </span>
                  {layer.label}
                  <span className="swap-layer-tag">unchanged</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="cta">
        <ShaderField speed={0.1} swirl={0.5} distortion={0.6} />
        <div className="cta-inner">
          <h2 className="cta-title">Put your catalogue in a conversation.</h2>
          <p className="cta-lede">
            Add products, share the link, and watch the ledger fill in. No card needed to try it.
          </p>
          <div className="hero-actions">
            <Link className="btn btn-primary btn-lg" to="/signup">
              Add your brand
              <IconArrow size={16} />
            </Link>
            <Link className="btn btn-glass btn-lg" to="/chat/smart-choice">
              See it working
            </Link>
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <span className="wordmark wordmark-sm">
          <Mark size={18} />
          <span>Convo</span>
        </span>
        <span className="t-sm t-muted">A conversational commerce platform.</span>
      </footer>
    </main>
  )
}
