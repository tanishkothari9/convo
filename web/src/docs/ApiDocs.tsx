import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  IconArrow,
  IconCheck,
  IconCopy,
  IconGate,
  IconLink,
} from "../components/icons";
import { useAuth } from "../dashboard/auth";
import { api } from "../lib/api";
import {
  BASE_URL_PLACEHOLDER,
  ERRORS,
  KEY_PLACEHOLDER,
  SECTIONS,
  type Endpoint,
} from "./reference";
import { PixelHorizon } from "../components/PixelHorizon";
import { Wordmark } from "../components/Wordmark";

/**
 * The API reference.
 *
 * Two things make this useful rather than decorative: every example is a
 * complete `curl` you can paste, and when you are signed in it fills in your
 * own key and this deployment's host — so the first request in the page is a
 * request against your own catalogue rather than a template to edit.
 */
export function ApiDocs() {
  const { session } = useAuth();
  const [keyValue, setKeyValue] = useState<string | null>(null);
  const [active, setActive] = useState(SECTIONS[0]!.endpoints[0]!.id);

  const baseUrl = typeof window === "undefined" ? "" : window.location.origin;

  // Track which endpoint is in view so the sidebar says where you are.
  useEffect(() => {
    const targets = document.querySelectorAll("[data-endpoint]");
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];
        if (visible)
          setActive((visible.target as HTMLElement).dataset.endpoint!);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  const fill = useMemo(
    () => (text: string) =>
      text
        .replaceAll(BASE_URL_PLACEHOLDER, baseUrl)
        .replaceAll(KEY_PLACEHOLDER, keyValue ?? "cvo_live_your_key_here"),
    [baseUrl, keyValue],
  );

  async function mintKey() {
    try {
      const result = await api.post<{ secret: string }>("/dashboard/api-keys", {
        name: "Created from the docs",
      });
      setKeyValue(result.secret);
    } catch {
      setKeyValue(null);
    }
  }

  return (
    <div className="docs">
      <header className="docs-bar">
        <Link to="/" aria-label="Convo home">
          <Wordmark size="sm" />
        </Link>
        <span className="docs-bar-title">API reference</span>
        <div className="docs-bar-actions">
          {session ? (
            <Link
              className="btn btn-secondary btn-sm"
              to="/dashboard/developers"
            >
              Manage keys
            </Link>
          ) : (
            <Link className="btn btn-secondary btn-sm" to="/login">
              Sign in
            </Link>
          )}
        </div>
      </header>

      <div className="docs-body">
        <nav className="docs-nav" aria-label="API reference">
          <a className="docs-nav-link" href="#start">
            Getting started
          </a>
          {SECTIONS.map((section) => (
            <div key={section.id} className="docs-nav-group">
              <p className="docs-nav-heading">{section.title}</p>
              {section.endpoints.map((endpoint) => (
                <a
                  key={endpoint.id}
                  className={`docs-nav-link${active === endpoint.id ? " is-active" : ""}`}
                  href={`#${endpoint.id}`}
                >
                  <span
                    className={`docs-verb docs-verb-${endpoint.method.toLowerCase()}`}
                  >
                    {endpoint.method}
                  </span>
                  {endpoint.title}
                </a>
              ))}
            </div>
          ))}
          <a className="docs-nav-link" href="#errors">
            Errors
          </a>
          <a className="docs-nav-link" href="#limits">
            Rate limits
          </a>
        </nav>

        <main className="docs-main">
          <section id="start" className="docs-intro">
            <h1 className="docs-title">Convo API</h1>
            <p className="docs-lede">
              Load your catalogue from whatever system already holds it, and
              read back what the agent sold. REST over HTTPS, JSON in and out,
              one bearer key.
            </p>

            <div className="docs-key">
              <span className="docs-key-icon">
                <IconLink size={16} />
              </span>
              <div className="docs-key-body">
                <p className="docs-key-label">Base URL</p>
                <code className="docs-key-value">{baseUrl}</code>
              </div>
              <CopyButton text={baseUrl} label="Copy" />
            </div>

            <div className="docs-key">
              <span className="docs-key-icon">
                <IconGate size={16} />
              </span>
              <div className="docs-key-body">
                <p className="docs-key-label">Your API key</p>
                <code className="docs-key-value">
                  {keyValue ??
                    (session
                      ? "Create one and it fills in every example below"
                      : "Sign in to fill in the examples")}
                </code>
              </div>
              {session ? (
                keyValue ? (
                  <CopyButton text={keyValue} label="Copy" />
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={mintKey}>
                    Create a key
                  </button>
                )
              ) : (
                <Link className="btn btn-secondary btn-sm" to="/login">
                  Sign in
                </Link>
              )}
            </div>

            {keyValue && (
              <p className="docs-warn">
                This is the only time this key is shown. Convo stores a digest
                of it, not the key — if you lose it, create another.
              </p>
            )}

            <h2 className="docs-h2">Authentication</h2>
            <p className="docs-p">
              Send the key as a bearer token on every request. A key belongs to
              one brand and can reach nothing outside it.
            </p>
            <Code
              text={`Authorization: Bearer ${keyValue ?? "cvo_live_your_key_here"}`}
            />

            <h2 className="docs-h2">Loading a catalogue</h2>
            <p className="docs-p">
              One call. Address products by <code>external_id</code> — your own
              id — and the same request can be run every night: it updates what
              changed and creates what is new, rather than growing a second copy
              of your catalogue.
            </p>
            <Code text={fill(SECTIONS[0]!.endpoints[0]!.request!)} />
          </section>

          {SECTIONS.map((section) => (
            <section key={section.id} className="docs-section">
              <header className="docs-section-head">
                <h2 className="docs-h1">{section.title}</h2>
                <p className="docs-p">{section.blurb}</p>
              </header>
              {section.endpoints.map((endpoint) => (
                <EndpointBlock
                  key={endpoint.id}
                  endpoint={endpoint}
                  fill={fill}
                />
              ))}
            </section>
          ))}

          <section id="errors" className="docs-section">
            <h2 className="docs-h1">Errors</h2>
            <p className="docs-p">
              Every failure returns a JSON body with a human <code>error</code>{" "}
              and a stable <code>code</code> you can branch on. The message
              names the field and what it expected, so a failing sync tells you
              what to change.
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Code</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {ERRORS.map((error) => (
                    <tr key={`${error.status}-${error.code}`}>
                      <td className="t-num">{error.status}</td>
                      <td>
                        <code>{error.code}</code>
                      </td>
                      <td>{error.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section id="limits" className="docs-section">
            <h2 className="docs-h1">Rate limits</h2>
            <p className="docs-p">
              Limits are per key. Every response carries{" "}
              <code>X-RateLimit-Remaining</code>; a 429 carries{" "}
              <code>Retry-After</code> in seconds. A nightly sync will not come
              close to these.
            </p>
            <div className="docs-table-wrap">
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Surface</th>
                    <th>Burst</th>
                    <th>Sustained</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>All endpoints</td>
                    <td className="t-num">120</td>
                    <td className="t-num">600 / min</td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/products/bulk</code>
                    </td>
                    <td className="t-num">10</td>
                    <td className="t-num">30 / min</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <footer className="docs-foot">
            <Link className="link-arrow" to="/dashboard/developers">
              Manage your API keys
              <IconArrow size={14} />
            </Link>
          </footer>
        </main>
      </div>

      {/* The same horizon the dashboard ends on. */}
      <PixelHorizon />
    </div>
  );
}

function EndpointBlock({
  endpoint,
  fill,
}: {
  endpoint: Endpoint;
  fill: (t: string) => string;
}) {
  return (
    <article
      className="docs-endpoint"
      id={endpoint.id}
      data-endpoint={endpoint.id}
    >
      <div className="docs-endpoint-head">
        <h3 className="docs-h2">{endpoint.title}</h3>
        <p className="docs-route">
          <span
            className={`docs-verb docs-verb-${endpoint.method.toLowerCase()}`}
          >
            {endpoint.method}
          </span>
          <code>{endpoint.path}</code>
        </p>
      </div>

      <p className="docs-p">{endpoint.summary}</p>
      {endpoint.note && <p className="docs-note">{endpoint.note}</p>}

      {endpoint.params && (
        <FieldTable title="Query parameters" fields={endpoint.params} />
      )}
      {endpoint.body && <FieldTable title="Body" fields={endpoint.body} />}

      <div className="docs-panes">
        {endpoint.request && (
          <div className="docs-pane">
            <p className="docs-pane-label">Request</p>
            <Code text={fill(endpoint.request)} />
          </div>
        )}
        <div className="docs-pane">
          <p className="docs-pane-label">Response</p>
          <Code text={endpoint.response} language="json" />
        </div>
      </div>
    </article>
  );
}

function FieldTable({
  title,
  fields,
}: {
  title: string;
  fields: Endpoint["params"];
}) {
  if (!fields || fields.length === 0) return null;
  return (
    <div className="docs-fields">
      <p className="docs-pane-label">{title}</p>
      <div className="docs-table-wrap">
        <table className="docs-table">
          <tbody>
            {fields.map((field) => (
              <tr key={field.name}>
                <td className="docs-field-name">
                  <code>{field.name}</code>
                  {field.required && (
                    <span className="docs-required">required</span>
                  )}
                </td>
                <td className="docs-field-type">{field.type}</td>
                <td>{field.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Code({ text, language }: { text: string; language?: string }) {
  return (
    <div className="docs-code">
      <pre>
        <code data-language={language}>{text}</code>
      </pre>
      <CopyButton text={text} label="Copy" subtle />
    </div>
  );
}

function CopyButton({
  text,
  label,
  subtle,
}: {
  text: string;
  label: string;
  subtle?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={subtle ? "docs-copy" : "btn btn-secondary btn-sm"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
      aria-label={copied ? "Copied" : label}
    >
      {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      {subtle ? null : copied ? "Copied" : label}
    </button>
  );
}
