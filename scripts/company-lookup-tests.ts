// =============================================================================
// Company lookup PHASE 1 — RPO (primárny zdroj) + RÚZ (DIČ), authz, API.
//
// SPUSTENIE
//   npm run test:company-lookup
//
// Žiadne sieťové volania: registre sú nahradené fixture odpoveďami
// (scripts/fixtures/company-lookup/*.json — reálny tvar RPO/RÚZ z 2026-10-01,
// osoby v nich sú vymyslené). DB-level authz matica je v
// scripts/company-lookup-authz-pglite-tests.ts.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const fixture = (name: string) => read(`scripts/fixtures/company-lookup/${name}`);

const normalize = await import("@/lib/company-lookup/normalize");
const { fetchRegistryJson } = await import("@/lib/company-lookup/http");
const { createRpoProvider, pickCurrent } = await import("@/lib/company-lookup/providers/rpo");
const { createRuzProvider } = await import("@/lib/company-lookup/providers/ruz");
const { createCompanyLookupService } = await import("@/lib/company-lookup/service");
const { guardCompanyLookup } = await import("@/lib/company-lookup/guard");
const { createCompanyLookupHandlers } = await import("@/lib/company-lookup/handlers");
const { applyCompanyDetailToForm, findPartnerWithIco } = await import("@/lib/company-lookup/prefill");
const sk = (await import("@/lib/i18n/dictionaries/sk")).default as Record<string, unknown>;
const en = (await import("@/lib/i18n/dictionaries/en")).default as Record<string, unknown>;
const de = (await import("@/lib/i18n/dictionaries/de")).default as Record<string, unknown>;

