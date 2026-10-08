import { EinvoiceProviderError, type OutboundState } from "../provider/types.ts";

// =============================================================================
// E-Faktúra outbound — čistá politika (bez I/O): retry, backoff, klasifikácia
// chýb poskytovateľa, mapovanie stavov. Testované v scripts/einvoice-outbound-tests.ts.
//
// Zásada proti dvojitému odoslaniu:
//   - Každý pokus (riadok einvoice_outbound) má JEDEN Idempotency-Key. Retry
//     aj reconciliation bez ID poskytovateľa = opakovanie TOHO ISTÉHO kľúča a
//     TÝCH ISTÝCH bajtov (poskytovateľ vráti pôvodný výsledok, nič nové
//     nevznikne).
//   - Nový pokus (nový kľúč) vzniká iba ručne cez RPC, a to iba po
//     terminálnom `failed` / `rejected`. `failed` sa nastaví IBA keď je isté,
//     že poskytovateľ dokument neprijal (alebo ho sám potvrdil ako chybný).
//     Neistý výsledok (timeout, sieť, 5xx, pád workera) nikdy nevedie na failed.
// =============================================================================

/**
 * Maximálny počet odoslaní jedného pokusu (claim = 1 odoslanie). Všetky automatické opakovania
 * s tým istým Idempotency-Key sa zmestia do ~2 h — hlboko pod 24 h, počas ktorých ho poskytovateľ drží
 * (overené testom). Po 24 h chráni pred druhým odoslaním trvalá deduplikácia poskytovateľa (SHA-256 UBL).
 */
export const PROVIDER_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/** Oneskorenie ďalšieho pokusu po `attemptsMade` odoslaniach: 1m, 2m, 4m, 8m … max 6 h. */
export function backoffMs(attemptsMade: number): number {
  const n = Math.max(1, Math.floor(attemptsMade));
  return Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_CAP_MS);
}

export type SendDisposition =
  /** Opakovať s tým istým kľúčom; outcomeUnknown = poskytovateľ to MOHOL prijať. */
  | { kind: "retry"; code: string; outcomeUnknown: boolean }
  /** Poskytovateľ potvrdene odmietol obsah dokumentu → terminálne `rejected`. */
  | { kind: "reject"; code: string }
  /** Isté, že dokument nebol prijatý (lokálna kontrola, konfigurácia, kredit) → `failed`. */
  | { kind: "fail"; code: string }
  /** Nejasný stav vyžadujúci človeka (napr. konflikt idempotencie) — nič sa neopakuje ani neuzatvára. */
  | { kind: "hold"; code: string };

const RETRY_DEFINITE = new Set(["EINVOICE_PROVIDER_RATE_LIMITED"]);
const RETRY_UNKNOWN = new Set([
  // 409 „Idempotency-Key sa práve spracúva" — poskytovateľ požiadavku MÁ, výsledok ešte nie je;
  // odložený retry s tým istým kľúčom a bajtmi (nie finálne zlyhanie, nie hold).
  "EINVOICE_PROVIDER_IDEMPOTENCY_IN_PROGRESS",
  "EINVOICE_PROVIDER_UNAVAILABLE",
  "EINVOICE_PROVIDER_TIMEOUT",
  "EINVOICE_PROVIDER_NETWORK",
  "EINVOICE_PROVIDER_BAD_RESPONSE",
  "EINVOICE_PROVIDER_UNKNOWN_STATE",
  "EINVOICE_PROVIDER_RESPONSE_TOO_LARGE",
]);
const REJECT = new Set(["EINVOICE_PROVIDER_REJECTED"]);
const FAIL = new Set([
  "EINVOICE_UBL_HASH_MISMATCH",
  "EINVOICE_INVALID_IDEMPOTENCY_KEY",
  "EINVOICE_IDEMPOTENCY_KEY_INVALID",
  "EINVOICE_INVALID_PARTICIPANT",
  "EINVOICE_INVALID_INPUT",
  "EINVOICE_INVALID_ID",
  "EINVOICE_PROVIDER_UNAUTHORIZED",
  "EINVOICE_PROVIDER_FORBIDDEN",
  "EINVOICE_PROVIDER_NOT_FOUND",
  "EINVOICE_PROVIDER_INSUFFICIENT_CREDIT",
  "EINVOICE_ORGANIZATION_NOT_FOUND",
  "EINVOICE_KEY_ENVIRONMENT_MISMATCH",
  "EINVOICE_ENVIRONMENT_MISMATCH",
]);
// Iný 409 (ten istý kľúč s iným telom, duplicita UBL / čísla dokladu u poskytovateľa) → človek, nič sa neopakuje.
const HOLD = new Set(["EINVOICE_PROVIDER_CONFLICT", "EINVOICE_IDEMPOTENCY_CONFLICT"]);

