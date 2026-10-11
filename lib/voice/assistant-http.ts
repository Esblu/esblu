// =============================================================================
// HTTP vrstva hlasového asistenta (voice hardening 2026-10-11).
//
// PREDTÝM: fetch bez časového limitu (relácia mohla ostať navždy v
// „Spracúvam…"), `response.json()` bez ošetrenia (HTML chybová stránka =
// výnimka), 5xx v jednom komponente „nerozumel som", v druhom „spojenie
// zlyhalo", a potvrdenie akcie, ktoré pri 400/500 ohlásilo „Hotovo".
//
// TERAZ: jedna funkcia s časovým limitom, kontrolou offline a jednotnou
// klasifikáciou chýb. Volajúci dostane typovaný výsledok, nikdy technický
// text — kľúč prekladu vyberá failureMessageKey().
//
// OPAKOVANIE: táto vrstva NIKDY sama neopakuje požiadavku. Zápis ide výhradne
// cez jednorazový podpísaný confirmationId (server ho spotrebuje presne raz),
// takže ani ručné „skúsiť znova" nemôže vytvoriť duplicitný zápis.
//
// Čistý modul bez závislosti na prehliadači — `fetchImpl` a `isOnline` sa dajú
// podstrčiť v testoch (scripts/voice-hardening-tests.ts).
// =============================================================================

export type HttpFailureKind =
  | "offline"
  | "timeout"
  | "network"
  | "cancelled"
  | "unauthenticated"
  | "forbidden"
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "unavailable"
  | "server"
  | "invalid_response";

export type JsonResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; kind: HttpFailureKind; status?: number; data?: unknown };

/** Limity (ms). Prepis zvuku je pomalší než textový príkaz. */
export const ASSISTANT_TIMEOUTS = {
  transcribeMs: 20_000,
  intentMs: 20_000,
  executeMs: 25_000,
} as const;

export function classifyHttpStatus(status: number): HttpFailureKind | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 413) return "too_large";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "bad_request";
  return "server";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Kód odpovede, ktorým server hlási vypnutú AI (app/api/assistant/transcribe). */
export const AI_UNAVAILABLE_CODE = "AI_UNAVAILABLE";

function isAiUnavailableBody(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { code?: unknown }).code === AI_UNAVAILABLE_CODE;
}

export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    /** Externé zrušenie (zastavená relácia, odchod zo stránky). */
    signal?: AbortSignal;
    fetchImpl?: FetchLike;
    isOnline?: () => boolean;
  }
): Promise<JsonResult<T>> {
  const online = options.isOnline ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  if (!online()) return { ok: false, kind: "offline" };
  if (options.signal?.aborted) return { ok: false, kind: "cancelled" };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const doFetch = options.fetchImpl ?? (fetch as FetchLike);
    const response = await doFetch(url, { ...init, signal: controller.signal });
    let data: unknown = null;
    let parsed = true;
    try {
      data = await response.json();
    } catch {
      parsed = false;
    }
    const failure = classifyHttpStatus(response.status);
    // 503 + AI_UNAVAILABLE = AI na serveri zámerne vypnutá (napr. staging bez
    // kľúča). Opakovanie nepomôže → volajúci reláciu ukončí s jasným
    // oznámením. Iná 503 (výpadok infraštruktúry) ostáva „server".
    if (failure === "server" && response.status === 503 && isAiUnavailableBody(data)) {
      return { ok: false, kind: "unavailable", status: response.status, data };
    }
    if (failure) return { ok: false, kind: failure, status: response.status, data };
    if (!parsed) return { ok: false, kind: "invalid_response", status: response.status };
    return { ok: true, status: response.status, data: data as T };
  } catch {
    if (timedOut) return { ok: false, kind: "timeout" };
    if (options.signal?.aborted) return { ok: false, kind: "cancelled" };
    return { ok: false, kind: online() ? "network" : "offline" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Kľúč prekladu (namespace search.voice.errors) pre používateľa. Nikdy
 * stavový kód ani telo odpovede.
 */
export function failureMessageKey(kind: HttpFailureKind, phase: "intent" | "execute" | "transcribe" = "intent"): string {
  // Pri potvrdení zápisu, ktorý vypršal alebo spadol spojením, nevieme, či
  // server zápis stihol — povedať „nepodarilo sa" by mohlo viesť k
  // duplicitnému ručnému zadaniu. Používateľ má výsledok skontrolovať.
  if (phase === "execute" && (kind === "timeout" || kind === "network")) return "search.voice.errors.executeUnknown";
  switch (kind) {
    case "offline":
      return "search.voice.errors.offline";
    case "timeout":
      return "search.voice.errors.timeout";
    case "network":
    case "invalid_response":
      return "search.voice.errors.network";
    case "unauthenticated":
      return "search.voice.errors.sessionExpired";
    case "forbidden":
      return "search.voice.states.denied";
    case "too_large":
      return "search.voice.errors.tooLong";
    case "rate_limited":
      return "search.voice.errors.rateLimited";
    case "unavailable":
      return "search.voice.errors.aiUnavailable";
    case "bad_request":
      return phase === "execute" ? "search.voice.errors.confirmationExpired" : "search.errors.commandNotUnderstood";
    case "cancelled":
      return "search.voice.session.cancelled";
    case "server":
    default:
      return "search.voice.errors.server";
  }
}
