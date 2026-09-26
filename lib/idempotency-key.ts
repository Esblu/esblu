// =============================================================================
// Stabilný Idempotency-Key pre AI spracovanie jedného dokumentu v prehliadači.
//
// Rovnaký súbor (ten istý File objekt) + rovnaký variant (napr. otočenie)
// = rovnaký kľúč, takže opakované odoslanie po stratenej odpovedi server
// nezaúčtuje druhýkrát (esblu_reserve_ai_processing: rovnaký kľúč + rovnaký
// obsah). Nový súbor = nový kľúč. Kľúč nie je tajomstvo ani oprávnenie —
// server ho viaže na firmu, používateľa a hash obsahu.
// =============================================================================

const keys = new WeakMap<object, Map<string, string>>();

export function idempotencyKeyFor(source: object, variant = ""): string {
  let byVariant = keys.get(source);
  if (!byVariant) {
    byVariant = new Map();
    keys.set(source, byVariant);
  }
  let key = byVariant.get(variant);
  if (!key) {
    key = crypto.randomUUID().replace(/-/g, "");
    byVariant.set(variant, key);
  }
  return key;
}
