// =============================================================================
// P1-5 skupina C — jadro runnera (bez sieťových závislostí; backend je injektovaný → offline testy).
//
// Bezpečnostné invarianty (audit 2026-11-24, F-1 … F-6):
//   F-3  povolený je IBA origin https://cjbdijbbcujvmrzezusd.supabase.co (presná zhoda, bez cesty, portu,
//        používateľa, query); každá požiadavka ide cez guardedFetch (iný origin = výnimka, redirect = 'error').
//   F-4  odtlačky lokálnych súborov (manifest, knižnice) sa overia pred použitím kľúča (ps1 aj runner).
//   F-5  proces Node musí bežať bez NODE_OPTIONS / NODE_PATH / proxy / TLS výnimiek a s presnými execArgv.
//   F-6  každý súbor manifestu: company_id ∈ 4 schválené UUID (napevno v kóde), cesta = "<company_id>/…",
//        mapovanie firma ↔ UUID = schválené; DB: firma/vlastník, zoznam súborov exportu, R3 a osirelé súbory
//        musia presne zodpovedať manifestu.
//   F-2  stav každého objektu sa klasifikuje (missing / valid / known_corrupt / unexpected); neočakávaný obsah
//        = STOP, nikdy sa neprepíše. Prepis existujúceho objektu iba cez replaceControlled() s pevným dôvodom
//        a iba pre presne určenú cestu.
//   F-1  test poškodeného originálu: najprv preukázateľne FILES_CORRUPT, potom obnova presných bajtov, overenie
//        SHA-256 a úspešný export T2; pri zlyhaní (aj pri prerušení — finally) KRITICKÝ FAIL.
// Runner nikdy nemaže (backend nemá operáciu remove) a nevolá nič mimo Supabase stagingu.
// =============================================================================
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  COMPANY_EXPORT_FILE_SOURCES,
  COMPANY_EXPORT_FILES_PER_PART,
  COMPANY_EXPORT_TABLES,
  exportCountMismatches,
  normalizeExportFiles,
  sliceExportFiles,
  type StorageFileRef,
} from "../../lib/company-export.ts";
import { filterCompanyVisibleEinvoice, visibleToCompany } from "../../lib/einvoice/visibility.ts";

export const STAGING_REF = "cjbdijbbcujvmrzezusd";
export const ALLOWED_ORIGIN = `https://${STAGING_REF}.supabase.co`;
export const PROD_REF = "fkpgvgvsmbpieduoatrt";
/** Jediné firmy, s ktorými runner smie pracovať (napevno — nie z manifestu). */
export const APPROVED_COMPANIES: Readonly<Record<string, string>> = Object.freeze({
  t1: "f1510000-0000-4000-8000-000000000001",
  t2: "f1510000-0000-4000-8000-000000000002",
  iso: "f1510000-0000-4000-8000-000000000003",
  perf: "f1510000-0000-4000-8000-000000000004",
});
export const APPROVED_NAMES: Readonly<Record<string, string>> = Object.freeze({ t1: "QA-P15-T1", t2: "QA-P15-T2", iso: "QA-P15-ISO", perf: "QA-P15-PERF" });
export const APPROVED_OWNERS: Readonly<Record<string, string>> = Object.freeze({
  t1: "f1500000-0000-4000-8000-000000000101",
  t2: "f1500000-0000-4000-8000-000000000102",
  iso: "f1500000-0000-4000-8000-000000000103",
  perf: "f1500000-0000-4000-8000-000000000104",
});
/** SHA-256 lokálnych súborov, ktoré runner načíta (F-4; ps1 kontroluje to isté + runner samotný). */
export const EXPECTED_LOCAL_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "scripts/p15-staging/manifest.json": "fd81a8f55f12c46a488f58441c7ef411a3620f50499f13b86f3804fba0b77d51",
  "lib/company-export.ts": "96adf813c4e03ba2ec15132900fa53dab6b582b584d016715edfc0a73f034eac",
  "lib/einvoice/visibility.ts": "7013c5f61aa819e6d299fd4eeeef9c9a65fc59cebf634d381756c54f1f14a5d2",
  "scripts/p15-staging/dependency-lock.json": "51c7b7fccbad2c2f844ce2a873dafaa68bb9c2c9c31decf8b999a95b1df4d632",
});
const ALLOWED_BUCKETS = new Set(["einvoice-documents", "ai-inbox-documents"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class Stop extends Error {}
export class Critical extends Error {}
export type Row = Record<string, unknown>;
export type ManifestFile = {
  company: string; company_id: string; bucket: string; path: string; sha256: string; bytes: number;
  kind: string; phase: string; content_b64: string; upload_sha256: string;
};
export type Manifest = { users: Record<string, string>; companies: Record<string, string>; names: Record<string, string>; files: ManifestFile[] };

export interface Backend {
  /** select * from table where column in (values) [order by id] limit/offset — iba čítanie. */
  selectIn(table: string, column: string, values: string[], from: number, to: number, orderById: boolean): Promise<{ rows: Row[]; error?: { code?: string; message?: string } }>;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;
  /** bytes = null a error = undefined → objekt neexistuje; error → stav neznámy. */
  download(bucket: string, path: string): Promise<{ bytes: Uint8Array | null; error?: string }>;
  upload(bucket: string, path: string, bytes: Uint8Array, upsert: boolean, contentType: string): Promise<{ status: "uploaded" | "exists" | "error"; error?: string }>;
}

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ----------------------------------------------------------------------------- F-3
export function validateStagingUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Stop("F-3: neplatná URL projektu");
  }
  if (raw !== ALLOWED_ORIGIN || u.origin !== ALLOWED_ORIGIN || u.username || u.password || u.port || (u.pathname !== "/" && u.pathname !== "")
      || u.search || u.hash || raw.includes(PROD_REF)) {
    throw new Stop("F-3: URL nie je presne povolený staging projekt");
  }
  return ALLOWED_ORIGIN;
}

