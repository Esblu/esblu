// Čistý kontrakt natívneho billing pluginu (bez Capacitor / Supabase importov) —
// testovateľný v Node. Klient nikdy neudeľuje nárok z týchto výsledkov; iba ich
// posiela na server (/api/billing/mobile/confirm) alebo zobrazí stav.

export type GooglePurchaseResult =
  | { kind: "play"; purchaseToken: string }
  | { kind: "developer_billing"; externalTransactionToken: string }
  | { kind: "canceled" }
  /** Purchase.PurchaseState.PENDING (napr. hotovosť / odložená platba) — nárok až po potvrdení. */
  | { kind: "pending"; purchaseToken: string | null }
  /** ITEM_ALREADY_OWNED — riešiť obnovou nákupov (restoreGoogle), nie druhou platbou. */
  | { kind: "already_owned" }
  /** BILLING_UNAVAILABLE / SERVICE_UNAVAILABLE / nepripojené Play služby. */
  | { kind: "billing_unavailable" }
  | { kind: "error"; code: string };

/** Výsledok natívneho pluginu → kontrakt (neznáme / neúplné = bezpečná chyba). */
export function normalizeGooglePluginResult(r: { kind?: string; purchaseToken?: string; externalTransactionToken?: string; code?: string } | null | undefined): GooglePurchaseResult {
  switch (r?.kind) {
    case "play":
      return r.purchaseToken ? { kind: "play", purchaseToken: r.purchaseToken } : { kind: "error", code: "MISSING_TOKEN" };
    case "developer_billing":
      return r.externalTransactionToken ? { kind: "developer_billing", externalTransactionToken: r.externalTransactionToken } : { kind: "error", code: "MISSING_TOKEN" };
    case "canceled":
      return { kind: "canceled" };
    case "pending":
      return { kind: "pending", purchaseToken: r.purchaseToken ?? null };
    case "already_owned":
      return { kind: "already_owned" };
    case "billing_unavailable":
      return { kind: "billing_unavailable" };
    default:
      return { kind: "error", code: typeof r?.code === "string" && /^[A-Z_]{1,40}$/.test(r.code) ? r.code : "UNKNOWN" };
  }
}

