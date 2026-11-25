// =============================================================================
// P1-5 skupina D — jadro runnera skutočného výmazu syntetických firiem (PRÍPRAVA; spúšťa vlastník až po schválení).
//
// Invarianty (navyše k F-3 … F-6 zo skupiny C, runner-core.ts):
//   D-1  výmaz IBA pre napevno zadané páry firma ↔ vlastník ↔ názov ↔ e-mail: QA-P15-T1, QA-P15-T2, QA-P15-PERF.
//        QA-P15-ISO, 16 pôvodných firiem a čokoľvek iné = STOP ešte pred sieťou.
//   D-2  jeden beh = jedna firma (aktívny cieľ). Sieťová vrstva (deletionGuardedFetch) pustí IBA:
//        čítanie REST, čítanie/list/mazanie Storage pod prefixom "<aktívna firma>/" v 2 bucketoch, 9 RPC s
//        p_company_id/p_user_id = aktívny cieľ, PATCH iba jobu tohto ukončenia, auth admin iba pre vlastníka cieľa.
//        billing-documents, iné buckety, DELETE/PUT cez REST, upload a iný projekt = výnimka (nič sa neodošle).
//   D-3  pred výmazom: identita v DB, vlastník bez iných firiem, bez registrácie u poskytovateľa e-Faktúry, bez
//        billing dokladov, všetky cesty súborov pod prefixom firmy, preflight brány = OK.
//   D-4  výmaz ide cez skutočný kód appky (lib/account-deletion-deps + orchestrator) a DB bránu bez zmien:
//        export ≤ 24 h a aktuálny, vyhlásenie oprávnenej osoby (text + SHA-256 z i18n), čerstvé prihlásenie ≤ 30 min.
//   D-5  po výmaze: firma, doklady, e-faktúry, členstvá a súbory preč; ukončenie completed + storage_purged_at;
//        job done; incidenty R3; ISO nezmenená (počty + objekty).
// Runner nevolá eFaktura.sk (ani sandbox) — deregistráciu nespúšťa; firma s registráciou = STOP.
// =============================================================================
import { APPROVED_COMPANIES, APPROVED_NAMES, APPROVED_OWNERS, ALLOWED_ORIGIN, Stop, guardedFetch } from "./runner-core.ts";

export type TargetKey = "t1" | "t2" | "perf";
export type Target = { key: TargetKey; companyId: string; ownerId: string; name: string; email: string };