/** fetch, ktorý pustí iba povolený origin a zakáže presmerovanie (iný projekt / hostiteľ = výnimka). */
export function guardedFetch(inner: typeof fetch = fetch): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    let origin: string;
    try {
      origin = new URL(target).origin;
    } catch {
      throw new Stop("F-3: neplatná cieľová URL požiadavky");
    }
    if (origin !== ALLOWED_ORIGIN) throw new Stop("F-3: požiadavka mimo povoleného projektu zablokovaná");
    return inner(input, { ...(init ?? {}), redirect: "error" });
  }) as typeof fetch;
}

// ----------------------------------------------------------------------------- F-5
const FORBIDDEN_ENV = [/^NODE_OPTIONS$/i, /^NODE_PATH$/i, /^NODE_EXTRA_CA_CERTS$/i, /^NODE_TLS_REJECT_UNAUTHORIZED$/i, /^NODE_USE_ENV_PROXY$/i,
  /^NODE_REPL_EXTERNAL_MODULE$/i, /^NODE_PENDING_DEPRECATION$/i, /^NODE_V8_COVERAGE$/i, /^NODE_DEBUG$/i, /^NODE_DEBUG_NATIVE$/i,
  /^(HTTP|HTTPS|ALL|NO)_PROXY$/i, /^UV_THREADPOOL_SIZE$/i, /^SSL_CERT_(FILE|DIR)$/i, /^NPM_CONFIG_/i];
export const EXPECTED_EXEC_ARGV = ["--experimental-strip-types", "--no-warnings"];
export function assertCleanProcess(env: Record<string, string | undefined>, execArgv: string[]): void {
  const bad = Object.keys(env).filter((k) => env[k] !== undefined && FORBIDDEN_ENV.some((re) => re.test(k)));
  if (bad.length) throw new Stop(`F-5: nepovolené premenné prostredia procesu Node: ${bad.sort().join(",")}`);
  if (execArgv.length !== EXPECTED_EXEC_ARGV.length || execArgv.some((a, i) => a !== EXPECTED_EXEC_ARGV[i])) {
    throw new Stop(`F-5: nečakané parametre Node (${execArgv.join(" ")})`);
  }
}

// ----------------------------------------------------------------------------- F-4
export function verifyLocalIntegrity(root: string, expected: Readonly<Record<string, string>> = EXPECTED_LOCAL_SHA256): void {
  for (const [rel, want] of Object.entries(expected)) {
    let got: string;
    try {
      got = sha256(readFileSync(path.join(root, rel)));
    } catch {
      throw new Stop(`F-4: chýba ${rel}`);
    }
    if (got !== want) throw new Stop(`F-4: SHA-256 nesedí pre ${rel}`);
  }
}

