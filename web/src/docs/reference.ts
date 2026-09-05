/**
 * The API reference, as data.
 *
 * Held here rather than written as prose in JSX so the page, the copyable
 * examples and the navigation all come from one description — a field renamed
 * in one place cannot go stale in the other two.
 */

export interface Field {
  name: string
  type: string
  required?: boolean
  detail: string
}

export interface Endpoint {
  id: string
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  title: string
  summary: string
  note?: string
  params?: Field[]
  body?: Field[]
  request?: string
  response: string
}

export interface Section {
  id: string
  title: string
  blurb: string
  endpoints: Endpoint[]
}

export const BASE_URL_PLACEHOLDER = '{{BASE}}'
export const KEY_PLACEHOLDER = '{{KEY}}'

export const SECTIONS: Section[] = [
  {
    id: 'products',
    title: 'Products',
    blurb:
      'Your catalogue. The agent searches these records and nothing else, so what is here is exactly what a customer can be sold — once your brand is listed. Pushing products does not put them on the marketplace by itself; turn on listing in Dashboard → Settings, and nothing of yours is searchable until you do.',
    endpoints: [
      {
        id: 'products-bulk',
        method: 'POST',
        path: '/v1/products/bulk',
        title: 'Upsert products',
        summary:
          'Push a whole catalogue in one call. This is the endpoint a real integration uses — a nightly job pointed at it is the entire integration.',
        note: 'Addressed by your own `external_id`, so running the same sync twice updates rather than duplicating. The batch is one transaction: if any row is invalid nothing is written, so a half-valid payload leaves your catalogue untouched rather than half-updated.',
        body: [
          { name: 'products', type: 'array', required: true, detail: 'Up to 500 products. Each needs an `external_id`.' },
          { name: 'products[].external_id', type: 'string', required: true, detail: 'Your own id for this product. This is what makes the call idempotent.' },
          { name: 'products[].name', type: 'string', detail: 'Required when creating; optional when updating.' },
          { name: 'products[].price', type: 'number', detail: 'In whole currency units, e.g. 8499 for ₹8,499.' },
          { name: 'products[].price_minor', type: 'integer', detail: 'Alternative to `price`, in the smallest unit (paise). Send one or the other.' },
          { name: 'products[].stock', type: 'integer', detail: 'Units available. Checkout stops when this reaches zero.' },
          { name: 'products[].description', type: 'string', detail: 'The agent searches this, so write it the way a customer would ask.' },
          { name: 'products[].category', type: 'string', detail: 'Used for filtering and for spreading an open browse across your range.' },
          { name: 'products[].images', type: 'string[]', detail: 'Up to 6 https URLs, or base64 png/jpeg/webp data URLs. SVG is refused.' },
          { name: 'products[].attributes', type: 'object', detail: 'String pairs shown on the card and searched by the agent. Colour and Occasion are worth including — they are what customers actually ask by.' },
          { name: 'products[].active', type: 'boolean', detail: 'Set false to hide without deleting.' },
          { name: 'deactivate_missing', type: 'boolean', detail: 'Hide any product whose `external_id` is absent from this call. Use it when you are sending your full catalogue.' },
        ],
        request: `curl -X POST ${BASE_URL_PLACEHOLDER}/v1/products/bulk \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "products": [
      {
        "external_id": "SKU-1001",
        "name": "Mysore Silk Saree — Emerald",
        "description": "Pure Mysore silk with a gold zari border.",
        "price": 8499,
        "stock": 5,
        "category": "Sarees",
        "images": ["https://cdn.example.com/saree-emerald.jpg"],
        "attributes": { "Colour": "Emerald green", "Occasion": "Wedding, festive" }
      }
    ],
    "deactivate_missing": false
  }'`,
        response: `{
  "object": "bulk_result",
  "received": 1,
  "created": 1,
  "updated": 0,
  "deactivated": 0
}`,
      },
      {
        id: 'products-list',
        method: 'GET',
        path: '/v1/products',
        title: 'List products',
        summary: 'Everything in your catalogue, including hidden products.',
        params: [
          { name: 'limit', type: 'integer', detail: '1–200. Defaults to 50.' },
          { name: 'offset', type: 'integer', detail: 'For paging. Defaults to 0.' },
        ],
        request: `curl ${BASE_URL_PLACEHOLDER}/v1/products?limit=2 \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        response: `{
  "object": "list",
  "total": 18,
  "limit": 2,
  "offset": 0,
  "has_more": true,
  "data": [
    {
      "id": "prd_e54yvqlnqq74oq",
      "external_id": "SKU-1001",
      "name": "Mysore Silk Saree — Emerald",
      "description": "Pure Mysore silk with a gold zari border.",
      "price": 8499,
      "price_minor": 849900,
      "currency": "INR",
      "images": ["https://cdn.example.com/saree-emerald.jpg"],
      "stock": 5,
      "category": "Sarees",
      "attributes": { "Colour": "Emerald green" },
      "active": true,
      "source": "manual",
      "updated_at": "2026-09-05T04:11:22.918Z"
    }
  ]
}`,
      },
      {
        id: 'products-get',
        method: 'GET',
        path: '/v1/products/{id}',
        title: 'Retrieve a product',
        summary: 'By Convo’s id or by your own `external_id` — both work, so you need not keep a mapping.',
        request: `curl ${BASE_URL_PLACEHOLDER}/v1/products/SKU-1001 \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        response: `{
  "id": "prd_e54yvqlnqq74oq",
  "external_id": "SKU-1001",
  "name": "Mysore Silk Saree — Emerald",
  "price": 8499,
  "stock": 5,
  "active": true
}`,
      },
      {
        id: 'products-create',
        method: 'POST',
        path: '/v1/products',
        title: 'Create a product',
        summary: 'One product. Use bulk upsert for a sync; this is for adding a single item.',
        note: 'Returns 409 if the `external_id` already exists. Use PATCH, or bulk upsert, to change an existing product.',
        request: `curl -X POST ${BASE_URL_PLACEHOLDER}/v1/products \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "external_id": "SKU-2001",
    "name": "Cotton Palazzo Set — Rust",
    "price": 2299,
    "stock": 11,
    "category": "Kurta Sets"
  }'`,
        response: `{
  "id": "prd_9x2kfhq0aw3ple",
  "external_id": "SKU-2001",
  "name": "Cotton Palazzo Set — Rust",
  "price": 2299,
  "stock": 11,
  "active": true
}`,
      },
      {
        id: 'products-update',
        method: 'PATCH',
        path: '/v1/products/{id}',
        title: 'Update a product',
        summary: 'Send only what changed. A field you omit is left alone — so a stock-only sync is a stock-only payload.',
        request: `curl -X PATCH ${BASE_URL_PLACEHOLDER}/v1/products/SKU-1001 \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\
  -H "Content-Type: application/json" \\
  -d '{ "stock": 3 }'`,
        response: `{
  "id": "prd_e54yvqlnqq74oq",
  "external_id": "SKU-1001",
  "stock": 3
}`,
      },
      {
        id: 'products-delete',
        method: 'DELETE',
        path: '/v1/products/{id}',
        title: 'Delete a product',
        summary: 'Permanent. To hide a product while keeping its order history, send `{ "active": false }` to PATCH instead.',
        request: `curl -X DELETE ${BASE_URL_PLACEHOLDER}/v1/products/SKU-2001 \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        response: `{ "id": "prd_9x2kfhq0aw3ple", "deleted": true }`,
      },
    ],
  },
  {
    id: 'orders',
    title: 'Orders',
    blurb: 'What the agent actually sold. Totals here were computed by Convo from live catalogue prices, not stated by a model.',
    endpoints: [
      {
        id: 'orders-list',
        method: 'GET',
        path: '/v1/orders',
        title: 'List orders',
        summary:
          'Newest first, with their line items, delivery address and outcome — everything a fulfilment system needs.',
        params: [{ name: 'limit', type: 'integer', detail: '1–100. Defaults to 50.' }],
        request: `curl ${BASE_URL_PLACEHOLDER}/v1/orders?limit=1 \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        response: `{
  "object": "list",
  "data": [
    {
      "id": "ord_48s3dh0pwcg6ac",
      "status": "paid",
      "total": 3499,
      "total_minor": 349900,
      "currency": "INR",
      "provider": "razorpay",
      "provider_order_id": "order_PxK2mFq9",
      "line_items": [
        { "product_id": "prd_75j3apt4utq1ph", "name": "Linen Saree — Ivory", "quantity": 1, "line_total_minor": 349900 }
      ],
      "shipping_address": {
        "name": "Anika Rao",
        "phone": "9876543210",
        "line1": "12 MG Road",
        "line2": "Near Devaraja Market",
        "city": "Mysuru",
        "state": "Karnataka",
        "postal_code": "570001",
        "country": "India"
      },
      "failure_reason": null,
      "created_at": "2026-09-05T03:42:11.204Z"
    }
  ]
}`,
      },
    ],
  },
  {
    id: 'audit',
    title: 'Audit trail',
    blurb:
      'Every money action the agent took, appended and never edited. Pull it into your own systems for reconciliation.',
    endpoints: [
      {
        id: 'audit-list',
        method: 'GET',
        path: '/v1/audit',
        title: 'List audit entries',
        summary:
          'Cart locks, orders, payment attempts, confirmations, and refusals — with the amount, the outcome, and the reason the agent gave.',
        params: [{ name: 'limit', type: 'integer', detail: '1–300. Defaults to 100.' }],
        request: `curl ${BASE_URL_PLACEHOLDER}/v1/audit?limit=1 \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        response: `{
  "object": "list",
  "data": [
    {
      "id": "aud_p3k9wqz1x8bnvd",
      "action": "checkout.blocked",
      "outcome": "blocked",
      "amount_minor": 1649900,
      "currency": "INR",
      "order_id": null,
      "reasoning": "customer asked to check out",
      "detail": { "gate": "stock", "items": [{ "product_id": "prd_kq…", "wanted": 1, "available": 0 }] },
      "created_at": "2026-09-05T03:29:44.771Z"
    }
  ]
}`,
      },
    ],
  },
  {
    id: 'account',
    title: 'Account',
    blurb: 'Confirm which brand a key belongs to and what it can do.',
    endpoints: [
      {
        id: 'me',
        method: 'GET',
        path: '/v1/me',
        title: 'Who am I',
        summary: 'The brand this key belongs to, its scope, and current counts. Useful as a health check for a sync job.',
        request: `curl ${BASE_URL_PLACEHOLDER}/v1/me \\
  -H "Authorization: Bearer ${KEY_PLACEHOLDER}"`,
        response: `{
  "brand": { "id": "ten_1qk1xdn2vqz5eg", "name": "Smart Choice", "slug": "smart-choice", "currency": "INR" },
  "scope": "write",
  "counts": { "products": 18, "conversations": 6, "orders": 6 }
}`,
      },
    ],
  },
]

export const ERRORS: Array<{ status: string; code: string; meaning: string }> = [
  { status: '400', code: 'invalid_field', meaning: 'A field failed validation. The message names the field and what it expected.' },
  { status: '400', code: 'unsafe_image_url', meaning: 'An image URL Convo will not serve to a customer. SVG is refused because it can carry script.' },
  { status: '400', code: 'missing_external_id', meaning: 'A row in a bulk call has no `external_id`. Bulk upsert is addressed by your id so it can be re-run safely.' },
  { status: '400', code: 'duplicate_in_batch', meaning: 'The same `external_id` appears twice in one call.' },
  { status: '400', code: 'batch_too_large', meaning: 'More than 500 products in one call. Split it.' },
  { status: '401', code: 'no_key', meaning: 'No API key was sent.' },
  { status: '401', code: 'bad_key', meaning: 'The key is unknown or has been revoked.' },
  { status: '403', code: 'read_only_key', meaning: 'A read key attempted a write. Create a write key.' },
  { status: '404', code: '—', meaning: 'No such product, or it belongs to another brand.' },
  { status: '409', code: 'duplicate_external_id', meaning: 'That `external_id` already exists. Use PATCH or bulk upsert.' },
  { status: '429', code: 'rate_limited', meaning: 'Too many requests. `Retry-After` says how many seconds to wait.' },
]
