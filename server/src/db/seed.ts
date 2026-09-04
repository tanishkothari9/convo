/**
 * Seeds a demo brand so there is always something working to look at.
 *
 * Smart Choice is an ethnic wear brand and Convo's first tenant — one row in
 * the tenants table, not the product. Running this twice is safe: it updates
 * the existing tenant rather than duplicating it.
 */
import { db, transaction } from './index.js'
import { connections, products, tenants, users } from './repo.js'
import { passwordFields } from '../auth/index.js'
import { toMinor } from '../lib/money.js'
import { log } from '../lib/logger.js'
import { env } from '../env.js'

const DEMO_EMAIL = 'owner@smartchoice.demo'
const DEMO_PASSWORD = 'convo-demo-2026'

interface SeedProduct {
  name: string
  description: string
  priceMajor: number
  stock: number
  category: string
  attributes: Record<string, string>
  image: string
}

/**
 * Photography is from Unsplash's public CDN, sized and cropped by URL. Swap
 * these for the brand's own imagery by editing the product in the dashboard.
 */
const image = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=800&h=1000&q=80`

const CATALOG: SeedProduct[] = [
  {
    name: 'Banarasi Silk Saree — Deep Maroon',
    description:
      'Handwoven on a pit loom in Varanasi, with a real zari border and a matching unstitched blouse piece. About three weeks on the loom.',
    priceMajor: 12499,
    stock: 6,
    category: 'Sarees',
    attributes: { Occasion: 'Wedding, reception, festive', Colour: 'Deep maroon and gold', Fabric: 'Pure Banarasi silk', Weave: 'Handloom', Length: '6.3 m with blouse piece', Care: 'Dry clean only' },
    image: image('photo-1610030469983-98e550d6193c'),
  },
  {
    name: 'Chanderi Cotton-Silk Saree — Sage',
    description:
      'A feather-light Chanderi weave with fine gold-thread butti scattered across the body. Holds a drape without weighing anything.',
    priceMajor: 6899,
    stock: 11,
    category: 'Sarees',
    attributes: { Occasion: 'Daytime wedding, puja, festive', Colour: 'Sage green and gold', Fabric: 'Chanderi cotton-silk', Weave: 'Handloom', Length: '6.3 m with blouse piece', Care: 'Dry clean' },
    image: image('photo-1679006831648-7c9ea12e5807'),
  },
  {
    name: 'Kanjivaram Silk Saree — Violet and Gold',
    description:
      'Pure mulberry silk from Kanchipuram with a contrast border and a korvai join at the pallu. The one for a wedding.',
    priceMajor: 18999,
    stock: 3,
    category: 'Sarees',
    attributes: { Occasion: 'Wedding, bridal, reception', Colour: 'Violet and gold', Fabric: 'Pure mulberry silk', Weave: 'Korvai handloom', Length: '6.3 m with blouse piece', Care: 'Dry clean only' },
    image: image('photo-1641699862936-be9f49b1c38d'),
  },
  {
    name: 'Tissue Silk Saree — Coral and Gold',
    description:
      'Sheer tissue silk shot through with gold, with a woven temple border. Light enough for a long evening.',
    priceMajor: 9499,
    stock: 7,
    category: 'Sarees',
    attributes: { Occasion: 'Wedding, cocktail, festive', Colour: 'Coral and gold', Fabric: 'Tissue silk', Length: '6.3 m with blouse piece', Care: 'Dry clean only' },
    image: image('photo-1727430228383-aa1fb59db8bf'),
  },
  {
    name: 'Linen Saree — Ivory',
    description:
      'Pure linen in undyed ivory with a fine silver border. Crushes beautifully and softens with every wash — an everyday saree.',
    priceMajor: 3499,
    stock: 14,
    category: 'Sarees',
    attributes: { Occasion: 'Everyday, office, casual', Colour: 'Ivory and silver', Fabric: 'Pure linen', Length: '6.3 m with blouse piece', Care: 'Machine wash cold' },
    image: image('photo-1609748340041-f5d61e061ebc'),
  },
  {
    name: 'Anarkali Kurta Set — Ivory Chikankari',
    description:
      'Hand-embroidered Lucknowi chikankari on cotton mul, with a churidar and a matching dupatta. Worked by hand, so no two are identical.',
    priceMajor: 5499,
    stock: 9,
    category: 'Kurta Sets',
    attributes: { Occasion: 'Festive, mehndi, daytime function', Colour: 'Ivory', Fabric: 'Cotton mul', Work: 'Hand chikankari', Includes: 'Kurta, churidar, dupatta', Care: 'Hand wash' },
    image: image('photo-1571908599538-7e1e6e92b064'),
  },
  {
    name: 'Sharara Set — Wine Georgette',
    description:
      'Thread-worked georgette kurta over a flared sharara, with a scalloped-edge dupatta. Built for a sangeet.',
    priceMajor: 7999,
    stock: 5,
    category: 'Kurta Sets',
    attributes: { Occasion: 'Sangeet, wedding, party', Colour: 'Wine red', Fabric: 'Georgette', Work: 'Zardozi and thread', Includes: 'Kurta, sharara, dupatta', Care: 'Dry clean' },
    image: image('photo-1756483509254-3cc48a5a15b2'),
  },
  {
    name: 'Lehenga Set — Silver Grey',
    description:
      'A tonal grey lehenga with sequin and pearl work through the skirt, and a net dupatta with a worked edge.',
    priceMajor: 16499,
    stock: 4,
    category: 'Kurta Sets',
    attributes: { Occasion: 'Wedding, reception, engagement', Colour: 'Silver grey', Fabric: 'Raw silk and net', Work: 'Sequin and pearl', Includes: 'Choli, lehenga, dupatta', Care: 'Dry clean only' },
    image: image('photo-1571587289339-cb7da03fb5a6'),
  },
  {
    name: 'Straight Kurta — Indigo Block Print',
    description:
      'Hand-block printed in natural indigo on soft cotton. Side slits, a chest pocket, and a fit that works over jeans or a churidar.',
    priceMajor: 1899,
    stock: 22,
    category: 'Kurtas',
    attributes: { Occasion: 'Everyday, casual, office', Colour: 'Indigo blue', Fabric: 'Cotton', Work: 'Hand block print', Fit: 'Straight', Care: 'Machine wash cold' },
    image: image('photo-1770359993283-a2c2f386584e'),
  },
  {
    name: 'Cotton Silk Kurta — Olive',
    description:
      'Structured cotton-silk with a mandarin collar and deep side slits. Holds a press and reads dressy without trying.',
    priceMajor: 2499,
    stock: 16,
    category: 'Kurtas',
    attributes: { Occasion: 'Office, casual, daytime', Colour: 'Olive green', Fabric: 'Cotton silk', Fit: 'Straight', Collar: 'Mandarin', Care: 'Dry clean' },
    image: image('photo-1727835523545-70ee992b5763'),
  },
  {
    name: 'Chikankari Kurta — White',
    description:
      'Everyday chikankari on white cotton, cut long and straight. The one people buy two of.',
    priceMajor: 2199,
    stock: 19,
    category: 'Kurtas',
    attributes: { Occasion: 'Everyday, summer, casual', Colour: 'White', Fabric: 'Cotton', Work: 'Hand chikankari', Fit: 'Straight', Care: 'Hand wash' },
    image: image('photo-1667665970124-2273c6ef3489'),
  },
  {
    name: 'Bandhani Dupatta — Ruby',
    description: 'Kutch bandhani tied by hand on a soft georgette base. Thousands of individual knots.',
    priceMajor: 1799,
    stock: 18,
    category: 'Dupattas',
    attributes: { Occasion: 'Festive, wedding, navratri', Colour: 'Ruby red', Fabric: 'Georgette', Work: 'Hand bandhani', Size: '2.4 m', Care: 'Hand wash separately' },
    image: image('photo-1570212773364-e30cd076539e'),
  },
  {
    name: 'Phulkari Dupatta — Lime',
    description: 'Punjabi phulkari worked in floss silk on a fine chanderi ground.',
    priceMajor: 2299,
    // Deliberately out of stock, so the out-of-stock path has something real to
    // hit in a demo without editing the catalogue first.
    stock: 0,
    category: 'Dupattas',
    attributes: { Occasion: 'Festive, mehndi, haldi', Colour: 'Lime green and pink', Fabric: 'Chanderi', Work: 'Hand phulkari', Size: '2.4 m', Care: 'Dry clean' },
    image: image('photo-1717585679395-bbe39b5fb6bc'),
  },
  {
    name: 'Kundan Choker Set — Gold Tone',
    description: 'A gold-tone kundan choker with matching drops. Light enough to wear all evening.',
    priceMajor: 3299,
    stock: 8,
    category: 'Jewellery',
    attributes: { Occasion: 'Wedding, reception, festive', Colour: 'Gold', Material: 'Brass with gold plating', Stones: 'Kundan and pearl', Includes: 'Choker and earrings' },
    image: image('photo-1756483560049-e7b2208f99a0'),
  },
  {
    name: 'Jhumka Earrings — Ruby Drop',
    description: 'A long jhumka with a faceted ruby-red drop and a pearl edge. Hooks, not screws.',
    priceMajor: 1499,
    stock: 13,
    category: 'Jewellery',
    attributes: { Occasion: 'Festive, everyday, party', Colour: 'Gold and ruby red', Material: 'Brass with gold plating', Stones: 'Cubic zirconia and pearl', Drop: '6.5 cm' },
    image: image('photo-1671642883395-0ab89c3ac890'),
  },
  {
    name: 'Juttis — Teal Embroidered',
    description: 'Hand-embroidered juttis with silver thread, a pom detail, and a cushioned sole. Sizes 4 to 9.',
    priceMajor: 2199,
    stock: 12,
    category: 'Footwear',
    attributes: { Occasion: 'Wedding, festive, everyday', Colour: 'Teal and silver', Material: 'Leather', Work: 'Hand embroidery', Sizes: 'UK 4-9', Care: 'Wipe clean' },
    image: image('photo-1777980808039-c8be538797f0'),
  },
]

function seed(): void {
  db()

  transaction(() => {
    let tenant = tenants.bySlug('smart-choice')
    if (!tenant) {
      tenant = tenants.create({
        name: 'Smart Choice',
        slug: 'smart-choice',
        description:
          'Handwoven sarees, chikankari kurta sets, and everyday ethnic wear, made by weavers and karigars across India.',
        assistantName: 'Meera',
        brandVoice:
          'warm and unhurried, the way a good shop assistant talks — plain about fabric, honest about what suits what, never pushy',
        currency: 'INR',
        accentColor: '#8C3A2B',
      })
      log.info('seeded tenant', { slug: tenant.slug })
    }

    if (!users.emailTaken(DEMO_EMAIL)) {
      const { hash, salt } = passwordFields(DEMO_PASSWORD)
      users.create({
        tenantId: tenant.id,
        email: DEMO_EMAIL,
        passwordHash: hash,
        passwordSalt: salt,
        displayName: 'Smart Choice',
      })
      log.info('seeded dashboard user', { email: DEMO_EMAIL })
    }

    // Products live in Convo's own catalogue to start with. The dashboard's
    // "Connect a provider" flow switches the brand over to Razorpay.
    const existing = new Set(products.list(tenant.id, { includeInactive: true }).map((p) => p.name))
    let created = 0
    for (const item of CATALOG) {
      if (existing.has(item.name)) continue
      products.create({
        tenantId: tenant.id,
        name: item.name,
        description: item.description,
        priceMinor: toMinor(item.priceMajor),
        currency: 'INR',
        images: [item.image],
        stock: item.stock,
        category: item.category,
        attributes: item.attributes,
        source: 'manual',
      })
      created += 1
    }

    if (!connections.byType(tenant.id, 'manual')) {
      connections.upsert({
        tenantId: tenant.id,
        providerType: 'manual',
        capabilities: 'catalog+payment',
        credentialsEnc: null,
        credentialsHint: null,
      })
      connections.activate(tenant.id, 'manual', ['catalog', 'payment'])
    }

    log.info('seed complete', {
      tenant: tenant.slug,
      productsCreated: created,
      chatUrl: `${env.publicBaseUrl}/chat/${tenant.slug}`,
    })
  })

  console.log(`
  Smart Choice is seeded.

    Dashboard   ${env.publicBaseUrl}/login
    Email       ${DEMO_EMAIL}
    Password    ${DEMO_PASSWORD}

    Chat link   ${env.publicBaseUrl}/chat/smart-choice
`)
}

seed()
