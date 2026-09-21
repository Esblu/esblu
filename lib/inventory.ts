// =============================================================================
// Sklad — typy a ODVODENÝ stav zásoby.
//
// ŽIADNA NOVÁ DB ZMENA.
//
// Čo tabuľka `inventory_items` reálne má (overené proti produkčnej schéme):
//   name, category, quantity, unit, min_quantity, location, notes,
//   created_at, user_id, company_id
//
// Čo NEMÁ a preto to UI nesmie predstierať (nahlásené ako gap):
//   • SKU / kód položky
//   • jednotkovú cenu ani hodnotu zásoby
//   • updated_at — vieme len, kedy položka VZNIKLA, nie kedy sa naposledy
//     zmenila. "Posledná zmena" v registri by bola nepravdivá.
//   • tabuľku pohybov (príjem/výdaj) — história zásoby neexistuje
//
// `min_quantity` naopak EXISTUJE, takže stav zásoby je poctivo odvoditeľný
// a nemusíme si ho vymýšľať.
// =============================================================================

export type InventoryItemRow = {
  id: string;
  name: string | null;
  category: string | null;
  quantity: number | null;
  unit: string | null;
  min_quantity: number | null;
  location: string | null;
  notes: string | null;
  created_at: string;
  company_id: string | null;
  /** Doplnené klientom z inventory_photos, nie stĺpec tabuľky. */
  first_photo_url?: string | null;
};

export type StockStatus = "out" | "low" | "ok" | "untracked";

/**
 * Stav zásoby.
 *
 *   out       množstvo je 0 alebo menej
 *   low       množstvo <= minimum (a minimum je nastavené)
 *   ok        množstvo nad minimom
 *   untracked položka nemá nastavené minimum — vieme koľko jej je,
 *             ale nie, koľko jej MÁ byť. To nie je "v poriadku", to je
 *             "nesledované", a UI to má povedať rovno.
 *
 * Prah je `<=`, rovnaký ako doterajšia funkcia isLowStock v app/sklad —
 * meniť ho by znamenalo, že položky zrazu zmenia stav bez zásahu
 * používateľa.
 */
export function stockStatus(item: InventoryItemRow): StockStatus {
  const quantity = typeof item.quantity === "number" ? item.quantity : null;
  const minimum = typeof item.min_quantity === "number" ? item.min_quantity : null;

  if (quantity !== null && quantity <= 0) return "out";
  if (minimum === null) return "untracked";
  if (quantity === null) return "untracked";
  return quantity <= minimum ? "low" : "ok";
}

export function inventoryCategories(items: InventoryItemRow[]): string[] {
  const seen = new Set<string>();
  for (const item of items) {
    const category = item.category?.trim();
    if (category) seen.add(category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

export function matchesInventoryQuery(item: InventoryItemRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [item.name, item.category, item.location, item.notes]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(needle));
}
