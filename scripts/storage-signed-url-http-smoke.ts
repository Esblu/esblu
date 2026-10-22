// =============================================================================
// Reálny HTTP test podpísaných URL (Supabase Storage) — IBA STAGING
// (`esblu-test`, cjbdijbbcujvmrzezusd). NIKDY produkcia.
//
// Spúšťa ČLOVEK na svojom počítači (Claude nesmie vytvárať účty ani sa
// prihlasovať heslom na vzdialenom hoste). Používa existujúce QA UX fixtures
// (QA UX Firma A / QA UX Firma B, `qa-ux-*@esblu-qa.invalid`) — nič na nich
// nemení: vytvorí JEDEN syntetický PNG (1×1 px, žiadne osobné údaje) ako
// nereferencovaný rozpracovaný upload vlastníka firmy A a na konci ho zmaže
// štandardným flow (storage remove() — politika media_delete_scoped, vetva
// „vlastný rozpracovaný upload“).
//
// Nikdy nevypisuje podpísanú URL, token, heslá, kľúče ani e-maily — iba
// ok/FAIL/info riadky so stavovým kódom, content-type, dĺžkou a TTL.
//
//   node --experimental-strip-types --no-warnings scripts/storage-signed-url-http-smoke.ts
//
// Povinné env:
//   SIGNED_URL_SUPABASE_URL       https://cjbdijbbcujvmrzezusd.supabase.co (iný ref = odmietnuté)
//   SIGNED_URL_ANON_KEY           publishable/anon kľúč STAGINGU
//   SIGNED_URL_SOURCE_A_EMAIL / SIGNED_URL_SOURCE_A_PASSWORD  „A“ = ZDROJOVÝ POUŽÍVATEĽ IBA Z FIRMY A
//       s právom setup uploadu do `vehicle-photos` (owner/admin/employee), NIE nutne skutočný owner.
//       Odporúčaný staging účet: `qa-ux-a-signedurl@esblu-qa.invalid` (admin, iba QA UX Firma A).
//       Starší alias: SIGNED_URL_OWNER_A_EMAIL / SIGNED_URL_OWNER_A_PASSWORD (SOURCE_A má prednosť).
//   SIGNED_URL_FOREIGN_EMAIL / SIGNED_URL_FOREIGN_PASSWORD    „B“ = POUŽÍVATEĽ CUDZEJ FIRMY (iba Firma B),
//       ľubovoľná rola, nie nutne owner. Odporúčaný staging účet: `qa-ux-b-foreign@esblu-qa.invalid`
//       (employee, iba QA UX Firma B). Starší alias: SIGNED_URL_OWNER_B_* (FOREIGN má prednosť).
//   Heslá sú iba lokálne v `Claude outputs/STAGING-QA-signed-url-credentials.txt` (gitignored), nikdy v repe.
//   Guard (pred akýmkoľvek uploadom): A má aktívnu firmu SIGNED_URL_EXPECT_A_COMPANY (default
//   „QA UX Firma A“), B má aktívnu firmu SIGNED_URL_EXPECT_B_COMPANY (default „QA UX Firma B“),
//   A ani B nesmú zdieľať žiadne členstvo vo firme — inak beh skončí bez zápisu (napr. vlastník
//   oboch QA UX firiem nie je cross-company identita).
// Voliteľné:
//   SIGNED_URL_EMPLOYEE_A_EMAIL / SIGNED_URL_EMPLOYEE_A_PASSWORD  zamestnanec firmy A
//
// Pokrýva zadanie A–G (docs/production-migration-runbook-2026-10-22.md §S):
//   A autorizovaný používateľ získa signed URL      B HTTP GET/HEAD vráti súbor
//   C cudzia firma signed URL nezíska               D anonym signed URL nevytvorí
//   E TTL = 3600 s (SIGNED_MEDIA_TTL_SECONDS) + expirácia krátkej URL
//   F po zmazaní objektu sa nová URL nevydá          G už vydaná URL po odhlásení
//     (revoke session) — zdokumentuje sa reálne platformové správanie
// =============================================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

export const STAGING_REF = "cjbdijbbcujvmrzezusd";
export const PROD_REF = "fkpgvgvsmbpieduoatrt";
/** Musí sedieť s lib/storage/signed-media.ts (SIGNED_MEDIA_TTL_SECONDS). */
export const EXPECTED_TTL_SECONDS = 3600;
const BUCKET = "vehicle-photos";

// 1×1 px PNG (67 B), syntetický — žiadne osobné údaje.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

