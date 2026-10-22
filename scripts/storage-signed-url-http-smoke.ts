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
//   SIGNED_URL_OWNER_A_EMAIL / SIGNED_URL_OWNER_A_PASSWORD   vlastník QA UX Firma A
//   SIGNED_URL_OWNER_B_EMAIL / SIGNED_URL_OWNER_B_PASSWORD   vlastník QA UX Firma B (iný tenant)
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

export function assertStagingTarget(url: string): void {
  if (url.includes(PROD_REF)) throw new Error("REFUSED: target is PRODUCTION");
  if (!url.startsWith(`https://${STAGING_REF}.supabase.co`)) throw new Error("REFUSED: target is not staging esblu-test");
}

function env(name: string, optional = false): string {
  const v = process.env[name]?.trim() ?? "";
  if (!v && !optional) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
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
  assertStagingTarget(URL_);
  const ANON = env("SIGNED_URL_ANON_KEY");
  const client = () => createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

  async function login(prefix: string): Promise<{ db: SupabaseClient; uid: string } | null> {
    const email = env(`${prefix}_EMAIL`, true);
    const password = env(`${prefix}_PASSWORD`, true);
    if (!email || !password) return null;
    const db = client();
    const { data, error } = await db.auth.signInWithPassword({ email, password });
    if (error || !data.user) {
      console.error(`login failed for ${prefix} (${error?.status ?? "?"})`);
      process.exit(2);
    }
    return { db, uid: data.user.id };
  }

  const a = await login("SIGNED_URL_OWNER_A");
  const b = await login("SIGNED_URL_OWNER_B");
  if (!a || !b) {
    console.error("missing owner A/B credentials");
    process.exit(2);
  }
  const emp = await login("SIGNED_URL_EMPLOYEE_A");
  const anon = client();

  // Vozidlo aktívnej firmy A (RLS) → cesta `<uid>/<vehicleId>/qa-signed-url-<uuid>.png`.
  const { data: vehicles, error: vErr } = await a.db.from("vehicles").select("id").limit(1);
  if (vErr || !vehicles?.length) {
    console.error(`owner A has no readable vehicle in the active company (${vErr?.code ?? "none"}) — cannot build a media path`);
    process.exit(2);
  }
  const path = `${a.uid}/${vehicles[0].id}/qa-signed-url-${randomUUID()}.png`;
  let uploaded = false;

  try {
    const up = await a.db.storage.from(BUCKET).upload(path, PNG_1X1, { contentType: "image/png", upsert: false });
    uploaded = !up.error;
    check("setup: owner A uploads synthetic 1×1 PNG (draft, unreferenced)", uploaded, up.error?.message ?? "");
    if (!uploaded) return;

    // A — autorizovaný používateľ
    const signed = await a.db.storage.from(BUCKET).createSignedUrl(path, EXPECTED_TTL_SECONDS);
    const url1 = signed.data?.signedUrl ?? "";
    check("A owner A gets signed URL", !signed.error && !!url1, signed.error?.message ?? "");
    if (!url1) return;

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
    check("C owner of company B cannot get signed URL", !!bSign.error && !bSign.data?.signedUrl);
    const bList = await b.db.storage.from(BUCKET).list(`${a.uid}/${vehicles[0].id}`);
    check("C owner B cannot list company A folder", !bList.error && (bList.data ?? []).length === 0, `rows=${bList.data?.length ?? "err"}`);
    const bDl = await b.db.storage.from(BUCKET).download(path);
    check("C owner B cannot download via authenticated API", !!bDl.error);
    const bBatch = await b.db.storage.from(BUCKET).createSignedUrls([path], 60);
    check("C owner B batch sign returns no URL", !(bBatch.data ?? []).some((x) => x.signedUrl));

    // D — anonym
    const anSign = await anon.storage.from(BUCKET).createSignedUrl(path, 60);
    check("D anonymous cannot create signed URL", !!anSign.error && !anSign.data?.signedUrl);
    const pub = await http("GET", `${URL_}/storage/v1/object/public/${BUCKET}/${path}`);
    check("security: bucket not public (public URL ≠ 200)", pub.status !== 200, `status=${pub.status}`);

    // Path normalization / traversal
    for (const evil of [`${b.uid}/../${path}`, `./${path}`, `${path}/..`, `/${path}`]) {
      const r = await b.db.storage.from(BUCKET).createSignedUrl(evil, 60);
      check(`path: owner B cannot sign traversal variant (${evil.startsWith("/") ? "leading-slash" : evil.includes("..") ? "dotdot" : "dot"})`, !r.data?.signedUrl);
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
    info("G issued URL after owner A global sign-out", `status=${gAfterLogout.status} (Supabase: signed URL is a standalone token; it stays valid until exp)`);
    const stale = createClient(URL_, ANON, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${oldAccess}` } },
    });
    const staleSign = await stale.storage.from(BUCKET).createSignedUrl(path, 60);
    info("G new sign with revoked session's old access JWT", staleSign.data?.signedUrl ? "ISSUED (JWT valid until its exp — platform behavior)" : `denied (${staleSign.error?.message ?? "-"})`);

    // F — po zmazaní objektu (štandardný flow) sa nová URL nevydá; stará vráti chybu
    const a2 = await login("SIGNED_URL_OWNER_A");
    if (!a2) return;
    const rm = await a2.db.storage.from(BUCKET).remove([path]);
    const removed = !rm.error && (rm.data ?? []).length === 1;
    uploaded = !removed;
    check("cleanup: owner A removes synthetic draft via standard remove()", !rm.error && (rm.data ?? []).length === 1, rm.error?.message ?? `removed=${rm.data?.length ?? 0}`);
    const fSign = await a2.db.storage.from(BUCKET).createSignedUrl(path, 60);
    check("F after removal no new signed URL is issued", !fSign.data?.signedUrl);
    const fOld = await http("GET", url1);
    check("F previously issued URL no longer returns the file after removal", fOld.status !== 200, `status=${fOld.status}`);
  } finally {
    if (uploaded) {
      const again = await login("SIGNED_URL_OWNER_A");
      const rm = again ? await again.db.storage.from(BUCKET).remove([path]) : null;
      console.log(`${rm && !rm.error ? "ok  " : "FAIL"} cleanup (finally): synthetic object removed`);
    }
  }

  console.log(`\n${fails === 0 ? "PASS" : "FAIL"} signed URL HTTP smoke: ${passes} ok, ${fails} fail`);
  process.exit(fails === 0 ? 0 : 1);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/storage-signed-url-http-smoke.ts")) {
  main().catch((e) => {
    console.error(`FAIL unexpected: ${redact(String(e?.message ?? e))}`);
    process.exit(1);
  });
}