type CompanyDetail = import("@/lib/company-lookup/types").CompanyDetail;

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Falošný register
// -----------------------------------------------------------------------------
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: URL[] = [];
  const impl = async (input: string, init: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    return handler(url, init);
  };
  return { impl, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Register, ktorý odpovie až po abort-e (simulovaný timeout). */
const hangUntilAbort: Handler = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

function rpoRegistry(overrides: Partial<Record<"searchIco" | "searchName" | "entity", Handler>> = {}) {
  return fakeFetch((url, init) => {
    assert.equal(url.hostname, "api.statistics.sk");
    if (url.pathname === "/rpo/v1/search" && url.searchParams.has("identifier")) {
      if (overrides.searchIco) return overrides.searchIco(url, init);
      const ico = url.searchParams.get("identifier");
      if (ico === "31322832") return json(fixture("rpo-search-ico-31322832.json"));
      if (ico === "35953039") return json(fixture("rpo-search-ico-35953039-terminated.json"));
      return json({ results: [], license: "cc-by" });
    }
    if (url.pathname === "/rpo/v1/search" && url.searchParams.has("fullName")) {
      if (overrides.searchName) return overrides.searchName(url, init);
      return json(fixture("rpo-search-name-slovnaft.json"));
    }
    if (url.pathname.startsWith("/rpo/v1/entity/")) {
      if (overrides.entity) return overrides.entity(url, init);
      if (url.pathname === "/rpo/v1/entity/1003617") return json(fixture("rpo-entity-1003617.json"));
      return json({}, 404);
    }
    return json({}, 404);
  });
}

function ruzRegistry(mode: "ok" | "missing" | "down" | "ambiguous" | "malformed" | "throws" = "ok") {
  return fakeFetch((url) => {
    assert.equal(url.hostname, "www.registeruz.sk");
    if (mode === "down") return json({ error: "x" }, 503);
    if (mode === "throws") throw new TypeError("network down");
    if (url.pathname === "/cruz-public/api/uctovne-jednotky") {
      if (mode === "missing") return json({ id: [], existujeDalsieId: false });
      if (mode === "malformed") return json({ id: "449752" });
      if (mode === "ambiguous") return json({ id: [449752, 449753] });
      return json(fixture("ruz-list-31322832.json"));
    }
    if (url.pathname === "/cruz-public/api/uctovna-jednotka") {
      const id = url.searchParams.get("id");
      if (id === "449752") return json(fixture("ruz-detail-449752.json"));
      if (id === "1051838") return json(fixture("ruz-detail-1051838-deleted.json"));
      if (id === "449753") return json({ id: 449753, ico: "31322832", dic: "2020999999" });
    }
    return json({}, 404);
  });
}

const FIXED_NOW = () => new Date("2026-10-01T12:00:00.000Z");

// =============================================================================
// 1. Normalizácia
// =============================================================================
await check("NORMALIZE: IČO kanonicky 8 číslic, nuly zľava, medzery povolené", () => {
  assert.equal(normalize.canonicalIco("31322832"), "31322832");
  assert.equal(normalize.canonicalIco(" 31 322 832 "), "31322832");
  assert.equal(normalize.canonicalIco("151742"), "00151742");
  assert.equal(normalize.canonicalIco("00151742"), "00151742");
  assert.equal(normalize.canonicalIco("12345"), null, "menej ako 6 číslic");
  assert.equal(normalize.canonicalIco("123456789"), null, "viac ako 8 číslic");
  assert.equal(normalize.canonicalIco("3132283a"), null);
  assert.equal(normalize.canonicalIco("31-322-832"), null, "pomlčky sa ne'opravujú'");
  assert.equal(normalize.canonicalIco("00000000"), null);
  assert.equal(normalize.canonicalIco(31322832 as unknown as string), null);
});

await check("NORMALIZE: kontrolná číslica IČO je iba informácia", () => {
  assert.equal(normalize.icoChecksumValid("31322832"), true);
  assert.equal(normalize.icoChecksumValid("35953039"), true);
  assert.equal(normalize.icoChecksumValid("31322833"), false);
  // Neplatná checksum nebráni vyhľadaniu ani kanonizácii.
  assert.equal(normalize.canonicalIco("31322833"), "31322833");
  assert.deepEqual(normalize.parseLookupQuery("31322833"), { kind: "ico", ico: "31322833" });
});

await check("NORMALIZE: DIČ presne 10 číslic alebo null", () => {
  assert.equal(normalize.canonicalDic("2020372640"), "2020372640");
  assert.equal(normalize.canonicalDic("2020 372 640"), "2020372640");
  assert.equal(normalize.canonicalDic("SK2020372640"), null);
  assert.equal(normalize.canonicalDic("202037264"), null);
  assert.equal(normalize.canonicalDic(""), null);
  assert.equal(normalize.canonicalDic(null), null);
});

await check("NORMALIZE: dopyt — číslice = IČO, inak názov (min 3 znaky)", () => {
  assert.deepEqual(normalize.parseLookupQuery("31 322 832"), { kind: "ico", ico: "31322832" });
  assert.deepEqual(normalize.parseLookupQuery("12345"), { kind: "error", code: "QUERY_TOO_SHORT" });
  assert.deepEqual(normalize.parseLookupQuery("123456789"), { kind: "error", code: "INVALID_ICO" });
  assert.deepEqual(normalize.parseLookupQuery("ab"), { kind: "error", code: "QUERY_TOO_SHORT" });
  assert.deepEqual(normalize.parseLookupQuery("   "), { kind: "error", code: "QUERY_TOO_SHORT" });
  assert.deepEqual(normalize.parseLookupQuery("Slov"), { kind: "name", name: "Slov" });
  assert.deepEqual(normalize.parseLookupQuery("x".repeat(101)), { kind: "error", code: "INVALID_QUERY" });
  assert.deepEqual(normalize.parseLookupQuery(undefined), { kind: "error", code: "INVALID_QUERY" });
  // Riadiace znaky sa zahodia, text sa inak nemení.
  assert.deepEqual(normalize.parseLookupQuery("Slov\u0000naft‮"), { kind: "name", name: "Slov naft" });
});

await check("NORMALIZE: registrový text — iba bezpečné očistenie, žiadne opravy", () => {
  assert.equal(normalize.cleanRegistryText("  SLOVNAFT ,  a.s. "), "SLOVNAFT , a.s.", "medzera pred čiarkou ostáva (je v registri)");
  assert.equal(normalize.cleanRegistryText("A\u0007B​C"), "A B C");
  assert.equal(normalize.cleanRegistryText(42), null);
  assert.equal(normalize.cleanRegistryText("x".repeat(400))?.length, 300);
  assert.equal(normalize.isoDateOrNull("2013-01-01"), "2013-01-01");
  assert.equal(normalize.isoDateOrNull("1.1.2013"), null);
});

// =============================================================================
// 2. HTTP vrstva: SSRF allowlist, timeout, strop veľkosti, formát
// =============================================================================
await check("HTTP: iba pevné https hosty registrov — iné URL sa nikdy nezavolajú", async () => {
  const { impl, calls } = fakeFetch(() => json({}));
  for (const href of [
    "https://evil.example/rpo/v1/search",
    "http://api.statistics.sk/rpo/v1/search",
    "https://api.statistics.sk:8443/rpo/v1/search",
    "https://user:pw@api.statistics.sk/rpo/v1/search",
    "https://api.statistics.sk.evil.example/x",
    "https://169.254.169.254/latest/meta-data",
  ]) {
    const result = await fetchRegistryJson(new URL(href), { timeoutMs: 100, maxBytes: 1000, fetchImpl: impl });
    assert.equal(result.ok, false, href);
  }
  assert.equal(calls.length, 0);
});

await check("HTTP: redirect=error, no-store, timeout → TIMEOUT", async () => {
  let seen: RequestInit | null = null;
  const { impl } = fakeFetch((url, init) => {
    seen = init;
    return hangUntilAbort(url, init);
  });
  const started = Date.now();
  const result = await fetchRegistryJson(new URL("https://api.statistics.sk/rpo/v1/search?identifier=1"), { timeoutMs: 50, maxBytes: 1000, fetchImpl: impl });
  assert.deepEqual(result, { ok: false, status: null, error: { code: "TIMEOUT", retryable: true } });
  assert.ok(Date.now() - started < 2000);
  assert.equal((seen as RequestInit | null)?.redirect, "error");
  assert.equal((seen as RequestInit | null)?.cache, "no-store");
});

await check("HTTP: strop veľkosti (stream) → TOO_LARGE; ne-JSON / pole → BAD_RESPONSE", async () => {
  const url = new URL("https://api.statistics.sk/rpo/v1/search?identifier=1");
  const big = await fetchRegistryJson(url, { timeoutMs: 1000, maxBytes: 100, fetchImpl: fakeFetch(() => json({ results: "x".repeat(500) })).impl });
  assert.equal(big.ok === false && big.error.code, "TOO_LARGE");
  const html = await fetchRegistryJson(url, { timeoutMs: 1000, maxBytes: 10_000, fetchImpl: fakeFetch(() => new Response("<html>maintenance</html>")).impl });
  assert.equal(html.ok === false && html.error.code, "BAD_RESPONSE");
  const arr = await fetchRegistryJson(url, { timeoutMs: 1000, maxBytes: 10_000, fetchImpl: fakeFetch(() => json([1, 2])).impl });
  assert.equal(arr.ok === false && arr.error.code, "BAD_RESPONSE");
  const err = await fetchRegistryJson(url, { timeoutMs: 1000, maxBytes: 10_000, fetchImpl: fakeFetch(() => json({}, 502)).impl });
  assert.deepEqual(err.ok === false && err.error, { code: "UPSTREAM_HTTP", retryable: true });
  const limited = await fetchRegistryJson(url, { timeoutMs: 1000, maxBytes: 10_000, fetchImpl: fakeFetch(() => json({}, 429)).impl });
  assert.equal(limited.ok === false && limited.error.code, "RATE_LIMITED");
});

// =============================================================================
// 3. RPO provider (fixtures)
// =============================================================================
await check("RPO: pickCurrent — bez validTo, inak najnovšie validFrom", () => {
  assert.deepEqual(pickCurrent([{ value: "A", validFrom: "2000-01-01", validTo: "2005-01-01" }, { value: "B", validFrom: "2005-01-02" }]), { value: "B", validFrom: "2005-01-02" });
  assert.deepEqual(pickCurrent([{ value: "A", validFrom: "2000-01-01", validTo: "2005-01-01" }, { value: "B", validFrom: "2003-01-01", validTo: "2012-12-31" }]), { value: "B", validFrom: "2003-01-01", validTo: "2012-12-31" });
  assert.equal(pickCurrent([]), null);
  assert.equal(pickCurrent(["x", null]), null);
});

await check("RPO: search podľa IČO — aktuálny názov, mesto, registryRef, bez onlyActive", async () => {
  const { impl, calls } = rpoRegistry();
  const rpo = createRpoProvider({ fetchImpl: impl, now: FIXED_NOW });
  const result = await rpo.searchByIco("31322832", { limit: 10 });
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.source, "rpo");
  assert.equal(result.authority, "official_registry");
  assert.equal(result.checkedAt, "2026-10-01T12:00:00.000Z");
  assert.deepEqual(result.data, [
    { ico: "31322832", name: "SLOVNAFT, a.s.", city: "Bratislava", status: "active", terminatedOn: null, registryRef: "rpo:1003617" },
  ]);
  assert.equal(calls[0].searchParams.get("identifier"), "31322832");
  assert.equal(calls[0].searchParams.has("onlyActive"), false, "IČO hľadá aj zrušené (používateľ musí vidieť varovanie)");
});

await check("RPO: search podľa názvu — onlyActive=true, poradie, dedupe, limit, zlé záznamy preč", async () => {
  const { impl, calls } = rpoRegistry();
  const rpo = createRpoProvider({ fetchImpl: impl, now: FIXED_NOW });
  const result = await rpo.searchByName("slovnaft", { onlyActive: true, limit: 10 });
  assert.equal(result.status, "VERIFIED");
  assert.equal(calls[0].searchParams.get("fullName"), "slovnaft");
  assert.equal(calls[0].searchParams.get("onlyActive"), "true");
  const names = (result.data ?? []).map((candidate) => candidate.name);
  // Začiatok názvu (aj bez diakritiky) > slovo v názve; zhoda iba v starom názve dostane aktuálny názov.
  assert.deepEqual(names.slice(0, 3).sort(), ["SLOVNAFT, a.s.", "Slovnaft Retail, s.r.o.", "Slovnafť Servis s.r.o."].sort());
  assert.equal(names[3], "MG Slovnaft s.r.o.", "slovo v strede názvu až za začiatkom názvu");
  assert.ok(names.includes("Slovnaft Retail, s.r.o."), "aktuálny názov, nie CONOCO");
  assert.ok(!names.includes("CONOCO Slovakia"));
  assert.ok(!names.includes("Bez platného id"), "záznam bez platného id sa zahodí");
  assert.ok(!names.some((name) => /[\u0000‮]/.test(name)), "riadiace/bidi znaky z registra sa zahodia");
  const limited = await rpo.searchByName("slovnaft", { onlyActive: true, limit: 2 });
  assert.equal(limited.data?.length, 2);
});

