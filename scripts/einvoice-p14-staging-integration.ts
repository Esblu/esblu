// =============================================================================
// P1-4 — STAGINGOVÝ INTEGRAČNÝ TEST prijímania eFaktúr (sandbox eFaktura.sk + staging esblu-test).
//
// RUČNÉ spúšťanie u vlastníka. NIE JE súčasťou CI. Produkciu sa nedotýka.
//   - poskytovateľ: IBA sandbox eFaktura.sk, partnerský testovací kľúč (efk_pk_test_…, odtlačok SHA-256 5888e939),
//   - DB: IBA staging esblu-test (cjbdijbbcujvmrzezusd) — produkčný ref = okamžitý STOP,
//   - organizácie: IBA syntetické E2E Partner A (odosielateľ) → E2E Partner B (príjemca), overené proti mapovaniu v DB,
//   - 7 syntetických faktúr `QA-P14-<beh>-1…7`; ACK karantény sa nepoužíva (vypnutý).
//
// Scenáre: F0 invariantné kontroly a inventár · F1 odoslanie A→B · F2 súbeh (ACK počas skenu → kotva chýba → reštart)
// · F3 stránkovanie (strana 3, offset s prekryvom, has_more) · F4 spracovanie (XML, koncept, firma, ACK, nemennosť)
// · F5 opakované behy (idempotencia) · F6 limiter · F7 monitoring (health + alerty; uloženie ≠ doručenie)
// · F8 ochrana cudzích firiem (cudzia nápoveda, odtlačok ostatných firiem pred/po).
//
// Poistky (STOP pred akoukoľvek požiadavkou/zápisom): --confirm-staging-sandbox; kľúč efk_pk_test_ + odtlačok;
// ESBLU_STAGING_SUPABASE_URL = https://cjbdijbbcujvmrzezusd.supabase.co; service-role kľúč (JWT: ref + rola);
// žiadna premenná nesmie obsahovať produkčný ref; ESBLU_EINVOICE_LIVE_ENABLED nesmie byť nastavené;
// fetch allowlist: iba api.efaktura.sk a 5 ciest (received, xml, acknowledge — iba org B; connector/send — iba org A
// s príjemcom 9915:2020147507; status — iba org A). Výstup: iba počty, stavy, kódy a skrátené hashe — nikdy kľúče,
// XML, ani identifikátory dokladov v čitateľnej forme.
//
// Použitie (PowerShell, koreň worktree vetvy fix/einvoice-inbound-pagination-quarantine):
//   node --env-file=..\..\..\assetpilot-einvoice\.env.local --env-file=<lokálny súbor so staging premennými> `
//     --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs `
//     scripts/einvoice-p14-staging-integration.ts --confirm-staging-sandbox
//   Staging premenné (vlastník si ich vloží lokálne SÁM, nikdy do chatu/repozitára):
//     ESBLU_STAGING_SUPABASE_URL=https://cjbdijbbcujvmrzezusd.supabase.co
//     ESBLU_STAGING_SERVICE_ROLE_KEY=<service role kľúč projektu esblu-test>
// Offline (bez siete a kľúčov; PGlite + falošný sandbox so stránkovaním): --offline-selftest
// =============================================================================

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { EfakturaSkProvider } from "../lib/einvoice/provider/efaktura-sk.ts";
import type { InboundStore } from "../lib/einvoice/inbound/store.ts";
import { createSupabaseInboundStore } from "../lib/einvoice/inbound/supabase-store.ts";
import {
  INBOUND_RATE_LIMITS,
  runInboundEvent,
  runInboundPoll,
  runInboundProcessBudget,
  syncInboundList,
  withInboundRateLimit,
  type InboundDeps,
} from "../lib/einvoice/inbound/processor.ts";
import { DEFAULT_ALERT_THRESHOLDS, evaluateAlerts, sanitizeHealth } from "../lib/einvoice/ops/alerts.ts";
import { generateUbl } from "../lib/einvoice/ubl/generate.ts";
import type { UblInvoiceSnapshot, UblParty } from "../lib/einvoice/ubl/model.ts";

// -----------------------------------------------------------------------------
// Argumenty a poistky
// -----------------------------------------------------------------------------
const ARGS = new Set(process.argv.slice(2).map((a) => a.replace(/^--/, "")));
class FatalStop extends Error {}
let RUNNING = false; // po štarte scenárov sa STOP nesmie ukončiť bez vrátenia rolloutu
// Výnimku z fetch môže adaptér poskytovateľa zabaliť do sieťovej chyby → STOP sa zaznamená aj globálne
// a beh sa ukončí po aktuálnom kroku (zablokovaná požiadavka sa NIKDY neodošle).
let FATAL: string | null = null;
function stop(message: string): never {
  console.error(`STOP: ${message}`);
  FATAL ??= message;
  if (RUNNING) throw new FatalStop(message);
  process.exit(2);
}
const SELFTEST = ARGS.has("offline-selftest");
if (!SELFTEST && !ARGS.has("confirm-staging-sandbox")) stop("chýba --confirm-staging-sandbox");

const STAGING_REF = "cjbdijbbcujvmrzezusd";
const PROD_REF = "fkpgvgvsmbpieduoatrt";
const KEY_FP = "5888e939";
const ORG_A = "b3b1d05a-5a9d-452f-a505-4029adac44d9"; // E2E Partner A (odosielateľ)
const ORG_B = "1664d1cd-40f8-453e-a5a8-9fd56f6d96c3"; // E2E Partner B (príjemca)
const CO_A = "e2e5a000-0000-4000-8000-00000000000a";
const CO_B = "e2e5a000-0000-4000-8000-00000000000b";
const PID_A = "9915:2054825695";
const PID_B = "9915:2020147507";
const PROVIDER = "efaktura_sk";
const N_SEND = 7;

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const short = (v: string) => sha(v).slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, SELFTEST ? 1 : ms));

