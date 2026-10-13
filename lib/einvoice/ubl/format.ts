import Decimal from "decimal.js";

// Deterministické formátovanie čísel a dátumov pre UBL (žiadne locale, žiadny float).

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function toDecimal(value: number | string): Decimal {
  const d = new Decimal(typeof value === "number" ? value.toString() : value);
  if (!d.isFinite()) throw new Error("UBL_NON_FINITE_NUMBER");
  return d;
}

/** Peňažná suma: presne 2 desatinné miesta (EN16931 povolí max. 2). */
export function money(value: number | string | Decimal): string {
  const d = value instanceof Decimal ? value : toDecimal(value);
  return d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

/** Množstvo / jednotková cena: bez zbytočných núl, bez exponentu. */
export function plainDecimal(value: number | string | Decimal): string {
  const d = value instanceof Decimal ? value : toDecimal(value);
  const s = d.toFixed();
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Sadzba DPH v percentách ("23", "19", "5.5"). */
export function percent(value: number | string): string {
  return plainDecimal(value);
}

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Dátum z DB (date alebo timestamptz) → YYYY-MM-DD, inak null. */
export function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const head = value.slice(0, 10);
  return isIsoDate(head) ? head : null;
}
