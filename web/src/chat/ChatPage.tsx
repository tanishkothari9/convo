import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../lib/api'
import { contrastOn, hexToRgb, shade } from '../lib/format'
import { Thinking } from './Thinking'
import { Composer } from './Composer'
import { CartSheet } from './CartSheet'
import { ProductCards } from './cards/ProductCards'
import { CartCard } from './cards/CartCard'
import { OrderConfirmationCard, OrderSummaryCard, PaymentFailedCard } from './cards/OrderCards'
import type {
  BrandInfo,
  CartPayload,
  ChatMessage,
  Component,
  OrderConfirmationPayload,
  OrderSummaryPayload,
  ProductCard,
} from './types'

interface BrandResponse {
  brand: BrandInfo
  catalogSize: number
  categories: string[]
  openers: string[]
}

interface HistoryResponse {
  conversationId: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; components: Component[] }>
  cart: CartPayload
}

export function ChatPage() {
  const { slug = '' } = useParams()
  const [brand, setBrand] = useState<BrandResponse | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [cart, setCart] = useState<CartPayload | null>(null)
  const [thinking, setThinking] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [cartOpen, setCartOpen] = useState(false)
  const [ready, setReady] = useState(false)

  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // ── load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true
    api
      .get<BrandResponse>(`/chat/${slug}`)
      .then((data) => {
        if (!live) return
        setBrand(data)
        document.title = `${data.brand.name}`
      })
      .catch(() => live && setNotFound(true))

    api
      .get<HistoryResponse>(`/chat/${slug}/history`)
      .then((data) => {
        if (!live) return
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            components: m.components,
          })),
        )
        setCart(data.cart)
      })
      .catch(() => undefined)
      .finally(() => live && setReady(true))

    return () => {
      live = false
    }
  }, [slug])

  // ── stay pinned to the newest message unless the customer scrolled up ─────
  const scrollToEnd = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const node = scroller.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior })
  }, [])

  useEffect(() => {
    if (pinned.current) scrollToEnd(messages.length <= 1 ? 'auto' : 'smooth')
  }, [messages, thinking, status, scrollToEnd])

  function onScroll() {
    const node = scroller.current
    if (!node) return
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120
  }

  // ── send a turn ───────────────────────────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed === '' || thinking) return

      pinned.current = true
      const userId = `local-${Date.now()}`
      const replyId = `${userId}-reply`

      // The customer's message lands on the same frame they pressed send.
      setMessages((current) => [
        ...current,
        { id: userId, role: 'user', content: trimmed, components: [] },
      ])
      setThinking(true)
      setStatus(null)

      try {
        const response = await fetch(`/api/chat/${slug}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ message: trimmed }),
        })
        if (!response.ok || !response.body) throw new Error('stream failed')

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let started = false

        const ensureReply = () => {
          if (started) return
          started = true
          setThinking(false)
          setStatus(null)
          setMessages((current) => [
            ...current,
            { id: replyId, role: 'assistant', content: '', components: [], streaming: true },
          ])
        }

        const patchReply = (patch: (message: ChatMessage) => ChatMessage) => {
          setMessages((current) =>
            current.map((message) => (message.id === replyId ? patch(message) : message)),
          )
        }

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let boundary = buffer.indexOf('\n\n')
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf('\n\n')

            const line = block.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue

            let event: { type: string; [key: string]: unknown }
            try {
              event = JSON.parse(line.slice(6))
            } catch {
              continue
            }

            switch (event.type) {
              case 'status':
                if (!started) setStatus(String(event.text))
                break

              case 'text_delta':
                ensureReply()
                patchReply((m) => ({ ...m, content: m.content + String(event.text) }))
                break

              case 'component': {
                ensureReply()
                const component = event.component as Component
                if (component.component === 'cart_state') {
                  // The running cart panel, not something posted in the reply.
                  setCart(component.payload as unknown as CartPayload)
                  break
                }
                patchReply((m) => ({ ...m, components: [...m.components, component] }))
                break
              }

              case 'error':
                ensureReply()
                patchReply((m) => ({ ...m, error: String(event.message), streaming: false }))
                break

              case 'done':
                ensureReply()
                patchReply((m) => ({ ...m, streaming: false }))
                break

              default:
                break
            }
          }
        }

        ensureReply()
        patchReply((m) => ({ ...m, streaming: false }))
      } catch {
        setMessages((current) => [
          ...current,
          {
            id: replyId,
            role: 'assistant',
            content: '',
            components: [],
            error: 'The connection dropped before that could be answered. Try again.',
          },
        ])
      } finally {
        setThinking(false)
        setStatus(null)
        refreshCart()
      }
    },
    [slug, thinking],
  )

  const refreshCart = useCallback(() => {
    api
      .get<{ cart: CartPayload }>(`/chat/${slug}/cart`)
      .then((r) => setCart(r.cart))
      .catch(() => undefined)
  }, [slug])

  // ── theme ─────────────────────────────────────────────────────────────────
  const theme = useMemo(() => {
    const accent = brand?.brand.accentColor ?? '#1B6B54'
    return {
      ['--brand']: accent,
      ['--brand-hover']: shade(accent, 0.18),
      ['--brand-tint']: shade(accent, 0.92, 'white'),
      ['--brand-ring']: `rgba(${hexToRgb(accent)}, 0.3)`,
      ['--brand-contrast']: contrastOn(accent),
    } as React.CSSProperties
  }, [brand])

  if (notFound) {
    return (
      <main className="chat-missing">
        <div>
          <h1 className="t-title">No brand at this link</h1>
          <p className="t-secondary" style={{ marginTop: 'var(--space-2)' }}>
            The address may have changed, or the brand may have taken it down.
          </p>
        </div>
      </main>
    )
  }

  if (!brand || !ready) return <div className="chat-boot" aria-busy="true" />

  const empty = messages.length === 0
  const lastChips = latestChips(messages)

  return (
    <div className="chat" style={theme}>
      <header className="chat-head">
        <div className="chat-head-inner">
          <div className="chat-brand">
            <span className="chat-brand-badge" aria-hidden="true">
              {brand.brand.name.slice(0, 1)}
            </span>
            <span className="chat-brand-name">{brand.brand.name}</span>
          </div>

          <button
            className="cart-button"
            onClick={() => setCartOpen(true)}
            aria-label={`Cart, ${cart?.item_count ?? 0} items`}
          >
            <CartIcon />
            {cart && cart.item_count > 0 && (
              <span className="cart-count t-num">{cart.item_count}</span>
            )}
          </button>
        </div>
      </header>

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-column">
          {empty ? (
            <section className="chat-open">
              <h1 className="chat-open-name">{brand.brand.name}</h1>
              {brand.brand.description && (
                <p className="chat-open-lede">{brand.brand.description}</p>
              )}
              <p className="chat-open-hint t-sm t-muted">
                {brand.catalogSize > 0
                  ? `${brand.brand.assistantName} can search the catalogue, keep a cart, and take you through checkout.`
                  : `${brand.brand.name} has not published a catalogue yet.`}
              </p>
              {brand.catalogSize > 0 && (
                <div className="chat-openers">
                  {brand.openers.map((opener, index) => (
                    <button
                      key={opener}
                      className="chip"
                      style={{ animationDelay: `${index * 55}ms` }}
                      onClick={() => send(opener)}
                    >
                      {opener}
                    </button>
                  ))}
                </div>
              )}
            </section>
          ) : (
            <ol className="chat-log">
              {messages.map((message) => (
                <li key={message.id} className={`turn turn-${message.role}`}>
                  {message.role === 'user' ? (
                    <p className="bubble">{message.content}</p>
                  ) : (
                    <Reply
                      message={message}
                      slug={slug}
                      disabled={thinking}
                      onAsk={send}
                      onPaymentSettled={refreshCart}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}

          {thinking && <Thinking status={status} />}
        </div>
      </div>

      <Composer
        brandName={brand.brand.name}
        chips={thinking ? [] : lastChips}
        busy={thinking}
        onSend={send}
      />

      {cartOpen && cart && (
        <CartSheet
          cart={cart}
          onClose={() => setCartOpen(false)}
          onAsk={(text) => {
            setCartOpen(false)
            send(text)
          }}
          busy={thinking}
        />
      )}
    </div>
  )
}

/** One assistant turn: its text, then whatever components it produced. */
function Reply({
  message,
  slug,
  disabled,
  onAsk,
  onPaymentSettled,
}: {
  message: ChatMessage
  slug: string
  disabled: boolean
  onAsk(text: string): void
  onPaymentSettled(): void
}) {
  if (message.error) {
    return <p className="reply-error">{message.error}</p>
  }

  return (
    <>
      {message.content !== '' && (
        <p className="reply" data-streaming={message.streaming ? 'true' : undefined}>
          {message.content}
        </p>
      )}

      {message.components
        .filter((c) => c.component !== 'suggestions')
        .map((component, index) => (
          <div className="component" key={`${message.id}-${index}`}>
            {renderComponent(component, slug, disabled, onAsk, onPaymentSettled)}
          </div>
        ))}
    </>
  )
}

function renderComponent(
  component: Component,
  slug: string,
  disabled: boolean,
  onAsk: (text: string) => void,
  onPaymentSettled: () => void,
) {
  switch (component.component) {
    case 'products':
      return (
        <ProductCards
          title={(component.payload.title as string | null) ?? null}
          layout={(component.payload.layout as string) ?? 'carousel'}
          items={component.payload.items as ProductCard[]}
          onAsk={onAsk}
          disabled={disabled}
        />
      )
    case 'cart':
      return (
        <CartCard
          cart={component.payload as unknown as CartPayload}
          onAsk={onAsk}
          disabled={disabled}
        />
      )
    case 'order_summary':
      return (
        <OrderSummaryCard
          payload={component.payload as unknown as OrderSummaryPayload}
          slug={slug}
          disabled={disabled}
          onSettled={(result) => {
            onPaymentSettled()
            if (result.paid) onAsk('Thanks — is my order confirmed?')
          }}
        />
      )
    case 'order_confirmation':
      return <OrderConfirmationCard payload={component.payload as unknown as OrderConfirmationPayload} />
    case 'payment_failed':
      return (
        <PaymentFailedCard
          payload={component.payload as unknown as { order_id: string; reason: string; total_display: string }}
        />
      )
    default:
      return null
  }
}

/** The chips from the most recent turn, which are the ones still on offer. */
function latestChips(messages: ChatMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    const chips = message.components.find((c) => c.component === 'suggestions')
    if (chips) return (chips.payload.suggestions as string[]) ?? []
    return []
  }
  return []
}

function CartIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path
        d="M2 2h1.6l1.6 8.4a1.4 1.4 0 0 0 1.4 1.1h6.2a1.4 1.4 0 0 0 1.4-1.1L15.6 5H4.4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="15" r="1.2" fill="currentColor" />
      <circle cx="13" cy="15" r="1.2" fill="currentColor" />
    </svg>
  )
}
