import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type AuditEntry,
  type Overview as OverviewData,
} from "../lib/api";
import { money, plural, when } from "../lib/format";
import { useCountUp } from "../lib/useCountUp";
import { Toaster, useToast } from "../components/Toast";
import {
  IconArrow,
  IconBolt,
  IconCheck,
  IconCopy,
  IconExternal,
  IconLink,
  IconSpark,
} from "../components/icons";
import { PageHead } from "./Layout";
import { ACTION_LABELS, ACTION_ICONS } from "./AuditLog";

export function Overview() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [recent, setRecent] = useState<AuditEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [listing, setListing] = useState(false);
  const { toasts, show } = useToast();

  useEffect(() => {
    api
      .get<OverviewData>("/dashboard/overview")
      .then(setData)
      .catch(() => setData(null));
    api
      .get<{ entries: AuditEntry[] }>("/dashboard/audit")
      .then((r) => setRecent(r.entries.slice(0, 6)))
      .catch(() => setRecent([]));
  }, []);

  if (!data) return <div className="boot" aria-busy="true" />;

  const { tenant, shopUrl, stats, provider, model } = data;
  const listed = data.listing.listed;
  const blockers = data.listing.blockers;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shopUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      show("Could not copy the link. Select it and copy manually.", "danger");
    }
  }

  async function toggleListing() {
    setListing(true);
    try {
      const response = await api.patch<{ tenant: typeof tenant }>(
        "/dashboard/tenant",
        {
          isListed: !listed,
        },
      );
      setData((current) =>
        current
          ? {
              ...current,
              tenant: response.tenant,
              listing: { ...current.listing, listed: response.tenant.isListed },
            }
          : current,
      );
      show(
        response.tenant.isListed
          ? "Your catalogue is on the marketplace."
          : "Taken off the marketplace. Nothing else has changed.",
        response.tenant.isListed ? "ok" : undefined,
      );
    } catch (error) {
      show(
        error instanceof Error ? error.message : "That did not go through.",
        "danger",
      );
    } finally {
      setListing(false);
    }
  }

  return (
    <>
      <PageHead
        title={tenant.name}
        eyebrow={
          listed ? (
            <>
              <span className="live-dot" />
              On the marketplace
            </>
          ) : (
            "Not listed"
          )
        }
        lede="Everything a shopper sees of your brand comes from what is set up here."
      />

      {/*
        Being on the shelf is the thing this dashboard is for, so it gets the
        one lit surface on the page. Dark when the brand is not listed: an
        unlit panel is a truer picture of a catalogue nobody can reach than a
        cheerful one with the switch turned off.
      */}
      <section className="link-panel" data-live={listed ? "true" : "false"}>
        <div className="link-panel-glow" aria-hidden="true" />
        <div className="link-panel-body">
          <span className="link-panel-icon">
            <IconLink size={18} />
          </span>
          <div className="link-panel-text">
            <p className="link-panel-label">
              {listed ? "Listed on the Convo marketplace" : "Not listed yet"}
            </p>
            <p className="link-panel-url">{shopUrl}</p>
          </div>
          <div className="link-panel-actions">
            {listed && (
              <button className="btn btn-secondary btn-sm" onClick={copyLink}>
                {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            {listed ? (
              <a
                className="btn btn-primary btn-sm"
                href={shopUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open
                <IconExternal size={15} />
              </a>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={toggleListing}
                disabled={listing || blockers.length > 0}
                title={blockers[0]}
              >
                {listing ? "Listing…" : "List my catalogue"}
              </button>
            )}
          </div>
        </div>

        {!listed && blockers.length > 0 && (
          <ul className="link-panel-blockers">
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        )}

        {!listed && blockers.length === 0 && (
          <p className="link-panel-foot">
            Your products appear alongside other brands. Customers pay you
            directly, on your own payment account — Convo never holds the money.
          </p>
        )}

        {listed && (
          <p className="link-panel-foot">
            Customers pay you directly, on your own payment account.{" "}
            <button
              className="link-panel-unlist"
              onClick={toggleListing}
              disabled={listing}
            >
              {listing ? "Removing…" : "Take my catalogue off the marketplace"}
            </button>
          </p>
        )}
      </section>

      <section className="stat-grid">
        <Stat
          label="Products"
          value={stats.products}
          note={
            stats.products === 0
              ? undefined
              : stats.outOfStock > 0
                ? `${stats.outOfStock} out of stock`
                : "all in stock"
          }
        />
        <Stat
          label="Shoppers reached"
          value={stats.conversations}
          note={listed ? undefined : "not listed"}
        />
        <Stat label="Paid orders" value={stats.orders} />
        <Stat
          label="Taken"
          value={stats.revenueMinor}
          format={(n) => money(n, tenant.currency)}
          accent
        />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Setup</h2>
        </div>
        <ul className="setup-list">
          <SetupRow
            done={stats.products > 0}
            title={
              stats.products > 0
                ? `${plural(stats.products, "product")} in the catalogue`
                : "Add your first product"
            }
            body={
              stats.products > 0
                ? "The agent searches this catalogue and nothing else."
                : "Until there is a catalogue, the agent has nothing to show a customer."
            }
            to="/dashboard/catalog"
            action={stats.products > 0 ? "Manage" : "Add products"}
          />
          <SetupRow
            done={provider?.providerType === "razorpay"}
            title={
              provider?.providerType === "razorpay"
                ? "Taking payment through Razorpay"
                : "Connect a payment provider"
            }
            body={
              provider?.providerType === "razorpay"
                ? `Razorpay test mode${provider.credentialsHint ? `, key ${provider.credentialsHint}` : ""}. Your catalogue and your payments both come from it.`
                : "Checkout runs on the built-in test processor, which signs and verifies payments the way a live provider does but moves no money."
            }
            to="/dashboard/provider"
            action={
              provider?.providerType === "razorpay" ? "Manage" : "Connect"
            }
          />
          {/* The model is Convo's choice now, not the brand's, so this row
              states a fact rather than pointing at a setting that no longer
              exists on the settings page. */}
          <SetupRow
            done
            title={`Convo's agent runs on ${modelLabel(model.active)}`}
            body={
              model.active === "scripted"
                ? "One assistant serves every brand here, so the model is Convo\u2019s choice rather than yours. It answers without calling out to anyone; the skills, the gates, and your audit trail are the same whichever model is behind it."
                : `One assistant serves every brand here, so the model is Convo\u2019s choice rather than yours. Calls go to ${modelLabel(model.active)}; the skills, the gates, and your audit trail are the same whichever model is behind it.`
            }
          />
        </ul>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="t-heading">Recent activity</h2>
          <Link className="link-arrow t-sm" to="/dashboard/audit">
            Full audit trail
            <IconArrow size={14} />
          </Link>
        </div>

        {recent.length === 0 ? (
          <div className="empty">
            <span className="empty-mark">
              <IconBolt size={20} />
            </span>
            <p className="empty-title">Nothing has happened yet</p>
            <p className="empty-body">
              Open the marketplace and buy something. Every cart lock, order,
              and payment lands here with its amount and outcome.
            </p>
            <a
              className="btn btn-secondary"
              href={shopUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open the marketplace
              <IconExternal size={15} />
            </a>
          </div>
        ) : (
          <ul className="activity">
            {recent.map((entry, index) => {
              const Icon = ACTION_ICONS[entry.actionType] ?? IconSpark;
              return (
                <li
                  key={entry.id}
                  className="activity-row"
                  data-outcome={entry.outcome}
                  style={{ animationDelay: `${Math.min(index, 6) * 40}ms` }}
                >
                  <span className="activity-icon">
                    <Icon size={15} />
                  </span>
                  <span className="activity-action">
                    {ACTION_LABELS[entry.actionType] ?? entry.actionType}
                  </span>
                  <span className="activity-amount t-num">
                    {entry.amountMinor === null
                      ? ""
                      : money(entry.amountMinor, entry.currency ?? "INR")}
                  </span>
                  <span className="activity-time t-sm t-muted">
                    {when(entry.createdAt)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Toaster toasts={toasts} />
    </>
  );
}

function Stat({
  label,
  value,
  note,
  format,
  accent,
}: {
  label: string;
  value: number;
  note?: string;
  format?: (n: number) => string;
  accent?: boolean;
}) {
  const shown = useCountUp(value);
  return (
    <div className="stat" data-accent={accent}>
      <p className="stat-label t-sm">{label}</p>
      <p className="stat-value t-num">
        {format ? format(shown) : shown.toLocaleString("en-IN")}
      </p>
      {note && <p className="stat-note t-xs">{note}</p>}
    </div>
  );
}

function SetupRow({
  done,
  title,
  body,
  to,
  action,
}: {
  done: boolean;
  title: string;
  body: string;
  /** Omitted for a row that only reports; not everything here is a task. */
  to?: string;
  action?: string;
}) {
  return (
    <li className="setup-row" data-done={done}>
      <span className="setup-tick" aria-hidden="true">
        {done ? <IconCheck size={13} /> : <span className="setup-ring" />}
      </span>
      <div className="setup-text">
        <p className="setup-title">{title}</p>
        <p className="t-sm t-secondary">{body}</p>
      </div>
      {to && action && (
        <Link className="btn btn-secondary btn-sm" to={to}>
          {action}
        </Link>
      )}
    </li>
  );
}

export function outcomeClass(outcome: string): string {
  if (outcome === "ok") return "badge-ok";
  if (outcome === "blocked") return "badge-warn";
  return "badge-danger";
}

export function providerLabel(type: string): string {
  return type === "razorpay" ? "Razorpay" : "the Convo catalogue";
}

/** Provider keys are configuration values; people read names. */
export function modelLabel(provider: string): string {
  if (provider === "anthropic") return "Claude";
  if (provider === "openai") return "GPT";
  if (provider === "scripted") return "Convo's built-in model";
  return provider;
}