/**
 * Graf závislostí (dependency-lock.json): každý skutočne načítaný modul + package.json balíkov má očakávaný SHA-256
 * a voliteľné balíky, ktoré by sa načítali dynamicky (napr. @opentelemetry/api), nesmú existovať.
 * Primárna kontrola je v .ps1 PRED spustením Node; runner ju opakuje pri štarte (obrana do hĺbky).
 */
export function verifyDependencyLock(root: string): void {
  let lock: { files: Record<string, string>; supabase_tree: Record<string, string>; absent: string[] };
  try {
    lock = JSON.parse(readFileSync(path.join(root, "scripts/p15-staging/dependency-lock.json"), "utf8"));
  } catch {
    throw new Stop("F-4: chýba dependency-lock.json");
  }
  for (const [rel, want] of Object.entries(lock.files ?? {})) {
    let got: string;
    try {
      got = sha256(readFileSync(path.join(root, rel)));
    } catch {
      throw new Stop(`F-4: chýba závislosť ${rel}`);
    }
    if (got !== want) throw new Stop(`F-4: závislosť sa zmenila: ${rel}`);
  }
  // Celý strom node_modules/@supabase: presná množina súborov (chýbajúci aj nadbytočný = STOP) a obsah každého súboru.
  // Porovnanie po súboroch — žiadne poradie ani spájanie reťazcov (rovnaký výsledok na Windows aj Linuxe).
  const tree = lock.supabase_tree ?? {};
  if (Object.keys(tree).length === 0) throw new Stop("F-4: lock neobsahuje strom @supabase");
  const onDisk = listSupabaseTree(root);
  const expected = new Set(Object.keys(tree));
  const extra = onDisk.filter((r) => !expected.has(r));
  const missing = [...expected].filter((r) => !onDisk.includes(r));
  if (extra.length || missing.length) throw new Stop(`F-4: strom @supabase nesedí (navyše ${extra.length}, chýba ${missing.length}: ${[...extra, ...missing].slice(0, 3).join(", ")})`);
  for (const [rel, want] of Object.entries(tree)) {
    if (sha256(readFileSync(path.join(root, rel))) !== want) throw new Stop(`F-4: súbor @supabase sa zmenil: ${rel}`);
  }
  for (const rel of lock.absent ?? []) {
    if (existsSync(path.join(root, rel))) throw new Stop(`F-4: nečakaný balík (dynamicky načítateľný): ${rel}`);
  }
}

