// =============================================================================
// P1-5 skupina C — Storage + export na stagingu esblu-test (IBA syntetické firmy QA-P15-*).
// Spúšťa vlastník cez release-backups/p15/run-p15-groupC.ps1 (kľúč iba v prostredí procesu).
//
// Kroky (žiadny výmaz, žiadna deregistrácia, žiadne volanie eFaktura.sk):
//   S0 identita: URL = cjbdijbbcujvmrzezusd, firmy QA-P15-* existujú pod presnými UUID z manifestu
//   S1 upload syntetických súborov fázy A + ORPHAN (upsert:false; existujúci objekt sa iba overí) + overenie SHA-256
//   E1 T1: súbor sa zmení počas exportu (re-upload rovnakých bajtov) → FILES_CHANGED
//   E2 T1: úplný export (emulácia /api/company/export): odtlačok pred čítaním, všetky tabuľky, R3 filter,
//          kontrola počtov voči DB, manifest, begin s p_files, dávky so SHA-256 stiahnutých bajtov → completed
//   E3 ISO: úplný export → completed (iba čítanie súborov)
//   E4 T2: chýbajúce súbory (doc-late, corrupt) → FILES_MISSING
//   S2 T2: upload doc-late + poškodeného XML (iné bajty než xml_sha256 v DB)
//   E5 T2: export → FILES_CORRUPT
//   P1 PERF: export (25 000 faktúr, 300 súborov) — časy
// Výstup: riadky PASS/FAIL + JSON súhrn (žiadne tajomstvá, iba UUID, kódy, počty, časy).
// =============================================================================
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  COMPANY_EXPORT_FILE_SOURCES,
  COMPANY_EXPORT_TABLES,
  COMPANY_EXPORT_FILES_PER_PART,
  exportCountMismatches,
  normalizeExportFiles,
  sliceExportFiles,
  type StorageFileRef,
} from "../../lib/company-export.ts";
import { filterCompanyVisibleEinvoice, visibleToCompany } from "../../lib/einvoice/visibility.ts";

const STAGING_REF = "cjbdijbbcujvmrzezusd";
const PROD_REF = "fkpgvgvsmbpieduoatrt";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_MD5 = "2d4df2f2e2f4e8caece059780f8fde88";

type ManifestFile = { company: string; company_id: string; bucket: string; path: string; sha256: string; bytes: number; kind: string; phase: string; content_b64: string; upload_sha256: string };
type Manifest = { users: Record<string, string>; companies: Record<string, string>; names: Record<string, string>; files: ManifestFile[] };
type Row = Record<string, unknown>;

