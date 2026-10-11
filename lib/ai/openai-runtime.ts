// =============================================================================
// OpenAI runtime helpers (voice E2E hardening, 2026-10-11).
//
// 1) Konfigurácia: staging/preview môže mať OpenAI zámerne vypnuté (bez
//    OPENAI_API_KEY). OpenAI SDK pri chýbajúcom kľúči HÁDŽE už v konštruktore
//    — klient vytvorený na úrovni modulu preto zhodil celý route (500 ešte
//    pred autentifikáciou), vrátane čisto deterministických textových
//    príkazov. Klienti sa preto vytvárajú lenivo a chýbajúci kľúč je
//    explicitný stav „AI nedostupná", nie pád.
// 2) Logovanie: chybová správa OpenAI pri 401 obsahuje maskovaný fragment
//    kľúča („sk-…abcd") a iné chyby môžu niesť časť požiadavky. Do logov ide
//    preto IBA bezpečná metadáta (name/status/code/type) — nikdy message,
//    transcript, audio ani hlavičky.
//
// Bez závislosti na `openai` (testovateľné v Node bez node_modules).
// =============================================================================

/**
 * true iba ak prostredie obsahuje kľúč v tvare OpenAI kľúča („sk-…": sk-proj-,
 * sk-svcacct-, sk-admin- …). Zámerne vypnuté prostredia (staging/preview)
 * mávajú premennú vyplnenú zástupnou hodnotou („disabled", „placeholder"),
 * aby prešiel build ostatných routes — taká hodnota NIE JE konfigurácia a
 * nesmie viesť k volaniu OpenAI (401 → zbytočná retry slučka). Hodnotu
 * kľúča nikdy nevraciame ani nelogujeme.
 */
export function isOpenAiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const key = env.OPENAI_API_KEY;
  return typeof key === "string" && /^sk-[A-Za-z0-9_-]{8,}/.test(key.trim());
}

export type SafeAiErrorMeta = {
  name?: string;
  status?: number;
  code?: string;
  type?: string;
};

/** Bezpečná metadáta chyby na logovanie — bez message, tela, hlavičiek. */
export function safeAiErrorMeta(error: unknown): SafeAiErrorMeta {
  if (!error || typeof error !== "object") return { name: typeof error };
  const e = error as { name?: unknown; status?: unknown; code?: unknown; type?: unknown };
  const meta: SafeAiErrorMeta = {};
  if (typeof e.name === "string") meta.name = e.name.slice(0, 64);
  if (typeof e.status === "number") meta.status = e.status;
  if (typeof e.code === "string") meta.code = e.code.slice(0, 64);
  if (typeof e.type === "string") meta.type = e.type.slice(0, 64);
  return meta;
}

/**
 * Lenivý singleton: factory sa zavolá až pri prvom použití a iba ak je kľúč
 * nastavený. Bez kľúča vracia null (volajúci odpovie „AI nedostupná").
 */
export function lazyAiClient<T>(factory: () => T, env?: Record<string, string | undefined>): () => T | null {
  let instance: T | null = null;
  return () => {
    if (instance) return instance;
    if (!isOpenAiConfigured(env)) return null;
    instance = factory();
    return instance;
  };
}
