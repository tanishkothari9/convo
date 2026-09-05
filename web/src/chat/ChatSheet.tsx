import { useEffect } from "react";
import { IconPlus, IconTrash } from "../components/icons";
import type { ChatSummary } from "./types";

/**
 * The shopper's chats, as a sheet.
 *
 * A sheet from the left, mirroring the cart's from the right, rather than the
 * permanent sidebar a desktop chat app would use. This page is a reading column
 * with a market drawn under it; a rail pinned beside that would squeeze both,
 * and it would only exist above some width — which is a layout you have not
 * designed rather than one you have.
 *
 * Worth saying plainly in here, because it is the thing people assume wrongly:
 * a new chat is a new transcript, not a new basket. The cart and the orders
 * belong to the shopper and follow them between chats.
 */
export function ChatSheet({
  chats,
  currentId,
  onOpen,
  onNew,
  onArchive,
  onClose,
}: {
  chats: ChatSummary[];
  currentId: string | null;
  onOpen(id: string): void;
  onNew(): void;
  onArchive(id: string): void;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="chats-layer"
      role="dialog"
      aria-modal="true"
      aria-label="Your chats"
    >
      <button
        className="cart-scrim"
        onClick={onClose}
        aria-label="Close chats"
        tabIndex={-1}
      />
      <div className="chats-sheet">
        <header className="cart-sheet-head">
          <h2 className="t-heading">Your chats</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="chats-new">
          <button className="btn btn-secondary chats-new-btn" onClick={onNew}>
            <IconPlus size={15} />
            New chat
          </button>
        </div>

        <ul className="chats-list">
          {chats.map((chat) => (
            <li
              key={chat.id}
              className="chats-row"
              data-current={chat.id === currentId}
            >
              <button
                className="chats-open"
                onClick={() => onOpen(chat.id)}
                aria-current={chat.id === currentId ? "true" : undefined}
              >
                <span className="chats-title">{chat.title ?? "New chat"}</span>
                <span className="chats-when t-xs t-muted">
                  {when(chat.last_active_at)}
                </span>
              </button>
              {/* Hides the chat; the orders placed in it stay exactly where
                  they are, which is why this says remove and not delete. */}
              <button
                className="chats-remove"
                onClick={() => onArchive(chat.id)}
                aria-label={`Remove ${chat.title ?? "this chat"}`}
                title="Remove from this list"
              >
                <IconTrash size={15} />
              </button>
            </li>
          ))}
        </ul>

        <p className="chats-foot t-xs t-muted">
          Your cart and your orders stay with you across every chat.
        </p>
      </div>
    </div>
  );
}

/** Relative for the last week, then the date. Long enough to be useful. */
function when(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
