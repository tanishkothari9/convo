/**
 * The executor: one place every tool call is built, checked, and answered.
 *
 * Adapted from `commerce_common/execution.py` and `shopping_agent/executor.py`
 * in anthropics/commerce-agents (Apache-2.0). It owns dispatch, the `status`
 * line, the failure ladder, skills, and the join from tool result to fenced
 * text, so the Messages-API path and any other runtime answer identically.
 *
 * The tool surface is a function of config: a name that is not in the built
 * tool list is refused here, whatever the model asked for.
 */
import { carts, orders, products, provenance } from "../db/repo.js";
import type { UiComponent } from "../domain/types.js";
import { formatMoney, toMinor } from "../lib/money.js";
import { log } from "../lib/logger.js";
import type { AgentConfig } from "./config.js";
import { STOREFRONT_FENCE, sanitizeLabel } from "./fencing.js";
import {
  gatedAddToCart,
  gatedCheckout,
  gatedRemoveFromCart,
  gatedSetAddress,
  gatedUpdateCartItem,
  viewCart,
} from "./gates.js";
import { failed, ok, type ToolOutcome } from "./outcome.js";
import {
  presentCart,
  presentProducts,
  presentSuggestions,
} from "./presentation.js";
import { skillByName } from "./skills.js";
import {
  LOAD_SKILL,
  STATUS_FIELD,
  STATUS_MAX_CHARS,
  isPresentationTool,
} from "./tools.js";
import {
  NotOffered,
  rememberSeen,
  type StorefrontBackend,
  type StorefrontSession,
} from "./storefront.js";

export interface ExecutionContext {
  session: StorefrontSession;
  config: AgentConfig;
  backend: StorefrontBackend;
  allowedTools: Set<string>;
  /** The model's text this round; recorded as the reasoning on money actions. */
  reasoning: string;
}

export interface ExecutedCall {
  outcome: ToolOutcome;
  /** The sanitized status line, for the host only. Never reaches the model. */
  status: string | null;
  components: UiComponent[];
}

/** Splits the `status` line off before validation, gates, and handlers run. */
function splitStatus(input: Record<string, unknown>): {
  status: string | null;
  rest: Record<string, unknown>;
} {
  const { [STATUS_FIELD]: raw, ...rest } = input;
  const status =
    typeof raw === "string" ? sanitizeLabel(raw, STATUS_MAX_CHARS) : null;
  return { status: status === "" ? null : status, rest };
}

export async function execute(
  context: ExecutionContext,
  name: string,
  rawInput: Record<string, unknown>,
): Promise<ExecutedCall> {
  const { status, rest } = isPresentationTool(name)
    ? { status: null, rest: rawInput }
    : splitStatus(rawInput);

  if (!context.allowedTools.has(name)) {
    return {
      status,
      outcome: failed(`There is no tool named ${name}.`),
      components: [],
    };
  }

  let outcome: ToolOutcome;
  try {
    outcome = await dispatch(context, name, rest);
  } catch (error) {
    if (error instanceof NotOffered) {
      outcome = ok(`No listed brand offers that: ${error.message}`);
    } else {
      // A tool exception never ends the turn.
      log.error("tool call failed", {
        tool: name,
        conversationId: context.session.conversationId,
        message: error instanceof Error ? error.message : "unknown",
      });
      outcome = failed(
        `${name} is temporarily unavailable. Try a different approach or tell the customer.`,
      );
    }
  }

  return { status, outcome, components: outcome.components };
}