/** Strojový kód chyby (iba [A-Z0-9_], max 80 znakov — zhodné s DB CHECK last_error_code). */
export function errorCode(error: unknown): string {
  const raw = error instanceof EinvoiceProviderError ? error.code : "EINVOICE_INTERNAL_ERROR";
  const code = raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
  return code || "EINVOICE_INTERNAL_ERROR";
}

export function classifySendError(error: unknown): SendDisposition {
  const code = errorCode(error);
  if (RETRY_DEFINITE.has(code)) return { kind: "retry", code, outcomeUnknown: false };
  if (RETRY_UNKNOWN.has(code)) return { kind: "retry", code, outcomeUnknown: true };
  if (REJECT.has(code)) return { kind: "reject", code };
  if (FAIL.has(code)) return { kind: "fail", code };
  if (HOLD.has(code)) return { kind: "hold", code };
  if (error instanceof EinvoiceProviderError && error.retryable) return { kind: "retry", code, outcomeUnknown: true };
  // Neznáma chyba (aj bug) = neistý výsledok, opakovať tým istým kľúčom.
  return { kind: "retry", code, outcomeUnknown: true };
}

/**
 * Po neúspešnom pokuse: čo s riadkom. Po vyčerpaní pokusov je výsledok
 * `failed` IBA ak žiadny pokus nemal neistý výsledok; inak riadok ostáva
 * `sending` bez ďalšieho plánovania (EINVOICE_RETRY_EXHAUSTED_UNKNOWN) a čaká
 * na reconciliation / operátora.
 */
export type RetryPlan =
  | { action: "retry"; code: string; nextRetryAt: Date; outcomeUnknown: boolean }
  | { action: "fail"; code: string }
  | { action: "reject"; code: string }
  | { action: "hold"; code: string; outcomeUnknown: boolean };

export function planAfterError(input: {
  disposition: SendDisposition;
  attemptsMade: number;
  priorOutcomeUnknown: boolean;
  now: Date;
}): RetryPlan {
  const d = input.disposition;
  if (d.kind === "reject") return { action: "reject", code: d.code };
  if (d.kind === "fail") {
    // „Fail" je isté iba ak predtým nebol neistý pokus — inak by nový pokus mohol zdvojiť doklad.
    return input.priorOutcomeUnknown
      ? { action: "hold", code: d.code, outcomeUnknown: true }
      : { action: "fail", code: d.code };
  }
  if (d.kind === "hold") return { action: "hold", code: d.code, outcomeUnknown: true };
  const unknown = input.priorOutcomeUnknown || d.outcomeUnknown;
  if (input.attemptsMade >= MAX_SEND_ATTEMPTS) {
    return unknown
      ? { action: "hold", code: "EINVOICE_RETRY_EXHAUSTED_UNKNOWN", outcomeUnknown: true }
      : { action: "fail", code: "EINVOICE_RETRY_EXHAUSTED" };
  }
  return {
    action: "retry",
    code: d.code,
    nextRetryAt: new Date(input.now.getTime() + backoffMs(input.attemptsMade)),
    outcomeUnknown: unknown,
  };
}

/** Stav poskytovateľa (GET status) → stav Esblu pre podanie, ktoré poskytovateľ už prijal. */
export function outboundStateFromProvider(state: OutboundState): "sent" | "deferred" | "delivered" | "failed" {
  switch (state) {
    case "deferred":
      return "deferred";
    case "delivered":
      return "delivered";
    case "failed":
      return "failed";
    default:
      // pending (not_sent) / queued / sending / sent u poskytovateľa = prijaté, prenos prebieha.
      return "sent";
  }
}

/** Normalizovaný stav pre provider_status / provider_code (DB CHECK ^[A-Za-z_]{1,40}$). */
export function providerStatusCode(state: string): string {
  return state.replace(/[^A-Za-z_]/g, "_").slice(0, 40) || "unknown";
}
