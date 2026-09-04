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
      'Handwoven on a pit loom in Varanasi, with a real zari border and a matching unstitched blouse piece. Takes about three weeks on the loom.',
    priceMajor: 12499,
    stock: 6,
    category: 'Sarees',
    attributes: { Fabric: 'Pure Banarasi silk', Weave: 'Handloom', Length: '6.3 m with blouse piece', Care: 'Dry clean only' },
    image: image('photo-1610030469983-98e550d6193c'),
  },
  {
    name: 'Chanderi Cotton-Silk Saree — Sage',
    description:
      'A feather-light Chanderi weave with fine gold-thread butti scattered across the body. Holds a drape without weighing anything.',
    priceMajor: 6899,
    stock: 11,
    category: 'Sarees',
    attributes: { Fabric: 'Chanderi cotton-silk', Weave: 'Handloom', Length: '6.3 m with blouse piece', Care: 'Dry clean' },
    image: image('photo-1583391733956-6c78276477e2'),
  },
  {
    name: 'Kanjivaram Silk Saree — Peacock Blue',
    description:
      'Pure mulberry silk from Kanchipuram with a contrast temple border and a korvai join at the pallu. The one for a wedding.',
    priceMajor: 18999,
    stock: 3,
    category: 'Sarees',
    attributes: { Fabric: 'Pure mulberry silk', Weave: 'Korvai handloom', Length: '6.3 m with blouse piece', Care: 'Dry clean only' },
    image: image('photo-1594633312681-425c7b97ccd1'),
  },
  {
    name: 'Linen Saree — Charcoal',
    description:
      'Pure linen in a deep charcoal with a thin silver border. Crushes beautifully and gets softer every wash — an everyday saree.',
    priceMajor: 3499,
    stock: 14,
    category: 'Sarees',
    attributes: { Fabric: 'Pure linen', Length: '6.3 m with blouse piece', Care: 'Machine wash cold' },
    image: image('photo-1610030181087-540017dc9d61'),
  },
  {
    name: 'Anarkali Kurta Set — Ivory Chikankari',
    description:
      'Hand-embroidered Lucknowi chikankari on cotton mul, with a churidar and a matching dupatta. The embroidery is done by hand, so no two are identical.',
    priceMajor: 5499,
    stock: 9,
    category: 'Kurta Sets',
    attributes: { Fabric: 'Cotton mul', Work: 'Hand chikankari', Includes: 'Kurta, churidar, dupatta', Care: 'Hand wash' },
    image: image('photo-1602810318383-e386cc2a3ccf'),
  },
  {
    name: 'Sharara Set — Rose Gold Georgette',
    description:
      'Sequin-worked georgette kurta over a flared sharara, with a scalloped-edge dupatta. Built for a sangeet.',
    priceMajor: 7999,
    stock: 5,
    category: 'Kurta Sets',
    attributes: { Fabric: 'Georgette', Work: 'Sequin and thread', Includes: 'Kurta, sharara, dupatta', Care: 'Dry clean' },
    image: image('photo-1595777457583-95e059d581b8'),
  },
  {
    name: 'Straight Kurta — Indigo Block Print',
    description:
      'Hand-block printed in natural indigo on soft cotton. Side slits, a chest pocket, and a fit that works over jeans or a churidar.',
    priceMajor: 1899,
    stock: 22,
    category: 'Kurtas',
    attributes: { Fabric: 'Cotton', Work: 'Hand block print', Fit: 'Straight', Care: 'Machine wash cold' },
    image: image('photo-1583391733981-8698e5b39b02'),
  },
  {
    name: 'Cotton Silk Kurta — Mustard',
    description:
      'Structured cotton-silk with a mandarin collar and deep side slits. Holds a press and reads dressy without trying.',
    priceMajor: 2499,
    stock: 16,
    category: 'Kurtas',
    attributes: { Fabric: 'Cotton silk', Fit: 'Straight', Collar: 'Mandarin', Care: 'Dry clean' },
    image: image('photo-1614251056216-f748f76cd228'),
  },
  {
    name: 'Bandhani Dupatta — Ruby',
    description: 'Kutch bandhani tied by hand on a soft georgette base. Thousands of individual knots.',
    priceMajor: 1799,
    stock: 18,
    category: 'Dupattas',
    attributes: { Fabric: 'Georgette', Work: 'Hand bandhani', Size: '2.4 m', Care: 'Hand wash separately' },
    image: image('photo-1600950207944-0d63e8edbc3f'),
  },
  {
    name: 'Phulkari Dupatta — Ivory and Fuchsia',
    description: 'Punjabi phulkari worked in floss silk on a fine chanderi ground.',
    priceMajor: 2299,
    stock: 0, // deliberately out of stock: the failure path has something real to hit
    category: 'Dupattas',
    attributes: { Fabric: 'Chanderi', Work: 'Hand phulkari', Size: '2.4 m', Care: 'Dry clean' },
    image: image('photo-1585487000160-6ebcfceb0d03'),
  },
  {
    name: 'Kundan Choker Set — Gold Tone',
    description: 'A gold-tone kundan choker with matching drops. Light enough to wear all evening.',
    priceMajor: 3299,
    stock: 8,
    category: 'Jewellery',
    attributes: { Material: 'Brass with gold plating', Stones: 'Kundan and pearl', Includes: 'Choker and earrings' },
    image: image('photo-1611591437281-460bfbe1220a'),
  },
  {
    name: 'Juttis — Ivory Embroidered',
    description: 'Hand-embroidered leather juttis with a cushioned sole. Sizes 4 to 9.',
    priceMajor: 2199,
    stock: 12,
    category: 'Footwear',
    attributes: { Material: 'Leather', Work: 'Hand embroidery', Sizes: 'UK 4–9', Care: 'Wipe clean' },
    image: image('photo-1595341888016-a392ef81b7de'),
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
      connections.activate(tenant.id, 'manual')
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