await check("RPO: používateľský vstup je iba hodnota parametra (žiadne skladanie URL)", async () => {
  const { impl, calls } = rpoRegistry({ searchName: () => json({ results: [] }) });
  const rpo = createRpoProvider({ fetchImpl: impl, now: FIXED_NOW });
  const evil = "a&identifier=1/../../entity/1?#x";
  const result = await rpo.searchByName(evil, { onlyActive: true, limit: 10 });
  assert.equal(result.status, "NOT_FOUND");
  assert.equal(calls[0].hostname, "api.statistics.sk");
  assert.equal(calls[0].pathname, "/rpo/v1/search");
  assert.equal(calls[0].searchParams.get("fullName"), evil);
  assert.equal(calls[0].searchParams.has("identifier"), false);
});

await check("RPO: detail — adresa, PSČ, krajina, právna forma; štatutári/spoločníci sa NEČÍTAJÚ", async () => {
  const { impl, calls } = rpoRegistry();
  const rpo = createRpoProvider({ fetchImpl: impl, now: FIXED_NOW });
  const result = await rpo.getDetailByIco("31322832");
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.error, null);
  assert.deepEqual(result.data, {
    ico: "31322832",
    name: "SLOVNAFT, a.s.",
    addressLine1: "Vlčie hrdlo 1",
    city: "Bratislava",
    postalCode: "82412",
    countryCode: "SK",
    legalForm: { code: "121", name: "Akciová spoločnosť" },
    status: "active",
    terminatedOn: null,
    establishedOn: "1992-05-01",
    sourceRegister: "Obchodný register",
    registryRef: "rpo:1003617",
    icoChecksumValid: true,
  });
  assert.equal(result.providerRef, "rpo:1003617");
  const serialized = JSON.stringify(result);
  for (const secret of ["Testovací", "Fiktívna", "Tajná", "Testovo", "684757602", "čerpacích", "license"]) {
    assert.ok(!serialized.includes(secret), `výstup nesmie obsahovať: ${secret}`);
  }
  assert.equal(calls[1].pathname, "/rpo/v1/entity/1003617", "id entity pochádza z overenej odpovede registra");
  assert.equal(calls[1].searchParams.get("showHistoricalData"), "false");
});

await check("RPO: zrušený subjekt — status terminated + dátum, názov z posledného záznamu", async () => {
  const { impl } = rpoRegistry();
  const rpo = createRpoProvider({ fetchImpl: impl, now: FIXED_NOW });
  const search = await rpo.searchByIco("35953039", { limit: 10 });
  assert.deepEqual(search.data?.[0], {
    ico: "35953039",
    name: "Slovnaft Petrochemicals, s.r.o.",
    city: "Bratislava",
    status: "terminated",
    terminatedOn: "2013-01-01",
    registryRef: "rpo:423700",
  });
  // Entity endpoint pre 423700 vráti 404 → partial success z výsledku vyhľadávania.
  const detail = await rpo.getDetailByIco("35953039");
  assert.equal(detail.status, "VERIFIED");
  assert.equal(detail.data?.status, "terminated");
  assert.equal(detail.data?.terminatedOn, "2013-01-01");
  assert.equal(detail.data?.addressLine1, "Vlčie hrdlo 4846");
  assert.equal(detail.data?.legalForm, null);
  assert.equal(detail.error?.code, "UPSTREAM_HTTP");
});

await check("RPO: neplatná hodnota termination subjekt neoživí", async () => {
  const raw = JSON.parse(fixture("rpo-search-ico-31322832.json"));
  raw.results[0].termination = "neznámy";
  const { impl } = rpoRegistry({ searchIco: () => json(raw) });
  const result = await createRpoProvider({ fetchImpl: impl }).searchByIco("31322832", { limit: 10 });
  assert.equal(result.data?.[0].status, "terminated");
  assert.equal(result.data?.[0].terminatedOn, null);
});

await check("RPO: obec bez ulice + súpisné číslo → 'Obec 152'", async () => {
  const { impl } = rpoRegistry({
    searchIco: () =>
      json({
        results: [
          {
            id: 777,
            identifiers: [{ value: "12345678", validFrom: "2015-01-01" }],
            fullNames: [{ value: "MG Slovnaft s.r.o.", validFrom: "2015-01-01" }],
            addresses: [{ validFrom: "2015-01-01", regNumber: 152, postalCodes: ["90001"], municipality: { value: "Malá Obec" }, country: { code: "999" } }],
          },
        ],
      }),
    entity: () => json({}, 500),
  });
  const detail = await createRpoProvider({ fetchImpl: impl }).getDetailByIco("12345678");
  assert.equal(detail.data?.addressLine1, "Malá Obec 152");
  assert.equal(detail.data?.countryCode, null, "neznámy kód krajiny sa nehádá");
  assert.equal(detail.data?.icoChecksumValid, normalize.icoChecksumValid("12345678"));
});

await check("RPO: IČO v odpovedi nesedí s dopytom → NOT_FOUND (fail closed)", async () => {
  const { impl } = rpoRegistry({ searchIco: () => json(fixture("rpo-search-ico-31322832.json")) });
  const rpo = createRpoProvider({ fetchImpl: impl });
  assert.equal((await rpo.searchByIco("35953039", { limit: 10 })).status, "NOT_FOUND");
  assert.equal((await rpo.getDetailByIco("35953039")).status, "NOT_FOUND");
});

await check("RPO: viac aktívnych subjektov s jedným IČO → AMBIGUOUS, žiadny detail", async () => {
  const raw = JSON.parse(fixture("rpo-search-ico-31322832.json"));
  raw.results.push({ ...raw.results[0], id: 9999999 });
  const { impl } = rpoRegistry({ searchIco: () => json(raw) });
  const detail = await createRpoProvider({ fetchImpl: impl }).getDetailByIco("31322832");
  assert.equal(detail.status, "UNAVAILABLE");
  assert.equal(detail.error?.code, "AMBIGUOUS");
  assert.equal(detail.data, null);
});

await check("RPO: malformed upstream → UNAVAILABLE / BAD_RESPONSE (fail closed)", async () => {
  for (const body of [{ results: "x" }, { items: [] }, { results: [{ id: "x" }, { foo: 1 }] }, "not json"]) {
    const { impl } = rpoRegistry({ searchName: () => json(body), searchIco: () => json(body) });
    const rpo = createRpoProvider({ fetchImpl: impl });
    const byName = await rpo.searchByName("slovnaft", { onlyActive: true, limit: 10 });
    assert.equal(byName.status, "UNAVAILABLE", JSON.stringify(body));
    assert.equal(byName.error?.code, "BAD_RESPONSE");
    assert.equal(byName.data, null);
    assert.equal((await rpo.getDetailByIco("31322832")).status, "UNAVAILABLE");
  }
  // Prázdne results je platná odpoveď (nič sa nenašlo), nie chyba.
  const { impl } = rpoRegistry({ searchName: () => json({ results: [] }) });
  assert.equal((await createRpoProvider({ fetchImpl: impl }).searchByName("zzz", { onlyActive: true, limit: 10 })).status, "NOT_FOUND");
});

