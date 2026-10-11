// =============================================================================
// Serverová brána nákupných kanálov (SERVER ONLY) — fail closed.
//
// DB (billing_channel_rules + billing_runtime_config) rozhoduje, KDE sa smie
// kúpiť. Server navyše vie, či je daný PROVIDER na tomto nasadení vôbec
// zapojený (ESBLU_BILLING_MODE / ESBLU_BILLING_STORE_MODE). Ak nie je, kanál
// sa klientovi NEPONÚKNE a nákupný zámer sa ODMIETNE — inak by appka mohla
// spustiť Play/StoreKit nákup, ktorý server nevie overiť (platba bez nároku).
// =============================================================================

import { getBillingServerMode } from "@/lib/billing/config";
import { getStoreMode } from "@/lib/billing/stores/store-config";

export type ProviderGate = { webEnabled: boolean; storesEnabled: boolean };

/** Kanály, ktoré spracúva obchod (Apple/Google). Všetky ostatné idú cez webového providera (Stripe/fake). */
export const STORE_METHODS: ReadonlySet<string> = new Set(["apple_iap", "google_play"]);

export function providerGateFromEnv(env: Record<string, string | undefined> = process.env): ProviderGate {
  return { webEnabled: getBillingServerMode(env) !== "off", storesEnabled: getStoreMode(env) !== "off" };
}

export function methodAllowedByServer(method: string, gate: ProviderGate): boolean {
  return STORE_METHODS.has(method) ? gate.storesEnabled : gate.webEnabled;
}

/**
 * Odfiltruje z odpovede esblu_billing_purchase_options kanály, ktorých provider
 * nie je na serveri zapojený, a prepočíta purchase_allowed / view_only.
 * Neznámy tvar → bezpečne bez kanálov.
 */
export function gatePurchaseOptions(data: unknown, gate: ProviderGate): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { methods: [], purchase_allowed: false, view_only: true };
  const o = data as Record<string, unknown>;
  const methods = (Array.isArray(o.methods) ? o.methods : []).filter(
    (m) => !!m && typeof m === "object" && typeof (m as Record<string, unknown>).method === "string" && methodAllowedByServer(String((m as Record<string, unknown>).method), gate),
  );
  const open = !!o.current;
  return {
    ...o,
    methods,
    purchase_allowed: !open && methods.length > 0 && o.purchase_allowed !== false,
    view_only: methods.length === 0,
  };
}
