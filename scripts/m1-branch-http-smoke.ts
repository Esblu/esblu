// =============================================================================
// M1 — authenticated HTTP / Storage smoke test proti IZOLOVANÉMU Supabase
// branchu (m1-authz-runtime-test). NIKDY proti produkcii.
//
// Spúšťa ČLOVEK na svojom počítači (Claude nesmie vytvárať účty ani sa
// prihlasovať heslom na vzdialenom hoste). Všetky hodnoty idú z env, nič sa
// nevypisuje okrem ok/FAIL riadkov — žiadne tokeny, heslá, kľúče ani e-maily.
//
//   node --experimental-strip-types --no-warnings scripts/m1-branch-http-smoke.ts
//
// Povinné env:
//   M1_BRANCH_URL            https://<branch-ref>.supabase.co (nie fkpgvgvsmbpieduoatrt)
//   M1_BRANCH_ANON_KEY       publishable/anon kľúč BRANCHU
//   M1_EMP_EMAIL / M1_EMP_PASSWORD           employee firmy A
//   M1_OWNER_EMAIL / M1_OWNER_PASSWORD       owner firmy A
//   M1_ACC_EMAIL / M1_ACC_PASSWORD           accountant firmy A
//   M1_OTHER_EMAIL / M1_OTHER_PASSWORD       owner firmy B (iný tenant)
//   M1_BRANCH_ATTEST_SECRET  ≥ 32 znakov; rovnaká hodnota uložená na BRANCHI
//                            vo Vault ako esblu_intake_attest_key_prev
// =============================================================================
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { signIntakeAttestation } from "../lib/intake-attest.ts";

const PROD_REF = "fkpgvgvsmbpieduoatrt";

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return v;
}

const URL_ = env("M1_BRANCH_URL");
if (URL_.includes(PROD_REF)) {
  console.error("REFUSED: M1_BRANCH_URL points to PRODUCTION. This smoke test runs only on the branch.");
  process.exit(2);
}
const ANON = env("M1_BRANCH_ANON_KEY");
const SECRET = env("M1_BRANCH_ATTEST_SECRET");
if (SECRET.length < 32) {
  console.error("M1_BRANCH_ATTEST_SECRET must be ≥ 32 chars");
  process.exit(2);
}

