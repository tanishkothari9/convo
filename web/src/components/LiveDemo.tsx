import { useEffect, useRef, useState } from 'react'
import { IconCart, IconSend, IconSpark } from './icons'
import { Mark } from './Mark'

/**
 * The hero's product demo: a scripted conversation that plays itself.
 *
 * It is the honest thing to put in a hero for this product — Convo is a
 * conversation, and a screenshot of one says nothing about how it feels to
 * use. So this replays a real exchange at reading speed: the question types
 * itself, the agent's status line appears, cards land, the total resolves.
 *
 * It is a recording, not a live agent. The frames below are copied from an
 * actual session against the seeded catalogue, which is why the figures are
 * the real ones.
 */

type Frame =
  | { kind: 'typing'; text: string }
  | { kind: 'sent'; text: string }
  | { kind: 'status'; text: string }
  | { kind: 'reply'; text: string }
  | { kind: 'cards' }
  | { kind: 'total' }

/*
 * Real catalogue photography, fetched deliberately tiny.
 *
 * The thumbnails used to be smooth CSS gradients, which is the one thing they
 * could not be on a page whose hero is pixel art — two colours blending
 * against a scene where nothing blends. These are the actual seeded products,
 * requested at forty-odd pixels wide and painted up with nearest-neighbour, so
 * the pixels come from the photograph itself rather than from a filter over
 * it. Cheaper than a gradient, too: each is a couple of kilobytes.
 */
const shot = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=52&h=22&q=70`

const PRODUCTS = [
  {
    name: 'Sharara Set — Wine',
    brand: 'Smart Choice',
    price: '₹7,999',
    hue: '#6d213a',
    image: shot('photo-1756483509254-3cc48a5a15b2'),
  },
  {
    // From the other brand, which is the whole point of the total below.
    name: 'Oxidised Silver Jhumkas',
    brand: 'Kalaa Studio',
    price: '₹3,450',
    hue: '#3c4a52',
    image: shot('photo-1762686130435-897de4b26aac'),
  },
  {
    name: 'Juttis — Teal',
    brand: 'Smart Choice',
    price: '₹2,199',
    hue: '#155e63',
    image: shot('photo-1777980808039-c8be538797f0'),
  },
]

const SCRIPT: Array<{ frame: Frame; hold: number }> = [
  { frame: { kind: 'typing', text: 'i need something for a sangeet' }, hold: 1500 },
  { frame: { kind: 'sent', text: 'i need something for a sangeet' }, hold: 260 },
  { frame: { kind: 'status', text: 'looking through the catalogue' }, hold: 1150 },
  { frame: { kind: 'reply', text: "Here's what fits." }, hold: 320 },
  { frame: { kind: 'cards' }, hold: 2100 },
  { frame: { kind: 'status', text: 'putting your cart together' }, hold: 1000 },
  { frame: { kind: 'total' }, hold: 3400 },
]

export function LiveDemo() {
  const [step, setStep] = useState(0)
  const [typed, setTyped] = useState('')
  const timers = useRef<number[]>([])

  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (still) {
      // No self-playing motion: show the finished exchange and stop.
      setStep(SCRIPT.length - 1)
      return
    }

    let cancelled = false
    const clear = () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }

    function play(index: number) {
      if (cancelled) return
      const entry = SCRIPT[index % SCRIPT.length]!
      setStep(index % SCRIPT.length)

      if (entry.frame.kind === 'typing') {
        const full = entry.frame.text
        setTyped('')
        full.split('').forEach((_, i) => {
          timers.current.push(
            window.setTimeout(() => setTyped(full.slice(0, i + 1)), 42 * (i + 1)),
          )
        })
      }
      timers.current.push(window.setTimeout(() => play(index + 1), entry.hold))
    }

    play(0)
    return () => {
      cancelled = true
      clear()
    }
  }, [])

  const shown = SCRIPT.slice(0, step + 1).map((s) => s.frame)
  const current = SCRIPT[step]!.frame
  const has = (kind: Frame['kind']) => shown.some((f) => f.kind === kind)
  const sent = has('sent')
  const status = current.kind === 'status' ? current.text : null

  return (
    <div className="demo">
      <div className="demo-bar">
        <span className="demo-brand">
          <Mark size={22} />
          Convo
        </span>
        <span className="demo-cart">
          <IconCart size={15} />
          {has('total') && <span className="demo-cart-dot" />}
        </span>
      </div>

      <div className="demo-body">
        {sent && (
          <p className="demo-bubble">{(SCRIPT[1]!.frame as { text: string }).text}</p>
        )}

        {status && (
          <p className="demo-status">
            <span className="demo-orb" />
            {status}
          </p>
        )}

        {has('reply') && !status && (
          <p className="demo-reply">{(SCRIPT[3]!.frame as { text: string }).text}</p>
        )}

        {has('cards') && (
          <div className="demo-cards">
            {PRODUCTS.map((product, i) => (
              <div key={product.name} className="demo-card" style={{ animationDelay: `${i * 70}ms` }}>
                <span className="demo-card-art" style={{ background: product.hue }}>
                  <img src={product.image} alt="" loading="lazy" decoding="async" />
                </span>
                <span className="demo-card-brand">{product.brand}</span>
                <span className="demo-card-name">{product.name}</span>
                <span className="demo-card-price">{product.price}</span>
              </div>
            ))}
          </div>
        )}

        {has('total') && (
          <div className="demo-total">
            <span>
              <IconSpark size={14} />
              Two brands, two orders, computed on the server
            </span>
            <strong>₹13,648</strong>
          </div>
        )}
      </div>

      <div className="demo-composer">
        <span className="demo-input">
          {current.kind === 'typing' ? (
            <>
              {typed}
              <span className="demo-caret" />
            </>
          ) : (
            <span className="demo-placeholder">Ask for something</span>
          )}
        </span>
        <span className="demo-send">
          <IconSend size={14} />
        </span>
      </div>
    </div>
  )
}