await check("RPO: timeout providera → UNAVAILABLE / TIMEOUT", async () => {
  const { impl } = rpoRegistry({ searchName: hangUntilAbort, searchIco: hangUntilAbort });
  const rpo = createRpoProvider({ fetchImpl: impl, timeouts: { searchMs: 30, detailMs: 30 } });
  const result = await rpo.searchByName("slovnaft", { onlyActive: true, limit: 10 });
  assert.equal(result.status, "UNAVAILABLE");
  assert.deepEqual(result.error, { code: "TIMEOUT", retryable: true });
  assert.equal((await rpo.getDetailByIco("31322832")).error?.code, "TIMEOUT");
});

await check("RPO: entity detail v neočakávanom tvare → partial (dáta z vyhľadávania)", async () => {
  const { impl } = rpoRegistry({ entity: () => json({ id: 1003617, identifiers: [{ value: "99999999" }], fullNames: [{ value: "Iný" }] }) });
  const detail = await createRpoProvider({ fetchImpl: impl }).getDetailByIco("31322832");
  assert.equal(detail.status, "VERIFIED");
  assert.equal(detail.data?.name, "SLOVNAFT, a.s.");
  assert.equal(detail.data?.legalForm, null);
  assert.equal(detail.error?.code, "BAD_RESPONSE");
});

// =============================================================================
// 4. RÚZ enrichment (iba DIČ)
// =============================================================================
await check("RÚZ: DIČ podľa IČO; ZMAZANÉ záznamy sa ignorujú", async () => {
  const { impl, calls } = ruzRegistry("ok");
  const result = await createRuzProvider({ fetchImpl: impl, now: FIXED_NOW }).getDicByIco("31322832");
  assert.equal(result.status, "VERIFIED");
  assert.deepEqual(result.data, { dic: "2020372640", ambiguous: false });
  assert.equal(result.source, "ruz");
  assert.equal(calls[0].searchParams.get("ico"), "31322832");
  assert.equal(calls[0].searchParams.get("zmenene-od"), "2000-01-01");
  assert.ok(calls.length <= 4, "strop počtu detailov");
});

await check("RÚZ: subjekt v RÚZ nie je → NOT_FOUND, dic null (bez chyby)", async () => {
  const result = await createRuzProvider({ fetchImpl: ruzRegistry("missing").impl }).getDicByIco("31322832");
  assert.equal(result.status, "NOT_FOUND");
  assert.deepEqual(result.data, { dic: null, ambiguous: false });
  assert.equal(result.error, null);
});

await check("RÚZ: dve rôzne DIČ → ambiguous, dic null", async () => {
  const result = await createRuzProvider({ fetchImpl: ruzRegistry("ambiguous").impl }).getDicByIco("31322832");
  assert.deepEqual(result.data, { dic: null, ambiguous: true });
});

await check("RÚZ: výpadok / malformed / výnimka → UNAVAILABLE", async () => {
  for (const mode of ["down", "malformed", "throws"] as const) {
    const result = await createRuzProvider({ fetchImpl: ruzRegistry(mode).impl }).getDicByIco("31322832");
    assert.equal(result.status, "UNAVAILABLE", mode);
    assert.equal(result.data, null);
  }
  const slow = fakeFetch(hangUntilAbort);
  const timedOut = await createRuzProvider({ fetchImpl: slow.impl, timeoutMs: 30 }).getDicByIco("31322832");
  assert.equal(timedOut.error?.code, "TIMEOUT");
});

await check("RÚZ: záznam s iným IČO sa nepoužije", async () => {
  const { impl } = fakeFetch((url) =>
    url.pathname.endsWith("uctovne-jednotky") ? json({ id: [1] }) : json({ id: 1, ico: "99999999", dic: "2020372640" })
  );
  const result = await createRuzProvider({ fetchImpl: impl }).getDicByIco("31322832");
  assert.equal(result.status, "NOT_FOUND");
  assert.equal(result.data?.dic, null);
});

// =============================================================================
// 5. Service: partial success, cache, circuit breaker, logy
// =============================================================================
function makeService(opts: { rpo?: ReturnType<typeof rpoRegistry>; ruz?: ReturnType<typeof ruzRegistry>; limits?: { perUserPerMinute: number; perCompanyPerHour: number } } = {}) {
  const rpoFetch = opts.rpo ?? rpoRegistry();
  const ruzFetch = opts.ruz ?? ruzRegistry("ok");
  const logs: unknown[] = [];
  let clock = Date.parse("2026-10-01T12:00:00.000Z");
  const service = createCompanyLookupService({
    rpo: createRpoProvider({ fetchImpl: rpoFetch.impl, now: () => new Date(clock), timeouts: { searchMs: 30, detailMs: 30 } }),
    ruz: createRuzProvider({ fetchImpl: ruzFetch.impl, now: () => new Date(clock), timeoutMs: 30 }),
    now: () => clock,
    log: (event) => logs.push(event),
    limits: opts.limits,
  });
  return { service, logs, rpoFetch, ruzFetch, advance: (ms: number) => (clock += ms) };
}

await check("SERVICE: RPO + RÚZ OK → úplný detail s DIČ", async () => {
  const { service } = makeService();
  const outcome = await service.detail("31322832");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.body.company.dic, "2020372640");
  assert.deepEqual(outcome.body.sources, [
    { id: "rpo", status: "VERIFIED" },
    { id: "ruz", status: "VERIFIED" },
  ]);
  assert.deepEqual(outcome.body.warnings, []);
  assert.equal(outcome.body.checkedAt, "2026-10-01T12:00:00.000Z");
});

await check("SERVICE: RPO success + RÚZ missing = partial success (dic null, varovanie)", async () => {
  const { service } = makeService({ ruz: ruzRegistry("missing") });
  const outcome = await service.detail("31322832");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.body.company.dic, null);
  assert.equal(outcome.body.company.name, "SLOVNAFT, a.s.");
  assert.deepEqual(outcome.body.warnings, ["RUZ_NOT_FOUND"]);
  assert.deepEqual(outcome.body.sources[1], { id: "ruz", status: "NOT_FOUND" });
});

await check("SERVICE: RÚZ výpadok/výnimka → stále 200, RUZ_UNAVAILABLE, bez cache", async () => {
  for (const mode of ["down", "throws"] as const) {
    const { service, rpoFetch } = makeService({ ruz: ruzRegistry(mode) });
    const first = await service.detail("31322832");
    assert.ok(first.ok, mode);
    if (!first.ok) return;
    assert.equal(first.body.company.dic, null);
    assert.deepEqual(first.body.warnings, ["RUZ_UNAVAILABLE"]);
    const callsAfterFirst = rpoFetch.calls.length;
    await service.detail("31322832");
    assert.ok(rpoFetch.calls.length > callsAfterFirst, "čiastočný výsledok sa necacheuje");
  }
});

