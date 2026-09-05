/**
 * Money is integer minor units everywhere (paise for INR). Nothing in Convo
 * stores or arithmetics a currency amount as a float, and no amount the model
 * states is ever used to charge — see agent/gates.ts.
 */

export type Minor = number;

export function toMinor(major: number): Minor {
  return Math.round(major * 100);
}

export function toMajor(minor: Minor): number {
  return minor / 100;
}

const SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

export function formatMoney(minor: Minor, currency = "INR"): string {
  const symbol = SYMBOLS[currency] ?? `${currency} `;
  const major = toMajor(minor);
  const locale = currency === "INR" ? "en-IN" : "en-US";
  const digits = Number.isInteger(major) ? 0 : 2;
  return `${symbol}${major.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: 2,
  })}`;
}

/** Sum of quantity × unit price, in minor units. Integer arithmetic throughout. */
export function lineTotal(unitPriceMinor: Minor, quantity: number): Minor {
  return unitPriceMinor * quantity;
}