let fails = 0;
let passes = 0;
function check(label: string, ok: boolean) {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

async function login(prefix: string): Promise<{ db: SupabaseClient; uid: string }> {
  const db = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await db.auth.signInWithPassword({ email: env(`${prefix}_EMAIL`), password: env(`${prefix}_PASSWORD`) });
  if (error || !data.user) {
    console.error(`login failed for ${prefix} (${error?.status ?? "?"})`);
    process.exit(2);
  }
  return { db, uid: data.user.id };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Čítanie originálu podľa OČAKÁVANÉHO oprávnenia (security assertion).
// Supabase Smart CDN môže povolené autentifikované GET-y obslúžiť z cache
// (cf=HIT) aj s unikátnym query stringom. Preto:
//   - každé čítanie = (1) GET na objekt (môže byť CDN) + (2) origin overenie
//     cez createSignedUrl (POST /object/sign — dynamická požiadavka, RLS
//     SELECT na storage.objects sa vyhodnotí VŽDY na origine),
//   - expect DENY: GET nesmie vrátiť 200 (ani z CDN = hard FAIL) A origin
//     sign musí zlyhať,
//   - expect ALLOW: origin sign musí uspieť A GET musí vrátiť bajty;
//     CDN HIT pri povolenom čítaní nie je security fail (iba sa počíta).
let cdnHitsAllowed = 0;
let cdnHitsDenied = 0;
async function readCheck(db: SupabaseClient, bucket: string, path: string, expect: "allow" | "deny"): Promise<boolean> {
  const { data: session } = await db.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return false;
  const res = await fetch(
    `${URL_}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}?cacheNonce=${randomUUID()}`,
    { headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } }
  );
  const cf = res.headers.get("cf-cache-status") ?? "-";
  const body = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  if (!res.ok) await res.body?.cancel().catch(() => undefined);
  const gotBytes = res.ok && !!body && body.length > 0;
  const { data: signed, error: signError } = await db.storage.from(bucket).createSignedUrl(path, 30);
  const originAllows = !signError && !!signed?.signedUrl;
  if (cf === "HIT" && res.ok) {
    if (expect === "allow") cdnHitsAllowed++;
    else cdnHitsDenied++;
  }
  const ok = expect === "allow" ? originAllows && gotBytes : !originAllows && !res.ok;
  if (!ok) {
    console.log(`     diag: expect=${expect} get_http=${res.status} get_cf=${cf} origin_sign=${originAllows ? "allow" : "deny"}`);
  }
  return ok;
}

// Informatívne (reziduálne riziko CDN, nie RLS): bežný GET bez nonce — presne
// ako supabase-js download(). Ak vráti 200 pri očakávanom DENY, CDN vydala
// kópiu mimo RLS → reportuje sa ako RESIDUAL a počíta do „denied reads".
async function cdnPlainDownloadInfo(db: SupabaseClient, bucket: string, path: string, label: string) {
  const { data: session } = await db.auth.getSession();
  const token = session.session?.access_token;
  if (!token) return;
  const res = await fetch(`${URL_}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  const cf = res.headers.get("cf-cache-status") ?? "-";
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) cdnHitsDenied++;
  console.log(`info ${label}: plain GET (no nonce) http=${res.status} cf=${cf}${res.ok ? " — RESIDUAL: bytes served outside RLS" : " — denied"}`);
}

// Bezpečná diagnostika pri FAIL attach — NIKDY nevypisuje heslá, tokeny,
// anon kľúč, Vault secret ani podpis. Iba: HTTP status, PostgREST chybu,
// dĺžku a solený 8-znakový odtlačok secretu (porovnateľný s DB stranou),
// posun hodín voči serveru a či expirácia padá do okna DB (now..now+600 s).
async function diagnoseAttach(
  res: { status?: number; data: unknown; error: { code?: string; message?: string; details?: string; hint?: string } | null },
  expiresAt: number
) {
  console.log(`     diag: http_status=${res.status ?? "?"} data=${JSON.stringify(res.data)}`);
  if (res.error) {
    console.log(`     diag: pg_code=${res.error.code ?? "-"} message=${res.error.message ?? "-"} details=${res.error.details ?? "-"} hint=${res.error.hint ?? "-"}`);
  }
  const fp = createHash("sha256").update(`m1-fp:${SECRET}`, "utf8").digest("hex").slice(0, 8);
  const hasDollar = SECRET.includes("$");
  console.log(`     diag: secret_len=${Buffer.byteLength(SECRET, "utf8")} secret_fp=${fp} secret_contains_dollar=${hasDollar}`);
  try {
    const r = await fetch(`${URL_}/rest/v1/`, { headers: { apikey: ANON } });
    const serverDate = r.headers.get("date");
    if (serverDate) {
      const server = Math.floor(new Date(serverDate).getTime() / 1000);
      const local = Math.floor(Date.now() / 1000);
      const inWindow = expiresAt >= server && expiresAt <= server + 600;
      console.log(`     diag: clock_skew_seconds(local-server)=${local - server} expires_in_db_window=${inWindow}`);
    }
  } catch {
    console.log("     diag: server clock unavailable");
  }
}

async function main() {
  const emp = await login("M1_EMP");
  const owner = await login("M1_OWNER");
  const acc = await login("M1_ACC");
  const other = await login("M1_OTHER");

  // Syntetický „originál" (nie reálny doklad).
  const bytes = new Uint8Array(Buffer.from(`M1 synthetic receipt ${randomUUID()}`, "utf8"));
  const hash = sha256Hex(bytes);
  const docId = randomUUID();
  const path = `${emp.uid}/${docId}/${Date.now()}-${randomUUID()}.webp`;

  // ---- Storage: upload nového súboru ----------------------------------------
  {
    const { error } = await emp.db.storage.from("ai-inbox-documents").upload(path, bytes, { contentType: "image/webp", upsert: false });
    check("STORAGE employee uploads new file (own folder, new path)", !error);
  }

  // ---- REST: platný intake (tvar B) ----------------------------------------
  {
    const { error } = await emp.db.from("documents").insert({
      id: docId,
      user_id: emp.uid,
      storage_bucket: "ai-inbox-documents",
      storage_path: path,
      document_type: "receipt",
      status: "needs_review",
      content_sha256: hash,
    });
    check("REST employee inserts valid intake row (needs_review, hash, no data)", !error);
    const { error: forged } = await emp.db.from("documents").insert({
      user_id: emp.uid,
      storage_bucket: "ai-inbox-documents",
      storage_path: `${emp.uid}/${randomUUID()}.webp`,
      document_type: "invoice",
      status: "confirmed",
      content_sha256: hash,
      extracted_fields: { total: 1 },
    });
    check("REST employee cannot insert confirmed invoice with data", !!forged);
  }

  // ---- REST: podpísané pripojenie AI návrhu --------------------------------
  const payload = JSON.stringify({ extracted_fields: { supplier: "M1 Synthetic s.r.o.", total: 12.3 }, ai_raw_output: { model: "synthetic" } });
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const signature = signIntakeAttestation({
    target: "documents", rowId: docId, userId: emp.uid, kind: "receipt",
    contentSha256: hash, expiresAt, payloadText: payload, secret: SECRET,
  });
  {
    const bad = await emp.db.rpc("esblu_attach_intake_extraction", { p_document_id: docId, p_payload: payload + " ", p_expires_at: expiresAt, p_signature: signature });
    check("REST attach with tampered payload rejected", bad.data !== true);
    const good = await emp.db.rpc("esblu_attach_intake_extraction", { p_document_id: docId, p_payload: payload, p_expires_at: expiresAt, p_signature: signature });
    check("REST attach with valid server signature accepted", good.data === true);
    if (good.data !== true) await diagnoseAttach(good, expiresAt);
    const replay = await emp.db.rpc("esblu_attach_intake_extraction", { p_document_id: docId, p_payload: payload, p_expires_at: expiresAt, p_signature: signature });
    check("REST attach replay rejected", replay.data !== true);
  }

  // ---- REST: resume --------------------------------------------------------
  {
    const { data } = await emp.db.rpc("esblu_list_my_intake_reviews");
    const rows = (data as { id: string; status: string }[] | null) ?? [];
    check("REST resume list contains own extracted review", rows.some((r) => r.id === docId && r.status === "extracted"));
    const { data: review } = await emp.db.rpc("esblu_get_my_intake_review", { p_target: "documents", p_id: docId });
    const rv = review as { can_confirm?: boolean; content_sha256?: string } | null;
    check("REST get review: can_confirm + bound hash", rv?.can_confirm === true && rv?.content_sha256 === hash);
    const { data: sel } = await emp.db.from("documents").select("id").eq("id", docId);
    check("REST no finance browse of the row even during review", (sel ?? []).length === 0);
  }

  // ---- Storage: originál je nemenný ----------------------------------------
  {
    const other = new Uint8Array(Buffer.from("M1 replacement bytes", "utf8"));
    const up = await emp.db.storage.from("ai-inbox-documents").upload(path, other, { contentType: "image/webp", upsert: true });
    check("STORAGE upsert of linked original fails", !!up.error);
    const upd = await emp.db.storage.from("ai-inbox-documents").update(path, other, { contentType: "image/webp" });
    check("STORAGE overwrite (update) of linked original fails", !!upd.error);
    const mv = await emp.db.storage.from("ai-inbox-documents").move(path, `${emp.uid}/${randomUUID()}.webp`);
    check("STORAGE move of linked original fails", !!mv.error);
    check("STORAGE employee reads own in-review original", await readCheck(emp.db, "ai-inbox-documents", path, "allow"));
  }

  // ---- REST: potvrdenie ----------------------------------------------------
  {
    const { data } = await emp.db.rpc("esblu_confirm_intake_document", {
      p_document_id: docId, p_fields: { supplier: "M1 Synthetic s.r.o.", total: 12.35 }, p_note: "synthetic correction",
    });
    check("REST employee confirms own intake with correction", data === true);
    check("STORAGE after confirm employee cannot read original", await readCheck(emp.db, "ai-inbox-documents", path, "deny"));
    await cdnPlainDownloadInfo(emp.db, "ai-inbox-documents", path, "after confirm employee");
    const { data: sel } = await emp.db.from("documents").select("id").eq("id", docId);
    check("REST after confirm finance SELECT denied for employee", (sel ?? []).length === 0);
  }

  // ---- Storage: delete potvrdeného originálu --------------------------------
  {
    await owner.db.storage.from("ai-inbox-documents").remove([path]);
    check("STORAGE owner delete of linked confirmed original has no effect", await readCheck(owner.db, "ai-inbox-documents", path, "allow"));
    await emp.db.storage.from("ai-inbox-documents").remove([path]);
    check("STORAGE employee delete of linked confirmed original has no effect", await readCheck(owner.db, "ai-inbox-documents", path, "allow"));
  }

  // ---- Finance čítanie podľa scope + cross-company -------------------------
  {
    const { data: o } = await owner.db.from("documents").select("id, status, content_sha256").eq("id", docId);
    check("REST owner reads confirmed receipt", (o ?? []).length === 1);
    check("STORAGE owner reads original", await readCheck(owner.db, "ai-inbox-documents", path, "allow"));
    const { data: a } = await acc.db.from("documents").select("id").eq("id", docId);
    check("REST accountant reads confirmed receipt", (a ?? []).length === 1);
    check("STORAGE accountant reads original", await readCheck(acc.db, "ai-inbox-documents", path, "allow"));
    const { data: log } = await owner.db.from("document_review_log").select("action").eq("document_ref", docId);
    check("REST owner sees audit (field edits + confirmed)", ((log ?? []) as { action: string }[]).some((l) => l.action === "confirmed"));
    const { data: x } = await other.db.from("documents").select("id").eq("id", docId);
    check("REST other tenant cannot read the receipt", (x ?? []).length === 0);
    check("STORAGE other tenant cannot read the original", await readCheck(other.db, "ai-inbox-documents", path, "deny"));
    const up = await other.db.storage.from("ai-inbox-documents").upload(`${emp.uid}/${randomUUID()}.webp`, bytes, { contentType: "image/webp" });
    check("STORAGE other tenant cannot upload into employee folder", !!up.error);
  }

  // ---- Human Chat ----------------------------------------------------------
  {
    const { data: ownerDirect } = await owner.db.rpc("esblu_get_or_create_direct_conversation", { p_other_user_id: acc.uid });
    const { data: empDirect } = await emp.db.rpc("esblu_get_or_create_direct_conversation", { p_other_user_id: acc.uid });
    const { data: channel } = await emp.db.rpc("esblu_ensure_company_chat_channel");
    const ins = async (db: SupabaseClient, uid: string, conv: unknown) =>
      (await db.from("chat_messages").insert({ conversation_id: conv, author_id: uid, body: "M1 synthetic" })).error;
    check("CHAT employee posts into company channel", !(await ins(emp.db, emp.uid, channel)));
    check("CHAT employee posts into own direct conversation", !(await ins(emp.db, emp.uid, empDirect)));
    check("CHAT employee cannot post into owner↔accountant direct", !!(await ins(emp.db, emp.uid, ownerDirect)));
    check("CHAT employee cannot post as owner (spoofed author)", !!(await ins(emp.db, owner.uid, channel)));
    check("CHAT other tenant cannot post into company A channel", !!(await ins(other.db, other.uid, channel)));
    const { data: seen } = await emp.db.from("chat_messages").select("id").eq("conversation_id", ownerDirect as string);
    check("CHAT employee cannot read owner↔accountant direct", (seen ?? []).length === 0);
  }

  console.log(`\nCDN cache hits on allowed reads = ${cdnHitsAllowed}`);
  console.log(`CDN cache hits on denied reads = ${cdnHitsDenied}`);
  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke test crashed:", e instanceof Error ? e.message : "unknown");
  process.exit(1);
});