await check("SERVICE: RPO entity nedostupný → RPO_DETAIL_UNAVAILABLE, legalForm null", async () => {
  const { service } = makeService({ rpo: rpoRegistry({ entity: () => json({}, 503) }) });
  const outcome = await service.detail("31322832");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.body.company.legalForm, null);
  assert.deepEqual(outcome.body.warnings, ["RPO_DETAIL_UNAVAILABLE"]);
});

await check("SERVICE: zrušený subjekt sa vráti (nie chyba) so statusom terminated", async () => {
  const { service } = makeService({ ruz: ruzRegistry("missing") });
  const outcome = await service.detail("35953039");
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.body.company.status, "terminated");
  assert.equal(outcome.body.company.terminatedOn, "2013-01-01");
});

await check("SERVICE: NOT_FOUND → 404, výpadok RPO → 503 (nikdy 'neexistuje')", async () => {
  const notFound = await makeService().service.detail("12345670");
  assert.deepEqual(notFound, { ok: false, status: 404, code: "NOT_FOUND" });
  const down = makeService({ rpo: rpoRegistry({ searchIco: () => json({}, 502), searchName: () => json({}, 502) }) });
  assert.deepEqual(await down.service.detail("31322832"), { ok: false, status: 503, code: "UNAVAILABLE" });
  assert.deepEqual(await down.service.search({ kind: "name", name: "slovnaft" }), { ok: false, status: 503, code: "UNAVAILABLE" });
});

await check("SERVICE: cache — detail 7 dní, vyhľadávanie 10 minút, kľúč bez textu dopytu", async () => {
  const { service, rpoFetch, ruzFetch, advance } = makeService();
  await service.detail("31322832");
  const rpoCalls = rpoFetch.calls.length;
  const ruzCalls = ruzFetch.calls.length;
  advance(6 * 24 * 3600 * 1000);
  const cached = await service.detail("31322832");
  assert.ok(cached.ok);
  assert.equal(rpoFetch.calls.length, rpoCalls);
  assert.equal(ruzFetch.calls.length, ruzCalls);
  advance(2 * 24 * 3600 * 1000);
  await service.detail("31322832");
  assert.ok(rpoFetch.calls.length > rpoCalls, "po 7 dňoch nový dopyt");

  await service.search({ kind: "name", name: "Slovnaft" });
  const searchCalls = rpoFetch.calls.length;
  await service.search({ kind: "name", name: "slovnaft" });
  assert.equal(rpoFetch.calls.length, searchCalls, "rovnaký dopyt (bez ohľadu na veľkosť písmen) z cache");
  advance(11 * 60 * 1000);
  await service.search({ kind: "name", name: "slovnaft" });
  assert.ok(rpoFetch.calls.length > searchCalls);
  const memory = read("lib/company-lookup/service.ts");
  assert.match(memory, /sha256Key\(query\.kind === "ico"/, "kľúč vyhľadávania je hash");
});

await check("SERVICE: circuit breaker po 5 zlyhaniach — register sa ďalej nevolá", async () => {
  const { service, rpoFetch, advance } = makeService({ rpo: rpoRegistry({ searchName: hangUntilAbort }) });
  for (let i = 0; i < 5; i++) await service.search({ kind: "name", name: `slovnaft ${i}` });
  const calls = rpoFetch.calls.length;
  assert.deepEqual(await service.search({ kind: "name", name: "slovnaft x" }), { ok: false, status: 503, code: "UNAVAILABLE" });
  assert.equal(rpoFetch.calls.length, calls);
  advance(61_000);
  await service.search({ kind: "name", name: "slovnaft y" });
  assert.ok(rpoFetch.calls.length > calls, "po cooldowne sa skúsi znova");
});

await check("SERVICE: logy iba technické minimum (bez dopytu, IČO, názvu)", async () => {
  const { service, logs } = makeService({ ruz: ruzRegistry("down") });
  await service.search({ kind: "name", name: "Tajomná Firma" });
  await service.search({ kind: "ico", ico: "31322832" });
  await service.detail("31322832");
  const text = JSON.stringify(logs);
  for (const forbidden of ["Tajomn", "31322832", "SLOVNAFT", "2020372640", "Bratislava"]) {
    assert.ok(!text.includes(forbidden), `log obsahuje ${forbidden}`);
  }
  for (const event of logs as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(event).filter((key) => !["op", "provider", "outcome", "ms", "count", "error"].includes(key)), []);
  }
});

// =============================================================================
// 6. Authz guard (rola z DB, nikdy z požiadavky)
// =============================================================================
const USER = { id: "0f0e0d0c-0b0a-4908-8706-050403020100" };
const COMPANY_A = "a0000000-0000-4000-8000-00000000000a";
const COMPANY_B = "b0000000-0000-4000-8000-00000000000b";

function guardDeps(user: { id: string } | null, financeManage: boolean | "throw", companyId: string | null, calls: string[] = []) {
  return {
    getUser: async () => {
      calls.push("user");
      return user;
    },
    canManageFinance: async () => {
      calls.push("finance");
      if (financeManage === "throw") throw new Error("rpc down");
      return financeManage;
    },
    getActiveCompanyId: async () => {
      calls.push("company");
      return companyId;
    },
  };
}

await check("AUTHZ: 401 bez používateľa — ďalšie RPC sa nevolajú", async () => {
  const calls: string[] = [];
  assert.deepEqual(await guardCompanyLookup(guardDeps(null, true, COMPANY_A, calls)), { ok: false, status: 401, code: "UNAUTHENTICATED" });
  assert.deepEqual(calls, ["user"]);
});

await check("AUTHZ: 403 podľa roly (esblu_my_finance_manage = false: employee, admin bez finance, bez členstva)", async () => {
  const calls: string[] = [];
  assert.deepEqual(await guardCompanyLookup(guardDeps(USER, false, COMPANY_A, calls)), { ok: false, status: 403, code: "FORBIDDEN" });
  assert.deepEqual(calls, ["user", "finance"]);
  assert.deepEqual(await guardCompanyLookup(guardDeps(USER, "throw", COMPANY_A)), { ok: false, status: 403, code: "FORBIDDEN" }, "chyba RPC = fail closed");
  assert.deepEqual(await guardCompanyLookup(guardDeps(USER, true, null)), { ok: false, status: 403, code: "FORBIDDEN" }, "bez aktívnej firmy");
  const throwingUser = { ...guardDeps(USER, true, COMPANY_A), getUser: async () => { throw new Error("jwt"); } };
  assert.deepEqual(await guardCompanyLookup(throwingUser), { ok: false, status: 401, code: "UNAUTHENTICATED" });
});

await check("AUTHZ: finance.manage (owner/accountant/admin s finance.manage) → OK s firmou z DB", async () => {
  assert.deepEqual(await guardCompanyLookup(guardDeps(USER, true, COMPANY_A)), { ok: true, userId: USER.id, companyId: COMPANY_A });
});

await check("AUTHZ: guard = presne esblu_my_finance_manage + esblu_my_active_company_id, bez service_role", () => {
  const server = read("lib/company-lookup/server.ts");
  assert.match(server, /rpc\("esblu_my_finance_manage"\)/);
  assert.match(server, /rpc\("esblu_my_active_company_id"\)/);
  assert.match(server, /return !error && data === true;/, "iba presne true povolí");
  assert.match(server, /getUserScopedSupabaseClient\(token\)/);
  assert.doesNotMatch(server, /supabase-admin|getSupabaseAdmin|SERVICE_ROLE/);
});