const env = (k: string) => process.env[k]?.trim() ?? "";
let KEY = "efk_pk_test_" + "0".repeat(24);
let SUPA_URL = "";
let SUPA_KEY = "";
if (!SELFTEST) {
  if (env("ESBLU_EINVOICE_LIVE_ENABLED")) stop("ESBLU_EINVOICE_LIVE_ENABLED nesmie byť nastavené");
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string" && v.includes(PROD_REF)) stop(`premenná ${k} odkazuje na produkčný projekt`);
  KEY = env("ESBLU_EFAKTURA_API_KEY");
  if (!KEY.startsWith("efk_pk_test_")) stop("ESBLU_EFAKTURA_API_KEY chýba alebo nie je testovací (efk_pk_test_)");
  if (short(KEY) !== KEY_FP) stop("odtlačok testovacieho kľúča nesedí s partnerským sandbox kľúčom");
  if (env("ESBLU_EFAKTURA_BASE_URL") && !/^https:\/\/api\.efaktura\.sk\/?$/.test(env("ESBLU_EFAKTURA_BASE_URL"))) stop("ESBLU_EFAKTURA_BASE_URL musí byť api.efaktura.sk");
  SUPA_URL = env("ESBLU_STAGING_SUPABASE_URL");
  if (SUPA_URL !== `https://${STAGING_REF}.supabase.co`) stop("ESBLU_STAGING_SUPABASE_URL nie je staging esblu-test");
  SUPA_KEY = env("ESBLU_STAGING_SERVICE_ROLE_KEY");
  if (!SUPA_KEY) stop("chýba ESBLU_STAGING_SERVICE_ROLE_KEY");
  const parts = SUPA_KEY.split(".");
  if (parts.length === 3) {
    let claims: { ref?: string; role?: string } = {};
    try {
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      stop("service-role kľúč nie je platný JWT");
    }
    if (claims.ref !== STAGING_REF || claims.role !== "service_role") stop("service-role kľúč nepatrí stagingu esblu-test (ref/rola)");
  } else if (!SUPA_KEY.startsWith("sb_secret_")) {
    stop("neznámy formát service-role kľúča");
  }
  // Žiadny fallback: implicitný klient (getSupabaseAdmin) by čítal tieto premenné — v procese nesmú existovať.
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_URL"]) delete process.env[k];
  if (!ARGS.has("switch-rollout")) stop("chýba --switch-rollout (dočasné povolenie rolloutu E2E Partner B so spätným prepnutím)");
  console.log(`kľúče: sandbox partner (odtlačok ${KEY_FP} sedí), staging ${STAGING_REF} (service role) — hodnoty sa nevypisujú`);
}

// -----------------------------------------------------------------------------
// Falošný sandbox (iba --offline-selftest): stránkovanie ako reálny sandbox (R1)
// -----------------------------------------------------------------------------
type FakeDoc = { id: string; org: string; xml: Uint8Array; number: string; ack: boolean };
const fakeDocs: FakeDoc[] = [];
async function fakeFetch(input: string, init: RequestInit): Promise<Response> {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  const org = new Headers(init.headers).get("x-organization-id") ?? "";
  const json = (s: number, v: unknown) => new Response(JSON.stringify(v), { status: s, headers: { "content-type": "application/json" } });
  const p = url.pathname;
  if (method === "POST" && p === "/v1/agent/peppol/connector/send") {
    const body = JSON.parse(String(init.body)) as { document: { xmlBase64: string } };
    const xml = new Uint8Array(Buffer.from(body.document.xmlBase64, "base64"));
    const number = /<cbc:ID>([^<]+)<\/cbc:ID>/.exec(new TextDecoder().decode(xml))?.[1] ?? "X";
    fakeDocs.push({ id: randomUUID(), org: ORG_B, xml, number, ack: false });
    return json(200, { data: { status: "queued", invoice_id: randomUUID(), document_id: `${PID_A}#${number}`, send_ready: true } });
  }
  if (method === "GET" && p === "/v1/agent/peppol/received") {
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    const all = fakeDocs.filter((d) => d.org === org && !d.ack).reverse(); // najnovšie prvé
    const data = all.slice(offset, offset + limit).map((d) => ({ id: d.id, sender_participant_id: PID_A, sender_name: "x", sender_ico: null, document_type: "invoice", document_number: d.number, received_at: new Date().toISOString(), acknowledged_at: null, is_test: true }));
    return json(200, { data, meta: { limit, offset, has_more: offset + limit < all.length } });
  }
  const m = /^\/v1\/agent\/peppol\/received\/([^/]+)\/(xml|acknowledge)$/.exec(p);
  if (m) {
    const d = fakeDocs.find((x) => x.id === m[1] && x.org === org);
    if (!d) return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
    if (m[2] === "xml") return new Response(d.xml, { status: 200, headers: { "content-type": "application/xml" } });
    const already = d.ack;
    d.ack = true;
    return json(200, { data: { id: d.id, acknowledged_at: new Date().toISOString(), already_acknowledged: already } });
  }
  return json(404, { error: { code: "NOT_FOUND", message: "Not found" } });
}

// -----------------------------------------------------------------------------
// Poskytovateľ za allowlistom + počítadlo požiadaviek
// -----------------------------------------------------------------------------
type Call = { kind: "list" | "xml" | "ack" | "send" | "status"; status: number };
const calls: Call[] = [];
let hook: (() => Promise<void>) | null = null;
let listCallsInHookPhase = 0;
const guardedFetch = async (input: string, init: RequestInit): Promise<Response> => {
  const url = new URL(input);
  const method = (init.method ?? "GET").toUpperCase();
  const org = new Headers(init.headers).get("x-organization-id") ?? "";
  if (url.protocol !== "https:" || url.hostname !== "api.efaktura.sk") stop(`host ${url.hostname} nie je povolený`);
  const p = url.pathname;
  let kind: Call["kind"];
  if (method === "GET" && p === "/v1/agent/peppol/received") kind = "list";
  else if (method === "GET" && /^\/v1\/agent\/peppol\/received\/[A-Za-z0-9._-]+\/xml$/.test(p)) kind = "xml";
  else if (method === "POST" && /^\/v1\/agent\/peppol\/received\/[A-Za-z0-9._-]+\/acknowledge$/.test(p)) kind = "ack";
  else if (method === "POST" && p === "/v1/agent/peppol/connector/send") kind = "send";
  else if (method === "GET" && /^\/v1\/agent\/peppol\/status\/[^/]+$/.test(p)) kind = "status";
  else stop(`${method} ${p} nie je na allowliste`);
  if ((kind === "list" || kind === "xml" || kind === "ack") && org !== ORG_B) stop(`${kind} iba pre organizáciu B`);
  if ((kind === "send" || kind === "status") && org !== ORG_A) stop(`${kind} iba z organizácie A`);
  if (kind === "send") {
    const body = JSON.parse(String(init.body)) as { document?: { xmlBase64?: string } };
    const text = Buffer.from(body.document?.xmlBase64 ?? "", "base64").toString("utf8");
    const endpoints = [...text.matchAll(/<cbc:EndpointID schemeID="([0-9]{4})">([^<]+)<\/cbc:EndpointID>/g)].map((m) => `${m[1]}:${m[2]}`);
    if (endpoints[0] !== PID_A || endpoints[1] !== PID_B) stop("odosielateľ/príjemca v UBL nie je A → B");
    if (!/<cbc:ID>QA-P14-/.test(text)) stop("odosielaný doklad nie je syntetický QA-P14");
  }
  if (kind === "list" && hook) {
    listCallsInHookPhase++;
    if (listCallsInHookPhase === 2) {
      const h = hook;
      hook = null;
      await h(); // súbežný proces potvrdí doklady MEDZI 1. a 2. stránkou
    }
  }
  const res = SELFTEST ? await fakeFetch(input, init) : await fetch(input, init);
  calls.push({ kind, status: res.status });
  return res;
};
const provider = new EfakturaSkProvider({ apiKey: KEY, environment: "sandbox", fetchImpl: guardedFetch, timeoutMs: 30_000 });
const countCalls = (from: number) => {
  const c: Record<string, number> = { list: 0, xml: 0, ack: 0, send: 0, status: 0, total: 0 };
  for (const x of calls.slice(from)) {
    c[x.kind]++;
    c.total++;
  }
  return c;
};

