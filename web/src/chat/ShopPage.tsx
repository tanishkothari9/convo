import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { IconCart } from '../components/icons'
import { Mark } from '../components/Mark'
import { Thinking } from './Thinking'
import { ProductMarquee } from './ProductMarquee'
import { Composer } from './Composer'
import { CartSheet } from './CartSheet'
import { ProductCards } from './cards/ProductCards'
import { CartCard } from './cards/CartCard'
import { CheckoutCard, OrderConfirmationCard, PaymentFailedCard } from './cards/OrderCards'
import type {
  CartPayload,
  ChatMessage,
  CheckoutPayload,
  Component,
  OrderConfirmationPayload,
  ProductCard,
  ShopInfo,
} from './types'

interface HistoryResponse {
  conversationId: string
  messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; components: Component[] }>
  cart: CartPayload
}

export function ShopPage() {
  const [shop, setShop] = useState<ShopInfo | null>(null)
  const [unreachable, setUnreachable] = useState(false)
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
      .get<ShopInfo>('/shop')
      .then((data) => {
        if (!live) return
        setShop(data)
        document.title = 'Convo'
      })
      .catch(() => live && setUnreachable(true))

    api
      .get<HistoryResponse>('/shop/history')
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
  }, [])

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
        const response = await fetch('/api/shop/message', {
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
    [thinking],
  )

  const refreshCart = useCallback(() => {
    api
      .get<{ cart: CartPayload }>('/shop/cart')
      .then((r) => setCart(r.cart))
      .catch(() => undefined)
  }, [])

  /**
   * A payment finished in the panel. The server authored the confirmation —
   * including the payment reference — so it goes into the transcript as it
   * came back, rather than the page writing its own version of what happened.
   */
  const settlePayment = useCallback(
    (result: { paid: boolean; reason?: string; components?: Component[] }) => {
      refreshCart()
      const components = (result.components ?? []).filter(
        (component) =>
          component.component === 'order_confirmation' || component.component === 'payment_failed',
      )
      if (components.length === 0) return
      setMessages((current) => [
        ...current,
        { id: `settled-${Date.now()}`, role: 'assistant', content: '', components },
      ])
      pinned.current = true
    },
    [refreshCart],
  )

  if (unreachable) {
    return (
      <main className="chat-missing">
        <div>
          <h1 className="t-title">The shop is not answering</h1>
          <p className="t-secondary" style={{ marginTop: 'var(--space-2)' }}>
            Reload in a moment. Nothing in your cart has been lost.
          </p>
        </div>
      </main>
    )
  }

  if (!shop || !ready) return <div className="chat-boot" aria-busy="true" />

  const empty = messages.length === 0
  const lastChips = latestChips(messages)

  return (
    <div className="chat">
      {/* A soft field of colour behind the conversation, so the page reads as
          somewhere rather than as a blank form. */}
      <div className="chat-ambient" aria-hidden="true" />

      <header className="chat-head">
        <div className="chat-head-inner">
          <div className="chat-brand">
            <Mark size={22} />
            <span className="chat-brand-name">Convo</span>
          </div>

          <button
            className="cart-button"
            onClick={() => setCartOpen(true)}
            aria-label={`Cart, ${cart?.item_count ?? 0} items`}
          >
            <IconCart size={18} />
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
              {/* Two lines before the goods, not four. The brands used to be
                  named in a pill of their own and the money rule set above the
                  chips; the first is now on every card in the rail, and the
                  second reads better underneath it, where a customer has
                  already seen what they might be buying. */}
              <h1 className="chat-open-name">Ask for what you want</h1>
              <p className="chat-open-lede">{lede(shop)}</p>
              {shop.catalogSize > 0 && (
                <div className="chat-openers">
                  {shop.openers.map((opener, index) => (
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

              {/* The shop's own goods, before a word is typed. Tapping one
                  starts the conversation about that product. */}
              <ProductMarquee
                products={shop.showcase ?? []}
                onPick={(product) => send(`Tell me about the ${product.name}`)}
              />

              {shop.brandCount > 1 && (
                <p className="chat-open-foot t-sm t-muted">
                  One cart across every brand. Each is paid to that brand directly, so a cart from
                  two shops is two charges.
                </p>
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
                      disabled={thinking}
                      onAsk={send}
                      onPaymentSettled={settlePayment}
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
        chips={thinking ? [] : lastChips}
        busy={thinking}
        closed={shop.catalogSize === 0 && messages.length === 0}
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
  disabled,
  onAsk,
  onPaymentSettled,
}: {
  message: ChatMessage
  disabled: boolean
  onAsk(text: string): void
  onPaymentSettled(result: { paid: boolean; reason?: string; components?: Component[] }): void
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
            {renderComponent(component, disabled, onAsk, onPaymentSettled)}
          </div>
        ))}
    </>
  )
}

function renderComponent(
  component: Component,
  disabled: boolean,
  onAsk: (text: string) => void,
  onPaymentSettled: (result: {
    paid: boolean
    reason?: string
    components?: Component[]
  }) => void,
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
    case 'checkout':
      return (
        <CheckoutCard
          payload={component.payload as unknown as CheckoutPayload}
          disabled={disabled}
          onSettled={onPaymentSettled}
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

/**
 * The opening line, which has to say what this place is in one breath.
 *
 * It leads with the size of the shelf rather than the number of brands: a
 * shopper cares that there is enough here to be worth asking, not about the
 * platform's merchant count.
 */
function lede(shop: ShopInfo): string {
  if (shop.catalogSize === 0) {
    return 'Nothing is on sale here yet. Come back once a brand has listed.'
  }
  return `${shop.catalogSize} pieces from ${brandLine(shop.brands)}. Describe what you are after — colour, occasion, budget — rather than working down a filter.`
}

/**
 * Who is on the shelf, named.
 *
 * Named rather than counted, because "2 brands" tells a shopper nothing and
 * "Smart Choice and Kalaa Studio" tells them whether this is a shop for them.
 * It falls back to a count past the point where a list stops being readable.
 */
function brandLine(brands: string[]): string {
  if (brands.length === 0) return 'the brands listed here'
  if (brands.length === 1) return brands[0]!
  if (brands.length === 2) return `${brands[0]} and ${brands[1]}`
  if (brands.length === 3) return `${brands[0]}, ${brands[1]} and ${brands[2]}`
  return `${brands[0]}, ${brands[1]} and ${brands.length - 2} more brands`
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

