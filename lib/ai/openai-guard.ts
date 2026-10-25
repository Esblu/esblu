// =============================================================================
// OpenAI retry cost guard (cost control hardening, 2026-10-25).
//
// Problém: OpenAI SDK má predvolene maxRetries 2 a timeout 10 min. SDK
// opakuje aj pri timeoute / prerušenom spojení (408, 409, connection error).
// Timeout NEZNAMENÁ, že OpenAI request nespracovala — model mohol odpoveď
// vygenerovať a zaúčtovať; retry potom platí ten istý drahý obrázkový request
// druhýkrát.
//
// Pravidlo: klienti majú `maxRetries: 0` (SDK nič neopakuje sám) a opakovanie
// rieši táto funkcia — IBA pri zjavne prechodnej chybe, keď request nebol
// spracovaný:
//   - 429 rate limit (nie `insufficient_quota`) s krátkym retry-after,
//   - 500 / 502 / 503.
// NEopakuje sa: timeout, abort, prerušené spojenie, 504, 408, 409 a ostatné
// 4xx (nevalidná požiadavka sa opakovaním neopraví, timeout môže byť
// zaúčtovaný). Výsledok nesie počet pokusov pre usage telemetriu.
//
// Bez závislosti na `openai` (testovateľné v Node bez node_modules).
// =============================================================================

export type AiErrorClass = "retryable" | "final" | "maybe_billed";

export type GuardedAiCall<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: unknown; attempts: number; errorClass: AiErrorClass };

export type CostGuardOptions = {
  /** Koľko DODATOČNÝCH pokusov po prvom (0 = žiadny retry). */
  maxRetries: number;
  /** Najdlhšie čakanie pred retry (ms); dlhší retry-after = bez retry. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

type ErrorShape = {
  status?: unknown;
  code?: unknown;
  name?: unknown;
  error?: { code?: unknown; type?: unknown } | null;
  headers?: unknown;
};

function headerValue(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const v = (headers as { get(n: string): string | null }).get(name);
    return typeof v === "string" ? v : null;
  }
  if (typeof headers === "object") {
    const v = (headers as Record<string, unknown>)[name];
    return typeof v === "string" ? v : null;
  }
  return null;
}

export function classifyAiError(error: unknown): AiErrorClass {
  if (!error || typeof error !== "object") return "final";
  const e = error as ErrorShape;
  const name = typeof e.name === "string" ? e.name : "";
  if (/Timeout|Abort/i.test(name)) return "maybe_billed";
  if (name === "APIConnectionError") return "maybe_billed";
  const status = typeof e.status === "number" ? e.status : null;
  if (status === null) return "final";
  if (status === 429) {
    const code = `${typeof e.code === "string" ? e.code : ""} ${typeof e.error?.code === "string" ? e.error.code : ""} ${typeof e.error?.type === "string" ? e.error.type : ""}`;
    return /insufficient_quota|billing/i.test(code) ? "final" : "retryable";
  }
  if (status === 500 || status === 502 || status === 503) return "retryable";
  if (status === 504 || status === 408) return "maybe_billed";
  return "final";
}

/** Čakanie pred retry: retry-after(-ms) z hlavičky, inak 500 ms × 2^n; null = nečakať → neopakovať. */
export function retryDelayMs(error: unknown, attempt: number, maxDelayMs: number): number | null {
  const headers = error && typeof error === "object" ? (error as ErrorShape).headers : undefined;
  const ms = Number(headerValue(headers, "retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms <= maxDelayMs ? ms : null;
  const s = Number(headerValue(headers, "retry-after"));
  if (Number.isFinite(s) && s > 0) return s * 1000 <= maxDelayMs ? s * 1000 : null;
  return Math.min(500 * 2 ** (attempt - 1), maxDelayMs);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function callOpenAiWithCostGuard<T>(
  fn: () => Promise<T>,
  options: CostGuardOptions
): Promise<GuardedAiCall<T>> {
  const maxRetries = Math.max(0, Math.min(2, Math.floor(options.maxRetries)));
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      return { ok: true, value: await fn(), attempts };
    } catch (error) {
      const errorClass = classifyAiError(error);
      if (errorClass !== "retryable" || attempts > maxRetries) {
        return { ok: false, error, attempts, errorClass };
      }
      const delay = retryDelayMs(error, attempts, maxDelayMs);
      if (delay === null) return { ok: false, error, attempts, errorClass };
      await sleep(delay);
    }
  }
}

/**
 * Konfigurácia klientov per flow (SDK retry vždy 0 — opakuje iba guard).
 * Timeouty sú veľkorysé voči dnešnému správaniu (predtým 10 min) a pod
 * limitom behu funkcie / klienta.
 */
export const AI_CALL_POLICY = {
  documentScan: { timeoutMs: 90_000, maxRetries: 1 },
  plateFallback: { timeoutMs: 45_000, maxRetries: 0 },
  vehicleRegistrationScan: { timeoutMs: 60_000, maxRetries: 1 },
  voiceTranscription: { timeoutMs: 18_000, maxRetries: 1 },
  intentClassification: { timeoutMs: 12_000, maxRetries: 0 },
} as const;