export const DELETE_ALLOWLIST: Readonly<Record<TargetKey, Target>> = Object.freeze({
  t1: Object.freeze({ key: "t1", companyId: "f1510000-0000-4000-8000-000000000001", ownerId: "f1500000-0000-4000-8000-000000000101", name: "QA-P15-T1", email: "qa-p15-t1@esblu-qa.invalid" }),
  t2: Object.freeze({ key: "t2", companyId: "f1510000-0000-4000-8000-000000000002", ownerId: "f1500000-0000-4000-8000-000000000102", name: "QA-P15-T2", email: "qa-p15-t2@esblu-qa.invalid" }),
  perf: Object.freeze({ key: "perf", companyId: "f1510000-0000-4000-8000-000000000004", ownerId: "f1500000-0000-4000-8000-000000000104", name: "QA-P15-PERF", email: "qa-p15-perf@esblu-qa.invalid" }),
}) as Readonly<Record<TargetKey, Target>>;
/** Chránená syntetická firma (kontrola izolácie) — nikdy cieľ. */
export const PROTECTED_ISO = Object.freeze({ companyId: "f1510000-0000-4000-8000-000000000003", ownerId: "f1500000-0000-4000-8000-000000000103" });
export const DELETE_BUCKETS: ReadonlySet<string> = new Set(["einvoice-documents", "ai-inbox-documents"]);
export const ALLOWED_RPC: ReadonlySet<string> = new Set([
  "esblu_company_export_fingerprint", "esblu_company_export_file_list", "esblu_company_export_storage_fingerprint",
  "esblu_company_export_begin", "esblu_company_export_part_files",
  "esblu_company_termination_preflight", "esblu_company_termination_execute", "esblu_company_termination_record_failure",
  "esblu_cleanup_job_confirm_storage", "esblu_cleanup_health",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** D-1: konzistencia allowlistu so schválenými identitami skupiny C; ISO nikdy. */
export function assertAllowlistIntegrity(): void {
  const keys = Object.keys(DELETE_ALLOWLIST).sort().join(",");
  if (keys !== "perf,t1,t2") throw new Stop("D-1: allowlist musí byť presne t1, t2, perf");
  for (const t of Object.values(DELETE_ALLOWLIST)) {
    if (APPROVED_COMPANIES[t.key] !== t.companyId || APPROVED_OWNERS[t.key] !== t.ownerId || APPROVED_NAMES[t.key] !== t.name) throw new Stop(`D-1: ${t.key} ≠ schválené identity`);
    if (t.companyId === PROTECTED_ISO.companyId || t.ownerId === PROTECTED_ISO.ownerId) throw new Stop("D-1: ISO v allowliste");
    if (!t.email.endsWith("@esblu-qa.invalid")) throw new Stop("D-1: nesyntetický e-mail");
  }
  const ids = Object.values(DELETE_ALLOWLIST).map((t) => t.companyId);
  if (new Set(ids).size !== 3) throw new Stop("D-1: duplicitné UUID");
}

/** D-1: jediný spôsob, ako získať cieľ výmazu. Akékoľvek iné ID/kľúč = STOP. */
export function resolveDeletionTarget(input: string): Target {
  assertAllowlistIntegrity();
  // iba vlastné kľúče (nie __proto__ / constructor / toString z prototypu)
  if ((input === "t1" || input === "t2" || input === "perf") && Object.hasOwn(DELETE_ALLOWLIST, input)) {
    const t = DELETE_ALLOWLIST[input];
    if (t.key === input) return t;
  }
  throw new Stop(`D-1: firma „${String(input).slice(0, 40)}“ nie je v allowliste výmazu (povolené iba t1, t2, perf)`);
}

// ----------------------------------------------------------------------------- D-2 sieťová vrstva
export type DeleteScope = { target: Target | null; jobId: string | null; injectStorageFailure: string | null; log: string[]; authOnly?: boolean };
export function newScope(target: Target | null): DeleteScope { return { target, jobId: null, injectStorageFailure: null, log: [], authOnly: false }; }

function methodOf(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string {
  return String(init?.method ?? (typeof input === "object" && "method" in (input as Request) ? (input as Request).method : "GET")).toUpperCase();
}
function jsonBody(init?: Parameters<typeof fetch>[1]): Record<string, unknown> {
  const b = init?.body;
  if (b === undefined || b === null || b === "") return {};
  if (typeof b !== "string") throw new Stop("D-2: telo požiadavky nie je JSON text — zablokované");
  try {
    const v = JSON.parse(b);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* nižšie */ }
  throw new Stop("D-2: neplatné JSON telo — zablokované");
}
const under = (p: string, companyId: string) => typeof p === "string" && p.startsWith(`${companyId}/`) && !p.includes("..");

/**
 * Sieťová poistka výmazu. Kontroluje KAŽDÚ požiadavku supabase-js pred odoslaním (origin rieši guardedFetch zo
 * skupiny C). Pri porušení vyhodí Stop — požiadavka sa neodošle.
 */
export function deletionGuardedFetch(scope: DeleteScope, inner: typeof fetch = fetch): typeof fetch {
  const originGuarded = guardedFetch(inner);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(raw);
    if (url.origin !== ALLOWED_ORIGIN) throw new Stop("F-3: požiadavka mimo povoleného projektu zablokovaná");
    const t = scope.target;
    if (!t) throw new Stop("D-2: bez aktívneho cieľa sa nič neodosiela");
    const m = methodOf(input, init);
    const p = decodeURIComponent(url.pathname);
    const deny = (why: string): never => { scope.log.push(`DENY ${m} ${p.slice(0, 60)} ${why}`); throw new Stop(`D-2: ${why}`); };
    // Test autentifikácie (auth-test): iba čítanie REST a Auth vlastníka cieľa — žiadne RPC, Storage ani DELETE.
    if (scope.authOnly) {
      const okRest = p.startsWith("/rest/v1/") && !p.startsWith("/rest/v1/rpc/") && (m === "GET" || m === "HEAD");
      const okAuth = p.startsWith("/auth/v1/") && !(m === "DELETE");
      if (!okRest && !okAuth) deny("režim auth-test: povolené iba čítanie REST a prihlásenie vlastníka");
    }

    if (p.startsWith("/rest/v1/rpc/")) {
      if (m !== "POST") deny("RPC iba POST");
      const fn = p.slice("/rest/v1/rpc/".length);
      if (!ALLOWED_RPC.has(fn)) deny(`RPC ${fn} nie je povolená`);
      const body = jsonBody(init);
      if ("p_company_id" in body && body.p_company_id !== t.companyId) deny("RPC pre inú firmu");
      if ("p_user_id" in body && body.p_user_id !== t.ownerId) deny("RPC za iného používateľa");
      if (fn === "esblu_cleanup_job_confirm_storage" && (!scope.jobId || body.p_job_id !== scope.jobId)) deny("potvrdenie cudzieho jobu");
      if ((fn.startsWith("esblu_company_") && !("p_company_id" in body))) deny("RPC bez p_company_id");
    } else if (p.startsWith("/rest/v1/")) {
      const table = p.slice("/rest/v1/".length);
      if (m === "GET" || m === "HEAD") { /* čítanie (service role) — mutácie nižšie */ }
      else if (m === "PATCH" && table === "account_deletion_cleanup_jobs" && scope.jobId && url.searchParams.get("id") === `eq.${scope.jobId}` && [...url.searchParams.keys()].every((k) => k === "id" || k === "select")) { /* stav jobu tohto ukončenia */ }
      else deny(`REST ${m} ${table} zakázané`);
    } else if (p.startsWith("/storage/v1/object/")) {
      const rest = p.slice("/storage/v1/object/".length);
      if (rest.startsWith("list/")) {
        const bucket = rest.slice(5);
        if (m !== "POST" || !DELETE_BUCKETS.has(bucket)) deny("list mimo povolených bucketov");
        const prefix = String(jsonBody(init).prefix ?? "");
        if (!(prefix === t.companyId || prefix === PROTECTED_ISO.companyId || under(prefix, t.companyId) || under(prefix, PROTECTED_ISO.companyId))) deny("list mimo prefixu cieľa/ISO");
      } else if (m === "DELETE") {
        const bucket = rest;
        if (!DELETE_BUCKETS.has(bucket)) deny(`mazanie v buckete ${bucket} zakázané`);
        const prefixes = jsonBody(init).prefixes;
        if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.length > 100) deny("mazanie bez zoznamu ciest");
        for (const x of prefixes as unknown[]) if (typeof x !== "string" || !under(x, t.companyId)) deny("mazanie mimo prefixu aktívnej firmy");
        if (scope.injectStorageFailure === bucket) {
          scope.injectStorageFailure = null;
          scope.log.push(`INJECT 503 DELETE ${bucket}`);
          return new Response(JSON.stringify({ statusCode: "503", error: "injected", message: "simulated outage (runner)" }), { status: 503, headers: { "content-type": "application/json" } });
        }
      } else if (m === "GET" || m === "HEAD") {
        const r2 = rest.replace(/^(authenticated|info)\//, "");
        const slash = r2.indexOf("/");
        const bucket = slash > 0 ? r2.slice(0, slash) : "";
        const objectPath = slash > 0 ? r2.slice(slash + 1) : "";
        if (!DELETE_BUCKETS.has(bucket) || !under(objectPath, t.companyId)) deny("čítanie objektu mimo prefixu cieľa");
      } else deny(`Storage ${m} zakázané (žiadny upload v skupine D)`);
    } else if (p.startsWith("/auth/v1/")) {
      const a = p.slice("/auth/v1/".length);
      if (a === `admin/users/${t.ownerId}` && (m === "GET" || m === "DELETE")) { /* iba vlastník cieľa */ }
      else if (a === "admin/generate_link" && m === "POST") {
        const b = jsonBody(init);
        if (b.type !== "magiclink" || b.email !== t.email) deny("generate_link iba magiclink pre vlastníka cieľa");
      } else if (a === "verify" && m === "POST") {
        const b = jsonBody(init);
        if (b.type !== "magiclink" || typeof b.token_hash !== "string") deny("verify iba magiclink token_hash");
      } else if (a === "logout" && m === "POST") { /* odhlásenie testovacej relácie */ }
      else if (a === "user" && m === "GET") { /* overenie relácie */ }
      else deny(`auth ${m} ${a.split("/")[0]} zakázané`);
    } else deny("služba mimo REST/Storage/Auth zakázaná");

    scope.log.push(`ALLOW ${m} ${p.split("/").slice(0, 5).join("/")}`);
    return originGuarded(input, init);
  }) as typeof fetch;
}

// ----------------------------------------------------------------------------- D-3 / D-5 kontroly
export type Read = (table: string, filter: Record<string, string>, select?: string) => Promise<Record<string, unknown>[]>;
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
export type ListObjects = (bucket: string, prefix: string) => Promise<string[]>;

/** Rekurzívny zoznam objektov pod prefixom (Storage list vracia priečinky bez id). */
export async function listAll(list: (bucket: string, prefix: string) => Promise<Array<{ name: string; id: string | null }>>, bucket: string, prefix: string, depth = 0): Promise<string[]> {
  if (depth > 8) throw new Stop("Storage list: príliš hlboká štruktúra");
  const out: string[] = [];
  for (const e of await list(bucket, prefix)) {
    const full = `${prefix}/${e.name}`;
    if (e.id) out.push(full);
    else out.push(...(await listAll(list, bucket, full, depth + 1)));
  }
  return out;
}

/** D-3a (iba čítanie, pred prihlásením aj po ňom): identita, oprávnenie vlastníka, rozsah firmy. Žiadne RPC. */
export async function precheckIdentity(t: Target, read: Read): Promise<{ r3: number; storagePaths: number }> {
  const [company] = await read("companies", { id: `eq.${t.companyId}` }, "id,name,owner_id");
  if (!company || company.name !== t.name || company.owner_id !== t.ownerId) throw new Stop("D-3: firma v DB ≠ allowlist (názov/vlastník)");
  const memberships = await read("company_members", { user_id: `eq.${t.ownerId}` }, "company_id,role,status");
  if (memberships.length !== 1 || memberships[0].company_id !== t.companyId || memberships[0].role !== "owner") throw new Stop("D-3: vlastník má iné členstvá — zrušenie účtu by zasiahlo inú firmu");
  const orgs = await read("einvoice_organizations", { company_id: `eq.${t.companyId}` }, "id,provider_org_id");
  if (orgs.length) throw new Stop("D-3: firma má organizáciu u poskytovateľa e-Faktúry — deregistrácia nie je v rozsahu (eFaktura.sk sa nevolá)");
  const billing = await read("billing_invoice_documents", { company_id: `eq.${t.companyId}` }, "id");
  if (billing.length) throw new Stop("D-3: firma má billing doklady Esblu");
  let paths = 0;
  for (const [table, cols] of [["documents", ["storage_path"]], ["document_attachments", ["storage_path"]], ["einvoice_inbound", ["xml_storage_path", "pdf_storage_path"]], ["einvoice_outbound", ["ubl_storage_path"]]] as const) {
    for (const row of await read(table, { company_id: `eq.${t.companyId}` }, cols.join(","))) {
      for (const c of cols) {
        const v = row[c];
        if (v === null || v === undefined) continue;
        if (typeof v !== "string" || !under(v, t.companyId)) throw new Stop(`D-3: cesta súboru mimo prefixu firmy (${table})`);
        paths++;
      }
    }
  }
  const [owner] = memberships;
  if (owner.status !== "active") throw new Stop("D-3: členstvo vlastníka nie je aktívne");
  const r3 = (await read("einvoice_inbound", { company_id: `eq.${t.companyId}`, last_error_code: "eq.RECIPIENT_MISMATCH" }, "id")).length;
  return { r3, storagePaths: paths };
}

/** D-6 databázová brána bez zmeny údajov (preflight) — až po overenom exporte. */
export async function gateCheck(t: Target, rpc: Rpc, ack: unknown): Promise<void> {
  const gate = await rpc("esblu_company_termination_preflight", { p_user_id: t.ownerId, p_company_id: t.companyId, p_export_mode: "exported", p_ack: ack });
  if (gate.error) throw new Stop(`D-6: preflight zlyhal (${gate.error.code ?? "?"})`);
  if (typeof gate.data === "string" && gate.data) throw new Stop(`D-6: brána odmieta: ${gate.data}`);
}

/** D-5 validácia nového exportu: presne tento beh, vlastník, completed, 0 chýbajúcich, súbory s SHA-256, čerstvý. */
export async function validateExport(t: Target, read: Read, runId: string | null, now: Date): Promise<{ files: number }> {
  if (!isUuid(runId)) throw new Stop("D-5: export nemá id behu");
  const [run] = await read("company_export_runs", { id: `eq.${runId}` }, "id,company_id,requested_by,status,missing_files,files_bound,files_total,completed_at,data_fingerprint,storage_fingerprint");
  if (!run || run.company_id !== t.companyId || run.requested_by !== t.ownerId) throw new Stop("D-5: export patrí inej firme/používateľovi");
  if (run.status !== "completed" || run.missing_files !== 0 || run.files_bound !== true || !run.data_fingerprint || !run.storage_fingerprint) throw new Stop("D-5: export nie je úplný a overený");
  const age = now.getTime() - Date.parse(String(run.completed_at));
  if (!(age >= -60_000 && age < 15 * 60_000)) throw new Stop("D-5: export nie je čerstvý");
  const files = await read("company_export_run_files", { run_id: `eq.${runId}` }, "path,sha256");
  if (files.length !== run.files_total || files.some((f) => typeof f.sha256 !== "string" || !under(String(f.path), t.companyId))) throw new Stop("D-5: súbory exportu nesedia (počet / SHA-256 / prefix)");
  return { files: files.length };
}

/** Výsledok skutočného prihlásenia (bez hodnôt tokenov). */
export type ReauthResult = { userId: string | null; email: string | null; tokenVerified: boolean; lastSignInAt: string | null; identities: number | null };
type AuthClients = {
  admin: { auth: { admin: { generateLink(p: { type: "magiclink"; email: string }): Promise<{ data: { properties?: { hashed_token?: string } | null } | null; error: { status?: number; code?: string } | null }>;
    getUserById(id: string): Promise<{ data: { user: { id: string; last_sign_in_at?: string | null; identities?: unknown[] | null } | null }; error: unknown }> } } };
  anon: { auth: { verifyOtp(p: { type: "magiclink"; token_hash: string }): Promise<{ data: { user: { id: string; email?: string } | null; session: { access_token: string } | null }; error: { status?: number; code?: string } | null }>;
    getUser(jwt: string): Promise<{ data: { user: { id: string; email?: string } | null }; error: unknown }>;
    signOut(o: { scope: "local" }): Promise<unknown> } };
};
/**
 * Skutočné prihlásenie vlastníka mechanizmom Supabase Auth (bez falšovania session a bez zápisu do auth.users):
 * admin generate_link (magiclink, e-mail sa NEPOSIELA) → verify(token_hash) s publishable key (ako klient) →
 * overenie access tokenu cez GET /auth/v1/user (rovnako ako verifyRequestUser v appke) → odhlásenie relácie →
 * last_sign_in_at z Auth Admin API. Akákoľvek chyba = Stop (volajúci nepokračuje).
 */
export async function realReauth(c: AuthClients, t: Target): Promise<ReauthResult> {
  const link = await c.admin.auth.admin.generateLink({ type: "magiclink", email: t.email });
  const hashed = link.data?.properties?.hashed_token;
  if (link.error || !hashed) throw new Stop(`reauth: generate_link zlyhal (${link.error?.status ?? "?"}:${link.error?.code ?? "-"})`);
  const v = await c.anon.auth.verifyOtp({ type: "magiclink", token_hash: hashed });
  if (v.error || !v.data.session || !v.data.user) throw new Stop(`reauth: overenie magic linku zlyhalo (${v.error?.status ?? "?"}:${v.error?.code ?? "-"})`);
  if (v.data.user.id !== t.ownerId) { await c.anon.auth.signOut({ scope: "local" }).catch(() => undefined); throw new Stop("reauth: prihlásil sa iný používateľ"); }
  let tokenVerified = false;
  let email: string | null = null;
  try {
    const me = await c.anon.auth.getUser(v.data.session.access_token);
    tokenVerified = me.data.user?.id === t.ownerId;
    email = me.data.user?.email ?? null;
  } finally {
    await c.anon.auth.signOut({ scope: "local" }).catch(() => undefined);
  }
  const u = await c.admin.auth.admin.getUserById(t.ownerId);
  return { userId: v.data.user.id, email, tokenVerified, lastSignInAt: u.data.user?.last_sign_in_at ?? null, identities: Array.isArray(u.data.user?.identities) ? u.data.user!.identities!.length : null };
}
/** Prihlásenie platí iba ak: ten istý vlastník, e-mail, token overený cez /user, last_sign_in_at < 5 min. */
export function assertFreshOwnerAuth(t: Target, r: ReauthResult, now: Date): void {
  if (r.userId !== t.ownerId) throw new Stop("D-3: prihlásený iný používateľ");
  if (!r.tokenVerified) throw new Stop("D-3: access token sa nepodarilo overiť (GET /auth/v1/user)");
  if ((r.email ?? "").toLowerCase() !== t.email) throw new Stop("D-3: e-mail prihláseného používateľa ≠ vlastník");
  const age = r.lastSignInAt ? now.getTime() - Date.parse(r.lastSignInAt) : Infinity;
  if (!(age >= -60_000 && age < 5 * 60_000)) throw new Stop("D-3: čerstvé prihlásenie vlastníka sa nepotvrdilo (last_sign_in_at)");
}

export type IsoSnapshot = { counts: Record<string, number>; objects: string[] };
export async function isoSnapshot(read: Read, list: ListObjects): Promise<IsoSnapshot> {
  const counts: Record<string, number> = {};
  for (const table of ["companies", "company_members", "invoices", "einvoice_inbound", "einvoice_outbound", "einvoice_events", "einvoice_mandates", "documents", "document_attachments"]) {
    counts[table] = (await read(table, table === "companies" ? { id: `eq.${PROTECTED_ISO.companyId}` } : { company_id: `eq.${PROTECTED_ISO.companyId}` }, "id")).length;
  }
  const objects: string[] = [];
  for (const b of DELETE_BUCKETS) objects.push(...(await list(b, PROTECTED_ISO.companyId)).map((x) => `${b}|${x}`));
  return { counts, objects: objects.sort() };
}
export function sameSnapshot(a: IsoSnapshot, b: IsoSnapshot): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export async function postcheck(t: Target, read: Read, list: ListObjects, expected: { r3: number }): Promise<string[]> {
  const issues: string[] = [];
  if ((await read("companies", { id: `eq.${t.companyId}` }, "id")).length) issues.push("firma existuje");
  for (const table of ["company_members", "invoices", "einvoice_inbound", "einvoice_outbound", "einvoice_events", "documents", "document_attachments", "vehicles"]) {
    if ((await read(table, { company_id: `eq.${t.companyId}` }, table === "company_members" ? "user_id" : "id")).length) issues.push(`zostali riadky ${table}`);
  }
  const terms = await read("company_terminations", { company_id: `eq.${t.companyId}`, status: "eq.completed" }, "id,termination_mode,storage_purged_at,cleanup_job_id,export_run_id");
  if (terms.length !== 1 || terms[0].termination_mode !== "customer_delete" || !terms[0].export_run_id) issues.push("ukončenie nie je completed/customer_delete s exportom");
  else {
    if (!terms[0].storage_purged_at) issues.push("storage_purged_at chýba");
    const job = await read("account_deletion_cleanup_jobs", { id: `eq.${terms[0].cleanup_job_id}` }, "storage_status,auth_status");
    if (job.length !== 1 || job[0].storage_status !== "done" || job[0].auth_status !== "done") issues.push("job nie je done");
    const inc = await read("einvoice_misdelivery_incidents", { termination_id: `eq.${terms[0].id}` }, "id");
    if (inc.length !== expected.r3) issues.push(`incidenty R3 ${inc.length}/${expected.r3}`);
  }
  for (const b of DELETE_BUCKETS) if ((await list(b, t.companyId)).length) issues.push(`zostali súbory v ${b}`);
  return issues;
}

export function isUuid(v: unknown): v is string { return typeof v === "string" && UUID.test(v); }