// -----------------------------------------------------------------------------
// DB vrstva: staging (supabase-js, service role) alebo PGlite (selftest)
// -----------------------------------------------------------------------------
type InRow = { provider_received_id: string; processing_status: string; company_id: string; invoice_id: string | null; xml_sha256: string | null; xml_storage_path: string | null; last_error_code: string | null };
type Db = {
  store: InboundStore;
  orgs(): Promise<{ company_id: string; provider: string; environment: string; provider_org_id: string; participant_id: string | null; reception_status: string | null; peppol_eligible: boolean }[]>;
  billingEnv(): Promise<string | null>;
  inbound(ids: string[]): Promise<InRow[]>;
  invoiceCompanies(ids: string[]): Promise<Record<string, string>>;
  scanState(org: string): Promise<{ last_complete_at: string | null; last_code: string | null; incomplete_streak: number } | null>;
  rateWindows(): Promise<{ window_start: string; used: number; denied: number }[]>;
  health(): Promise<unknown>;
  opsAlerts(): Promise<number>;
  othersFingerprint(): Promise<string>;
  /** brána rolloutu (processing claimuje iba firmy s povoleným rolloutom) */
  rolloutAllowed(company: string): Promise<boolean>;
  /** nedokončené prijaté doklady iných firiem (claim je globálny — musia byť 0) */
  othersPending(): Promise<number>;
  /** odtlačok VŠETKÝCH riadkov einvoice_rollout okrem B (izolácia prepnutia) */
  rolloutOthersFingerprint(): Promise<string>;
  /** podmienené prepnutie rolloutu B (iba sandbox, iba z očakávaného stavu); vracia počet zmenených riadkov */
  setRolloutB(from: "paused" | "internal", to: "paused" | "internal"): Promise<number>;
  rolloutStageB(): Promise<string | null>;
  rolloutUpdatedAtB(): Promise<string | null>;
  /** všetky mapovania organizácií a stavy skenu (malé tabuľky) — nezávislý prepočet scan_overdue */
  orgsAndScans(): Promise<{ orgs: OrgRow[]; scans: ScanRow[] }>;
};
type OrgRow = { provider: string; environment: string; provider_org_id: string | null; peppol_eligible: boolean; reception_status: string | null; created_at: string };
type ScanRow = { provider: string; environment: string; provider_org_id: string; last_complete_at: string | null };

/**
 * Nezávislý prepočet pravidla health `inbound.scan_overdue` (migrácia 20261125100000): aktívny príjem, mapovanie
 * staršie ako 2 h; bez záznamu stavu skenu sa organizácia počíta až keď existuje záznam pre ten istý provider/prostredie
 * (poll s novým kódom beží), inak keď posledný úplný sken chýba alebo je starší ako 2 h.
 */
function overdueOrgs(orgs: OrgRow[], scans: ScanRow[], nowMs = Date.now()): string[] {
  const limit = nowMs - 2 * 3600_000;
  const out: string[] = [];
  for (const o of orgs) {
    if (!o.peppol_eligible || !o.provider_org_id) continue;
    if (o.reception_status !== null && o.reception_status !== "active") continue;
    if (Date.parse(o.created_at) >= limit) continue;
    const row = scans.find((x) => x.provider === o.provider && x.environment === o.environment && x.provider_org_id === o.provider_org_id);
    const overdue = row
      ? row.last_complete_at === null || Date.parse(row.last_complete_at) < limit
      : scans.some((x) => x.provider === o.provider && x.environment === o.environment);
    if (overdue) out.push(o.provider_org_id);
  }
  return out;
}

