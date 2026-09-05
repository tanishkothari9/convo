import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Product } from "../lib/api";

interface Props {
  product: Product | null;
  onClose(): void;
  onSaved(product: Product, created: boolean): void;
}

/**
 * A sheet, not a page. Editing a product is a side task — leaving the list on
 * screen behind it keeps the merchant's place, and the scrim says the list is
 * inert until they are done.
 */
export function ProductEditor({ product, onClose, onSaved }: Props) {
  const creating = product === null;
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [priceMajor, setPriceMajor] = useState(
    product ? String(Math.round(product.priceMinor / 100)) : "",
  );
  const [stock, setStock] = useState(product ? String(product.stock) : "0");
  const [category, setCategory] = useState(product?.category ?? "");
  const [imageUrl, setImageUrl] = useState(product?.images[0] ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstField.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const price = Number(priceMajor);
    if (!Number.isFinite(price) || price < 0) {
      setError("Give a price as a whole number of rupees.");
      return;
    }

    setBusy(true);
    const body = {
      name: name.trim(),
      description: description.trim(),
      priceMajor: Math.round(price),
      stock: Math.max(0, Math.round(Number(stock) || 0)),
      category: category.trim(),
      images: imageUrl.trim() === "" ? [] : [imageUrl.trim()],
    };

    try {
      const result = creating
        ? await api.post<{ product: Product }>("/dashboard/products", body)
        : await api.patch<{ product: Product }>(
            `/dashboard/products/${product.id}`,
            body,
          );
      onSaved(result.product, creating);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not save that product.",
      );
      setBusy(false);
    }
  }

  return (
    <div
      className="sheet-layer"
      role="dialog"
      aria-modal="true"
      aria-label={creating ? "Add product" : "Edit product"}
    >
      <button
        className="sheet-scrim"
        onClick={onClose}
        aria-label="Close"
        tabIndex={-1}
      />
      <div className="sheet">
        <header className="sheet-head">
          <h2 className="t-heading">
            {creating ? "Add product" : "Edit product"}
          </h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </header>

        <form className="sheet-body" onSubmit={submit}>
          <div className="field">
            <label className="field-label" htmlFor="p-name">
              Name
            </label>
            <input
              id="p-name"
              ref={firstField}
              className="input"
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Banarasi Silk Saree — Deep Maroon"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="p-description">
              Description
            </label>
            <textarea
              id="p-description"
              className="textarea"
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What it is made of, how it is made, who it suits."
            />
            <p className="field-hint">
              The agent searches this text, so write it the way a customer would
              ask.
            </p>
          </div>

          <div className="field-pair">
            <div className="field">
              <label className="field-label" htmlFor="p-price">
                Price
              </label>
              <div className="input-prefixed">
                <span className="input-prefix">₹</span>
                <input
                  id="p-price"
                  className="input t-num"
                  required
                  inputMode="numeric"
                  value={priceMajor}
                  onChange={(e) =>
                    setPriceMajor(e.target.value.replace(/[^0-9]/g, ""))
                  }
                  placeholder="12499"
                />
              </div>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="p-stock">
                Stock
              </label>
              <input
                id="p-stock"
                className="input t-num"
                required
                inputMode="numeric"
                value={stock}
                onChange={(e) =>
                  setStock(e.target.value.replace(/[^0-9]/g, ""))
                }
              />
              <p className="field-hint">
                Checkout stops when this reaches zero.
              </p>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="p-category">
              Category
            </label>
            <input
              id="p-category"
              className="input"
              maxLength={60}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Sarees"
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="p-image">
              Image URL
            </label>
            <input
              id="p-image"
              className="input"
              type="url"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>

          {imageUrl.trim() !== "" && (
            <div className="image-preview">
              <img
                src={imageUrl}
                alt=""
                onError={(e) => (e.currentTarget.style.opacity = "0.25")}
              />
            </div>
          )}

          {error && (
            <p className="notice notice-danger" role="alert">
              {error}
            </p>
          )}

          <div className="sheet-foot">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy && <span className="spinner" />}
              {creating ? "Add product" : "Save changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
