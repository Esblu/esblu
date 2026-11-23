import { EinvoiceProviderError, type EinvoiceEnvironment, type EinvoiceProvider } from "./types.ts";

// =============================================================================
// Spoločný limit požiadaviek pre CELÝ partnerský kľúč eFaktura.sk (migrácia 20261126100000).
//
// Každá sieťová metóda poskytovateľa patrí do triedy s vlastnou kvótou (DB: einvoice_provider_rate_limits):
//   interactive (akcie používateľa), outbound (odoslanie — rezerva), reconcile, inbound_event / inbound_poll
//   (príjem — rieši withInboundRateLimit podľa kontextu), background (feed, deregistrácia).
// Zamietnutie = lokálne EINVOICE_PROVIDER_RATE_LIMITED (retryable) PRED odoslaním požiadavky:
//   - odoslanie: politika ho berie ako RETRY_DEFINITE → žiadny „neznámy výsledok“, ten istý Idempotency-Key pri
//     ďalšom pokuse → žiadna duplicita,
//   - príjem/feed: beh sa zastaví a pokračuje ďalším behom, nič sa nestratí.
// 429 od poskytovateľa → cooldown pre všetky triedy (Retry-After, inak 30 s).
// Chyba limitera (DB, chýbajúca migrácia) = fail-open: požiadavka pokračuje; posledná poistka je 429 poskytovateľa.
// Proxy vracia getter/metódy nad SKUTOČNÝM objektom (privátne polia — test RL5); `instanceof` funguje.
// =============================================================================

export type ProviderRateClass = "interactive" | "outbound" | "reconcile" | "inbound_event" | "inbound_poll" | "background";
export type ProviderRateDecision = "ok" | "class_limit" | "total_limit" | "cooldown" | "unconfigured";

export interface ProviderRateLimiter {
  acquire(provider: string, environment: EinvoiceEnvironment, cls: ProviderRateClass, cost: number): Promise<ProviderRateDecision>;
  cooldown(provider: string, environment: EinvoiceEnvironment, seconds: number): Promise<void>;
}

/**
 * Trieda každej sieťovej metódy poskytovateľa. "inbound" = triedu určí kontext (poll / udalosť) cez
 * withInboundRateLimit; tu sa iba sleduje 429. Nová sieťová metóda bez záznamu = chyba testu (RL-map).
 */
export const PROVIDER_METHOD_CLASS: Record<string, ProviderRateClass | "inbound"> = {
  // akcie používateľa (onboarding, mandát, odoslanie — kontrola pred odoslaním)
  provisionOrganization: "interactive",
  getOrganization: "interactive",
  enrollPeppol: "interactive",
  verifyRecipient: "interactive",
  preflight: "interactive",
  // odoslanie faktúr + dohľadanie podania (idempotencia)
  sendUbl: "outbound",
  getSubmissionByDocumentId: "outbound",
  findSubmissionByIdempotencyKey: "outbound",
  // stav odoslaných
  getOutboundStatus: "reconcile",
  getDeliveryEvidence: "reconcile",
  // príjem
  listUnacknowledgedInbound: "inbound",
  listUnacknowledgedInboundPage: "inbound",
  getInboundDocument: "inbound",
  acknowledgeInbound: "inbound",
  // pozadie
  listPartnerEvents: "background",
  deactivatePeppol: "background",
};

/** Metódy bez sieťovej požiadavky (nelimitujú sa). */
export const PROVIDER_LOCAL_METHODS = new Set(["toJSON", "constructor"]);

const LOCAL_PREFIX = "Lokálny limit požiadaviek";

export function isLocalRateLimit(error: unknown): boolean {
  return error instanceof EinvoiceProviderError && error.code === "EINVOICE_PROVIDER_RATE_LIMITED" && error.message.startsWith(LOCAL_PREFIX);
}

/** Retry-After z hlášky adaptéra „… (Retry-After N s)“; inak 30 s; najviac 1 h. */
export function cooldownSeconds(error: unknown): number {
  const m = error instanceof Error ? /Retry-After (\d+) s/.exec(error.message) : null;
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : 30;
}

export function localRateLimitError(cls: ProviderRateClass, decision: ProviderRateDecision): EinvoiceProviderError {
  return new EinvoiceProviderError("EINVOICE_PROVIDER_RATE_LIMITED", `${LOCAL_PREFIX} (${cls}: ${decision})`, true);
}

/** Po 429 od poskytovateľa (nie lokálnom) nastaví cooldown; chyba zápisu sa ignoruje. */
export async function noteProviderRateLimit(limiter: ProviderRateLimiter, provider: string, environment: EinvoiceEnvironment, error: unknown) {
  if (!(error instanceof EinvoiceProviderError) || error.code !== "EINVOICE_PROVIDER_RATE_LIMITED" || isLocalRateLimit(error)) return;
  try {
    await limiter.cooldown(provider, environment, cooldownSeconds(error));
  } catch {
    // fail-open
  }
}

export function withProviderRateLimit<T extends EinvoiceProvider>(provider: T, environment: EinvoiceEnvironment, limiter: ProviderRateLimiter): T {
  return new Proxy(provider, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const name = String(key);
      const cls = PROVIDER_METHOD_CLASS[name];
      if (!cls) return value.bind(target);
      return async (...args: unknown[]) => {
        if (cls !== "inbound") {
          let decision: ProviderRateDecision = "ok";
          try {
            decision = await limiter.acquire(target.name, environment, cls, 1);
          } catch {
            decision = "ok"; // fail-open: výpadok limitera nesmie zastaviť prevádzku
          }
          if (decision !== "ok" && decision !== "unconfigured") throw localRateLimitError(cls, decision);
        }
        try {
          return await value.apply(target, args);
        } catch (error) {
          await noteProviderRateLimit(limiter, target.name, environment, error);
          throw error;
        }
      };
    },
  });
}