async function stagingDb(): Promise<Db> {
  const admin: SupabaseClient = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const must = <T>(r: { data: T | null; error: unknown }, what: string): T => {
    if (r.error) stop(`DB ${what}: ${(r.error as { message?: string }).message ?? "chyba"}`);
    return r.data as T;
  };
  return {
    store: createSupabaseInboundStore(admin),
    async orgs() {
      return must(await admin.from("einvoice_organizations").select("company_id, provider, environment, provider_org_id, participant_id, reception_status, peppol_eligible").in("provider_org_id", [ORG_A, ORG_B]), "orgs");
    },
    async billingEnv() {
      const r = must(await admin.from("billing_runtime_config").select("environment").limit(1), "billing_runtime_config") as { environment: string }[];
      return r[0]?.environment ?? null;
    },
    async inbound(ids) {
      if (ids.length === 0) return [];
      return must(await admin.from("einvoice_inbound").select("provider_received_id, processing_status, company_id, invoice_id, xml_sha256, xml_storage_path, last_error_code").eq("provider", PROVIDER).in("provider_received_id", ids), "inbound");
    },
    async invoiceCompanies(ids) {
      if (ids.length === 0) return {};
      const r = must(await admin.from("invoices").select("id, company_id").in("id", ids), "invoices") as { id: string; company_id: string }[];
      return Object.fromEntries(r.map((x) => [x.id, x.company_id]));
    },
    async scanState(org) {
      return must(await admin.from("einvoice_inbound_scan_state").select("last_complete_at, last_code, incomplete_streak").eq("provider", PROVIDER).eq("environment", "sandbox").eq("provider_org_id", org).maybeSingle(), "scan_state");
    },
    async rateWindows() {
      return must(await admin.from("einvoice_provider_rate_window").select("window_start, used, denied").eq("provider", PROVIDER).eq("environment", "sandbox").order("window_start"), "rate_window");
    },
    async health() {
      return must(await admin.rpc("esblu_einvoice_health", { p_stuck_minutes: 60, p_ack_pending_minutes: 60 }), "health");
    },
    async opsAlerts() {
      const r = await admin.from("einvoice_ops_alerts").select("id", { count: "exact", head: true });
      if (r.error) stop("DB ops_alerts");
      return r.count ?? 0;
    },
    async rolloutAllowed(company) {
      return must(await admin.rpc("esblu_einvoice_rollout_allowed", { p_company_id: company, p_environment: "sandbox" }), "rollout") === true;
    },
    async othersPending() {
      const r = await admin.from("einvoice_inbound").select("id", { count: "exact", head: true }).neq("company_id", CO_B).not("processing_status", "in", "(acknowledged,failed)");
      if (r.error) stop("DB others pending");
      return r.count ?? 0;
    },
    async rolloutOthersFingerprint() {
      const r = must(await admin.from("einvoice_rollout").select("company_id, environment, stage, changed_by, updated_at").order("company_id").order("environment"), "rollout fp") as { company_id: string; environment: string }[];
      return sha(JSON.stringify(r.filter((x) => !(x.company_id === CO_B && x.environment === "sandbox")))).slice(0, 16);
    },
    async setRolloutB(from, to) {
      const r = await admin.from("einvoice_rollout")
        // updated_at explicitne: einvoice_rollout nemá touch trigger (audit zmeny); filter mení iba riadok B
        .update({ stage: to, changed_by: "p14-staging-integration", updated_at: new Date().toISOString(), note: to === "internal" ? `P1-4 test ${RUN} — dočasne, automatické vrátenie na paused` : `P1-4 test ${RUN} — vrátené na paused` })
        .eq("company_id", CO_B).eq("environment", "sandbox").eq("stage", from)
        .select("company_id");
      if (r.error) throw new FatalStop(`rollout ${from}→${to}: ${r.error.message}`);
      return (r.data ?? []).length;
    },
    async orgsAndScans() {
      const orgs = must(await admin.from("einvoice_organizations").select("provider, environment, provider_org_id, peppol_eligible, reception_status, created_at"), "orgs (overdue)") as OrgRow[];
      const scans = must(await admin.from("einvoice_inbound_scan_state").select("provider, environment, provider_org_id, last_complete_at"), "scans (overdue)") as ScanRow[];
      return { orgs, scans };
    },
    async rolloutUpdatedAtB() {
      const r = must(await admin.from("einvoice_rollout").select("updated_at").eq("company_id", CO_B).eq("environment", "sandbox").maybeSingle(), "rollout B updated_at") as { updated_at: string } | null;
      return r?.updated_at ?? null;
    },
    async rolloutStageB() {
      const r = must(await admin.from("einvoice_rollout").select("stage").eq("company_id", CO_B).eq("environment", "sandbox").maybeSingle(), "rollout B") as { stage: string } | null;
      return r?.stage ?? null;
    },
    async othersFingerprint() {
      const a = must(await admin.from("einvoice_inbound").select("id, company_id, processing_status, updated_at, invoice_id, xml_sha256").neq("company_id", CO_B).order("id"), "others inbound");
      const b = must(await admin.from("invoices").select("id, company_id, updated_at").neq("company_id", CO_B).order("id"), "others invoices");
      const c = must(await admin.from("einvoice_organizations").select("id, provider_org_id, reception_status, updated_at").order("id"), "orgs fp");
      return sha(JSON.stringify([a, b, c])).slice(0, 16);
    },
  };
}

