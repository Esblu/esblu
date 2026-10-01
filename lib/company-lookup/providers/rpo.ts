import "server-only";

import { fetchRegistryJson, type FetchLike } from "../http.ts";
import {
  canonicalIco,
  cleanRegistryText,
  foldForCompare,
  icoChecksumValid,
  isoDateOrNull,
} from "../normalize.ts";
import type {
  CompanyCandidate,
  CompanyDetail,
  CompanyLegalForm,
  CompanyLookupProvider,
  ProviderError,
  ProviderResult,
} from "../types.ts";

// =============================================================================
// Register právnických osôb (RPO) — Štatistický úrad SR. Primárny zdroj.
// =============================================================================
// Dokumentácia: https://susrrpo.docs.apiary.io
// Licencia: CC BY 4.0 (text licencie prichádza v každej odpovedi) — UI musí
// uviesť zdroj „Register právnických osôb ŠÚ SR (CC BY 4.0)".
//
//   GET /rpo/v1/search?identifier=<IČO>
//   GET /rpo/v1/search?fullName=<text>&onlyActive=true   (fulltext, aj staré názvy)
//   GET /rpo/v1/entity/<id>?showHistoricalData=false&showOrganizationUnits=false
//
// Z odpovede sa berie IBA: id, IČO, aktuálny názov, aktuálna adresa sídla,
// právna forma, dátum vzniku/zániku, názov zdrojového registra. Štatutári,
// spoločníci, ich adresy, predmety činnosti, imanie atď. sa NEČÍTAJÚ a
// nikam nepokračujú (data minimization).
//
// Fail closed: chýbajúce/neplatné jadro (results[], id, IČO, názov) =
// BAD_RESPONSE. Voliteľné polia (adresa, právna forma) s neočakávaným
// tvarom sa iba vynechajú.
// =============================================================================

const RPO_BASE = "https://api.statistics.sk/rpo/v1";
const SEARCH_TIMEOUT_MS = 4000;
const DETAIL_TIMEOUT_MS = 5000;
const SEARCH_MAX_BYTES = 3 * 1024 * 1024;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;