// =============================================================================
// 7. HTTP handlery (POST + JSON telo): 401/403/400/429, cross-tenant, no-store
// =============================================================================
function makeHandlers(guard: ReturnType<typeof guardDeps>, opts: Parameters<typeof makeService>[0] = {}) {
  const ctx = makeService(opts);
  const handlers = createCompanyLookupHandlers({ guardDeps: () => guard, service: ctx.service });
  return { handlers, ...ctx };
}
const SEARCH = "https://www.esblu.com/api/company-lookup/search";
const DETAIL_URL = "https://www.esblu.com/api/company-lookup/detail";
/** POST s JSON telom — dopyt/IČO nikdy v URL. */
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const searchReq = (q: unknown) => post(SEARCH, { q });
const detailReq = (ico: unknown) => post(DETAIL_URL, { ico });

await check("API: 401 → {ok:false, code:UNAUTHENTICATED}, register sa nevolá", async () => {
  const { handlers, rpoFetch } = makeHandlers(guardDeps(null, true, COMPANY_A));
  const response = await handlers.search(searchReq("slovnaft"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, code: "UNAUTHENTICATED" });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const detail = await handlers.detail(detailReq("31322832"));
  assert.equal(detail.status, 401);
  assert.equal(rpoFetch.calls.length, 0);
});

await check("API: 403 pre employee / admin bez finance — telo, register ani limit sa nedotknú", async () => {
  const { handlers, rpoFetch, ruzFetch } = makeHandlers(guardDeps(USER, false, COMPANY_A));
  const requests = [searchReq("slovnaft"), searchReq("31322832"), detailReq("31322832")];
  for (const [index, request] of requests.entries()) {
    const response = index === 2 ? await handlers.detail(request) : await handlers.search(request);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, code: "FORBIDDEN" });
    assert.equal(request.bodyUsed, false, "bez oprávnenia sa telo ani neprečíta");
  }
  assert.equal(rpoFetch.calls.length + ruzFetch.calls.length, 0);
});