async function selftestDb(): Promise<Db> {
  const { createPartnerHarness } = await import("./einvoice-partner-harness.ts");
  const h = await createPartnerHarness();
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await h.exec(readFileSync(path.join(root, "supabase/migrations/20261125100000_einvoice_inbound_quarantine.sql"), "utf8"));
  await h.exec(`
    insert into public.companies (id, name) values ('${CO_A}', 'E2E Partner A s.r.o.'), ('${CO_B}', 'E2E Partner B s.r.o.'), ('e2e5a000-0000-4000-8000-0000000000ff', 'Iná firma');
    insert into public.company_billing_profile (company_id, legal_name, ico, dic, ic_dph, address_line1, city, postal_code, country_code, electronic_address, electronic_address_scheme_id)
      values ('${CO_A}', 'E2E Partner A s.r.o.', '33002711', '2054825695', 'SK2054825695', 'Testovacia 1', 'Bratislava', '81101', 'SK', '2054825695', '9915'),
             ('${CO_B}', 'E2E Partner B s.r.o.', '37665880', '2020147507', 'SK2020147507', 'Testovacia 2', 'Košice', '04001', 'SK', '2020147507', '9915');
    insert into public.company_entitlements (company_id, entitlement_key, source, note) values ('${CO_B}', 'einvoice', 'manual', 'p14-selftest');
    insert into public.einvoice_rollout (company_id, environment, stage, changed_by) values ('${CO_B}', 'sandbox', 'paused', 'p14-selftest'), ('${CO_A}', 'sandbox', 'paused', 'p14-selftest');
    -- regresia F7 (staging 2026-11-23): organizácie sú staršie ako 2 h ako na stagingu (vznik 5. 10.) — A s aktívnym
    -- príjmom, ktorú test zámerne neskenuje, je po prvom skene B oprávnene „po termíne“ (scan_overdue = 1)
    insert into public.einvoice_organizations (company_id, provider, environment, provider_org_id, participant_id, org_status, peppol_eligible, reception_status, created_at)
      values ('${CO_A}', '${PROVIDER}', 'sandbox', '${ORG_A}', '${PID_A}', 'aktivne', true, 'active', now() - interval '49 days'),
             ('${CO_B}', '${PROVIDER}', 'sandbox', '${ORG_B}', '${PID_B}', 'aktivne', true, 'active', now() - interval '49 days');
    create table if not exists public.billing_runtime_config (id boolean primary key default true, environment text);
    insert into public.billing_runtime_config (id, environment) values (true, 'test') on conflict do nothing;
  `);
  const svc = async <T>(q: string, p: unknown[] = []) => (await h.asService(() => h.db.query<T>(q, p))).rows;
  const store: InboundStore = {
    ...h.inbound,
    async recordInboundScan(i) {
      await svc("select public.esblu_einvoice_org_record_inbound_scan($1, $2, $3, $4, $5)", [i.provider, i.environment, i.providerOrgId, i.complete, i.code]);
    },
    async inboundScanOrder(p, e) {
      return (await svc<{ a: string[] }>("select public.esblu_einvoice_inbound_scan_order($1, $2) a", [p, e]))[0]?.a ?? [];
    },
    async acquireProviderBudget(p, e, cost, limit) {
      return (await svc<{ ok: boolean }>("select public.esblu_einvoice_rate_acquire($1, $2, $3, $4) ok", [p, e, cost, limit]))[0]?.ok !== false;
    },
  };
  const q = async <T>(text: string, p: unknown[] = []) => (await h.sql<T>(text, p)).rows;
  return {
    store,
    orgs: () => q("select company_id, provider, environment, provider_org_id, participant_id, reception_status, peppol_eligible from public.einvoice_organizations where provider_org_id = any($1)", [[ORG_A, ORG_B]]),
    billingEnv: async () => (await q<{ environment: string }>("select environment from public.billing_runtime_config limit 1"))[0]?.environment ?? null,
    inbound: (ids) => q("select provider_received_id, processing_status, company_id, invoice_id, xml_sha256, xml_storage_path, last_error_code from public.einvoice_inbound where provider = $1 and provider_received_id = any($2)", [PROVIDER, ids]),
    invoiceCompanies: async (ids) => Object.fromEntries((await q<{ id: string; company_id: string }>("select id, company_id from public.invoices where id = any($1)", [ids])).map((r) => [r.id, r.company_id])),
    scanState: async (org) => (await q<{ last_complete_at: string | null; last_code: string | null; incomplete_streak: number }>("select last_complete_at::text, last_code, incomplete_streak from public.einvoice_inbound_scan_state where provider_org_id = $1", [org]))[0] ?? null,
    rateWindows: () => q("select window_start::text, used, denied from public.einvoice_provider_rate_window where provider = $1 order by window_start", [PROVIDER]),
    health: async () => (await svc<{ j: unknown }>("select public.esblu_einvoice_health(60, 60) j"))[0].j,
    // harness neobsahuje migráciu einvoice_ops_alerts (20261122120000) → v selftestu 0
    opsAlerts: async () => (await q<{ n: number }>("select count(*)::int n from pg_class where relname = 'einvoice_ops_alerts'"))[0].n === 0 ? 0 : (await q<{ n: number }>("select count(*)::int n from public.einvoice_ops_alerts"))[0].n,
    rolloutOthersFingerprint: async () => sha(JSON.stringify(await q("select company_id, environment, stage, changed_by, updated_at from public.einvoice_rollout where not (company_id = $1 and environment = 'sandbox') order by company_id, environment", [CO_B]))).slice(0, 16),
    setRolloutB: async (from, to) => (await q<{ company_id: string }>("update public.einvoice_rollout set stage = $1, changed_by = 'p14-staging-integration', updated_at = now() where company_id = $2 and environment = 'sandbox' and stage = $3 returning company_id", [to, CO_B, from])).length,
    orgsAndScans: async () => ({
      orgs: await q<OrgRow>("select provider, environment, provider_org_id, peppol_eligible, reception_status, created_at::text from public.einvoice_organizations"),
      scans: await q<ScanRow>("select provider, environment, provider_org_id, last_complete_at::text from public.einvoice_inbound_scan_state"),
    }),
    rolloutUpdatedAtB: async () => (await q<{ u: string }>("select updated_at::text u from public.einvoice_rollout where company_id = $1 and environment = 'sandbox'", [CO_B]))[0]?.u ?? null,
    rolloutStageB: async () => (await q<{ stage: string }>("select stage from public.einvoice_rollout where company_id = $1 and environment = 'sandbox'", [CO_B]))[0]?.stage ?? null,
    rolloutAllowed: async (c) => (await svc<{ ok: boolean }>("select public.esblu_einvoice_rollout_allowed($1, 'sandbox') ok", [c]))[0]?.ok === true,
    othersPending: async () => (await q<{ n: number }>("select count(*)::int n from public.einvoice_inbound where company_id <> $1 and processing_status not in ('acknowledged', 'failed')", [CO_B]))[0].n,
    othersFingerprint: async () => sha(JSON.stringify(await q("select id, company_id, processing_status, updated_at, invoice_id, xml_sha256 from public.einvoice_inbound where company_id <> $1 order by id", [CO_B]))).slice(0, 16),
  };
}

// -----------------------------------------------------------------------------
// Výsledky
// -----------------------------------------------------------------------------
type Verdict = "PASS" | "FAIL" | "SKIP";
const results: { id: string; label: string; verdict: Verdict; requests: Record<string, number>; evidence: Record<string, unknown> }[] = [];
async function step(id: string, label: string, fn: () => Promise<Record<string, unknown>>) {
  if (results.some((r) => r.verdict === "FAIL" && r.id < id && ["F0", "F1"].includes(r.id))) {
    results.push({ id, label, verdict: "SKIP", requests: {}, evidence: { reason: "zlyhal F0/F1" } });
    console.log(`SKIP  ${id} ${label}`);
    return;
  }
  if (FATAL) throw new FatalStop(FATAL);
  const from = calls.length;
  try {
    // selftest: simulácia zásahu poistky uprostred behu (overenie vrátenia rolloutu)
    if (SELFTEST && ARGS.has(`selftest-fault-${id}`)) await provider.getInboundDocument({ environment: "sandbox", providerOrgId: ORG_A }, "x");
    const evidence = await fn();
    if (FATAL) throw new FatalStop(FATAL);
    results.push({ id, label, verdict: "PASS", requests: countCalls(from), evidence });
    console.log(`PASS  ${id} ${label}  req=${JSON.stringify(countCalls(from))}`);
  } catch (error) {
    if (error instanceof FatalStop || FATAL) throw error instanceof FatalStop ? error : new FatalStop(FATAL!); // STOP ukončí celý beh (rollout sa vráti vo finally)
    const message = (error instanceof Error ? error.message.split("\n")[0] : String(error)).slice(0, 300);
    results.push({ id, label, verdict: "FAIL", requests: countCalls(from), evidence: { error: message } });
    console.log(`FAIL  ${id} ${label}\n      ${message}`);
  }
}

