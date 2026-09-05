/**
 * Seeds two demo brands so there is always something working to look at.
 *
 * Smart Choice sells ethnic wear and Kalaa Studio sells handcrafted jewellery
 * — two rows in the tenants table, not the product. Two of them rather than
 * one because the marketplace only shows what it is for when a cart can hold
 * a saree from one shop and earrings from another, and settle as two orders.
 *
 * Running this twice is safe: it updates the existing brands rather than
 * duplicating them.
 */
import { db, transaction } from "./index.js";
import {
  carts,
  connections,
  conversations,
  orders,
  products,
  shoppers,
  tenants,
  users,
} from "./repo.js";
import { passwordFields } from "../auth/index.js";
import { toMinor } from "../lib/money.js";
import { id } from "../lib/ids.js";
import { log } from "../lib/logger.js";
import { env } from "../env.js";

const DEMO_PASSWORD = "convo-demo-2026";
/** The same password, so there is only one to remember. */
const DEMO_SHOPPER = "shopper@convo.demo";

interface SeedProduct {
  name: string;
  description: string;
  priceMajor: number;
  stock: number;
  category: string;
  attributes: Record<string, string>;
  image: string;
}

/**
 * Photography is from Unsplash's public CDN, sized and cropped by URL. Swap
 * these for the brand's own imagery by editing the product in the dashboard.
 */
