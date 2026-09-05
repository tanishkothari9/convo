import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { IconAgent, IconCart, IconMenu, IconPlus } from "../components/icons";
import { Thinking } from "./Thinking";
import { PixelStreet } from "../components/PixelStreet";
import { Wordmark } from "../components/Wordmark";
import { Composer } from "./Composer";
import { CartSheet } from "./CartSheet";
import { AgentSheet } from "./AgentSheet";
import { ChatSheet } from "./ChatSheet";
import { ProductCards } from "./cards/ProductCards";
import { CartCard } from "./cards/CartCard";
import {
  CheckoutCard,
  OrderConfirmationCard,
  PaymentFailedCard,
} from "./cards/OrderCards";
import type {
  CartPayload,
  ChatMessage,
  ChatSummary,
  CheckoutPayload,
  Component,
  OrderConfirmationPayload,
  ProductCard,
  ShopInfo,
} from "./types";

interface HistoryResponse {
  conversationId: string;
  conversations: ChatSummary[];
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    components: Component[];
  }>;
  cart: CartPayload;
}

/**
 * Text that arrives a word at a time, each one coming up out of a blur.
 *
 * Opacity alone reads as a page that was slow to load. The blur is what makes it
 * read as something settling into focus, and it is the move the rest of this
 * design language is borrowed from. Words rather than letters: letter-by-letter
 * is a typewriter, and a typewriter is a different, busier idea than this.
 */
function Settle({ text, delay = 0 }: { text: string; delay?: number }) {
  const words = text.split(" ");
  return (
    <>
      {words.map((word, index) => (
        <span
          key={`${word}-${index}`}
          className="settle-word"
          style={{ animationDelay: `${delay + index * 120}ms` }}
        >
          {index < words.length - 1 ? `${word} ` : word}
        </span>
      ))}
    </>
  );
}