// -----------------------------------------------------------------------------
// Syntetické UBL A → B
// -----------------------------------------------------------------------------
const RUN = Date.now().toString(36).toUpperCase();
const party = (role: "seller" | "buyer", name: string, ico: string, dic: string, street: string, city: string, psc: string, iban: string | null): UblParty => ({
  role, legal_name: name, ico, dic, ic_dph: `SK${dic}`, address_line1: street, address_line2: null, city, postal_code: psc, country_code: "SK",
  iban, bic: null, email: null, electronic_address: dic, electronic_address_scheme_id: "9915",
  legal_registration_id: null, legal_registration_scheme_id: null, vat_identifier: null,
});
function syntheticUbl(n: number): Uint8Array {
  const today = new Date().toISOString().slice(0, 10);
  const s: UblInvoiceSnapshot = {
    invoice: {
      id: randomUUID(), company_id: CO_A, direction: "issued", kind: "regular_invoice", document_status: "finalized",
      invoice_number: `QA-P14-${RUN}-${n}`, issue_date: today, due_date: today, delivery_date: today, tax_point_date: null,
      currency: "EUR", subtotal_amount: 10, vat_total_amount: 2.3, total_amount: 12.3, rounding_amount: 0,
      buyer_reference: `QA-P14-${RUN}`, purchase_order_reference: null, payment_means_code: "30", payment_reference: null, corrects_invoice_id: null,
    },
    // syntetické E2E identity zo stagingu (žiadne reálne osoby); IBAN = ukážkový testovací
    seller: party("seller", "E2E Partner A s.r.o.", "33002711", "2054825695", "Testovacia 1", "Bratislava", "81101", "SK3112000000198742637541"),
    buyer: party("buyer", "E2E Partner B s.r.o.", "37665880", "2020147507", "Testovacia 2", "Košice", "04001", null),
    items: [{ position: 1, description: `QA P1-4 syntetická položka ${n}`, quantity: 1, unit_code: "C62", unit_price: 10, price_mode: "net", vat_category_code: "S", vat_rate: 23, line_net_amount: 10 }],
    taxBreakdowns: [{ vat_category_code: "S", vat_rate: 23, taxable_amount: 10, vat_amount: 2.3, vat_exemption_reason_code: null, vat_exemption_reason_text: null }],
    correctedInvoice: null,
  };
  const r = generateUbl(s);
  if (!r.ok) throw new Error(`UBL: ${r.issues.map((i) => i.code).join(",")}`);
  return r.bytes;
}

// =============================================================================
// Beh
// =============================================================================
const db = SELFTEST ? await selftestDb() : await stagingDb();
// Poll iba pre organizáciu B (A a ostatné organizácie stagingu sa nečítajú ani nepotvrdzujú).
const scopedStore: InboundStore = {
  ...db.store,
  async listOrganizations(p, e) {
    return (await db.store.listOrganizations(p, e)).filter((o) => o.providerOrgId === ORG_B);
  },
};
const deps: InboundDeps = { store: scopedStore, provider, environment: "sandbox" };
const ctxA = { environment: "sandbox" as const, providerOrgId: ORG_A };
const ctxB = { environment: "sandbox" as const, providerOrgId: ORG_B };
const listAllB = async () => {
  const ids: string[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const p = await provider.listUnacknowledgedInboundPage!(ctxB, { limit: 100, offset });
    ids.push(...p.items.map((i) => i.providerReceivedId));
    if (p.hasMore !== true) break;
  }
  return [...new Set(ids)];
};

let hookResult: string[] = [];
let PRE: string[] = []; // nepotvrdené u B pred testom
let OURS: string[] = []; // 7 nových
let FP_OTHERS = "";
let ALERTS_BEFORE = 0;
const savedLimits = { ...INBOUND_RATE_LIMITS };

// -----------------------------------------------------------------------------
// Dočasný rollout E2E Partner B: paused → internal → paused (vrátenie aj pri chybe, STOP, Ctrl+C)
// Mení IBA riadok (company_id = B, environment = sandbox, stage = očakávaný); ostatné riadky sa overia odtlačkom.
// -----------------------------------------------------------------------------
let rolloutSwitched = false;
const RUN_STARTED_MS = Date.now();
const ROLLOUT_OTHERS_BEFORE = await db.rolloutOthersFingerprint();
const rolloutReport: Record<string, unknown> = { others_fp_before: ROLLOUT_OTHERS_BEFORE };
async function revertRollout(reason: string) {
  if (!rolloutSwitched) return;
  for (let i = 0; i < 3 && rolloutSwitched; i++) {
    try {
      const n = await db.setRolloutB("internal", "paused");
      const stage = await db.rolloutStageB();
      rolloutSwitched = stage !== "paused";
      rolloutReport.reverted = { reason, rows: n, stage_after: stage };
    } catch (error) {
      rolloutReport.revert_error = error instanceof Error ? error.message.slice(0, 200) : "chyba";
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  if (rolloutSwitched) console.error("POZOR: rollout B sa nepodarilo vrátiť na paused — vráťte ho ručne (SQL v reporte)");
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void revertRollout(sig).finally(() => process.exit(130));
  });
}

