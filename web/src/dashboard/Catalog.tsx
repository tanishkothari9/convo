import { useEffect, useMemo, useState } from "react";
import { PixelStall } from "../components/PixelStall";
import { api, ApiError, type Product } from "../lib/api";
import { money, plural } from "../lib/format";
import { Toaster, useToast } from "../components/Toast";
import { PageHead } from "./Layout";
import { ProductEditor } from "./ProductEditor";

export function Catalog() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [query, setQuery] = useState("");
  const { toasts, show } = useToast();

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const result = await api.get<{ products: Product[] }>(
        "/dashboard/products",
      );
      setProducts(result.products);
    } catch {
      setProducts([]);
      show("Could not load the catalogue.", "danger");
    }
  }

  const visible = useMemo(() => {
    if (!products) return [];
    const term = query.trim().toLowerCase();
    if (term === "") return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(term) ||
        (p.category ?? "").toLowerCase().includes(term) ||
        (p.description ?? "").toLowerCase().includes(term),
    );
  }, [products, query]);

  async function remove(product: Product) {
    if (!confirm(`Delete “${product.name}”? This cannot be undone.`)) return;
    try {
      await api.delete(`/dashboard/products/${product.id}`);
      setProducts((current) =>
        (current ?? []).filter((p) => p.id !== product.id),
      );
      show(`Deleted ${product.name}.`);
    } catch (error) {
      show(
        error instanceof ApiError
          ? error.message
          : "Could not delete that product.",
        "danger",
      );
    }
  }

  if (!products) return <div className="boot" aria-busy="true" />;

  const synced = products.some((p) => p.source !== "manual");

  return (
    <>
      <PageHead
        title="Catalogue"
        lede={
          products.length === 0
            ? "The agent can only show what is here."
            : `${plural(products.filter((p) => p.isActive).length, "product")} the agent can show and sell.`
        }
        actions={
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            Add product
          </button>
        }
      />

      {synced && (
        <p className="notice" style={{ marginBottom: "var(--space-5)" }}>
          Some products came from a connected provider. Editing one here changes
          it in Convo only; the next sync will overwrite it.
        </p>
      )}

      {products.length === 0 ? (
        <div className="empty">
          {/* The one screen in here with nothing to render, so the picture is
              the content: the brand's own pitch, awning up, table bare. */}
          <PixelStall />
          <p className="empty-title">No products yet</p>
          <p className="empty-body">
            Add one by hand, or connect a provider and Convo pulls your
            catalogue across. The agent searches this list and nothing else, so
            what is here is what a customer can buy.
          </p>
          <button className="btn btn-primary" onClick={() => setEditing("new")}>
            Add your first product
          </button>
        </div>
      ) : (
        <>
          <div className="catalog-search">
            <input
              className="input"
              placeholder="Search the catalogue"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search the catalogue"
            />
          </div>

          {visible.length === 0 ? (
            <p className="t-secondary" style={{ padding: "var(--space-6) 0" }}>
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            <ul className="product-list">
              {visible.map((product) => (
                <li
                  key={product.id}
                  className="product-row"
                  data-inactive={!product.isActive}
                >
                  <div className="product-thumb">
                    {product.images[0] ? (
                      <img src={product.images[0]} alt="" loading="lazy" />
                    ) : (
                      <span
                        className="product-thumb-empty"
                        aria-hidden="true"
                      />
                    )}
                  </div>

                  <div className="product-main">
                    <p className="product-name">{product.name}</p>
                    <p className="t-sm t-muted product-meta">
                      {[
                        product.category,
                        product.source !== "manual"
                          ? `synced from ${product.source}`
                          : null,
                        !product.isActive ? "hidden" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>

                  <p className="product-price t-num">
                    {money(product.priceMinor, product.currency)}
                  </p>

                  <p className="product-stock">
                    {product.stock === 0 ? (
                      <span className="badge badge-danger">Out of stock</span>
                    ) : product.stock >= 999_999 ? (
                      <span className="badge">Not tracked</span>
                    ) : product.stock <= 3 ? (
                      <span className="badge badge-warn t-num">
                        {product.stock} left
                      </span>
                    ) : (
                      <span className="t-sm t-muted t-num">
                        {product.stock} in stock
                      </span>
                    )}
                  </p>

                  <div className="product-actions">
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => setEditing(product)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn-ghost btn-sm product-delete"
                      onClick={() => remove(product)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {editing && (
        <ProductEditor
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setProducts((current) => {
              const list = current ?? [];
              return created
                ? [saved, ...list]
                : list.map((p) => (p.id === saved.id ? saved : p));
            });
            setEditing(null);
            show(created ? `Added ${saved.name}.` : `Saved ${saved.name}.`);
          }}
        />
      )}

      <Toaster toasts={toasts} />
    </>
  );
}
