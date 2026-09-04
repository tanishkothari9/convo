/**
 * Convo's icon set.
 *
 * One construction rule, applied to everything: each icon is built from the
 * three horizontal registers of a ledger — y = 7, 12 and 17 on a 24 grid —
 * bent, broken or beaded into its subject. Nothing here is a picture of an
 * object; it is a record deforming into one.
 *
 * The rule has an origin. The rupee sign is already two horizontal rules over
 * a stem, so the currency this product mostly counts in is the set's own
 * seed glyph, and the rest of the icons are drawn to match it.
 *
 * Practical consequences: strokes are 1.6 with round caps, lines start at
 * x = 4 and run to x = 20 unless the subject shortens them, and nothing is
 * filled. Everything inherits `currentColor`.
 */
import type { SVGProps } from 'react'

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

// ── Navigation ──────────────────────────────────────────────────────────────

/** Overview: the registers climb. A ledger read as a trend. */
export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 18h16" />
    <path d="M4 12.5h5l3.5-5h3" />
    <path d="M4 7h2.5" />
    <circle cx="18.5" cy="7.5" r="1.6" />
  </Svg>
)

/** Catalogue: goods held between two registers. */
export const IconCatalogue = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5.5h16" />
    <rect x="4" y="9" width="16" height="6" rx="1.8" />
    <path d="M9.5 9v6M14.5 9v6" />
    <path d="M4 18.5h16" />
  </Svg>
)

/**
 * Provider: two records meeting at a coupling. The outer registers stop short
 * of the seam and the middle one carries across it, so the icon says "these
 * were separate and now they are joined" rather than drawing a plug.
 */
export const IconProvider = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h5M15 7h5" />
    <path d="M4 17h5M15 17h5" />
    <path d="M4 12h5.4M14.6 12H20" />
    <circle cx="10.7" cy="12" r="1.3" />
    <circle cx="13.3" cy="12" r="1.3" />
  </Svg>
)

/** Audit: registers with one sealed. The entry that cannot be edited. */
export const IconAudit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.5h16M4 11h9M4 15.5h6" />
    <circle cx="16" cy="16" r="4" />
    <path d="m14.4 16 1.1 1.1 2.1-2.3" />
  </Svg>
)

/**
 * Settings: the registers stood on end, each with a bead you can move.
 *
 * The one deliberate exception to the horizontal rule. It sits directly under
 * Provider in the sidebar, and two icons made of horizontal lines and beads
 * would be told apart only by a gap — which is not a distinction at 17px.
 * Turning these vertical separates them at a glance and keeps the vocabulary.
 */
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4v16M12 4v16M17 4v16" />
    <circle cx="7" cy="15.5" r="2" />
    <circle cx="12" cy="8" r="2" />
    <circle cx="17" cy="13" r="2" />
  </Svg>
)

// ── Semantic ────────────────────────────────────────────────────────────────

/**
 * The agent. Registers that lift off the page at their right end and turn
 * into speech — not a sparkle, and not a robot.
 */
export const IconAgent = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h11" />
    <path d="M4 12h7" />
    <path d="M4 17h4" />
    <path d="M13.5 15.5c0-2.8 2-4.6 4.4-4.6 1.2 0 2.1.9 2.1 2.2 0 2.7-3 4.6-6.5 5.4l1.6-2.4" />
  </Svg>
)

/**
 * The gates. Three registers running left to right, stopped dead by a bar,
 * with a seal on it. Nothing continues past the bar — which is the whole
 * claim the product makes about what the agent can do.
 */
export const IconGate = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h7.5M4 12h7.5M4 17h7.5" />
    <path d="M14.5 4v16" />
    <circle cx="14.5" cy="12" r="2.4" />
  </Svg>
)

/** Kept so existing call sites keep working. */
export const IconShield = IconGate

/** Money. The seed glyph: two rules over a stem. */
export const IconRupee = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 5.5h11M6.5 10h11" />
    <path d="M13 5.5c2.4 0 3.8 1.7 3.8 3.9s-1.6 4-4.3 4H6.5L15.5 21" />
  </Svg>
)

/** Cart. A basket whose contents are two registers. */
export const IconCart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4.5h2.5l1.3 4.5" />
    <path d="M6.8 9h13.7l-2 6.5a1.6 1.6 0 0 1-1.5 1.1H9.5a1.6 1.6 0 0 1-1.6-1.2Z" />
    <path d="M10.4 11.6h6.4M11 14h5" />
    <circle cx="10" cy="20" r="1.2" />
    <circle cx="17" cy="20" r="1.2" />
  </Svg>
)

/** A receipt: registers on a torn slip. */
export const IconReceipt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h12v17l-2.4-1.5-2.4 1.5-2.4-1.5-2.4 1.5Z" />
    <path d="M9.5 8h5M9.5 12h5M9.5 16h2.5" />
  </Svg>
)

/** A link: one register handed across a break. */
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 12h5" />
    <path d="M10.5 7.5H8a4.5 4.5 0 0 0 0 9h2.5" />
    <path d="M13.5 7.5H16a4.5 4.5 0 0 1 0 9h-2.5" />
  </Svg>
)

/** Speed: a register struck through at an angle. */
export const IconBolt = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h6M4 16h6" />
    <path d="M15.5 3.5 9.5 12.5H14L12.5 20.5l6-9H14Z" />
  </Svg>
)

// ── Actions ─────────────────────────────────────────────────────────────────
// Deliberately quieter: these sit inside controls, where a clever mark would
// compete with the label beside it.

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
    <path d="M12 13.5h5M12 16.5h3" />
  </Svg>
)

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
  </Svg>
)

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </Svg>
)

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M7.5 9h6M7.5 12h4" />
    <path d="m15.5 15.5 4.5 4.5" />
  </Svg>
)

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
  </Svg>
)

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5Z" />
    <path d="m14 7 3.2 3.2" />
  </Svg>
)

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Svg>
)

export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 10 4 4 4-4" />
  </Svg>
)

export const IconArrow = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h13M13 7l5 5-5 5" />
  </Svg>
)

export const IconSend = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 19V6M12 5.5 6.5 11M12 5.5 17.5 11" />
  </Svg>
)

export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </Svg>
)

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
  </Svg>
)

/** Kept as an alias so nothing that reached for a sparkle breaks. */
export const IconSpark = IconAgent