async function scenarios() {
  await step("F0", "invariantné kontroly: staging, mapovanie A/B, test kľúč, žiadne produkčné smerovanie; inventár B", async () => {
    assert.equal(await db.billingEnv(), "test", "billing_runtime_config = test (staging)");
    const o = await db.orgs();
    const a = o.find((x) => x.provider_org_id === ORG_A);
    const b = o.find((x) => x.provider_org_id === ORG_B);
    assert.ok(a && b, "mapovanie A aj B existuje");
    assert.deepEqual([a.company_id, a.provider, a.environment, a.participant_id, a.reception_status, a.peppol_eligible], [CO_A, PROVIDER, "sandbox", PID_A, "active", true]);
    assert.deepEqual([b.company_id, b.provider, b.environment, b.participant_id, b.reception_status, b.peppol_eligible], [CO_B, PROVIDER, "sandbox", PID_B, "active", true]);
    assert.ok(PID_A.startsWith("9915:") && PID_B.startsWith("9915:"), "testovacia schéma 9915 (nie 0245)");
    assert.equal(provider.inboundPagination, "offset");
    // rollout B prepína obal behu (paused → internal → paused); tu sa iba overí, že ho prepol
    assert.equal(await db.rolloutStageB(), "internal", "rollout B je počas testu dočasne internal");
    assert.equal(await db.othersPending(), 0, "žiadne nedokončené doklady iných firiem (claim je globálny)");
    PRE = await listAllB();
    if (PRE.length > 3) throw new Error(`u B je ${PRE.length} nepotvrdených (> 3) — rozhodnutie vlastníka`);
    const preRows = await db.inbound(PRE);
    FP_OTHERS = await db.othersFingerprint();
    ALERTS_BEFORE = await db.opsAlerts();
    return { pre_unacked: PRE.length, pre_known_in_db: preRows.map((r) => r.processing_status), others_fp: FP_OTHERS, ops_alerts: ALERTS_BEFORE };
  });

  await step("F1", `odoslanie ${N_SEND} syntetických faktúr A → B (sandbox), doručenie`, async () => {
    const states: string[] = [];
    for (let n = 1; n <= N_SEND; n++) {
      const ubl = syntheticUbl(n);
      const r = await provider.sendUbl(ctxA, { ubl, ublSha256: sha(ubl), idempotencyKey: `qa-p14-${RUN}-${n}-${"x".repeat(8)}`, receiverParticipantId: PID_B });
      states.push(r.state);
      await sleep(1_500);
    }
    for (let i = 0; i < 36; i++) {
      const now = await listAllB();
      OURS = now.filter((id) => !PRE.includes(id));
      if (OURS.length >= N_SEND) break;
      await sleep(5_000);
    }
    assert.equal(OURS.length, N_SEND, `doručených ${OURS.length}/${N_SEND}`);
    return { send_states: states, delivered: OURS.length, ids: OURS.map(short) };
  });

  await step("F2", "súbeh: počas skenu (strana 3) iný proces potvrdí 2 doklady → kotva chýba → reštart, nič sa nepreskočí", async () => {
    assert.equal(await db.othersPending(), 0, "pred spracovaním: žiadne nedokončené doklady iných firiem");
    hook = async () => {
      // spracovanie (XML → koncept → ACK) najviac 2 už zaregistrovaných dokladov = súbežný webhook/poll
      const r = await runInboundProcessBudget(deps, { maxItems: 2, batchSize: 2 });
      hookResult = r.results.map((x) => `${x.from}>${x.to}:${x.code ?? ""}`);
    };
    listCallsInHookPhase = 0;
    const r = await syncInboundList(deps, [{ providerOrgId: ORG_B }], "poll", { pageSize: 3 });
    hook = null;
    const unacked = await listAllB();
    const rows = await db.inbound(unacked);
    const missing = unacked.filter((id) => !rows.some((x) => x.provider_received_id === id));
    assert.deepEqual(missing.map(short), [], "každý nepotvrdený doklad je zaregistrovaný");
    assert.ok((r.passes ?? 0) >= 2, `prechody ${r.passes} (očakávaný reštart; súbežné spracovanie: ${hookResult.join(" ")})`);
    assert.equal(r.orgsComplete, 1, "sken úplný");
    const st = await db.scanState(ORG_B);
    assert.ok(st?.last_complete_at, "stav skenu: úplný");
    return { passes: r.passes, pages: r.pages, registered: r.registered, already_known: r.alreadyKnown, stopped: r.stopped, acked_during_scan: OURS.length + PRE.length - unacked.length };
  });

  await step("F3", "stránkovanie: strana 3, offset s prekryvom 1, koniec podľa has_more", async () => {
    const n = (await listAllB()).length;
    const from = calls.length;
    const r = await syncInboundList(deps, [{ providerOrgId: ORG_B }], "poll", { pageSize: 3 });
    const lists = countCalls(from).list - 1; // bez kontrolného listAllB nižšie
    const expectedPages = n <= 3 ? 1 : Math.ceil((n - 3) / 2) + 1;
    assert.equal(r.pages, expectedPages, `strán ${r.pages}, očakávané ${expectedPages} pre ${n} dokladov`);
    assert.equal(r.orgsComplete, 1);
    assert.equal(r.registered, 0, "nič nové (všetko známe z F2)");
    void lists;
    return { unacked: n, pages: r.pages, passes: r.passes, already_known: r.alreadyKnown };
  });

  await step("F6", "limiter: sken s limitom 2/min → RATE_LIMITED, okno ≤ 2, zamietnutia zaznamenané (bez claimu dokladov)", async () => {
    // nové okno: čakanie na začiatok ďalšej minúty, aby limit 3 platil pre tento beh
    if (!SELFTEST) await sleep(61_000 - (Date.now() % 60_000));
    INBOUND_RATE_LIMITS.poll = 2;
    INBOUND_RATE_LIMITS.event = 2;
    try {
      // iba sken cez limiter triedy poll (žiadny claim → po zastavení nezostanú doklady v lease)
      const r = await syncInboundList(withInboundRateLimit(deps, "poll"), [{ providerOrgId: ORG_B }], "poll", { pageSize: 2 }); // ≥ 3 strany pri 5 dokladoch
      const w = await db.rateWindows();
      const last = w[w.length - 1];
      const stopped = (r.stopped ?? []).map((x) => x.code);
      assert.ok(stopped.includes("RATE_LIMITED"), `zastavenie limiterom (${stopped.join(",")})`);
      assert.ok(w.every((x) => Number(x.used) <= 60), "žiadne okno nad limit udalostí");
      assert.ok(Number(last.used) <= 2, `okno ${last.used} ≤ 2`);
      assert.ok(Number(last.denied) >= 1, "zamietnutia");
      return { stopped, window: { used: Number(last.used), denied: Number(last.denied) } };
    } finally {
      Object.assign(INBOUND_RATE_LIMITS, savedLimits);
    }
  });

  await step("F4", "spracovanie: XML uložené (SHA-256), koncept vo firme B, ACK presne raz, nemennosť XML", async () => {
    if (!SELFTEST) await sleep(61_000 - (Date.now() % 60_000)); // nové okno limitera
    assert.equal(await db.othersPending(), 0, "pred spracovaním: žiadne nedokončené doklady iných firiem");
    const from = calls.length;
    for (let i = 0; i < 6; i++) {
      const rows = await db.inbound(OURS);
      if (rows.length === N_SEND && rows.every((x) => x.processing_status === "acknowledged")) break;
      await runInboundPoll(deps, { maxItems: 30, requestBudget: 20 });
    }
    const rows = await db.inbound(OURS);
    assert.equal(rows.length, N_SEND);
    assert.deepEqual([...new Set(rows.map((r) => r.processing_status))], ["acknowledged"], "všetky acknowledged");
    assert.ok(rows.every((r) => r.company_id === CO_B), "firma B");
    const invoiceIds = rows.map((r) => r.invoice_id).filter((x): x is string => !!x);
    assert.equal(new Set(invoiceIds).size, N_SEND, "7 rôznych konceptov");
    const comp = await db.invoiceCompanies(invoiceIds);
    assert.ok(invoiceIds.every((id) => comp[id] === CO_B), "koncepty vo firme B");
    // nemennosť: uložené XML (storage) aj op. stiahnuté XML = xml_sha256
    for (const r of rows) {
      const stored = await db.store.getXml(r.xml_storage_path!);
      assert.ok(stored && sha(stored) === r.xml_sha256, "storage = SHA-256");
    }
    const ackCalls = calls.slice(from).filter((c) => c.kind === "ack").length;
    const totalAcks = calls.filter((c) => c.kind === "ack").length;
    assert.ok(totalAcks <= N_SEND + PRE.length, `ACK spolu ${totalAcks} ≤ ${N_SEND + PRE.length} (každý doklad najviac raz)`);
    const stillUnacked = (await listAllB()).filter((id) => OURS.includes(id));
    assert.deepEqual(stillUnacked, [], "u poskytovateľa nepotvrdené 0 z našich");
    return { acknowledged: rows.length, drafts: invoiceIds.length, ack_calls_this_step: ackCalls, ack_calls_total: totalAcks };
  });

  await step("F5", "opakované behy: 2× poll + udalosť s nápovedou → 0 nových, 0 ACK, 0 duplicít", async () => {
    const from = calls.length;
    const r1 = await runInboundPoll(deps, { maxItems: 30, requestBudget: 20 });
    const r2 = await runInboundPoll(deps, { maxItems: 30, requestBudget: 20 });
    const ev = await runInboundEvent(deps, ORG_B, OURS[0]);
    const c = countCalls(from);
    assert.equal(r1.sync.registered + r2.sync.registered + ev.sync.registered, 0);
    assert.equal(c.ack, 0, "žiadny ďalší ACK");
    const rows = await db.inbound(OURS);
    assert.equal(rows.length, N_SEND, "žiadna duplicita");
    assert.equal(new Set(rows.map((r) => r.invoice_id)).size, N_SEND);
    return { registered: 0, requests: c };
  });

  await step("F8", "ochrana cudzích firiem: cudzia/podvrhnutá nápoveda sa nezaregistruje; ostatné firmy nezmenené", async () => {
    const fake = "rcv-foreign-p14-0000";
    const ev = await runInboundEvent(deps, ORG_B, fake);
    assert.equal(ev.sync.hintsRegistered ?? 0, 0);
    assert.equal((await db.inbound([fake])).length, 0);
    const fp = await db.othersFingerprint();
    assert.equal(fp, FP_OTHERS, "riadky ostatných firiem nezmenené");
    return { others_fp_before: FP_OTHERS, others_fp_after: fp };
  });

  await step("F7", "monitoring: health (scan, limiter), vyhodnotenie alertov; uloženie ≠ doručenie", async () => {
    const h = sanitizeHealth(await db.health());
    const alerts = evaluateAlerts(h, DEFAULT_ALERT_THRESHOLDS).map((a) => `${a.code}:${a.severity}`);
    const st = await db.scanState(ORG_B);
    // B (skenovaná testom): úplný sken za posledné 2 h, žiadna séria neúplných, nie je po termíne
    assert.ok(st?.last_complete_at, "B: chýba úplný sken");
    assert.ok(Date.parse(st.last_complete_at!) > Date.now() - 2 * 3600_000, `B: posledný úplný sken ${st.last_complete_at} je starší ako 2 h`);
    assert.equal(Number(st.incomplete_streak), 0, `B: incomplete_streak ${st.incomplete_streak}`);
    const { orgs, scans } = await db.orgsAndScans();
    const overdue = overdueOrgs(orgs, scans);
    assert.ok(!overdue.includes(ORG_B), "B nesmie byť po termíne");
    // celkový scan_overdue = oprávnene oneskorené organizácie mimo testu (test skenuje iba B), nie pevná nula
    assert.equal(h.inbound.scan_overdue, overdue.length, `scan_overdue: health ${h.inbound.scan_overdue}, nezávislý prepočet ${overdue.length}`);
    assert.ok(h.inbound.rate_limited_1h >= 1, `rate_limited_1h ${h.inbound.rate_limited_1h} (očakávané ≥ 1 z F6)`);
    const opsAfter = await db.opsAlerts();
    return {
      overdue_outside_test: overdue.map(short),
      health_inbound: { acknowledged: h.inbound.acknowledged, failed: h.inbound.failed, scan_overdue: h.inbound.scan_overdue, scan_incomplete: h.inbound.scan_incomplete, rate_limited_1h: h.inbound.rate_limited_1h, stuck: h.inbound.stuck },
      alerts_evaluated: alerts,
      ops_alerts_stored_before_after: [ALERTS_BEFORE, opsAfter],
      delivery: "žiadna (bez drainu/e-mailu) — iba vyhodnotenie; perzistenciu robí cron einvoice-maintenance (iba produkcia)",
    };
  });

}

