const SYMBOLS: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }

/** Money is minor units on the wire and stays integer until the last moment. */
export function money(minor: number, currency = 'INR'): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `
  const major = minor / 100
  const locale = currency === 'INR' ? 'en-IN' : 'en-US'
  return `${symbol}${major.toLocaleString(locale, {
    minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`
}

/** Relative for the recent past, absolute once it stops being "just now". */
export function when(iso: string): string {
  const then = new Date(iso)
  const seconds = Math.round((Date.now() - then.getTime()) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600)
    return `${hours} hour${hours === 1 ? '' : 's'} ago`
  }
  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function timeOfDay(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Readable contrast against an arbitrary brand colour, so a light brand accent
 * still gets legible text on its buttons.
 */
export function contrastOn(hex: string): string {
  const value = hex.replace('#', '')
  if (value.length !== 6) return '#ffffff'
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
  const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
  return luminance > 0.45 ? '#1a1c22' : '#ffffff'
}

/** Mixes a brand colour toward white or black, for tints and hover states. */
export function shade(hex: string, amount: number, toward: 'white' | 'black' = 'black'): string {
  const value = hex.replace('#', '')
  if (value.length !== 6) return hex
  const target = toward === 'white' ? 255 : 0
  const mixed = [0, 2, 4]
    .map((i) => parseInt(value.slice(i, i + 2), 16))
    .map((channel) => Math.round(channel + (target - channel) * amount))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')
  return `#${mixed}`
}

export function hexToRgb(hex: string): string {
  const value = hex.replace('#', '')
  if (value.length !== 6) return '27, 107, 84'
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)).join(', ')
}