const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const timings: Record<string, number> = {};
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
function record(id: string, ok: boolean, detail: string) {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`);
}
class Stop extends Error {}

const url = process.env.ESBLU_STAGING_SUPABASE_URL ?? "";
const key = process.env.ESBLU_STAGING_SERVICE_ROLE_KEY ?? "";
if (!url.includes(STAGING_REF) || url.includes(PROD_REF) || !key) {
  console.error("STOP: chýba staging URL/kľúč alebo URL nie je esblu-test");
  process.exit(2);
}
const raw = readFileSync(path.join(HERE, "manifest.json"));
if (createHash("md5").update(raw).digest("hex") !== MANIFEST_MD5) {
  console.error("STOP: manifest.json sa zmenil (md5 nesedí)");
  process.exit(2);
}
const manifest = JSON.parse(raw.toString("utf8")) as Manifest;
const admin: SupabaseClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const C = manifest.companies;
const U = manifest.users;

async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<{ data: T | null; error: { code?: string; message?: string } | null }> {
  const { data, error } = await admin.rpc(fn, args);
  return { data: (data ?? null) as T | null, error: error ? { code: error.code, message: error.message } : null };
}

async function download(bucket: string, p: string): Promise<Uint8Array | null> {
  const { data, error } = await admin.storage.from(bucket).download(p);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

async function upload(f: ManifestFile, opts: { upsert: boolean; bytes?: Uint8Array }) {
  const bytes = opts.bytes ?? new Uint8Array(Buffer.from(f.content_b64, "base64"));
  const contentType = f.path.endsWith(".pdf") ? "application/pdf" : "application/xml";
  const { error } = await admin.storage.from(f.bucket).upload(f.path, bytes, { upsert: opts.upsert, contentType });
  if (error && !opts.upsert && /exist/i.test(error.message)) return "exists";
  if (error) throw new Stop(`upload ${f.kind} ${f.company}: ${error.message}`);
  return "uploaded";
}

// ----------------------------------------------------------------------------- S0
async function identity() {
  const ids = Object.values(C);
  const { data, error } = await admin.from("companies").select("id, name, owner_id").in("id", ids);
  if (error) throw new Stop(`S0 companies: ${error.code}`);
  const rows = (data ?? []) as Row[];
  const ok = rows.length === 4 && rows.every((r) => String(r.name).startsWith("QA-P15-") && Object.values(U).includes(String(r.owner_id)));
  record("S0.identity", ok, `firmy QA-P15 = ${rows.length}/4`);
  if (!ok) throw new Stop("S0: syntetické firmy nesedia s manifestom");
  for (const f of manifest.files) {
    if (!f.path.startsWith(`${f.company_id}/`)) throw new Stop(`S0: cesta mimo prefixu firmy (${f.kind})`);
  }
}

// ----------------------------------------------------------------------------- S1
async function uploadPhase(phases: string[], label: string) {
  const list = manifest.files.filter((f) => phases.includes(f.phase));
  const t0 = performance.now();
  let up = 0, ex = 0, verified = 0;
  for (const f of list) {
    (await upload(f, { upsert: false })) === "exists" ? ex++ : up++;
    const got = await download(f.bucket, f.path);
    if (got && sha(got) === f.upload_sha256) verified++;
  }
  timings[`${label}_ms`] = Math.round(performance.now() - t0);
  record(label, verified === list.length, `súbory ${list.length}, nahraté ${up}, už existovali ${ex}, SHA-256 overené ${verified}/${list.length}`);
  if (verified !== list.length) throw new Stop(`${label}: nesúlad SHA-256 po uploade`);
}

// ----------------------------------------------------------------------------- export (emulácia route)
async function fetchAll(table: string, column: string, values: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200);
    for (let from = 0; ; from += 1000) {
      const q = admin.from(table).select("*");
      const base = chunk.length === 1 ? q.eq(column, chunk[0]) : q.in(column, chunk);
      let { data, error } = await base.order("id", { ascending: true }).range(from, from + 999);
      if (error?.code === "42703") ({ data, error } = await admin.from(table).select("*").in(column, chunk).range(from, from + 999));
      if (error) {
        if (error.code === "42P01" || error.code === "PGRST205") return out;
        throw new Stop(`fetch ${table}: ${error.code}`);
      }
      out.push(...((data ?? []) as Row[]));
      if (!data || data.length < 1000) break;
    }
  }
  return out;
}

async function collectFiles(companyId: string): Promise<StorageFileRef[]> {
  const files: StorageFileRef[] = [];
  for (const src of COMPANY_EXPORT_FILE_SOURCES) {
    const rows = await fetchAll(src.table, "company_id", [companyId]);
    for (const row of rows) {
      if (src.companyVisibleOnly && !visibleToCompany(row as { last_error_code?: string | null })) continue;
      const bucket = src.bucket ?? (src.bucketColumn ? String(row[src.bucketColumn] ?? "") : "");
      const p = String(row[src.pathColumn] ?? "");
      if (bucket && p && p !== "null") files.push({ bucket, path: p });
    }
  }
  return normalizeExportFiles(files);
}

type ExportOutcome = { runId: string | null; status: string; error?: string; files: number; excluded?: unknown; mismatches?: string[]; partsMs?: number[] };

async function runExport(label: string, owner: string, companyId: string, hooks: { afterBegin?: () => Promise<void> } = {}): Promise<ExportOutcome> {
  const t0 = performance.now();
  const fpRes = await rpc<{ fingerprint: string; counts: Record<string, number> }>("esblu_company_export_fingerprint", { p_company_id: companyId });
  timings[`${label}.fingerprint_rpc_ms`] = Math.round(performance.now() - t0);
  if (fpRes.error || !fpRes.data) return { runId: null, status: "error", error: `fingerprint ${fpRes.error?.code}:${fpRes.error?.message}`, files: 0 };
  const t1 = performance.now();
  const invoices = await fetchAll("invoices", "company_id", [companyId]);
  const invoiceIds = invoices.map((r) => String(r.id));
  const exported: Record<string, Row[]> = {};
  for (const spec of COMPANY_EXPORT_TABLES) {
    exported[spec.table] = spec.table === "invoices" ? invoices
      : spec.scope === "self" ? await fetchAll(spec.table, "id", [companyId])
      : spec.scope === "company" ? await fetchAll(spec.table, "company_id", [companyId])
      : invoiceIds.length ? await fetchAll(spec.table, "invoice_id", invoiceIds) : [];
  }
  const visible = filterCompanyVisibleEinvoice({ inbound: exported.einvoice_inbound ?? [], events: exported.einvoice_events ?? [] });
  exported.einvoice_inbound = visible.inbound;
  exported.einvoice_events = visible.events;
  const counts = Object.fromEntries(Object.entries(exported).map(([k, v]) => [k, v.length]));
  const mismatches = exportCountMismatches(fpRes.data.counts, counts);
  timings[`${label}.data_read_ms`] = Math.round(performance.now() - t1);
  const files = await collectFiles(companyId);
  const manifestJson = JSON.stringify({ kind: "esblu_company_export", company_id: companyId, counts, excluded_counts: visible.hidden, data_fingerprint: fpRes.data.fingerprint, files_total: files.length });
  if (mismatches.length) return { runId: null, status: "incomplete", error: mismatches.join(","), files: files.length, excluded: visible.hidden, mismatches };
  const parts = files.length ? Math.ceil(files.length / COMPANY_EXPORT_FILES_PER_PART) : 0;
  const t2 = performance.now();
  const begin = await rpc<string>("esblu_company_export_begin", {
    p_user_id: owner, p_company_id: companyId, p_schema_version: "2026-11-23.gdpr2-isolation", p_files_total: files.length, p_file_parts: parts,
    p_data_sha256: sha(manifestJson), p_manifest_sha256: sha(manifestJson), p_expected_fingerprint: fpRes.data.fingerprint,
    p_files: files.map((f) => ({ bucket: f.bucket, path: f.path })),
  });
  timings[`${label}.begin_ms`] = Math.round(performance.now() - t2);
  if (begin.error || !begin.data) return { runId: null, status: "begin_error", error: `${begin.error?.code}:${begin.error?.message}`, files: files.length, excluded: visible.hidden };
  const runId = String(begin.data);
  if (hooks.afterBegin) await hooks.afterBegin();
  let status = parts === 0 ? "completed" : "in_progress";
  const partsMs: number[] = [];
  for (let i = 0; i < parts; i++) {
    const tp = performance.now();
    const batch = sliceExportFiles(files, i);
    const evidence: Array<{ bucket: string; path: string; sha256: string; bytes: string }> = [];
    const missing: StorageFileRef[] = [];
    for (const f of batch) {
      const bytes = await download(f.bucket, f.path);
      if (!bytes) missing.push(f);
      else evidence.push({ bucket: f.bucket, path: f.path, sha256: sha(bytes), bytes: String(bytes.byteLength) });
    }
    const part = await rpc<string>("esblu_company_export_part_files", {
      p_export_id: runId, p_user_id: owner, p_company_id: companyId, p_index: i, p_files: evidence, p_missing: missing,
      p_part_sha256: sha(JSON.stringify(evidence)),
    });
    partsMs.push(Math.round(performance.now() - tp));
    if (part.error) return { runId, status: "part_error", error: `${part.error.code}:${part.error.message}`, files: files.length, excluded: visible.hidden, partsMs };
    status = String(part.data);
    if (status === "failed") break;
  }
  timings[`${label}.total_ms`] = Math.round(performance.now() - t0);
  return { runId, status, files: files.length, excluded: visible.hidden, mismatches, partsMs };
}

async function runError(runId: string | null): Promise<string | null> {
  if (!runId) return null;
  const { data } = await admin.from("company_export_runs").select("status, error_code, missing_files").eq("id", runId).maybeSingle();
  return data ? `${(data as Row).status}:${(data as Row).error_code ?? "-"}` : null;
}

async function main() {
  try {
    await identity();
    await uploadPhase(["A", "ORPHAN"], "S1.upload_phase_A");

    // E1: zmena súboru počas exportu
    const t1doc = manifest.files.find((f) => f.company === "t1" && f.kind === "pdf_document")!;
    const e1 = await runExport("E1", U.t1, C.t1, { afterBegin: async () => { await upload(t1doc, { upsert: true }); } });
    record("E1.t1_change_during_export", e1.status === "failed" && (await runError(e1.runId)) === "failed:FILES_CHANGED", `${e1.status} ${await runError(e1.runId)}`);

    // E2: úplný export T1
    const e2 = await runExport("E2", U.t1, C.t1);
    const ex2 = e2.excluded as { einvoice_inbound: number; einvoice_events: number } | undefined;
    record("E2.t1_export_completed", e2.status === "completed", `${e2.status} súbory=${e2.files} ${e2.error ?? ""}`);
    record("E2.t1_r3_excluded", ex2?.einvoice_inbound === 1 && ex2?.einvoice_events === 1, `excluded=${JSON.stringify(ex2)}`);
    record("E2.t1_counts_match_db", (e2.mismatches ?? ["?"]).length === 0, `nezhody=${JSON.stringify(e2.mismatches)}`);
    const files2 = await collectFiles(C.t1);
    const leak = files2.filter((f) => f.path.includes("mismatch") || f.path.includes("/orphan/") || !f.path.startsWith(`${C.t1}/`));
    record("E2.t1_files_isolated", files2.length === 5 && leak.length === 0, `súbory=${files2.length}, R3/osirelé/cudzie=${leak.length}`);
    if (e2.runId) {
      const { data } = await admin.from("company_export_run_files").select("bucket, path, sha256, expected_sha256").eq("run_id", e2.runId);
      const rows = (data ?? []) as Row[];
      const bySha = new Map(manifest.files.map((f) => [`${f.bucket}/${f.path}`, f.sha256]));
      const okSha = rows.filter((r) => bySha.get(`${r.bucket}/${r.path}`) === r.sha256).length;
      const okExpected = rows.filter((r) => r.expected_sha256 === null || r.expected_sha256 === r.sha256).length;
      record("E2.t1_sha256_bound_to_run", rows.length === 5 && okSha === 5 && okExpected === 5, `riadky=${rows.length}, SHA=manifest ${okSha}/5, SHA=DB originál ${okExpected}/5`);
    }

    // E3: ISO
    const e3 = await runExport("E3", U.iso, C.iso);
    record("E3.iso_export_completed", e3.status === "completed", `${e3.status} súbory=${e3.files} ${e3.error ?? ""}`);

    // E4: T2 chýbajúce súbory
    const e4 = await runExport("E4", U.t2, C.t2);
    record("E4.t2_missing_files", e4.status === "failed" && (await runError(e4.runId)) === "failed:FILES_MISSING", `${e4.status} ${await runError(e4.runId)}`);

    // S2 + E5: T2 poškodený originál
    await uploadPhase(["T2_LATE"], "S2.upload_t2_late");
    const corrupt = manifest.files.find((f) => f.phase === "T2_CORRUPT")!;
    await upload(corrupt, { upsert: false });
    const got = await download(corrupt.bucket, corrupt.path);
    record("S2.upload_t2_corrupt", !!got && sha(got) === corrupt.upload_sha256 && corrupt.upload_sha256 !== corrupt.sha256, "uložené bajty ≠ xml_sha256 v DB (zámerne)");
    const e5 = await runExport("E5", U.t2, C.t2);
    record("E5.t2_corrupt_original", e5.status === "failed" && (await runError(e5.runId)) === "failed:FILES_CORRUPT", `${e5.status} ${await runError(e5.runId)}`);

    // P1: PERF
    const p1 = await runExport("P1", U.perf, C.perf);
    record("P1.perf_export_completed", p1.status === "completed", `${p1.status} súbory=${p1.files} dávky=${JSON.stringify(p1.partsMs)} ${p1.error ?? ""}`);
  } catch (error) {
    const msg = error instanceof Stop ? error.message : error instanceof Error ? error.message.slice(0, 200) : String(error);
    record("ABORT", false, msg);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ summary: { passed, total: results.length }, timings, results }, null, 1));
  console.log(`p15-groupC: ${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
}

await main();