/** Odstráni z textu čokoľvek, čo by mohlo byť token/JWT/URL s query (bezpečný log). */
export function redact(text: string): string {
  return text
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "<jwt>")
    .replace(/token=[^&\s"]+/gi, "token=<redacted>")
    .replace(/https?:\/\/\S+/g, "<url>");
}

/** exp − iat z tokenu podpísanej URL (dekóduje sa lokálne, nič sa nevypisuje). */
export function signedUrlTtlSeconds(signedUrl: string): number | null {
  try {
    const token = new URL(signedUrl).searchParams.get("token");
    if (!token) return null;
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || typeof payload.iat !== "number") return null;
    return payload.exp - payload.iat;
  } catch {
    return null;
  }
}

/** Podpísaná URL nesmie niesť service_role ani iný „role“ claim — iba url + exp/iat. */
export function signedTokenClaims(signedUrl: string): string[] {
  try {
    const token = new URL(signedUrl).searchParams.get("token") ?? "";
    return Object.keys(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))).sort();
  } catch {
    return [];
  }
}

export type CompanyMembership = { company_id: string; company_name: string | null };

/**
 * Cross-company identita (čistá funkcia, testovaná): vráti dôvod odmietnutia alebo null.
 * A musí mať aktívnu firmu `expectA` a byť v nej členom, B aktívnu `expectB`, žiadne spoločné členstvo.
 */
export function identityGuardError(
  a: { active: string | null; companies: CompanyMembership[] },
  b: { active: string | null; companies: CompanyMembership[] },
  expectA: string,
  expectB: string
): string | null {
  const nameOf = (list: CompanyMembership[], id: string | null) => list.find((c) => c.company_id === id)?.company_name ?? null;
  if (!a.active || nameOf(a.companies, a.active) !== expectA) return `identity A: active company is not "${expectA}"`;
  if (!b.active || nameOf(b.companies, b.active) !== expectB) return `identity B: active company is not "${expectB}"`;
  const aIds = new Set(a.companies.map((c) => c.company_id));
  if (b.companies.some((c) => aIds.has(c.company_id))) return "identities A and B share a company membership";
  if (b.companies.some((c) => c.company_name === expectA)) return `identity B belongs to "${expectA}"`;
  if (a.companies.some((c) => c.company_name === expectB)) return `identity A belongs to "${expectB}"`;
  return null;
}

/** Riadený koniec bez process.exit() — na Windows inak hrozí `UV_HANDLE_CLOSING` pri zatváraní fetch socketov. */
class SmokeExit extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}
function fatal(code: number, message: string): never {
  throw new SmokeExit(code, message);
}

export function assertStagingTarget(url: string): void {
  if (url.includes(PROD_REF)) throw new Error("REFUSED: target is PRODUCTION");
  if (!url.startsWith(`https://${STAGING_REF}.supabase.co`)) throw new Error("REFUSED: target is not staging esblu-test");
}

function env(name: string, optional = false): string {
  const v = process.env[name]?.trim() ?? "";
  if (!v && !optional) fatal(2, `missing env ${name}`);
  return v;
}

let passes = 0;
let fails = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${redact(detail)}` : ""}`);
}
function info(label: string, detail: string) {
  console.log(`info ${label} — ${redact(detail)}`);
}

async function http(method: "GET" | "HEAD", url: string) {
  const res = await fetch(url, { method, headers: { "Cache-Control": "no-cache" } });
  const len = method === "GET" && res.ok ? (await res.arrayBuffer()).byteLength : Number(res.headers.get("content-length") ?? 0);
  if (method === "GET" && !res.ok) await res.text().catch(() => "");
  return { status: res.status, type: res.headers.get("content-type") ?? "-", len };
}

