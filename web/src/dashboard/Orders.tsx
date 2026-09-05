import { useEffect, useMemo, useState } from "react";
import { api, type Order } from "../lib/api";
import { money, when } from "../lib/format";
import { Toaster, useToast } from "../components/Toast";
import { IconCheck, IconCopy, IconReceipt } from "../components/icons";
import { PageHead } from "./Layout";

const FILTERS = [
  { key: "all", label: "Everything" },
  { key: "paid", label: "Paid" },
  { key: "awaiting_payment", label: "Awaiting payment" },
  { key: "failed", label: "Failed" },
] as const;

const STATUS_TONE: Record<string, string> = {
  paid: "badge-ok",
  awaiting_payment: "badge-warn",
  created: "badge-warn",
  failed: "badge-danger",
  cancelled: "badge",
  refunded: "badge",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  awaiting_payment: "Awaiting payment",
  created: "Started",
  failed: "Failed",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

/**
 * What was sold, and where it goes.
 *
 * The audit trail answers "was this safe"; this answers "what do I put in a
 * box". So the delivery address is the thing the row expands to show, rather
 * than a technical detail buried behind an id.
 */
export function Orders() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const { toasts, show } = useToast();

  useEffect(() => {
    api
      .get<{ orders: Order[] }>("/dashboard/orders")
      .then((r) => setOrders(r.orders))
      .catch(() => setOrders([]));
  }, []);

  const visible = useMemo(
    () =>
      (orders ?? []).filter(
        (order) => filter === "all" || order.status === filter,
      ),
    [orders, filter],
  );

  const paid = (orders ?? []).filter((order) => order.status === "paid");
  const toShip = paid.filter((order) => order.shippingAddress);

  async function copyAddress(order: Order) {
    const address = order.shippingAddress;
    if (!address) return;
    const block = [
      address.name,
      `+91 ${address.phone}`,
      address.line1,
      address.line2,
      `${address.city}, ${address.state} ${address.postalCode}`,
      address.country,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(block);
      setCopied(order.id);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      show(
        "Could not copy. Select the address and copy it manually.",
        "danger",
      );
    }
  }

  if (!orders) return <div className="boot" aria-busy="true" />;

  return (
    <>
      <PageHead
        title="Orders"
        lede={
          paid.length === 0
            ? "Everything the agent has sold, and where each one goes."
            : `${toShip.length} paid ${toShip.length === 1 ? "order" : "orders"} to send out.`
        }
      />

      {orders.length === 0 ? (
        <div className="empty">
          <span className="empty-mark">
            <IconReceipt size={20} />
          </span>
          <p className="empty-title">No orders yet</p>
          <p className="empty-body">
            When a customer checks out on the marketplace, the order appears
            here with its items and the address to send it to.
          </p>
        </div>
      ) : (
        <>
          <div
            className="filter-row"
            role="group"
            aria-label="Filter by status"
          >
            {FILTERS.map((option) => (
              <button
                key={option.key}
                className={`chip${filter === option.key ? " is-selected" : ""}`}
                onClick={() => setFilter(option.key)}
                aria-pressed={filter === option.key}
              >
                {option.label}
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <p className="t-secondary" style={{ padding: "var(--space-6) 0" }}>
              Nothing{" "}
              {FILTERS.find((f) => f.key === filter)?.label.toLowerCase()}.
            </p>
          ) : (
            <ul className="order-list">
              {visible.map((order) => {
                const expanded = open === order.id;
                return (
                  <li
                    key={order.id}
                    className="order-item"
                    data-expanded={expanded}
                  >
                    <button
                      className="order-summary-row"
                      onClick={() => setOpen(expanded ? null : order.id)}
                      aria-expanded={expanded}
                    >
                      <span
                        className={`badge badge-dot ${STATUS_TONE[order.status] ?? "badge"}`}
                      >
                        {STATUS_LABEL[order.status] ?? order.status}
                      </span>
                      <span className="order-item-name">
                        {order.lineItems.map((line) => line.name).join(", ") ||
                          "—"}
                      </span>
                      <span className="order-item-total t-num">
                        {money(order.totalAmountMinor, order.currency)}
                      </span>
                      <span className="order-item-when t-sm t-muted">
                        {when(order.createdAt)}
                      </span>
                    </button>

                    {expanded && (
                      <div className="order-detail">
                        <div className="order-detail-block">
                          <p className="t-xs t-muted">Items</p>
                          <ul className="order-detail-lines">
                            {order.lineItems.map((line) => (
                              <li key={line.productId}>
                                <span>
                                  {line.name}
                                  {line.quantity > 1 && (
                                    <span className="t-muted t-num">
                                      {" "}
                                      × {line.quantity}
                                    </span>
                                  )}
                                </span>
                                <span className="t-num">
                                  {money(line.lineTotalMinor, order.currency)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div className="order-detail-block">
                          <p className="t-xs t-muted">Deliver to</p>
                          {order.shippingAddress ? (
                            <>
                              <address className="order-address">
                                {order.shippingAddress.name}
                                <br />
                                <span className="t-num">
                                  +91 {order.shippingAddress.phone}
                                </span>
                                <br />
                                {order.shippingAddress.line1}
                                <br />
                                {order.shippingAddress.line2 && (
                                  <>
                                    {order.shippingAddress.line2}
                                    <br />
                                  </>
                                )}
                                {order.shippingAddress.city},{" "}
                                {order.shippingAddress.state}{" "}
                                <span className="t-num">
                                  {order.shippingAddress.postalCode}
                                </span>
                              </address>
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => copyAddress(order)}
                              >
                                {copied === order.id ? (
                                  <IconCheck size={14} />
                                ) : (
                                  <IconCopy size={14} />
                                )}
                                {copied === order.id
                                  ? "Copied"
                                  : "Copy address"}
                              </button>
                            </>
                          ) : (
                            <p className="t-sm t-secondary">
                              Not given. The customer left before finishing
                              checkout, so nothing was charged.
                            </p>
                          )}
                        </div>

                        <div className="order-detail-block">
                          <p className="t-xs t-muted">Reference</p>
                          <dl className="order-refs">
                            <div>
                              <dt className="t-sm t-muted">Order</dt>
                              <dd className="t-id">{order.id}</dd>
                            </div>
                            {order.providerPaymentId && (
                              <div>
                                <dt className="t-sm t-muted">Payment</dt>
                                <dd className="t-id">
                                  {order.providerPaymentId}
                                </dd>
                              </div>
                            )}
                            <div>
                              <dt className="t-sm t-muted">Placed</dt>
                              <dd className="t-sm t-num">
                                {new Date(order.createdAt).toLocaleString(
                                  "en-IN",
                                )}
                              </dd>
                            </div>
                          </dl>
                          {order.failureReason && (
                            <p className="notice notice-danger">
                              {order.failureReason}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      <Toaster toasts={toasts} />
    </>
  );
}