/** Číselník krajín RPO (CL000086, ISO 3166 numeric) → alpha-2. Iba známe kódy. */
const RPO_COUNTRY_NUMERIC_TO_ALPHA2: Record<string, string> = {
  "703": "SK",
  "203": "CZ",
  "348": "HU",
  "040": "AT",
  "616": "PL",
  "804": "UA",
  "276": "DE",
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * Aktuálna položka časovo platného zoznamu RPO: prednostne tá bez validTo
 * (najnovšie validFrom), inak (zaniknutý subjekt) tá s najnovším validFrom.
 */
export function pickCurrent<T extends Json>(items: unknown[]): T | null {
  const valid = items.filter(isObject) as T[];
  if (valid.length === 0) return null;
  const from = (item: Json) => (typeof item.validFrom === "string" ? item.validFrom : "");
  const sorted = [...valid].sort((a, b) => from(b).localeCompare(from(a)));
  return sorted.find((item) => item.validTo === undefined || item.validTo === null) ?? sorted[0];
}

function currentIco(entity: Json): string | null {
  const current = pickCurrent<Json>(asArray(entity.identifiers));
  return current ? canonicalIco(typeof current.value === "string" ? current.value : "") : null;
}

function allIcos(entity: Json): string[] {
  return asArray(entity.identifiers)
    .filter(isObject)
    .map((item) => canonicalIco(typeof item.value === "string" ? item.value : ""))
    .filter((value): value is string => value !== null);
}

function currentName(entity: Json): string | null {
  const current = pickCurrent<Json>(asArray(entity.fullNames));
  return current ? cleanRegistryText(current.value, 250) : null;
}

type RpoAddress = { addressLine1: string | null; city: string | null; postalCode: string | null; countryCode: string | null };

export function currentAddress(entity: Json): RpoAddress {
  const empty = { addressLine1: null, city: null, postalCode: null, countryCode: null };
  const address = pickCurrent<Json>(asArray(entity.addresses));
  if (!address) return empty;

  const street = cleanRegistryText(address.street, 150);
  const building = cleanRegistryText(typeof address.buildingNumber === "number" ? String(address.buildingNumber) : address.buildingNumber, 40);
  const reg = typeof address.regNumber === "number" && Number.isInteger(address.regNumber) && address.regNumber > 0 ? String(address.regNumber) : null;
  const municipality = isObject(address.municipality) ? cleanRegistryText(address.municipality.value, 150) : null;
  const postal = cleanRegistryText(asArray(address.postalCodes).find((value) => typeof value === "string"), 20);
  const countryNumeric = isObject(address.country) && typeof address.country.code === "string" ? address.country.code : null;

  // Súpisné/orientačné číslo: register ich niekedy vedie zvlášť (regNumber +
  // buildingNumber), inak je všetko v buildingNumber ("5538/2A").
  const number = reg && building ? `${reg}/${building}` : reg ?? building;
  // Obce bez ulíc: adresa je "Obec číslo" (bežná SK prax).
  const base = street ?? (number ? municipality : null);
  const line1 = base ? cleanRegistryText(number ? `${base} ${number}` : base, 200) : null;

  return {
    addressLine1: line1,
    city: municipality,
    postalCode: postal,
    countryCode: countryNumeric ? RPO_COUNTRY_NUMERIC_TO_ALPHA2[countryNumeric] ?? null : null,
  };
}

function currentLegalForm(entity: Json): CompanyLegalForm | null {
  const current = pickCurrent<Json>(asArray(entity.legalForms));
  if (!current || !isObject(current.value)) return null;
  const code = typeof current.value.code === "string" && /^\d{1,4}$/.test(current.value.code) ? current.value.code : null;
  const name = cleanRegistryText(current.value.value, 120);
  return code && name ? { code, name } : null;
}

function sourceRegisterName(entity: Json): string | null {
  const source = isObject(entity.sourceRegister) ? entity.sourceRegister : null;
  const value = source && isObject(source.value) ? source.value : null;
  return value ? cleanRegistryText(value.value, 120) : null;
}

/** Jadro entity: bez platného id, IČO a názvu sa záznam NEPOUŽIJE. */
function parseCore(entity: unknown): { id: number; ico: string; name: string; entity: Json } | null {
  if (!isObject(entity)) return null;
  const id = entity.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  const ico = currentIco(entity);
  const name = currentName(entity);
  if (!ico || !name) return null;
  return { id, ico, name, entity };
}

function statusOf(entity: Json): { status: "active" | "terminated"; terminatedOn: string | null } {
  const terminatedOn = isoDateOrNull(entity.termination);
  // Akákoľvek prítomná hodnota termination = zánik; neplatný formát
  // dátumu nesmie subjekt "oživiť".
  const terminated = entity.termination !== undefined && entity.termination !== null;
  return { status: terminated ? "terminated" : "active", terminatedOn };
}

export function parseRpoCandidate(raw: unknown): CompanyCandidate | null {
  const core = parseCore(raw);
  if (!core) return null;
  const { status, terminatedOn } = statusOf(core.entity);
  return {
    ico: core.ico,
    name: core.name,
    city: currentAddress(core.entity).city,
    status,
    terminatedOn,
    registryRef: `rpo:${core.id}`,
  };
}

export function parseRpoDetail(raw: unknown): Omit<CompanyDetail, "dic"> | null {
  const core = parseCore(raw);
  if (!core) return null;
  const address = currentAddress(core.entity);
  const { status, terminatedOn } = statusOf(core.entity);
  return {
    ico: core.ico,
    name: core.name,
    addressLine1: address.addressLine1,
    city: address.city,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    legalForm: currentLegalForm(core.entity),
    status,
    terminatedOn,
    establishedOn: isoDateOrNull(core.entity.establishment),
    sourceRegister: sourceRegisterName(core.entity),
    registryRef: `rpo:${core.id}`,
    icoChecksumValid: icoChecksumValid(core.ico),
  };
}

/** `results` musí byť pole; inak fail closed. */
function parseResults(json: Json): unknown[] | null {
  return Array.isArray(json.results) ? json.results : null;
}

/** Radenie návrhov podľa názvu: začiatok > obsahuje > zhoda iba v starom názve. */
export function rankByName(candidates: CompanyCandidate[], query: string): CompanyCandidate[] {
  const q = foldForCompare(query);
  const score = (candidate: CompanyCandidate) => {
    const name = foldForCompare(candidate.name);
    const activeBonus = candidate.status === "active" ? 0 : 10;
    if (name.startsWith(q)) return 0 + activeBonus;
    if (name.split(/[\s,.-]+/).some((word) => word.startsWith(q))) return 1 + activeBonus;
    if (name.includes(q)) return 2 + activeBonus;
    return 3 + activeBonus;
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .sort((a, b) => a.score - b.score || a.candidate.name.localeCompare(b.candidate.name, "sk") || a.index - b.index)
    .map((entry) => entry.candidate);
}

function dedupeByIco(candidates: CompanyCandidate[]): CompanyCandidate[] {
  const seen = new Map<string, CompanyCandidate>();
  for (const candidate of candidates) {
    const previous = seen.get(candidate.ico);
    // Pri rovnakom IČO (znovupridelenie, staré záznamy) vyhrá aktívny.
    if (!previous || (previous.status === "terminated" && candidate.status === "active")) seen.set(candidate.ico, candidate);
  }
  return [...seen.values()];
}

export type RpoProviderOptions = {
  fetchImpl?: FetchLike;
  now?: () => Date;
  /** Iba pre testy; produkcia používa predvolené hodnoty vyššie. */
  timeouts?: { searchMs?: number; detailMs?: number };
};

export function createRpoProvider(options: RpoProviderOptions = {}): CompanyLookupProvider {
  const now = options.now ?? (() => new Date());
  const searchTimeoutMs = options.timeouts?.searchMs ?? SEARCH_TIMEOUT_MS;
  const detailTimeoutMs = options.timeouts?.detailMs ?? DETAIL_TIMEOUT_MS;

  const result = <T>(status: ProviderResult<T>["status"], data: T | null, error: ProviderError | null, providerRef: string | null = null): ProviderResult<T> => ({
    source: "rpo",
    authority: "official_registry",
    checkedAt: now().toISOString(),
    status,
    data,
    providerRef,
    error,
  });

  async function search(params: URLSearchParams, timeoutMs: number): Promise<{ ok: true; candidates: CompanyCandidate[]; raw: unknown[] } | { ok: false; error: ProviderError }> {
    const url = new URL(`${RPO_BASE}/search`);
    url.search = params.toString();
    const response = await fetchRegistryJson(url, { timeoutMs, maxBytes: SEARCH_MAX_BYTES, fetchImpl: options.fetchImpl });
    if (!response.ok) {
      // RPO pri "nič nenájdené" vracia 200 + prázdne results; 404 berieme ako prázdny výsledok.
      if (response.status === 404) return { ok: true, candidates: [], raw: [] };
      return { ok: false, error: response.error };
    }
    const results = parseResults(response.json);
    if (!results) return { ok: false, error: { code: "BAD_RESPONSE", retryable: false } };
    const candidates = results.map(parseRpoCandidate).filter((value): value is CompanyCandidate => value !== null);
    // Neprázdne results, z ktorých sa nedá použiť ani jeden záznam = zmenený formát.
    if (results.length > 0 && candidates.length === 0) return { ok: false, error: { code: "BAD_RESPONSE", retryable: false } };
    return { ok: true, candidates, raw: results };
  }

  return {
    id: "rpo",
    authority: "official_registry",

    async searchByName(query, { onlyActive, limit }) {
      const params = new URLSearchParams({ fullName: query });
      if (onlyActive) params.set("onlyActive", "true");
      const response = await search(params, searchTimeoutMs);
      if (!response.ok) return result<CompanyCandidate[]>("UNAVAILABLE", null, response.error);
      const ranked = rankByName(dedupeByIco(response.candidates), query).slice(0, limit);
      return result(ranked.length ? "VERIFIED" : "NOT_FOUND", ranked, null);
    },

    async searchByIco(ico, { limit }) {
      if (!canonicalIco(ico)) return result<CompanyCandidate[]>("NOT_FOUND", [], null);
      const response = await search(new URLSearchParams({ identifier: ico }), searchTimeoutMs);
      if (!response.ok) return result<CompanyCandidate[]>("UNAVAILABLE", null, response.error);
      // Register musí vrátiť subjekt s TÝMTO IČO (aj historickým); inak sa zahodí.
      const matching = response.raw
        .filter((raw) => isObject(raw) && allIcos(raw).includes(ico))
        .map(parseRpoCandidate)
        .filter((value): value is CompanyCandidate => value !== null)
        .map((candidate) => ({ ...candidate, ico }));
      const list = dedupeByIco(matching).slice(0, limit);
      return result(list.length ? "VERIFIED" : "NOT_FOUND", list, null);
    },

    async getDetailByIco(ico) {
      if (!canonicalIco(ico)) return result<Omit<CompanyDetail, "dic">>("NOT_FOUND", null, null);
      const found = await search(new URLSearchParams({ identifier: ico }), searchTimeoutMs);
      if (!found.ok) return result<Omit<CompanyDetail, "dic">>("UNAVAILABLE", null, found.error);

      const matches = found.raw.filter((raw): raw is Json => isObject(raw) && allIcos(raw).includes(ico));
      if (matches.length === 0) return result<Omit<CompanyDetail, "dic">>("NOT_FOUND", null, null);

      const active = matches.filter((raw) => statusOf(raw).status === "active");
      // Viac aktívnych subjektov s jedným IČO = nejednoznačné; radšej nič než zlý partner.
      if (active.length > 1) return result<Omit<CompanyDetail, "dic">>("UNAVAILABLE", null, { code: "AMBIGUOUS", retryable: false });
      const chosen = active[0] ?? matches[0];
      const fromSearch = parseRpoDetail(chosen);
      if (!fromSearch) return result<Omit<CompanyDetail, "dic">>("UNAVAILABLE", null, { code: "BAD_RESPONSE", retryable: false });
      const base = { ...fromSearch, ico, icoChecksumValid: icoChecksumValid(ico) };

      // Detail entity dopĺňa právnu formu (vo výsledku vyhľadávania chýba).
      // Id pochádza z overenej odpovede registra (kladné celé číslo), nie od používateľa.
      const id = Number(base.registryRef.slice("rpo:".length));
      const url = new URL(`${RPO_BASE}/entity/${id}`);
      url.search = new URLSearchParams({ showHistoricalData: "false", showOrganizationUnits: "false" }).toString();
      const detail = await fetchRegistryJson(url, { timeoutMs: detailTimeoutMs, maxBytes: DETAIL_MAX_BYTES, fetchImpl: options.fetchImpl });
      if (!detail.ok) {
        // Partial success: údaje z vyhľadávania sú platné, chýba iba právna forma.
        return result("VERIFIED", base, detail.error, base.registryRef);
      }
      const parsed = parseRpoDetail(detail.json);
      if (!parsed || parsed.registryRef !== base.registryRef || !allIcos(detail.json).includes(ico)) {
        return result("VERIFIED", base, { code: "BAD_RESPONSE", retryable: false }, base.registryRef);
      }
      return result("VERIFIED", { ...parsed, ico, icoChecksumValid: icoChecksumValid(ico) }, null, parsed.registryRef);
    },
  };
}