async function main() {
  const URL_ = env("SIGNED_URL_SUPABASE_URL").replace(/\/+$/, "");
  try {
    assertStagingTarget(URL_);
  } catch (e) {
    fatal(2, (e as Error).message);
  }
  const ANON = env("SIGNED_URL_ANON_KEY");
  const client = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

  async function login(prefix: string): Promise<{ db: SupabaseClient; uid: string } | null> {
    const email = env(`${prefix}_EMAIL`, true);
    const password = env(`${prefix}_PASSWORD`, true);
    if (!email || !password) return null;
    const db = client();
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error || !data.user) fatal(2, `login failed for ${prefix} (${error?.status ?? "?"})`);
    return { db, uid: data.user.id };
  }

  // Zdrojová identita A (iba Firma A, smie uploadnúť) a cudzia identita B (iba Firma B).
  const A_PREFIX = env("SIGNED_URL_SOURCE_A_EMAIL", true) ? "SIGNED_URL_SOURCE_A" : "SIGNED_URL_OWNER_A";
  const a = await login(A_PREFIX);
  const b = (await login("SIGNED_URL_FOREIGN")) ?? (await login("SIGNED_URL_OWNER_B"));
  if (!a || !b) fatal(2, "missing source A (SIGNED_URL_SOURCE_A_*) / foreign B (SIGNED_URL_FOREIGN_*) credentials");

  const identity = async (db: SupabaseClient) => {
    const { data: active } = await db.rpc("esblu_my_active_company_id");
    const { data: companies } = await db.rpc("esblu_list_my_companies");
    return { active: typeof active === "string" ? active : null, companies: (companies ?? []) as CompanyMembership[] };
  };
  const guard = identityGuardError(
    await identity(a.db),
    await identity(b.db),
    env("SIGNED_URL_EXPECT_A_COMPANY", true) || "QA UX Firma A",
    env("SIGNED_URL_EXPECT_B_COMPANY", true) || "QA UX Firma B"
  );
  if (guard) fatal(2, `REFUSED (no upload done): ${guard}`);
  check("setup: A only in company A, B only in company B, no shared membership", true);
  const emp = await login("SIGNED_URL_EMPLOYEE_A");
  const anon = client();

  // Vozidlo aktívnej firmy A (RLS) → cesta `<uid>/<vehicleId>/qa-signed-url-<uuid>.png`.
  const { data: vehicles, error: vErr } = await a.db.from("vehicles").select("id").limit(1);
  if (vErr || !vehicles?.length) fatal(2, `source A has no readable vehicle in the active company (${vErr?.code ?? "none"}) — cannot build a media path`);
  const path = `${a.uid}/${vehicles[0].id}/qa-signed-url-${randomUUID()}.png`;
  let uploaded = false;

  try {
    const up = await a.db.storage.from(BUCKET).upload(path, PNG_1X1, { contentType: "image/png", upsert: false });
    uploaded = !up.error;
    check("setup: source A uploads synthetic 1×1 PNG (draft, unreferenced)", uploaded, up.error?.message ?? "");
    if (!uploaded) return 1;

    // A — autorizovaný používateľ
    const signed = await a.db.storage.from(BUCKET).createSignedUrl(path, EXPECTED_TTL_SECONDS);
    const url1 = signed.data?.signedUrl ?? "";
    check("A source user A (company A) gets signed URL", !signed.error && !!url1, signed.error?.message ?? "");
    if (!url1) return 1;

    // B — reálny HTTP GET + HEAD
    const g = await http("GET", url1);
    check("B HTTP GET signed URL → 200 image/png", g.status === 200 && g.type.startsWith("image/png") && g.len === PNG_1X1.length, `status=${g.status} type=${g.type} len=${g.len}`);
    const h = await http("HEAD", url1);
    check("B HTTP HEAD signed URL → 200", h.status === 200, `status=${h.status} type=${h.type} len≈${h.len}`);

    // E — TTL a obsah tokenu
    const ttl = signedUrlTtlSeconds(url1);
    check(`E TTL = ${EXPECTED_TTL_SECONDS} s (app SIGNED_MEDIA_TTL_SECONDS)`, ttl === EXPECTED_TTL_SECONDS, `ttl=${ttl}`);
    const claims = signedTokenClaims(url1);
    check("security: token claims = exp/iat/url only (no role / service_role)", claims.join(",") === "exp,iat,url", `claims=${claims.join(",")}`);
    check("security: signed URL does not contain anon/service key", !url1.includes(ANON) && !/service_role/i.test(url1));

    const short = await a.db.storage.from(BUCKET).createSignedUrl(path, 5);
    const urlShort = short.data?.signedUrl ?? "";
    const beforeExp = urlShort ? await http("GET", urlShort) : { status: 0, type: "-", len: 0 };
    await new Promise((r) => setTimeout(r, 8_000));
    const afterExp = urlShort ? await http("GET", urlShort) : { status: 0, type: "-", len: 0 };
    check("E short URL (5 s) valid before expiry", beforeExp.status === 200, `status=${beforeExp.status}`);
    check("E short URL rejected after expiry", afterExp.status >= 400, `status=${afterExp.status}`);

    // C — cudzia firma
    const bSign = await b.db.storage.from(BUCKET).createSignedUrl(path, 60);
    check("C foreign-company user B cannot get signed URL", !!bSign.error && !bSign.data?.signedUrl);
    const bList = await b.db.storage.from(BUCKET).list(`${a.uid}/${vehicles[0].id}`);
    check("C foreign user B cannot list company A folder", !bList.error && (bList.data ?? []).length === 0, `rows=${bList.data?.length ?? "err"}`);
    const bDl = await b.db.storage.from(BUCKET).download(path);
    check("C foreign user B cannot download via authenticated API", !!bDl.error);
    const bBatch = await b.db.storage.from(BUCKET).createSignedUrls([path], 60);
    check("C foreign user B batch sign returns no URL", !(bBatch.data ?? []).some((x) => x.signedUrl));

    // D — anonym
    const anSign = await anon.storage.from(BUCKET).createSignedUrl(path, 60);
    check("D anonymous cannot create signed URL", !!anSign.error && !anSign.data?.signedUrl);
    const pub = await http("GET", `${URL_}/storage/v1/object/public/${BUCKET}/${path}`);
    check("security: bucket not public (public URL ≠ 200)", pub.status !== 200, `status=${pub.status}`);

    // Path normalization / traversal
    for (const evil of [`${b.uid}/../${path}`, `./${path}`, `${path}/..`, `/${path}`]) {
      const r = await b.db.storage.from(BUCKET).createSignedUrl(evil, 60);
      check(`path: foreign user B cannot sign traversal variant (${evil.startsWith("/") ? "leading-slash" : evil.includes("..") ? "dotdot" : "dot"})`, !r.data?.signedUrl);
    }
    const evilUp = await a.db.storage.from(BUCKET).upload(`${a.uid}/../${b.uid}/x.png`, PNG_1X1, { contentType: "image/png" });
    check("path: upload with '..' segment rejected", !!evilUp.error);

    // Zamestnanec tej istej firmy — rozpracovaný upload vidí iba nahrávateľ (zámer politiky)
    if (emp) {
      const eSign = await emp.db.storage.from(BUCKET).createSignedUrl(path, 60);
      check("policy: employee A cannot sign owner's unreferenced draft upload (uploader-only)", !eSign.data?.signedUrl);
    } else {
      info("policy: employee A", "skipped (no SIGNED_URL_EMPLOYEE_A_* env)");
    }

    // G — revoke session: global sign-out vlastníka A, potom už vydaná URL
    const { data: sess } = await a.db.auth.getSession();
    const oldAccess = sess.session?.access_token ?? "";
    await a.db.auth.signOut({ scope: "global" });
    const gAfterLogout = await http("GET", url1);
    info("G issued URL after source A global sign-out", `status=${gAfterLogout.status} (Supabase: signed URL is a standalone token; it stays valid until exp)`);
    const stale = createClient(URL_, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${oldAccess}` } },
    });
    const staleSign = await stale.storage.from(BUCKET).createSignedUrl(path, 60);
    info("G new sign with revoked session's old access JWT", staleSign.data?.signedUrl ? "ISSUED (JWT valid until its exp — platform behavior)" : `denied (${staleSign.error?.message ?? "-"})`);

    // F — po zmazaní objektu (štandardný flow) sa nová URL nevydá; stará vráti chybu
    const a2 = await login(A_PREFIX);
    if (!a2) return 1;
    const rm = await a2.db.storage.from(BUCKET).remove([path]);
    const removed = !rm.error && (rm.data ?? []).length === 1;
    uploaded = !removed;
    check("cleanup: source A removes synthetic draft via standard remove()", !rm.error && (rm.data ?? []).length === 1, rm.error?.message ?? `removed=${rm.data?.length ?? 0}`);
    const fSign = await a2.db.storage.from(BUCKET).createSignedUrl(path, 60);
    check("F after removal no new signed URL is issued", !fSign.data?.signedUrl);
    const fOld = await http("GET", url1);
    check("F previously issued URL no longer returns the file after removal", fOld.status !== 200, `status=${fOld.status}`);
  } finally {
    if (uploaded) {
      const again = await login(A_PREFIX).catch(() => null);
      const rm = again ? await again.db.storage.from(BUCKET).remove([path]) : null;
      console.log(`${rm && !rm.error ? "ok  " : "FAIL"} cleanup (finally): synthetic object removed`);
    }
  }

  console.log(`\n${fails === 0 ? "PASS" : "FAIL"} signed URL HTTP smoke: ${passes} ok, ${fails} fail`);
  return fails === 0 ? 0 : 1;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/storage-signed-url-http-smoke.ts")) {
  // Žiadne process.exit(): exit code cez process.exitCode a prirodzené ukončenie event loopu
  // (Windows: process.exit() počas zatvárania fetch socketov → `UV_HANDLE_CLOSING` assertion).
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      if (e instanceof SmokeExit) {
        console.error(e.message);
        process.exitCode = e.code;
      } else {
        console.error(`FAIL unexpected: ${redact(String(e?.message ?? e))}`);
        process.exitCode = 1;
      }
    });
}
