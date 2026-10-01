import "server-only";

import { fetchRegistryJson, type FetchLike } from "../http.ts";
import { canonicalDic, canonicalIco } from "../normalize.ts";
import type { CompanyTaxIdEnrichmentProvider, ProviderError, ProviderResult } from "../types.ts";

// =============================================================================
// Register účtovných závierok (RÚZ) — IBA doplnenie DIČ podľa IČO.
// =============================================================================
// Dokumentácia: https://www.registeruz.sk/cruz-public/home/api  (CC0)
//
//   GET /cruz-public/api/uctovne-jednotky?zmenene-od=2000-01-01&ico=<IČO>&max-zaznamov=10
//       → { id: number[], existujeDalsieId: boolean }
//   GET /cruz-public/api/uctovna-jednotka?id=<id>
//       → { ico, dic, nazovUJ, ... } alebo { id, stav: "ZMAZANÉ" }
//
// Pravidlá:
//   - zo záznamu sa číta IBA ico + dic (+ stav), nič iné,
//   - záznam so stavom "ZMAZANÉ" alebo s iným IČO sa ignoruje,
//   - subjekt v RÚZ nie je (časť SZČO) → NOT_FOUND, dic = null; lookup
//     ako celok NIKDY nezlyhá kvôli RÚZ,
//   - viac rôznych DIČ pre jedno IČO → dic = null + ambiguous (žiadne
//     hádanie, ktoré je správne).
// =============================================================================

const RUZ_BASE = "https://www.registeruz.sk/cruz-public/api";
const TIMEOUT_MS = 3500;
const LIST_MAX_BYTES = 64 * 1024;
const DETAIL_MAX_BYTES = 256 * 1024;
/** Strop detailov na jedno IČO (zvyčajne 1–2 záznamy). */
const MAX_DETAILS = 3;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type RuzProviderOptions = {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Iba pre testy. */
  timeoutMs?: number;
};

export function createRuzProvider(options: RuzProviderOptions = {}): CompanyTaxIdEnrichmentProvider {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  type Out = { dic: string | null; ambiguous: boolean };
  const result = (status: ProviderResult<Out>["status"], data: Out | null, error: ProviderError | null): ProviderResult<Out> => ({
    source: "ruz",
    authority: "official_registry",
    checkedAt: now().toISOString(),
    status,
    data,
    providerRef: null,
    error,
  });

  return {
    id: "ruz",
    authority: "official_registry",

    async getDicByIco(ico) {
      if (!canonicalIco(ico)) return result("NOT_FOUND", { dic: null, ambiguous: false }, null);

      const listUrl = new URL(`${RUZ_BASE}/uctovne-jednotky`);
      listUrl.search = new URLSearchParams({ "zmenene-od": "2000-01-01", ico, "max-zaznamov": "10" }).toString();
      const list = await fetchRegistryJson(listUrl, { timeoutMs, maxBytes: LIST_MAX_BYTES, fetchImpl: options.fetchImpl });
      if (!list.ok) return result("UNAVAILABLE", null, list.error);
      if (!Array.isArray(list.json.id)) return result("UNAVAILABLE", null, { code: "BAD_RESPONSE", retryable: false });

      const ids = list.json.id.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
      if (ids.length !== list.json.id.length) return result("UNAVAILABLE", null, { code: "BAD_RESPONSE", retryable: false });
      if (ids.length === 0) return result("NOT_FOUND", { dic: null, ambiguous: false }, null);

      const dics = new Set<string>();
      let usable = 0;
      // Novšie záznamy majú vyššie id — skúšame ich prvé.
      for (const id of [...ids].sort((a, b) => b - a).slice(0, MAX_DETAILS)) {
        const detailUrl = new URL(`${RUZ_BASE}/uctovna-jednotka`);
        detailUrl.search = new URLSearchParams({ id: String(id) }).toString();
        const detail = await fetchRegistryJson(detailUrl, { timeoutMs, maxBytes: DETAIL_MAX_BYTES, fetchImpl: options.fetchImpl });
        if (!detail.ok) return result("UNAVAILABLE", null, detail.error);
        const row = detail.json;
        if (!isObject(row)) continue;
        if (typeof row.stav === "string" && row.stav.toUpperCase().startsWith("ZMAZAN")) continue;
        if (canonicalIco(typeof row.ico === "string" ? row.ico : "") !== ico) continue;
        usable += 1;
        const dic = canonicalDic(row.dic);
        if (dic) dics.add(dic);
      }

      if (usable === 0 || dics.size === 0) return result("NOT_FOUND", { dic: null, ambiguous: false }, null);
      if (dics.size > 1) return result("VERIFIED", { dic: null, ambiguous: true }, { code: "AMBIGUOUS", retryable: false });
      return result("VERIFIED", { dic: [...dics][0], ambiguous: false }, null);
    },
  };
}