await check("API: validácia vstupu → 400 s kódom, register sa nevolá", async () => {
  const { handlers, rpoFetch } = makeHandlers(guardDeps(USER, true, COMPANY_A));
  const cases: [Request, string][] = [
    [searchReq("ab"), "QUERY_TOO_SHORT"],
    [searchReq(""), "QUERY_TOO_SHORT"],
    [searchReq("12345"), "QUERY_TOO_SHORT"],
    [searchReq("123456789"), "INVALID_ICO"],
    [searchReq(123), "INVALID_QUERY"],
    [post(SEARCH, {}), "INVALID_QUERY"],
    [post(SEARCH, [1]), "INVALID_QUERY"],
    [post(SEARCH, "{not json"), "INVALID_QUERY"],
    [post(SEARCH, { q: "x".repeat(5000) }), "INVALID_QUERY"],
    [post(SEARCH, { q: "slovnaft" }, { "content-type": "text/plain" }), "INVALID_QUERY"],
    [new Request(SEARCH, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" } }), "INVALID_QUERY"],
  ];
  for (const [request, code] of cases) {
    const response = await handlers.search(request);
    assert.equal(response.status, 400, code);
    assert.deepEqual(await response.json(), { ok: false, code });
  }
  for (const ico of ["", "abc", "123", "31-322-832", "https://evil", 31322832, null]) {
    const response = await handlers.detail(detailReq(ico));
    assert.equal(response.status, 400, String(ico));
    assert.deepEqual(await response.json(), { ok: false, code: "INVALID_ICO" });
  }
  assert.equal(rpoFetch.calls.length, 0);
});

await check("API: query string sa ignoruje — dopyt/IČO iba z tela", async () => {
  const { handlers, rpoFetch } = makeHandlers(guardDeps(USER, true, COMPANY_A));
  const viaQuery = await handlers.search(post(`${SEARCH}?q=slovnaft`, {}));
  assert.equal(viaQuery.status, 400, "?q= v URL sa nečíta ani ako fallback");
  const detailViaQuery = await handlers.detail(post(`${DETAIL_URL}?ico=31322832`, {}));
  assert.equal(detailViaQuery.status, 400);
  assert.equal(rpoFetch.calls.length, 0);
});

await check("API: search úspech — max 10, mode, status, no-store", async () => {
  const many = { results: Array.from({ length: 25 }, (_, i) => ({ id: 1000 + i, identifiers: [{ value: String(31000000 + i) }], fullNames: [{ value: `Slovnaft ${i}` }] })) };
  const { handlers } = makeHandlers(guardDeps(USER, true, COMPANY_A), { rpo: rpoRegistry({ searchName: () => json(many) }) });
  const response = await handlers.search(searchReq("slovnaft"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "name");
  assert.equal(body.status, "VERIFIED");
  assert.equal(body.results.length, 10);
  const ico = await (await handlers.search(searchReq("31 322 832"))).json();
  assert.equal(ico.mode, "ico");
  const charset = await handlers.search(post(SEARCH, { q: "slovnaft" }, { "content-type": "application/json; charset=utf-8" }));
  assert.equal(charset.status, 200);
});

await check("API: detail — RPO success + RÚZ missing = 200 partial", async () => {
  const { handlers } = makeHandlers(guardDeps(USER, true, COMPANY_A), { ruz: ruzRegistry("missing") });
  const response = await handlers.detail(detailReq("31322832"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.equal(body.company.ico, "31322832");
  assert.equal(body.company.dic, null);
  assert.deepEqual(body.warnings, ["RUZ_NOT_FOUND"]);
});

await check("API: výpadok registra → 503 UNAVAILABLE; neexistujúce IČO → 404", async () => {
  const down = makeHandlers(guardDeps(USER, true, COMPANY_A), { rpo: rpoRegistry({ searchIco: hangUntilAbort, searchName: hangUntilAbort }) });
  const response = await down.handlers.search(searchReq("slovnaft"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, code: "UNAVAILABLE" });
  const nf = makeHandlers(guardDeps(USER, true, COMPANY_A));
  assert.equal((await nf.handlers.detail(detailReq("12345670"))).status, 404);
});

await check("API: rate limit server-side per používateľ aj per firma → 429", async () => {
  const limits = { perUserPerMinute: 3, perCompanyPerHour: 5 };
  const { handlers, advance } = makeHandlers(guardDeps(USER, true, COMPANY_A), { limits });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await handlers.search(searchReq(`slovnaft${i}`))).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  const limited = await handlers.search(searchReq("slovnaft"));
  assert.deepEqual(await limited.json(), { ok: false, code: "RATE_LIMITED" });
  advance(61_000);
  assert.equal((await handlers.detail(detailReq("31322832"))).status, 200);
});

await check("API cross-tenant: firma iba z DB; polia/hlavičky požiadavky sa ignorujú; buckety oddelené", async () => {
  const limits = { perUserPerMinute: 100, perCompanyPerHour: 2 };
  const ctx = makeService({ limits });
  let tenant = COMPANY_A;
  let user = USER;
  const handlers = createCompanyLookupHandlers({ guardDeps: () => guardDeps(user, true, tenant), service: ctx.service });
  const spoof = (q: string) =>
    post(`${SEARCH}?companyId=${COMPANY_B}`, { q, companyId: COMPANY_B, company_id: COMPANY_B, role: "owner" }, { "x-company-id": COMPANY_B, "x-esblu-role": "owner" });
  assert.equal((await handlers.search(spoof("slovnaft"))).status, 200);
  assert.equal((await handlers.search(spoof("slovnaft"))).status, 200);
  assert.equal((await handlers.search(spoof("slovnaft"))).status, 429, "firma A vyčerpaná, aj keď požiadavka tvrdí firmu B");
  tenant = COMPANY_B;
  user = { id: "1f0e0d0c-0b0a-4908-8706-050403020100" };
  assert.equal((await handlers.search(spoof("slovnaft"))).status, 200, "firma B má vlastný bucket");
  const handlerSource = read("lib/company-lookup/handlers.ts");
  assert.doesNotMatch(handlerSource, /searchParams|req\.url|new URL\(/, "handler nečíta URL vôbec");
  assert.doesNotMatch(handlerSource, /body\.(company|role|user)/i);
  for (const m of handlerSource.matchAll(/headers\.get\("([^"]+)"\)/g)) assert.ok(["content-type", "content-length"].includes(m[1]), m[1]);
  for (const m of handlerSource.matchAll(/(?<!req\.)\bbody\.([a-zA-Z_]+)/g)) assert.ok(["q", "ico"].includes(m[1]), `telo: ${m[1]}`);
  const body = await (await handlers.detail(detailReq("31322832"))).json();
  assert.ok(!JSON.stringify(body).includes(COMPANY_B) && !JSON.stringify(body).includes(user.id), "odpoveď bez tenantových údajov");
});

await check("API: routes iba POST, klient posiela JSON telo, nič v URL", () => {
  for (const file of ["app/api/company-lookup/search/route.ts", "app/api/company-lookup/detail/route.ts"]) {
    const source = read(file);
    assert.match(source, /export async function POST\(req: Request\)/, file);
    assert.doesNotMatch(source, /export (async )?function GET|export const GET/, `${file}: GET → 405`);
  }
  const client = read("lib/company-lookup/client.ts");
  assert.match(client, /method: "POST"/);
  assert.match(client, /"Content-Type": "application\/json"/);
  assert.match(client, /body: JSON\.stringify\(payload\)/);
  assert.match(client, /postJson<CompanySearchResponseBody>\("\/api\/company-lookup\/search", \{ q: query \}/);
  assert.match(client, /postJson<CompanyDetailResponseBody>\("\/api\/company-lookup\/detail", \{ ico \}/);
  assert.doesNotMatch(client, /URLSearchParams|\?q=|\?ico=|company-lookup\/[a-z]+\?/);
  // CORS (mobil): POST a content-type sú povolené centrálne.
  const cors = read("lib/cors.ts");
  assert.match(cors, /CORS_ALLOWED_METHODS = "[^"]*POST/);
  assert.match(cors, /"content-type"/);
});

// =============================================================================
// 8. Predvyplnenie, duplicitné IČO, ručné zadanie
// =============================================================================
const DETAIL: CompanyDetail = {
  ico: "31322832",
  name: "SLOVNAFT, a.s.",
  dic: "2020372640",
  addressLine1: "Vlčie hrdlo 1",
  city: "Bratislava",
  postalCode: "82412",
  countryCode: "SK",
  legalForm: { code: "121", name: "Akciová spoločnosť" },
  status: "active",
  terminatedOn: null,
  establishedOn: "1992-05-01",
  sourceRegister: "Obchodný register",
  registryRef: "rpo:1003617",
  icoChecksumValid: true,
};
const { EMPTY_BUSINESS_PARTNER_FORM, validateBusinessPartnerForm } = await import("@/lib/business-partners");

await check("PREFILL: registrové polia sa prepíšu, ostatné ostanú; payload prejde existujúcou validáciou", () => {
  const form = { ...EMPTY_BUSINESS_PARTNER_FORM, email: "fakturacia@example.sk", iban: "SK3112000000198742637541", address_line2: "stará" };
  const next = applyCompanyDetailToForm(form, DETAIL);
  assert.equal(next.legal_name, "SLOVNAFT, a.s.");
  assert.equal(next.ico, "31322832");
  assert.equal(next.dic, "2020372640");
  assert.equal(next.address_line1, "Vlčie hrdlo 1");
  assert.equal(next.address_line2, "");
  assert.equal(next.city, "Bratislava");
  assert.equal(next.postal_code, "82412");
  assert.equal(next.country_code, "SK");
  assert.equal(next.email, "fakturacia@example.sk");
  assert.equal(next.iban, "SK3112000000198742637541");
  assert.equal(next.legal_registration_id, "", "IČO sa automaticky nestotožňuje s EN16931 BT-30");
  assert.equal(form.legal_name, "", "pôvodný objekt sa nemení");
  const { errors, payload } = validateBusinessPartnerForm(next);
  assert.deepEqual(errors, []);
  assert.equal(payload?.ico, "31322832");
});

await check("PREFILL: zmena subjektu vyprázdni IČ DPH a chýbajúce registrové polia", () => {
  const form = { ...EMPTY_BUSINESS_PARTNER_FORM, ico: "35953039", ic_dph: "SK2020999999", vat_identifier: "SK2020999999", dic: "2020999999", city: "Košice" };
  const next = applyCompanyDetailToForm(form, { ...DETAIL, dic: null, city: null });
  assert.equal(next.ic_dph, "");
  assert.equal(next.vat_identifier, "");
  assert.equal(next.dic, "", "DIČ inej firmy nesmie ostať");
  assert.equal(next.city, "");
  const same = applyCompanyDetailToForm({ ...EMPTY_BUSINESS_PARTNER_FORM, ico: "31 322 832", ic_dph: "SK2020372640" }, DETAIL);
  assert.equal(same.ic_dph, "SK2020372640", "ten istý subjekt: ručne zadané IČ DPH ostáva");
});

await check("DUPLICATE IČO: kanonické porovnanie voči existujúcim partnerom", () => {
  const partners = [
    { id: "p1", ico: "31 322 832", legal_name: "Slovnaft" },
    { id: "p2", ico: null, legal_name: "Bez IČO" },
    { id: "p3", ico: "00151742", legal_name: "Úrad" },
  ];
  assert.equal(findPartnerWithIco(partners, "31322832")?.id, "p1");
  assert.equal(findPartnerWithIco(partners, "151742")?.id, "p3");
  assert.equal(findPartnerWithIco(partners, "31322832", "p1"), null, "editovaný partner sa neráta");
  assert.equal(findPartnerWithIco(partners, ""), null);
  assert.equal(findPartnerWithIco(partners, "35953039"), null);
});

await check("DUPLICATE IČO flow: faktúra ponúkne existujúceho partnera, DB constraint je druhá poistka", () => {
  const panel = read("app/components/company-lookup/NewPartnerFromRegistry.tsx");
  assert.match(panel, /findPartnerWithIco\(partners, form\.ico\)/);
  assert.match(panel, /existing !== null/, "vytvorenie je pri duplicite zablokované");
  assert.match(panel, /onSelectExisting\(existing\)/);
  assert.match(panel, /BUSINESS_PARTNER_DUPLICATE_ICO_ERROR/);
  assert.match(panel, /createBusinessPartner\(companyId, userId, payload\)/, "existujúca cesta (RLS)");
  assert.match(panel, /validateBusinessPartnerForm\(form\)/);
  assert.match(read("lib/business-partners.ts"), /business_partners_company_ico_unique/);
  const invoice = read("app/faktury/new/page.tsx");
  assert.match(invoice, /<select[\s\S]*customerId[\s\S]*companyLookup\.invoice\.newFromRegistry/, "pôvodný select ostáva");
  assert.match(invoice, /setCustomerId\(created\.id\)/, "nový partner sa automaticky vyberie");
  assert.match(invoice, /setCustomerId\(existing\.id\)/);
  const partnersPage = read("app/obchodni-partneri/page.tsx");
  assert.match(partnersPage, /findPartnerWithIco\(partners, form\.ico, editingId\)/);
  assert.match(partnersPage, /BUSINESS_PARTNER_DUPLICATE_ICO_ERROR/);
});

await check("MANUAL FALLBACK: lookup nikdy neblokuje formulár; ukladá iba človek", () => {
  const page = read("app/obchodni-partneri/page.tsx");
  // Polia formulára sú stále obyčajné editovateľné inputy naviazané na form.*.
  for (const field of ["legal_name", "ico", "dic", "ic_dph", "address_line1", "city", "postal_code", "country_code"]) {
    assert.match(page, new RegExp(`value=\\{form\\.${field}\\}`), field);
  }
  assert.match(page, /function handleRegistrySelect[\s\S]*?setForm\(\(previous\) => applyCompanyDetailToForm\(previous, detail\.company\)\)/);
  const selectBody = /function handleRegistrySelect[\s\S]*?\n  }\n/.exec(page)?.[0] ?? "";
  assert.doesNotMatch(selectBody, /createBusinessPartner|updateBusinessPartner|handleSubmit/, "výber z registra nič neukladá");
  const combo = read("app/components/company-lookup/CompanyLookupCombobox.tsx");
  assert.doesNotMatch(combo, /createBusinessPartner|from\("business_partners"\)/);
  assert.match(combo, /DEBOUNCE_MS = 300/);
  assert.match(combo, /new AbortController\(\)/);
  assert.match(combo, /role="combobox"/);
  assert.match(combo, /role="listbox"/);
  assert.match(combo, /aria-activedescendant/);
  assert.match(combo, /aria-live="polite"/);
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) assert.ok(combo.includes(`"${key}"`), key);
  assert.match(combo, /companyLookup\.sourceRpo/, "atribúcia CC BY 4.0 pri návrhoch");
  assert.match(read("app/components/company-lookup/CompanyRegistryNotice.tsx"), /companyLookup\.checkedAt/);
  assert.match(read("app/components/company-lookup/CompanyRegistryNotice.tsx"), /companyLookup\.sourceRuz/);
});

// =============================================================================
// 9. i18n SK/DE/EN
// =============================================================================
await check("I18N: companyLookup — rovnaké kľúče v SK/DE/EN, všetky kódy chýb a varovaní", () => {
  const keys = (value: unknown, prefix = ""): string[] =>
    value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k))
      : [prefix];
  const skKeys = keys(sk.companyLookup).sort();
  assert.deepEqual(keys(en.companyLookup).sort(), skKeys);
  assert.deepEqual(keys(de.companyLookup).sort(), skKeys);
  for (const code of ["UNAUTHENTICATED", "FORBIDDEN", "QUERY_TOO_SHORT", "INVALID_QUERY", "INVALID_ICO", "RATE_LIMITED", "NOT_FOUND", "UNAVAILABLE", "NETWORK"]) {
    assert.ok(skKeys.includes(`errors.${code}`), code);
  }
  for (const warning of ["RPO_DETAIL_UNAVAILABLE", "RUZ_UNAVAILABLE", "RUZ_NOT_FOUND", "DIC_AMBIGUOUS", "ICO_CHECKSUM"]) {
    assert.ok(skKeys.includes(`warnings.${warning}`), warning);
  }
  const skLookup = sk.companyLookup as Record<string, unknown>;
  assert.equal(skLookup.sourceRpo, "Zdroj: Register právnických osôb ŠÚ SR (CC BY 4.0)");
  assert.match(String((en.companyLookup as Record<string, unknown>).sourceRpo), /CC BY 4\.0/);
  assert.match(String((de.companyLookup as Record<string, unknown>).sourceRpo), /CC BY 4\.0/);
});

// =============================================================================
// 10. Statické bezpečnostné invarianty
// =============================================================================
const walk = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    return statSync(path.join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });

await check("SECURITY: server-only, žiadny service_role, žiadne AI, pevné hosty", () => {
  const serverFiles = ["http.ts", "memory.ts", "service.ts", "handlers.ts", "server.ts", "providers/rpo.ts", "providers/ruz.ts"];
  for (const file of serverFiles) {
    assert.match(read(`lib/company-lookup/${file}`), /^import "server-only";/, file);
  }
  const all = [...walk("lib/company-lookup"), ...walk("app/components/company-lookup"), ...walk("app/api/company-lookup")];
  for (const file of all) {
    const source = read(file);
    assert.doesNotMatch(source, /supabase-admin|getSupabaseAdmin|SUPABASE_SERVICE_ROLE_KEY/, file);
    assert.doesNotMatch(source, /from "openai"|lib\/ai|chat\.completions|responses\.create/, file);
    assert.doesNotMatch(source, /localStorage|sessionStorage/, file);
  }
  // Klientské súbory nesmú importovať serverovú vrstvu.
  for (const file of [...walk("app/components/company-lookup"), "lib/company-lookup/client.ts", "lib/company-lookup/prefill.ts", "lib/company-lookup/normalize.ts", "lib/company-lookup/types.ts"]) {
    assert.doesNotMatch(read(file), /company-lookup\/(server|service|handlers|http|memory|providers)/, file);
  }
  const http = read("lib/company-lookup/http.ts");
  assert.match(http, /new Set\(\["api\.statistics\.sk", "www\.registeruz\.sk"\]\)/);
  assert.match(http, /redirect: "error"/);
  for (const provider of ["providers/rpo.ts", "providers/ruz.ts"]) {
    const source = read(`lib/company-lookup/${provider}`);
    assert.doesNotMatch(source, /console\./, `${provider} neloguje`);
    assert.doesNotMatch(source, /`https:\/\/[^`]*\$\{(?!RPO_BASE|RUZ_BASE)/, `${provider}: URL sa neskladá z vstupu`);
  }
});

await check("DATA MINIMIZATION: žiadna DB tabuľka/migrácia, žiadne uloženie surovej odpovede", () => {
  for (const file of walk("supabase/migrations")) {
    assert.doesNotMatch(read(file), /company_lookup/i, file);
  }
  const rpo = read("lib/company-lookup/providers/rpo.ts");
  assert.doesNotMatch(rpo, /statutoryBodies|stakeholders|personName|equities|activities/, "provider tieto polia vôbec nečíta");
});

console.log(`\ncompany-lookup: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