/** node_modules/@supabase/<balík>/package.json + všetky súbory v <balík>/dist (relatívne k root, oddeľovač "/"). */
export function listSupabaseTree(root: string): string[] {
  const base = path.join(root, "node_modules", "@supabase");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  for (const pkg of readdirSync(base, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    if (existsSync(path.join(base, pkg.name, "package.json"))) out.push(`node_modules/@supabase/${pkg.name}/package.json`);
    if (existsSync(path.join(base, pkg.name, "dist"))) walk(path.join(base, pkg.name, "dist"));
  }
  return out.sort();
}

// ----------------------------------------------------------------------------- F-6 (manifest)
export function validateManifest(m: Manifest): void {
  const approvedIds = new Set(Object.values(APPROVED_COMPANIES));
  const keys = Object.keys(APPROVED_COMPANIES).sort();
  if (JSON.stringify(Object.keys(m.companies ?? {}).sort()) !== JSON.stringify(keys)) throw new Stop("F-6: manifest má iné firmy");
  for (const k of keys) {
    if (m.companies[k] !== APPROVED_COMPANIES[k] || m.names?.[k] !== APPROVED_NAMES[k] || m.users?.[k] !== APPROVED_OWNERS[k]) {
      throw new Stop(`F-6: mapovanie firmy ${k} nezodpovedá schváleným UUID`);
    }
  }
  const seen = new Set<string>();
  for (const f of m.files ?? []) {
    const id = `${f.bucket}/${f.path}`;
    if (seen.has(id)) throw new Stop("F-6: duplicitná cesta v manifeste");
    seen.add(id);
    if (!approvedIds.has(f.company_id) || APPROVED_COMPANIES[f.company] !== f.company_id) throw new Stop("F-6: súbor s cudzím company_id");
    if (!f.path.startsWith(`${f.company_id}/`) || f.path.includes("..") || f.path.includes("//") || /[\\\0]/.test(f.path)) {
      throw new Stop("F-6: cesta mimo prefixu firmy");
    }
    if (!ALLOWED_BUCKETS.has(f.bucket)) throw new Stop("F-6: nepovolený bucket");
    const bytes = Buffer.from(f.content_b64, "base64");
    if (sha256(bytes) !== f.upload_sha256 || bytes.byteLength > 64 * 1024) throw new Stop("F-6: obsah manifestu nesedí so SHA-256 / veľkosťou");
    if (f.phase === "T2_CORRUPT") {
      if (f.company !== "t2" || f.sha256 === f.upload_sha256) throw new Stop("F-6: chybná definícia poškodeného súboru");
    } else if (f.sha256 !== f.upload_sha256) throw new Stop("F-6: SHA-256 súboru nesedí");
  }
  if ((m.files ?? []).length !== 322) throw new Stop("F-6: manifest nemá 322 súborov");
}

/** Správne (pôvodné) bajty súboru — pre poškodený cieľ sú to bajty s SHA = xml_sha256 v DB. */
export function goodBytes(f: ManifestFile): Uint8Array {
  if (f.phase !== "T2_CORRUPT") return new Uint8Array(Buffer.from(f.content_b64, "base64"));
  const bad = Buffer.from(f.content_b64, "base64").toString("utf8");
  const good = Buffer.from(bad.replace("CORRUPTED", "SYNTHETIC"), "utf8");
  if (sha256(good) !== f.sha256) throw new Stop("F-1: nedá sa odvodiť pôvodný obsah poškodeného súboru");
  return new Uint8Array(good);
}
export const corruptBytes = (f: ManifestFile) => new Uint8Array(Buffer.from(f.content_b64, "base64"));

// ----------------------------------------------------------------------------- runner
export type Outcome = { id: string; status: "PASS" | "FAIL" | "SKIP"; detail: string };
export type RunOptions = { log?: (line: string) => void; skipPerf?: boolean };

export class Runner {
  readonly results: Outcome[] = [];
  readonly timings: Record<string, number> = {};
  private corruptInjected = false;
  private readonly be: Backend;
  private readonly m: Manifest;
  private readonly opts: RunOptions;
  constructor(be: Backend, m: Manifest, opts: RunOptions = {}) {
    validateManifest(m);
    this.be = be;
    this.m = m;
    this.opts = opts;
  }
  private log(s: string) { (this.opts.log ?? console.log)(s); }
  record(id: string, status: Outcome["status"], detail: string) {
    this.results.push({ id, status, detail });
    this.log(`${status} ${id} ${detail}`);
  }
  private file(pred: (f: ManifestFile) => boolean): ManifestFile {
    const f = this.m.files.find(pred);
    if (!f) throw new Stop("manifest: súbor nenájdený");
    return f;
  }
  private assertManifestPath(bucket: string, p: string): ManifestFile {
    const f = this.m.files.find((x) => x.bucket === bucket && x.path === p);
    if (!f) throw new Stop("F-6: zápis mimo manifestu zablokovaný");
    return f;
  }

  // --- stav objektu (F-2)
  async classify(f: ManifestFile): Promise<"missing" | "valid" | "known_corrupt" | "unexpected"> {
    const { bytes, error } = await this.be.download(f.bucket, f.path);
    if (error) throw new Stop(`stav objektu neznámy (${f.kind}): ${error}`);
    if (!bytes) return "missing";
    const h = sha256(bytes);
    if (h === f.sha256) return "valid";
    if (f.phase === "T2_CORRUPT" && h === f.upload_sha256) return "known_corrupt";
    return "unexpected";
  }
  /** Nový objekt (upsert:false). Ak medzitým vznikol, overí sa obsah — nikdy sa neprepíše. */
  private async putNew(f: ManifestFile, bytes: Uint8Array, expectSha: string) {
    this.assertManifestPath(f.bucket, f.path);
    const r = await this.be.upload(f.bucket, f.path, bytes, false, f.path.endsWith(".pdf") ? "application/pdf" : "application/xml");
    if (r.status === "error") throw new Stop(`upload ${f.kind}: ${r.error}`);
    const got = await this.be.download(f.bucket, f.path);
    if (!got.bytes || sha256(got.bytes) !== expectSha) throw new Stop(`po uploade nesedí SHA-256 (${f.kind})`);
  }
  /** Kontrolovaný prepis existujúceho syntetického objektu — iba pevné dôvody a presné cesty. */
  async replaceControlled(reason: "E1_same_bytes" | "E5_inject_corrupt" | "E5_restore", f: ManifestFile, bytes: Uint8Array) {
    this.assertManifestPath(f.bucket, f.path);
    const allowed = (reason === "E1_same_bytes" && f.company === "t1" && f.kind === "pdf_document" && sha256(bytes) === f.sha256)
      || (reason === "E5_inject_corrupt" && f.phase === "T2_CORRUPT" && sha256(bytes) === f.upload_sha256)
      || (reason === "E5_restore" && f.phase === "T2_CORRUPT" && sha256(bytes) === f.sha256);
    if (!allowed) throw new Stop(`F-2: nepovolený prepis (${reason})`);
    const r = await this.be.upload(f.bucket, f.path, bytes, true, f.path.endsWith(".pdf") ? "application/pdf" : "application/xml");
    if (r.status !== "uploaded") throw new Stop(`prepis ${reason}: ${r.error ?? r.status}`);
    const got = await this.be.download(f.bucket, f.path);
    if (!got.bytes || sha256(got.bytes) !== sha256(bytes)) throw new Stop(`po prepise ${reason} nesedí SHA-256`);
  }

  // --- S0 identita a zhoda DB ↔ manifest (F-6)
  async identity() {
    const ids = Object.values(APPROVED_COMPANIES);
    const { rows, error } = await this.be.selectIn("companies", "id", ids, 0, 9, false);
    if (error) throw new Stop(`S0: čítanie firiem zlyhalo (${error.code ?? "?"})`);
    const ok = rows.length === 4 && Object.entries(APPROVED_COMPANIES).every(([k, id]) => rows.some((r) => r.id === id && r.name === APPROVED_NAMES[k] && r.owner_id === APPROVED_OWNERS[k]));
    if (!ok) throw new Stop("S0: syntetické firmy nesedia so schválenými UUID");
    for (const [k, id] of Object.entries(APPROVED_COMPANIES)) {
      const list = await this.be.rpc("esblu_company_export_file_list", { p_company_id: id });
      if (list.error) throw new Stop(`S0: zoznam súborov ${k} (${list.error.code})`);
      const db = ((list.data ?? []) as Row[]).map((r) => `${r.bucket}|${r.path}|${r.expected_sha256 ?? ""}`).sort();
      const man = this.m.files.filter((f) => f.company === k && f.kind !== "orphan" && f.kind !== "xml_recipient_mismatch")
        .map((f) => `${f.bucket}|${f.path}|${f.bucket === "einvoice-documents" ? f.sha256 : ""}`).sort();
      if (JSON.stringify(db) !== JSON.stringify(man)) throw new Stop(`S0: DB zoznam súborov ${k} ≠ manifest`);
      const inbound = await this.be.selectIn("einvoice_inbound", "company_id", [id], 0, 9999, false);
      if (inbound.error) throw new Stop(`S0: einvoice_inbound ${k}`);
      for (const f of this.m.files.filter((x) => x.company === k)) {
        const refs = inbound.rows.filter((r) => r.xml_storage_path === f.path);
        if (f.kind === "xml_recipient_mismatch" && !(refs.length === 1 && refs[0].last_error_code === "RECIPIENT_MISMATCH")) throw new Stop(`S0: R3 súbor ${k} nezodpovedá DB`);
        if (f.kind === "orphan" && refs.length !== 0) throw new Stop(`S0: osirelý súbor ${k} je v DB`);
      }
    }
    this.record("S0.identity_db_manifest", "PASS", "4 schválené firmy, vlastníci, zoznamy súborov, R3 a osirelé = manifest");
  }

  // --- S1 upload (F-2)
  async ensurePhase(phases: string[], label: string) {
    const counts = { uploaded: 0, valid: 0 };
    for (const f of this.m.files.filter((x) => phases.includes(x.phase))) {
      const st = await this.classify(f);
      if (st === "unexpected") throw new Stop(`F-2: neočakávaný obsah objektu (${f.company}/${f.kind}) — neprepisuje sa`);
      if (st === "known_corrupt") throw new Stop("F-2: poškodený objekt mimo testu");
      if (st === "valid") counts.valid++;
      else { await this.putNew(f, goodBytes(f), f.sha256); counts.uploaded++; }
    }
    this.record(label, "PASS", `nahraté ${counts.uploaded}, už platné ${counts.valid}`);
  }

  // --- export (emulácia /api/company/export)
  private async fetchAll(table: string, column: string, values: string[]): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = 0; i < values.length; i += 200) {
      const chunk = values.slice(i, i + 200);
      for (let from = 0; ; from += 1000) {
        let r = await this.be.selectIn(table, column, chunk, from, from + 999, true);
        if (r.error?.code === "42703") r = await this.be.selectIn(table, column, chunk, from, from + 999, false);
        if (r.error) {
          if (r.error.code === "42P01" || r.error.code === "PGRST205") return out;
          throw new Stop(`čítanie ${table}: ${r.error.code}`);
        }
        out.push(...r.rows);
        if (r.rows.length < 1000) break;
      }
    }
    return out;
  }
  async collectFiles(companyId: string): Promise<StorageFileRef[]> {
    const files: StorageFileRef[] = [];
    for (const src of COMPANY_EXPORT_FILE_SOURCES) {
      for (const row of await this.fetchAll(src.table, "company_id", [companyId])) {
        if (src.companyVisibleOnly && !visibleToCompany(row as { last_error_code?: string | null })) continue;
        const bucket = src.bucket ?? (src.bucketColumn ? String(row[src.bucketColumn] ?? "") : "");
        const v = row[src.pathColumn];
        if (bucket && typeof v === "string" && v) files.push({ bucket, path: v });
      }
    }
    return normalizeExportFiles(files);
  }
  async runExport(label: string, key: string, hooks: { afterBegin?: () => Promise<void>; failPartAt?: number } = {}) {
    const companyId = APPROVED_COMPANIES[key];
    const owner = APPROVED_OWNERS[key];
    const t0 = Date.now();
    const fp = await this.be.rpc("esblu_company_export_fingerprint", { p_company_id: companyId });
    if (fp.error || !fp.data) return { runId: null as string | null, status: "error", error: `fingerprint ${fp.error?.code}`, files: 0, excluded: null as unknown, mismatches: [] as string[] };
    const fpd = fp.data as { fingerprint: string; counts: Record<string, number> };
    const invoices = await this.fetchAll("invoices", "company_id", [companyId]);
    const invoiceIds = invoices.map((r) => String(r.id));
    const exported: Record<string, Row[]> = {};
    for (const spec of COMPANY_EXPORT_TABLES) {
      exported[spec.table] = spec.table === "invoices" ? invoices
        : spec.scope === "self" ? await this.fetchAll(spec.table, "id", [companyId])
        : spec.scope === "company" ? await this.fetchAll(spec.table, "company_id", [companyId])
        : invoiceIds.length ? await this.fetchAll(spec.table, "invoice_id", invoiceIds) : [];
    }
    const visible = filterCompanyVisibleEinvoice({ inbound: exported.einvoice_inbound ?? [], events: exported.einvoice_events ?? [] });
    exported.einvoice_inbound = visible.inbound;
    exported.einvoice_events = visible.events;
    const counts = Object.fromEntries(Object.entries(exported).map(([k, v]) => [k, v.length]));
    const mismatches = exportCountMismatches(fpd.counts, counts);
    const files = await this.collectFiles(companyId);
    for (const f of files) if (!f.path.startsWith(`${companyId}/`)) throw new Stop("F-6: súbor exportu mimo prefixu firmy");
    this.timings[`${label}.read_ms`] = Date.now() - t0;
    if (mismatches.length) return { runId: null, status: "incomplete", error: mismatches.join(","), files: files.length, excluded: visible.hidden, mismatches };
    const manifestJson = JSON.stringify({ company_id: companyId, counts, excluded_counts: visible.hidden, data_fingerprint: fpd.fingerprint, files_total: files.length });
    const parts = files.length ? Math.ceil(files.length / COMPANY_EXPORT_FILES_PER_PART) : 0;
    const begin = await this.be.rpc("esblu_company_export_begin", {
      p_user_id: owner, p_company_id: companyId, p_schema_version: "2026-11-23.gdpr2-isolation", p_files_total: files.length, p_file_parts: parts,
      p_data_sha256: sha256(manifestJson), p_manifest_sha256: sha256(manifestJson), p_expected_fingerprint: fpd.fingerprint,
      p_files: files.map((f) => ({ bucket: f.bucket, path: f.path })),
    });
    if (begin.error || typeof begin.data !== "string") return { runId: null, status: "begin_error", error: `${begin.error?.code}:${begin.error?.message}`, files: files.length, excluded: visible.hidden, mismatches };
    const runId = begin.data;
    if (hooks.afterBegin) await hooks.afterBegin();
    let status = parts === 0 ? "completed" : "in_progress";
    for (let i = 0; i < parts; i++) {
      if (hooks.failPartAt === i) throw new Stop(`simulované prerušenie pred dávkou ${i}`);
      const evidence: Array<{ bucket: string; path: string; sha256: string; bytes: string }> = [];
      const missing: StorageFileRef[] = [];
      for (const f of sliceExportFiles(files, i)) {
        const d = await this.be.download(f.bucket, f.path);
        if (d.error) throw new Stop(`stiahnutie počas exportu: ${d.error}`);
        if (!d.bytes) missing.push(f);
        else evidence.push({ bucket: f.bucket, path: f.path, sha256: sha256(d.bytes), bytes: String(d.bytes.byteLength) });
      }
      const part = await this.be.rpc("esblu_company_export_part_files", {
        p_export_id: runId, p_user_id: owner, p_company_id: companyId, p_index: i, p_files: evidence, p_missing: missing, p_part_sha256: sha256(JSON.stringify(evidence)),
      });
      if (part.error) return { runId, status: "part_error", error: `${part.error.code}:${part.error.message}`, files: files.length, excluded: visible.hidden, mismatches };
      status = String(part.data);
      if (status === "failed") break;
    }
    this.timings[`${label}.total_ms`] = Date.now() - t0;
    return { runId, status, files: files.length, excluded: visible.hidden, mismatches };
  }
  async runState(runId: string | null): Promise<string> {
    if (!runId) return "-";
    const r = await this.be.selectIn("company_export_runs", "id", [runId], 0, 0, false);
    const row = r.rows[0];
    return row ? `${row.status}:${row.error_code ?? "-"}` : "-";
  }

  // --- F-1: poškodený originál T2 (negatívny test + povinná obnova)
  async corruptScenario() {
    const target = this.file((f) => f.phase === "T2_CORRUPT");
    const good = goodBytes(target);
    let st = await this.classify(target);
    if (st === "unexpected") throw new Stop("F-2: neočakávaný obsah poškodeného cieľa — neprepisuje sa");
    try {
      if (st === "missing") { await this.putNew(target, corruptBytes(target), target.upload_sha256); this.corruptInjected = true; }
      else if (st === "valid") { await this.replaceControlled("E5_inject_corrupt", target, corruptBytes(target)); this.corruptInjected = true; }
      else this.corruptInjected = true; // known_corrupt (prerušený predchádzajúci beh)
      const neg = await this.runExport("E5", "t2");
      const state = await this.runState(neg.runId);
      this.record("E5.t2_corrupt_original", neg.status === "failed" && state === "failed:FILES_CORRUPT" ? "PASS" : "FAIL", `${neg.status} ${state}`);
    } finally {
      await this.restoreCorrupt(good);
    }
    st = await this.classify(target);
    if (st !== "valid") throw new Critical("F-1: po obnove poškodený cieľ nemá pôvodné bajty");
    const pos = await this.runExport("E6", "t2");
    const s = await this.runState(pos.runId);
    this.record("E6.t2_restored_export_completed", pos.status === "completed" && s === "completed:-" ? "PASS" : "FAIL", `${pos.status} ${s}`);
  }
  async restoreCorrupt(good?: Uint8Array) {
    if (!this.corruptInjected) return;
    const target = this.file((f) => f.phase === "T2_CORRUPT");
    try {
      await this.replaceControlled("E5_restore", target, good ?? goodBytes(target));
      this.corruptInjected = false;
      this.record("E5R.t2_restore_original", "PASS", "pôvodné bajty obnovené, SHA-256 = xml_sha256");
    } catch (error) {
      this.record("E5R.t2_restore_original", "FAIL", `KRITICKÉ: obnova zlyhala (${error instanceof Error ? error.message : "?"})`);
      throw new Critical("F-1: obnova poškodeného súboru zlyhala — T2 ostáva poškodená, skupina D nesmie pokračovať");
    }
  }

  // --- celý beh
  async run(): Promise<{ exitCode: number }> {
    let critical = false;
    try {
      await this.identity();
      await this.ensurePhase(["A", "ORPHAN"], "S1.phase_A");
      // E1 zmena počas exportu (prepis rovnakými bajtmi → nový updated_at)
      const t1doc = this.file((f) => f.company === "t1" && f.kind === "pdf_document");
      const e1 = await this.runExport("E1", "t1", { afterBegin: async () => this.replaceControlled("E1_same_bytes", t1doc, goodBytes(t1doc)) });
      const e1s = await this.runState(e1.runId);
      this.record("E1.t1_change_during_export", e1.status === "failed" && e1s === "failed:FILES_CHANGED" ? "PASS" : "FAIL", `${e1.status} ${e1s}`);
      // E2 úplný export T1
      const e2 = await this.runExport("E2", "t1");
      const ex = e2.excluded as { einvoice_inbound?: number; einvoice_events?: number } | null;
      this.record("E2.t1_export_completed", e2.status === "completed" ? "PASS" : "FAIL", `${e2.status} súbory=${e2.files} ${e2.error ?? ""}`);
      this.record("E2.t1_r3_excluded", ex?.einvoice_inbound === 1 && ex?.einvoice_events === 1 ? "PASS" : "FAIL", JSON.stringify(ex));
      this.record("E2.t1_counts_match_db", e2.mismatches.length === 0 ? "PASS" : "FAIL", JSON.stringify(e2.mismatches));
      // E3 ISO
      const e3 = await this.runExport("E3", "iso");
      this.record("E3.iso_export_completed", e3.status === "completed" ? "PASS" : "FAIL", `${e3.status} súbory=${e3.files}`);
      // E4 chýbajúce súbory T2 — iba ak ešte chýbajú (opakovaný beh = SKIP)
      const late = this.file((f) => f.phase === "T2_LATE");
      const corrupt = this.file((f) => f.phase === "T2_CORRUPT");
      const lateSt = await this.classify(late);
      const corrSt = await this.classify(corrupt);
      if (lateSt === "missing" && corrSt === "missing") {
        const e4 = await this.runExport("E4", "t2");
        const s4 = await this.runState(e4.runId);
        this.record("E4.t2_missing_files", e4.status === "failed" && s4 === "failed:FILES_MISSING" ? "PASS" : "FAIL", `${e4.status} ${s4}`);
      } else {
        this.record("E4.t2_missing_files", "SKIP", `súbory už existujú (doc-late=${lateSt}, corrupt=${corrSt}) — opakovaný beh`);
      }
      await this.ensurePhase(["T2_LATE"], "S2.t2_late");
      await this.corruptScenario();
      if (!this.opts.skipPerf) {
        const p1 = await this.runExport("P1", "perf");
        this.record("P1.perf_export_completed", p1.status === "completed" ? "PASS" : "FAIL", `${p1.status} súbory=${p1.files} ${p1.error ?? ""}`);
      }
    } catch (error) {
      if (error instanceof Critical) critical = true;
      this.record("ABORT", "FAIL", error instanceof Error ? error.message.slice(0, 240) : String(error));
      if (!critical && this.corruptInjected) {
        try { await this.restoreCorrupt(); } catch { critical = true; }
      }
    }
    if (critical) this.log("!!! KRITICKÉ: T2 môže obsahovať poškodený originál — skupinu D nespúšťať, kontaktujte Claude !!!");
    const failed = this.results.filter((r) => r.status === "FAIL").length;
    this.log(JSON.stringify({ summary: { pass: this.results.filter((r) => r.status === "PASS").length, fail: failed, skip: this.results.filter((r) => r.status === "SKIP").length }, timings: this.timings }));
    this.log(`p15-groupC: ${failed === 0 ? "PASS" : "FAIL"} (${this.results.length} krokov)`);
    return { exitCode: critical ? 3 : failed ? 1 : 0 };
  }
}

export function loadManifest(root: string): Manifest {
  return JSON.parse(readFileSync(path.join(root, "scripts/p15-staging/manifest.json"), "utf8")) as Manifest;
}
export { UUID_RE };