export function ShopPage() {
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [cart, setCart] = useState<CartPayload | null>(null);
  const [thinking, setThinking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // ── load ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    api
      .get<ShopInfo>("/shop")
      .then((data) => {
        if (!live) return;
        setShop(data);
        document.title = "Convo";
      })
      .catch(() => live && setUnreachable(true));

    api
      .get<HistoryResponse>("/shop/history")
      .then((data) => {
        if (!live) return;
        setConversationId(data.conversationId);
        setChats(data.conversations);
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            components: m.components,
          })),
        );
        setCart(data.cart);
      })
      .catch(() => undefined)
      .finally(() => live && setReady(true));

    return () => {
      live = false;
    };
  }, []);

  // ── stay pinned to the newest message unless the customer scrolled up ─────
  const scrollToEnd = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (pinned.current) scrollToEnd(messages.length <= 1 ? "auto" : "smooth");
  }, [messages, thinking, status, scrollToEnd]);

  function onScroll() {
    const node = scroller.current;
    if (!node) return;
    pinned.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  // ── send a turn ───────────────────────────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed === "" || thinking) return;

      pinned.current = true;
      const userId = `local-${Date.now()}`;
      const replyId = `${userId}-reply`;

      // The customer's message lands on the same frame they pressed send.
      setMessages((current) => [
        ...current,
        { id: userId, role: "user", content: trimmed, components: [] },
      ]);
      setThinking(true);
      setStatus(null);

      try {
        const response = await fetch("/api/shop/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ message: trimmed, conversationId }),
        });
        if (!response.ok || !response.body) throw new Error("stream failed");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;

        const ensureReply = () => {
          if (started) return;
          started = true;
          setThinking(false);
          setStatus(null);
          setMessages((current) => [
            ...current,
            {
              id: replyId,
              role: "assistant",
              content: "",
              components: [],
              streaming: true,
            },
          ]);
        };

        const patchReply = (patch: (message: ChatMessage) => ChatMessage) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === replyId ? patch(message) : message,
            ),
          );
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            boundary = buffer.indexOf("\n\n");

            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;

            let event: { type: string; [key: string]: unknown };
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            switch (event.type) {
              // Which chat the turn landed in. On the first message of a new
              // one this is how the page learns its id.
              case "conversation":
                setConversationId(String(event.conversationId));
                break;

              case "status":
                if (!started) setStatus(String(event.text));
                break;

              case "text_delta":
                ensureReply();
                patchReply((m) => ({
                  ...m,
                  content: m.content + String(event.text),
                }));
                break;

              case "component": {
                ensureReply();
                const component = event.component as Component;
                if (component.component === "cart_state") {
                  // The running cart panel, not something posted in the reply.
                  setCart(component.payload as unknown as CartPayload);
                  break;
                }
                patchReply((m) => ({
                  ...m,
                  components: [...m.components, component],
                }));
                break;
              }

              case "error":
                ensureReply();
                patchReply((m) => ({
                  ...m,
                  error: String(event.message),
                  streaming: false,
                }));
                break;

              case "done":
                ensureReply();
                patchReply((m) => ({ ...m, streaming: false }));
                break;

              default:
                break;
            }
          }
        }

        ensureReply();
        patchReply((m) => ({ ...m, streaming: false }));
      } catch {
        setMessages((current) => [
          ...current,
          {
            id: replyId,
            role: "assistant",
            content: "",
            components: [],
            error:
              "The connection dropped before that could be answered. Try again.",
          },
        ]);
      } finally {
        setThinking(false);
        setStatus(null);
        refreshCart();
      }
    },
    [thinking, conversationId],
  );

  /** Load one of the shopper's chats into the page. */
  const openChat = useCallback(
    async (id: string) => {
      setChatsOpen(false);
      if (id === conversationId) return;
      setReady(false);
      try {
        const data = await api.get<HistoryResponse>(
          `/shop/history?conversationId=${encodeURIComponent(id)}`,
        );
        setConversationId(data.conversationId);
        setChats(data.conversations);
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            components: m.components,
          })),
        );
        // The cart comes back with it because the cart is the shopper's, not
        // the chat's — it is the same basket either side of this call.
        setCart(data.cart);
        pinned.current = true;
      } finally {
        setReady(true);
      }
    },
    [conversationId],
  );

  const newChat = useCallback(async () => {
    setChatsOpen(false);
    const chat = await api.post<ChatSummary>("/shop/conversations", {});
    setConversationId(chat.id);
    setMessages([]);
    setChats((current) => [chat, ...current]);
    pinned.current = true;
  }, []);

  const archiveChat = useCallback(
    async (id: string) => {
      const { conversations: left } = await api.delete<{
        conversations: ChatSummary[];
      }>(`/shop/conversations/${encodeURIComponent(id)}`);
      setChats(left);
      // Removing the chat you are reading has to leave you somewhere.
      if (id === conversationId && left[0]) await openChat(left[0].id);
    },
    [conversationId, openChat],
  );

  const refreshCart = useCallback(() => {
    api
      .get<{ cart: CartPayload }>("/shop/cart")
      .then((r) => setCart(r.cart))
      .catch(() => undefined);
  }, []);

  /**
   * A payment finished in the panel. The server authored the confirmation —
   * including the payment reference — so it goes into the transcript as it
   * came back, rather than the page writing its own version of what happened.
   */
  const settlePayment = useCallback(
    (result: { paid: boolean; reason?: string; components?: Component[] }) => {
      refreshCart();
      const components = (result.components ?? []).filter(
        (component) =>
          component.component === "order_confirmation" ||
          component.component === "payment_failed",
      );
      if (components.length === 0) return;
      setMessages((current) => [
        ...current,
        {
          id: `settled-${Date.now()}`,
          role: "assistant",
          content: "",
          components,
        },
      ]);
      pinned.current = true;
    },
    [refreshCart],
  );

  if (unreachable) {
    return (
      <main className="chat-missing">
        <div>
          <h1 className="t-title">The shop is not answering</h1>
          <p className="t-secondary" style={{ marginTop: "var(--space-2)" }}>
            Reload in a moment. Nothing in your cart has been lost.
          </p>
        </div>
      </main>
    );
  }

  if (!shop || !ready) return <div className="chat-boot" aria-busy="true" />;

  const empty = messages.length === 0;
  const lastChips = latestChips(messages);

  return (
    <div className="chat">
      {/* A soft field of colour behind the conversation, so the page reads as
          somewhere rather than as a blank form. */}
      <div className="chat-ambient" aria-hidden="true" />

      <header className="chat-head">
        <div className="chat-head-inner">
          <div className="chat-head-side">
            <button
              className="chat-head-btn"
              onClick={() => setChatsOpen(true)}
              aria-label={`Your chats, ${chats.length}`}
            >
              <IconMenu size={18} />
            </button>
            <Wordmark />
          </div>

          <div className="chat-head-side">
            {/* New chat sits in the bar, not only inside the sheet: it is the
                one thing here people reach for without wanting a list first. */}
            <button
              className="chat-head-btn"
              onClick={newChat}
              aria-label="New chat"
              title="New chat"
            >
              <IconPlus size={18} />
            </button>

            {/* The shopper is the one who delegates a budget, so the way to
                hand one to an agent belongs on the shopper's own screen. */}
            <button
              className="chat-head-btn"
              onClick={() => setAgentOpen(true)}
              aria-label="Let an agent shop for you"
              title="Let an agent shop for you"
            >
              <IconAgent size={18} />
            </button>

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
        </div>
      </header>

      <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
        <div className="chat-column">
          {empty ? (
            <section className="chat-open">
              <PixelStreet />
              {/* Five words and a street, and nothing else at all. Everything
                  that used to sit here — the catalogue count, the how-to-ask
                  line, the split-payment rule — was answering questions nobody
                  had asked yet, and it crowded out the one thing the screen is
                  actually for. The money rule still holds; it is simply told at
                  checkout, where it matters, rather than here. */}
              <h1 className="chat-open-name">
                <Settle text="Ask for what you want" />
              </h1>
              {shop.catalogSize > 0 && (
                <div className="chat-openers">
                  {shop.openers.map((opener, index) => (
                    <button
                      key={opener}
                      className="chip"
                      style={{ animationDelay: `${900 + index * 90}ms` }}
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
                  {message.role === "user" ? (
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
              {/* What to say next, under the reply that offered it and inside
                  the column it belongs to. Three at most: this is a nudge, not
                  a menu, and a fourth was only ever there because the model
                  returned one. */}
              {!thinking && lastChips.length > 0 && (
                <li className="turn turn-suggestions">
                  <div className="suggestions">
                    {lastChips.slice(0, 3).map((chip, index) => (
                      <button
                        key={chip}
                        className="chip chip-suggestion"
                        style={{ animationDelay: `${index * 60}ms` }}
                        onClick={() => send(chip)}
                      >
                        {chip}
                      </button>
                    ))}
                  </div>
                </li>
              )}
            </ol>
          )}

          {thinking && <Thinking status={status} />}
        </div>
      </div>

      <Composer
        busy={thinking}
        closed={shop.catalogSize === 0 && messages.length === 0}
        onSend={send}
      />

      {agentOpen && <AgentSheet onClose={() => setAgentOpen(false)} />}

      {chatsOpen && (
        <ChatSheet
          chats={chats}
          currentId={conversationId}
          onOpen={openChat}
          onNew={newChat}
          onArchive={archiveChat}
          onClose={() => setChatsOpen(false)}
        />
      )}

      {cartOpen && cart && (
        <CartSheet
          cart={cart}
          onClose={() => setCartOpen(false)}
          onAsk={(text) => {
            setCartOpen(false);
            send(text);
          }}
          busy={thinking}
        />
      )}
    </div>
  );
}

/** One assistant turn: its text, then whatever components it produced. */
function Reply({
  message,
  disabled,
  onAsk,
  onPaymentSettled,
}: {
  message: ChatMessage;
  disabled: boolean;
  onAsk(text: string): void;
  onPaymentSettled(result: {
    paid: boolean;
    reason?: string;
    components?: Component[];
  }): void;
}) {
  if (message.error) {
    return <p className="reply-error">{message.error}</p>;
  }

  return (
    <>
      {message.content !== "" && (
        <p
          className="reply"
          data-streaming={message.streaming ? "true" : undefined}
        >
          {message.content}
        </p>
      )}

      {message.components
        .filter((c) => c.component !== "suggestions")
        .map((component, index) => (
          <div className="component" key={`${message.id}-${index}`}>
            {renderComponent(component, disabled, onAsk, onPaymentSettled)}
          </div>
        ))}
    </>
  );
}

function renderComponent(
  component: Component,
  disabled: boolean,
  onAsk: (text: string) => void,
  onPaymentSettled: (result: {
    paid: boolean;
    reason?: string;
    components?: Component[];
  }) => void,
) {
  switch (component.component) {
    case "products":
      return (
        <ProductCards
          title={(component.payload.title as string | null) ?? null}
          layout={(component.payload.layout as string) ?? "carousel"}
          items={component.payload.items as ProductCard[]}
          onAsk={onAsk}
          disabled={disabled}
        />
      );
    case "cart":
      return (
        <CartCard
          cart={component.payload as unknown as CartPayload}
          onAsk={onAsk}
          disabled={disabled}
        />
      );
    case "checkout":
      return (
        <CheckoutCard
          payload={component.payload as unknown as CheckoutPayload}
          disabled={disabled}
          onSettled={onPaymentSettled}
        />
      );
    case "order_confirmation":
      return (
        <OrderConfirmationCard
          payload={component.payload as unknown as OrderConfirmationPayload}
        />
      );
    case "payment_failed":
      return (
        <PaymentFailedCard
          payload={
            component.payload as unknown as {
              order_id: string;
              reason: string;
              total_display: string;
            }
          }
        />
      );
    default:
      return null;
  }
}

/** The chips from the most recent turn, which are the ones still on offer. */
function latestChips(messages: ChatMessage[]): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const chips = message.components.find((c) => c.component === "suggestions");
    if (chips) return (chips.payload.suggestions as string[]) ?? [];
    return [];
  }
  return [];
}
