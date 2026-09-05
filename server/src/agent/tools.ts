/**
 * Convo's tool contracts, in a fixed order.
 *
 * The list depends only on deployment config, so it is the same bytes on every
 * request and stays cacheable. A description covers one tool; rules that span
 * tools live in the prompt or a skill. Adapted from
 * `shopping_agent/tools/registry.py` in anthropics/commerce-agents (Apache-2.0).
 *
 * These definitions are provider-neutral. `models/anthropic.ts` and
 * `models/openai.ts` each translate them into their own wire format.
 */
import type { ToolDefinition } from "../models/types.js";
import type { AgentConfig } from "./config.js";
import { skillNames } from "./skills.js";

export const LOAD_SKILL = "load_skill";

/**
 * Every non-presentation tool takes an optional `status` first: a few words
 * the customer sees while the call runs ("looking through the catalogue…").
 * It is the model's own text, so it is sanitized like any display string; it
 * never reaches a backend, a gate, or a tool result.
 */
export const STATUS_FIELD = "status";
export const STATUS_MAX_CHARS = 60;

const statusProperty = {
  type: "string",
  maxLength: STATUS_MAX_CHARS,
  description:
    'A few words, lowercase, describing what you are doing right now, shown to the customer while this runs. For example "looking through the catalogue".',
};

function withStatus(tool: ToolDefinition): ToolDefinition {
  const parameters = tool.parameters as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  return {
    ...tool,
    parameters: {
      ...parameters,
      properties: {
        [STATUS_FIELD]: statusProperty,
        ...(parameters.properties ?? {}),
      },
    },
  };
}

export function buildTools(config: AgentConfig): ToolDefinition[] {
  const readAndWrite: ToolDefinition[] = [
    {
      name: LOAD_SKILL,
      description:
        "Load the rules for one of the flows in the Skills section. Call it in the same round as your first read for that flow.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            enum: skillNames(),
            description: "The skill to load.",
          },
        },
        required: ["skill"],
        additionalProperties: false,
      },
    },
    {
      name: "search_catalog",
      description:
        "Search this brand's catalogue. Word the query in the catalogue's vocabulary; put constraints the customer stated into filters and guesses into the query. Returns product records whose ids the cart and the presentation tools accept.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to search for. An empty query lists the catalogue.",
          },
          filters: {
            type: "object",
            description:
              "Constraints the customer stated; leave guesses in the query.",
            properties: {
              category: {
                type: "string",
                description: "Catalogue category name.",
              },
              min_price: {
                type: "number",
                description:
                  "Lowest acceptable price, in whole currency units.",
              },
              max_price: {
                type: "number",
                description:
                  "Price ceiling the customer stated, in whole currency units.",
              },
              sort: {
                type: "string",
                enum: ["relevance", "price_asc", "price_desc"],
                description:
                  "Result order; relevance unless the customer asked otherwise.",
              },
            },
            additionalProperties: false,
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: config.maxSearchResults,
            description: `How many results to return, at most ${config.maxSearchResults}.`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_product_details",
      description:
        "The full record for one product id, including description, attributes, and stock. Use it to resolve an id you have but no record for; text search does not match ids.",
      parameters: {
        type: "object",
        properties: {
          product_id: {
            type: "string",
            description: "A product_id a tool returned this conversation.",
          },
        },
        required: ["product_id"],
        additionalProperties: false,
      },
    },
    {
      name: "manage_cart",
      description:
        "Add to, change, or empty the customer's cart, or read it back. Accepts only product ids a tool returned this conversation. Changes exactly what the customer asked to change.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "update", "remove", "view"],
            description:
              "What to do. `view` reads the cart without changing it.",
          },
          product_id: {
            type: "string",
            description: "Required for add, update, and remove.",
          },
          quantity: {
            type: "integer",
            minimum: 1,
            maximum: config.maxQuantityPerItem,
            description: `Units. Defaults to 1 for add; required for update. At most ${config.maxQuantityPerItem} per item.`,
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "checkout",
      description:
        "Lock the cart and start a payment. Convo recomputes the total server-side from live catalogue prices and returns it on the order summary — this tool takes no amount, and you must not state one. It opens the payment panel for the customer; it does not complete a payment. Use it only when the customer asks to check out.",
      parameters: {
        type: "object",
        properties: {
          note: {
            type: "string",
            maxLength: 300,
            description: "Anything the customer should check before paying.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_orders",
      description:
        "Orders placed in this conversation, newest first. The only source for an order's status, total, or contents.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "How many orders, at most 10.",
          },
        },
        additionalProperties: false,
      },
    },
  ];

  const presentation: ToolDefinition[] = [
    {
      name: "present_products",
      description:
        "Show products from this conversation as cards; the UI fills in the title, price, image, and stock from the catalogue. Each pick's reason is the one judgment of yours on the card.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            maxLength: 80,
            description: "Short heading for the set of cards.",
          },
          layout: {
            type: "string",
            enum: ["carousel", "grid", "list"],
            description: "Card layout; carousel when omitted.",
          },
          picks: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            description: "Products to show, the one you recommend first.",
            items: {
              type: "object",
              properties: {
                product_id: {
                  type: "string",
                  description:
                    "product_id returned by a tool this conversation.",
                },
                reason: {
                  type: "string",
                  maxLength: 140,
                  description:
                    "One clause tying the pick to a need the customer stated.",
                },
              },
              required: ["product_id"],
              additionalProperties: false,
            },
          },
        },
        required: ["picks"],
        additionalProperties: false,
      },
    },
    {
      name: "present_cart",
      description:
        "Show the customer's cart as a panel. Takes no arguments: the lines and the total are read from the cart server-side. Use it after a change the customer should see in full, or when they ask what is in the cart.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "present_suggestions",
      description:
        "Give the turn its 1-4 chips; it ends the reply. Call it in the same round as the turn's last component. Each chip is something the customer taps instead of typing: a short imperative, a different kind of step from the others, and nothing this turn already displayed.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 4,
            description:
              "1-4 chips, each a brief imperative and each a different kind of step.",
          },
        },
        required: ["suggestions"],
        additionalProperties: false,
      },
    },
  ];

  return [...readAndWrite.map(withStatus), ...presentation];
}

export const PRESENTATION_TOOLS = new Set([
  "present_products",
  "present_cart",
  "present_suggestions",
]);

export function isPresentationTool(name: string): boolean {
  return PRESENTATION_TOOLS.has(name);
}