RUNNING = true;
try {
  if ((await db.rolloutStageB()) !== "paused") throw new FatalStop("rollout B nie je v očakávanom stave paused");
  if ((await db.othersPending()) !== 0) throw new FatalStop("iné firmy majú nedokončené prijaté doklady (globálny claim)");
  const switched = await db.setRolloutB("paused", "internal");
  if (switched !== 1) throw new FatalStop(`prepnutie rolloutu zmenilo ${switched} riadkov (očakávaný 1)`);
  rolloutSwitched = true;
  await scenarios();
} catch (error) {
  const message = error instanceof Error ? error.message.slice(0, 300) : String(error);
  results.push({ id: "ABORT", label: "beh zastavený", verdict: "FAIL", requests: {}, evidence: { error: message } });
  console.log(`ABORT ${message}`);
} finally {
  await revertRollout("koniec behu");
  rolloutReport.others_fp_after = await db.rolloutOthersFingerprint();
  rolloutReport.others_unchanged = rolloutReport.others_fp_after === ROLLOUT_OTHERS_BEFORE;
  rolloutReport.stage_b_final = await db.rolloutStageB();
  const bUpdated = await db.rolloutUpdatedAtB();
  // audit: ak sa rollout prepínal, updated_at riadku B musí byť z tohto behu
  rolloutReport.b_updated_at_in_run = !rolloutReport.reverted || (bUpdated !== null && Date.parse(bUpdated) >= RUN_STARTED_MS - 1_000);
  RUNNING = false;
}
if (rolloutReport.others_unchanged !== true || rolloutReport.stage_b_final !== "paused" || rolloutReport.b_updated_at_in_run !== true) {
  results.push({ id: "ROLLOUT", label: "rollout B vrátený, ostatné firmy nezmenené", verdict: "FAIL", requests: {}, evidence: rolloutReport });
} else {
  results.push({ id: "ROLLOUT", label: "rollout B vrátený, ostatné firmy nezmenené", verdict: "PASS", requests: {}, evidence: rolloutReport });
}

// -----------------------------------------------------------------------------
// Súhrn (bez tajomstiev, XML a čitateľných ID)
// -----------------------------------------------------------------------------
const total = countCalls(0);
console.log("\nSÚHRN");
console.log(JSON.stringify({ mode: SELFTEST ? "offline-selftest" : "staging+sandbox", run: RUN, results: results.map((r) => ({ id: r.id, verdict: r.verdict, requests: r.requests, evidence: r.evidence })), provider_requests_total: total }, null, 2));
const failed = results.filter((r) => r.verdict !== "PASS").length;
console.log(`\np14-staging-integration: ${results.length - failed}/${results.length} PASS`);
process.exit(failed > 0 ? 1 : 0);