const image = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&h=1000&q=80`;

const CATALOG: SeedProduct[] = [
  {
    name: "Banarasi Silk Saree — Deep Maroon",
    description:
      "Handwoven on a pit loom in Varanasi, with a real zari border and a matching unstitched blouse piece. About three weeks on the loom.",
    priceMajor: 12499,
    stock: 6,
    category: "Sarees",
    attributes: {
      Occasion: "Wedding, reception, festive",
      Colour: "Deep maroon and gold",
      Fabric: "Pure Banarasi silk",
      Weave: "Handloom",
      Length: "6.3 m with blouse piece",
      Care: "Dry clean only",
    },
    image: image("photo-1610030469983-98e550d6193c"),
  },
  {
    name: "Chanderi Cotton-Silk Saree — Sage",
    description:
      "A feather-light Chanderi weave with fine gold-thread butti scattered across the body. Holds a drape without weighing anything.",
    priceMajor: 6899,
    stock: 11,
    category: "Sarees",
    attributes: {
      Occasion: "Daytime wedding, puja, festive",
      Colour: "Sage green and gold",
      Fabric: "Chanderi cotton-silk",
      Weave: "Handloom",
      Length: "6.3 m with blouse piece",
      Care: "Dry clean",
    },
    image: image("photo-1679006831648-7c9ea12e5807"),
  },
  {
    name: "Kanjivaram Silk Saree — Violet and Gold",
    description:
      "Pure mulberry silk from Kanchipuram with a contrast border and a korvai join at the pallu. The one for a wedding.",
    priceMajor: 18999,
    stock: 3,
    category: "Sarees",
    attributes: {
      Occasion: "Wedding, bridal, reception",
      Colour: "Violet and gold",
      Fabric: "Pure mulberry silk",
      Weave: "Korvai handloom",
      Length: "6.3 m with blouse piece",
      Care: "Dry clean only",
    },
    image: image("photo-1641699862936-be9f49b1c38d"),
  },
  {
    name: "Tissue Silk Saree — Coral and Gold",
    description:
      "Sheer tissue silk shot through with gold, with a woven temple border. Light enough for a long evening.",
    priceMajor: 9499,
    stock: 7,
    category: "Sarees",
    attributes: {
      Occasion: "Wedding, cocktail, festive",
      Colour: "Coral and gold",
      Fabric: "Tissue silk",
      Length: "6.3 m with blouse piece",
      Care: "Dry clean only",
    },
    image: image("photo-1727430228383-aa1fb59db8bf"),
  },
  {
    name: "Linen Saree — Ivory",
    description:
      "Pure linen in undyed ivory with a fine silver border. Crushes beautifully and softens with every wash — an everyday saree.",
    priceMajor: 3499,
    stock: 14,
    category: "Sarees",
    attributes: {
      Occasion: "Everyday, office, casual",
      Colour: "Ivory and silver",
      Fabric: "Pure linen",
      Length: "6.3 m with blouse piece",
      Care: "Machine wash cold",
    },
    image: image("photo-1609748340041-f5d61e061ebc"),
  },
  {
    name: "Anarkali Kurta Set — Ivory Chikankari",
    description:
      "Hand-embroidered Lucknowi chikankari on cotton mul, with a churidar and a matching dupatta. Worked by hand, so no two are identical.",
    priceMajor: 5499,
    stock: 9,
    category: "Kurta Sets",
    attributes: {
      Occasion: "Festive, mehndi, daytime function",
      Colour: "Ivory",
      Fabric: "Cotton mul",
      Work: "Hand chikankari",
      Includes: "Kurta, churidar, dupatta",
      Care: "Hand wash",
    },
    image: image("photo-1571908599538-7e1e6e92b064"),
  },
  {
    name: "Sharara Set — Wine Georgette",
    description:
      "Thread-worked georgette kurta over a flared sharara, with a scalloped-edge dupatta. Built for a sangeet.",
    priceMajor: 7999,
    stock: 5,
    category: "Kurta Sets",
    attributes: {
      Occasion: "Sangeet, wedding, party",
      Colour: "Wine red",
      Fabric: "Georgette",
      Work: "Zardozi and thread",
      Includes: "Kurta, sharara, dupatta",
      Care: "Dry clean",
    },
    image: image("photo-1756483509254-3cc48a5a15b2"),
  },
  {
    name: "Lehenga Set — Silver Grey",
    description:
      "A tonal grey lehenga with sequin and pearl work through the skirt, and a net dupatta with a worked edge.",
    priceMajor: 16499,
    stock: 4,
    category: "Kurta Sets",
    attributes: {
      Occasion: "Wedding, reception, engagement",
      Colour: "Silver grey",
      Fabric: "Raw silk and net",
      Work: "Sequin and pearl",
      Includes: "Choli, lehenga, dupatta",
      Care: "Dry clean only",
    },
    image: image("photo-1571587289339-cb7da03fb5a6"),
  },
  {
    name: "Straight Kurta — Indigo Block Print",
    description:
      "Hand-block printed in natural indigo on soft cotton. Side slits, a chest pocket, and a fit that works over jeans or a churidar.",
    priceMajor: 1899,
    stock: 22,
    category: "Kurtas",
    attributes: {
      Occasion: "Everyday, casual, office",
      Colour: "Indigo blue",
      Fabric: "Cotton",
      Work: "Hand block print",
      Fit: "Straight",
      Care: "Machine wash cold",
    },
    image: image("photo-1770359993283-a2c2f386584e"),
  },
  {
    name: "Cotton Silk Kurta — Olive",
    description:
      "Structured cotton-silk with a mandarin collar and deep side slits. Holds a press and reads dressy without trying.",
    priceMajor: 2499,
    stock: 16,
    category: "Kurtas",
    attributes: {
      Occasion: "Office, casual, daytime",
      Colour: "Olive green",
      Fabric: "Cotton silk",
      Fit: "Straight",
      Collar: "Mandarin",
      Care: "Dry clean",
    },
    image: image("photo-1727835523545-70ee992b5763"),
  },
  {
    name: "Chikankari Kurta — White",
    description:
      "Everyday chikankari on white cotton, cut long and straight. The one people buy two of.",
    priceMajor: 2199,
    stock: 19,
    category: "Kurtas",
    attributes: {
      Occasion: "Everyday, summer, casual",
      Colour: "White",
      Fabric: "Cotton",
      Work: "Hand chikankari",
      Fit: "Straight",
      Care: "Hand wash",
    },
    image: image("photo-1667665970124-2273c6ef3489"),
  },
  {
    name: "Bandhani Dupatta — Ruby",
    description:
      "Kutch bandhani tied by hand on a soft georgette base. Thousands of individual knots.",
    priceMajor: 1799,
    stock: 18,
    category: "Dupattas",
    attributes: {
      Occasion: "Festive, wedding, navratri",
      Colour: "Ruby red",
      Fabric: "Georgette",
      Work: "Hand bandhani",
      Size: "2.4 m",
      Care: "Hand wash separately",
    },
    image: image("photo-1570212773364-e30cd076539e"),
  },
  {
    name: "Phulkari Dupatta — Lime",
    description:
      "Punjabi phulkari worked in floss silk on a fine chanderi ground.",
    priceMajor: 2299,
    // Deliberately out of stock, so the out-of-stock path has something real to
    // hit in a demo without editing the catalogue first.
    stock: 0,
    category: "Dupattas",
    attributes: {
      Occasion: "Festive, mehndi, haldi",
      Colour: "Lime green and pink",
      Fabric: "Chanderi",
      Work: "Hand phulkari",
      Size: "2.4 m",
      Care: "Dry clean",
    },
    image: image("photo-1717585679395-bbe39b5fb6bc"),
  },
  {
    name: "Kundan Choker Set — Gold Tone",
    description:
      "A gold-tone kundan choker with matching drops. Light enough to wear all evening.",
    priceMajor: 3299,
    stock: 8,
    category: "Jewellery",
    attributes: {
      Occasion: "Wedding, reception, festive",
      Colour: "Gold",
      Material: "Brass with gold plating",
      Stones: "Kundan and pearl",
      Includes: "Choker and earrings",
    },
    image: image("photo-1756483560049-e7b2208f99a0"),
  },
  {
    name: "Jhumka Earrings — Ruby Drop",
    description:
      "A long jhumka with a faceted ruby-red drop and a pearl edge. Hooks, not screws.",
    priceMajor: 1499,
    stock: 13,
    category: "Jewellery",
    attributes: {
      Occasion: "Festive, everyday, party",
      Colour: "Gold and ruby red",
      Material: "Brass with gold plating",
      Stones: "Cubic zirconia and pearl",
      Drop: "6.5 cm",
    },
    image: image("photo-1671642883395-0ab89c3ac890"),
  },
  {
    name: "Juttis — Teal Embroidered",
    description:
      "Hand-embroidered juttis with silver thread, a pom detail, and a cushioned sole. Sizes 4 to 9.",
    priceMajor: 2199,
    stock: 12,
    category: "Footwear",
    attributes: {
      Occasion: "Wedding, festive, everyday",
      Colour: "Teal and silver",
      Material: "Leather",
      Work: "Hand embroidery",
      Sizes: "UK 4-9",
      Care: "Wipe clean",
    },
    image: image("photo-1777980808039-c8be538797f0"),
  },
];

/**
 * Kalaa Studio's shelf. Deliberately a different lane from Smart Choice's, so
 * a cart holding both is the ordinary case rather than a contrivance — which
 * is the whole reason there are two brands in the seed.
 */
const KALAA_CATALOG: SeedProduct[] = [
  {
    name: "Oxidised Silver Jhumkas — Temple Work",
    description:
      "Cast in 92.5 sterling silver and oxidised by hand, with a domed bell and a row of tiny ghungroos. Light enough to wear all evening.",
    priceMajor: 3450,
    stock: 14,
    category: "Earrings",
    attributes: {
      Metal: "92.5 sterling silver",
      Finish: "Oxidised",
      Weight: "18g the pair",
      Drop: "5.5 cm",
      Occasion: "Festive, wedding",
      Care: "Store dry, polish with a soft cloth",
    },
    image: image("photo-1762686130435-897de4b26aac"),
  },
  {
    name: "Turquoise and Pearl Silver Necklace",
    description:
      "A Kutch-style collar in silver with turquoise cabochons and freshwater pearls. Adjustable at the back from 14 to 18 inches.",
    priceMajor: 6900,
    stock: 6,
    category: "Necklaces",
    attributes: {
      Metal: "92.5 sterling silver",
      Stones: "Turquoise, freshwater pearl",
      Length: "14-18 in adjustable",
      Occasion: "Festive, evening",
      Care: "Keep away from perfume",
    },
    image: image("photo-1767971958465-16d986fad8df"),
  },
  {
    name: "Silver Bangles — Set of Six",
    description:
      "Slim hand-hammered bangles that stack without rattling. Sold as a set of six; tell us your wrist size and we will send the nearest fit.",
    priceMajor: 4200,
    stock: 9,
    category: "Bangles",
    attributes: {
      Metal: "92.5 sterling silver",
      Finish: "Hand-hammered",
      Sizes: "2.4, 2.6, 2.8",
      Quantity: "Set of six",
      Occasion: "Everyday, festive",
    },
    image: image("photo-1762780700709-9695d1df32e8"),
  },
  {
    name: "Brass and Bead Jewellery Set",
    description:
      "A matched set from a Jaipur studio — necklace, earrings, and a ring in raw brass with glass beads. The brass warms in colour as it is worn.",
    priceMajor: 2650,
    stock: 11,
    category: "Sets",
    attributes: {
      Metal: "Raw brass",
      Includes: "Necklace, earrings, ring",
      Finish: "Unlacquered",
      Occasion: "Everyday",
      Care: "Polish with lemon and salt to brighten",
    },
    image: image("photo-1766585903095-0ce7a25fee93"),
  },
  {
    name: "Silver Chain Bracelet — Fine Link",
    description:
      "A fine curb-link bracelet in sterling silver with a lobster clasp. Plain enough for every day, and it sits flat under a sleeve.",
    priceMajor: 2900,
    stock: 18,
    category: "Bracelets",
    attributes: {
      Metal: "92.5 sterling silver",
      Length: "18 cm",
      Clasp: "Lobster",
      Occasion: "Everyday",
      Care: "Remove before swimming",
    },
    image: image("photo-1744722093742-aad22c7fa68b"),
  },
  {
    name: "Layered Silver Necklaces — Pair",
    description:
      "Two chains meant to be worn together, one short and one long, so the layering sits right without tangling. Also good apart.",
    priceMajor: 3800,
    stock: 7,
    category: "Necklaces",
    attributes: {
      Metal: "92.5 sterling silver",
      Lengths: "16 in and 20 in",
      Quantity: "Pair",
      Occasion: "Everyday, evening",
    },
    image: image("photo-1727333011028-ab6f7589f713"),
  },
  {
    name: "Two-Tone Drop Earrings — Silver and Gold",
    description:
      "Silver hoops with a gold-plated inner drop, so they read differently depending on the light. Posts are solid silver.",
    priceMajor: 3100,
    stock: 0,
    category: "Earrings",
    attributes: {
      Metal: "92.5 sterling silver, gold plate",
      Drop: "3 cm",
      Fastening: "Post and butterfly",
      Occasion: "Everyday, evening",
    },
    image: image("photo-1714733831162-0a6e849141be"),
  },
  {
    name: "Turquoise Charm Bracelet",
    description:
      "Silver links with turquoise drops and small stamped charms, made in Kutch. It moves and makes a little noise, which is the point.",
    priceMajor: 3600,
    stock: 10,
    category: "Bracelets",
    attributes: {
      Metal: "92.5 sterling silver",
      Stones: "Turquoise",
      Length: "19 cm",
      Occasion: "Everyday, festive",
    },
    image: image("photo-1676303679145-8679f5ceeb16"),
  },
];

interface SeedBrand {
  name: string;
  slug: string;
  description: string;
  email: string;
  catalog: SeedProduct[];
}

const BRANDS: SeedBrand[] = [
  {
    name: "Smart Choice",
    slug: "smart-choice",
    description:
      "Handwoven sarees, chikankari kurta sets, and everyday ethnic wear, made by weavers and karigars across India.",
    email: "owner@smartchoice.demo",
    catalog: CATALOG,
  },
  {
    name: "Kalaa Studio",
    slug: "kalaa-studio",
    description:
      "Handcrafted silver and brass jewellery from studios in Jaipur and Kutch — oxidised jhumkas, temple work, and everyday pieces.",
    email: "owner@kalaa.demo",
    catalog: KALAA_CATALOG,
  },
];

function seedBrand(brand: SeedBrand): void {
  let tenant = tenants.bySlug(brand.slug);
  if (!tenant) {
    tenant = tenants.create({
      name: brand.name,
      slug: brand.slug,
      description: brand.description,
      currency: "INR",
    });
    log.info("seeded tenant", { slug: tenant.slug });
  }

  if (!users.emailTaken(brand.email)) {
    const { hash, salt } = passwordFields(DEMO_PASSWORD);
    users.create({
      tenantId: tenant.id,
      email: brand.email,
      passwordHash: hash,
      passwordSalt: salt,
      displayName: brand.name,
    });
    log.info("seeded dashboard user", { email: brand.email });
  }

  // Products live in Convo's own catalogue to start with. The dashboard's
  // "Connect a provider" flow switches the brand over to Razorpay.
  const existing = new Set(
    products.list(tenant.id, { includeInactive: true }).map((p) => p.name),
  );
  let created = 0;
  for (const item of brand.catalog) {
    if (existing.has(item.name)) continue;
    products.create({
      tenantId: tenant.id,
      name: item.name,
      description: item.description,
      priceMinor: toMinor(item.priceMajor),
      currency: "INR",
      images: [item.image],
      stock: item.stock,
      category: item.category,
      attributes: item.attributes,
      source: "manual",
    });
    created += 1;
  }

  if (!connections.byType(tenant.id, "manual")) {
    connections.upsert({
      tenantId: tenant.id,
      providerType: "manual",
      capabilities: "catalog+payment",
      credentialsEnc: null,
      credentialsHint: null,
    });
    connections.activate(tenant.id, "manual", ["catalog", "payment"]);
  }

  // Both demo brands are on the shelf: a marketplace with nothing listed is a
  // blank page, and the first thing anyone opening this wants to see is that
  // it works.
  if (!tenant.isListed) tenants.update(tenant.id, { isListed: true });

  log.info("seed complete", { tenant: tenant.slug, productsCreated: created });
}

function seed(): void {
  db();
  transaction(() => {
    for (const brand of BRANDS) seedBrand(brand);
    seedShopper();
  });

  /**
   * A shopper with an account and something already bought.
   *
   * With one paid order and one still awaiting payment, so the orders page has
   * both states in it the moment you sign in. An empty history demonstrates
   * nothing, and staging the orders through a live checkout would need a payment
   * provider to be reachable from a seed script.
   */
  function seedShopper(): void {
    if (shoppers.credentialsByEmail(DEMO_SHOPPER)) return;

    const { hash, salt } = passwordFields(DEMO_PASSWORD);
    const shopper = shoppers.create({
      email: DEMO_SHOPPER,
      passwordHash: hash,
      passwordSalt: salt,
      displayName: "Anika Rao",
    });

    const conversation = conversations.ensure(shopper.customerSessionId);
    const cart = carts.ensureOpen(shopper.customerSessionId);
    const checkoutId = id("cko");

    // One order per brand, exactly as a real split checkout would leave them.
    const past: Array<{
      tenantIndex: number;
      status: "paid" | "awaiting_payment";
    }> = [
      { tenantIndex: 0, status: "paid" },
      { tenantIndex: 1, status: "awaiting_payment" },
    ];

    for (const entry of past) {
      const brand = BRANDS[entry.tenantIndex]!;
      const tenant = tenants.bySlug(brand.slug);
      if (!tenant) continue;
      const catalogue = products.list(tenant.id);
      const item = catalogue[0];
      if (!item) continue;

      orders.create({
        tenantId: tenant.id,
        cartId: cart.id,
        conversationId: conversation.id,
        checkoutId,
        totalAmountMinor: item.priceMinor,
        currency: "INR",
        providerType: "manual",
        providerOrderId: null,
        lineItems: [
          {
            productId: item.id,
            name: item.name,
            quantity: 1,
            unitPriceMinor: item.priceMinor,
            lineTotalMinor: item.priceMinor,
          },
        ],
        status: entry.status,
      });
    }

    carts.setStatus(cart.id, "converted");
    log.info("seeded demo shopper", { email: DEMO_SHOPPER });
  }

  const lines = BRANDS.map(
    (brand) =>
      `    ${brand.name.padEnd(14)}${brand.email.padEnd(24)}${brand.catalog.length} products`,
  ).join("\n");

  console.log(`
  Two brands are seeded and listed.

${lines}

    Password    ${DEMO_PASSWORD}
    Dashboard   ${env.publicBaseUrl}/login

  And one shopper, with two past orders already on the account.

    Shopper     ${DEMO_SHOPPER}
    Shop        ${env.publicBaseUrl}/shop
`);
}

seed();