async function dispatch(
  context: ExecutionContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const { session, config, backend } = context;

  switch (name) {
    case LOAD_SKILL: {
      const skill = skillByName(String(input.skill ?? ""));
      if (!skill) return failed(`No skill named ${String(input.skill ?? "")}.`);
      return ok(skill.body);
    }

    case "search_catalog": {
      const query = typeof input.query === "string" ? input.query : "";
      const filters = (input.filters ?? {}) as Record<string, unknown>;
      const limit = clamp(
        Number(input.limit ?? config.maxSearchResults),
        1,
        config.maxSearchResults,
      );

      const results = await backend.searchProducts(
        session,
        query,
        {
          ...(typeof filters.category === "string"
            ? { category: filters.category }
            : {}),
          ...(Number.isFinite(Number(filters.min_price))
            ? { minPriceMinor: toMinor(Number(filters.min_price)) }
            : {}),
          ...(Number.isFinite(Number(filters.max_price))
            ? { maxPriceMinor: toMinor(Number(filters.max_price)) }
            : {}),
          ...(typeof filters.sort === "string"
            ? { sort: filters.sort as "relevance" | "price_asc" | "price_desc" }
            : {}),
        },
        limit,
      );

      rememberSeen(session, results);

      if (results.length === 0) {
        return ok(
          STOREFRONT_FENCE.fencePayload({
            query,
            results: [],
            note: "No catalogue records matched. Try a broader query before saying the brand does not carry it.",
          }),
        );
      }

      return ok(
        STOREFRONT_FENCE.fencePayload(
          {
            query,
            count: results.length,
            results: results.map((product) => ({
              product_id: product.id,
              name: product.name,
              price: formatMoney(product.priceMinor, product.currency),
              price_minor: product.priceMinor,
              currency: product.currency,
              category: product.category,
              in_stock: product.stock > 0,
              stock: product.stock,
              attributes: product.attributes,
              short_description: truncate(product.description ?? "", 200),
            })),
          },
          config.maxFencedChars,
        ),
      );
    }

    case "get_product_details": {
      const productId = String(input.product_id ?? "");
      const product = await backend.getProductDetails(session, productId);
      if (!product)
        return ok(`No product with id ${productId} in this brand's catalogue.`);
      rememberSeen(session, [product]);
      return ok(
        STOREFRONT_FENCE.fencePayload(
          {
            product_id: product.id,
            name: product.name,
            description: product.description,
            price: formatMoney(product.priceMinor, product.currency),
            price_minor: product.priceMinor,
            currency: product.currency,
            category: product.category,
            attributes: product.attributes,
            in_stock: product.stock > 0,
            stock: product.stock,
            images: product.images.length,
          },
          config.maxFencedChars,
        ),
      );
    }

    case "manage_cart": {
      const action = String(input.action ?? "view");
      const productId =
        typeof input.product_id === "string" ? input.product_id : "";
      const quantity = Number.isFinite(Number(input.quantity))
        ? Number(input.quantity)
        : 1;

      if (action === "view") return viewCart({ backend, session });
      if (productId === "")
        return failed(`manage_cart "${action}" needs a product_id.`);
      if (action === "add") {
        return gatedAddToCart({
          backend,
          config,
          session,
          productId,
          quantity,
        });
      }
      if (action === "update") {
        return gatedUpdateCartItem({
          backend,
          config,
          session,
          productId,
          quantity,
        });
      }
      if (action === "remove")
        return gatedRemoveFromCart({ backend, session, productId });
      return failed(`manage_cart has no action "${action}".`);
    }

    case "checkout":
      return gatedCheckout({
        session,
        config,
        reasoning: context.reasoning || null,
        note: typeof input.note === "string" ? input.note : null,
      });

    case "set_delivery_address":
      return gatedSetAddress({ session, address: input });

    case "get_orders": {
      const limit = clamp(Number(input.limit ?? 5), 1, 10);
      const history = await backend.getOrders(session, limit);
      // Items on the customer's own orders count as provenance, so a reorder
      // needs no search.
      provenance.remember(
        session.conversationId,
        history.flatMap((order) =>
          order.lineItems.map((line) => ({
            productId: line.productId,
            tenantId: order.tenantId,
          })),
        ),
      );
      return ok(
        STOREFRONT_FENCE.fencePayload(
          {
            count: history.length,
            orders: history.map((order) => ({
              order_id: order.id,
              status: order.status,
              placed_at: order.createdAt,
              total: formatMoney(order.totalAmountMinor, order.currency),
              items: order.lineItems.map((line) => ({
                product_id: line.productId,
                name: line.name,
                quantity: line.quantity,
              })),
              ...(order.failureReason
                ? { failure_reason: order.failureReason }
                : {}),
            })),
          },
          config.maxFencedChars,
        ),
      );
    }

    case "present_products":
      return presentProducts(session, input);

    case "present_cart": {
      const cart = carts.ensureOpen(session.customerSessionId);
      return presentCart(session, cart.id);
    }

    case "present_suggestions":
      return presentSuggestions(input);

    default:
      return failed(`There is no tool named ${name}.`);
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Re-exported so the routes can look up an order without importing the repo layer.
export { orders as orderStore, products as productStore };
