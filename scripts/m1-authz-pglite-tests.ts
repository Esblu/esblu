// =============================================================================
// M1 authz — SKUTOČNÝ PostgreSQL test (PGlite = PostgreSQL vo WASM) pre
//   20260930125000 podpísané pripojenie údajov príjmu (HMAC v2, replay),
//   20260930130000 documents INSERT podľa roly a tvaru,
//   20260930135000 ai_evidence INSERT podľa roly a tvaru.
//
// NIKDY sa nepripája na Supabase. Schéma = scripts/sql/pglite/m1-authz-baseline.sql
// (prod-verná kostra) + DOSLOVNE súbory migrácií z repa. Podpisy počíta
// skutočný serverový kód (lib/intake-attest.ts), takže test overuje, že Node
// a PostgreSQL podpisujú presne tie isté bajty.
//
// SPUSTENIE (PGlite nie je závislosť projektu — nainštaluje sa bez uloženia):
//   npm i --no-save @electric-sql/pglite@0.5.8
//   npm run test:m1-authz-db
// Inde nainštalovaný PGlite: PGLITE_DIR=/cesta/k/node_modules/@electric-sql/pglite
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256HexBytes, signIntakeAttestation } from "../lib/intake-attest.ts";
import {
  buildEvidenceIntakeInsert,
  buildEvidenceIntakePatch,
  buildIntakeExtractionPatch,
  buildIntakeInsert,
} from "../lib/intake-document.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type Row = Record<string, unknown>;
type Db = {
  exec: (sql: string) => Promise<unknown>;
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
};

async function loadPglite(): Promise<Db> {
  const dir = process.env.PGLITE_DIR;
  const main = dir ? pathToFileURL(path.join(dir, "dist/index.js")).href : "@electric-sql/pglite";
  const crypto = dir ? pathToFileURL(path.join(dir, "dist/contrib/pgcrypto.js")).href : "@electric-sql/pglite/contrib/pgcrypto";
  try {
    const { PGlite } = await import(main);
    const { pgcrypto } = await import(crypto);
    return new PGlite({ extensions: { pgcrypto } }) as Db;
  } catch (error) {
    console.error("PGlite nie je nainštalovaný: npm i --no-save @electric-sql/pglite@0.5.8  (alebo PGLITE_DIR=…)");
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}

const db = await loadPglite();
let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

// -----------------------------------------------------------------------------
// Schéma: kostra + skutočné migrácie
// -----------------------------------------------------------------------------
await db.exec(read("scripts/sql/pglite/m1-authz-baseline.sql"));
for (const migration of [
  "supabase/migrations/20260930120000_m1_authz_accountant_document_scope.sql",
  "supabase/migrations/20260930125000_m1_authz_intake_extraction_rpc.sql",
  "supabase/migrations/20260930130000_m1_authz_documents_insert_shape.sql",
  "supabase/migrations/20260930135000_m1_authz_ai_evidence_insert_shape.sql",
  "supabase/migrations/20260930140000_m1_authz_intake_storage_immutable.sql",
]) {
  await db.exec(read(migration));
}

const KEY = "test-only-key-" + "x".repeat(40); // syntetický, nikdy produkčný
const PREV_KEY = "test-only-prev-" + "y".repeat(40);
await db.query("insert into vault.decrypted_secrets (name, decrypted_secret) values ('esblu_intake_attest_key', $1)", [KEY]);

const CA = "a0000000-0000-4000-8000-000000000001";
const CB = "b0000000-0000-4000-8000-000000000002";
const U = {
  owner: "10000000-0000-4000-8000-000000000001",
  adminFin: "10000000-0000-4000-8000-000000000002",
  admin: "10000000-0000-4000-8000-000000000003",
  acc: "10000000-0000-4000-8000-000000000004",
  emp: "10000000-0000-4000-8000-000000000005",
  emp2: "10000000-0000-4000-8000-000000000006",
  b: "20000000-0000-4000-8000-000000000001",
};
await db.exec(`
  insert into public.companies values ('${CA}', 'A'), ('${CB}', 'B');
  insert into public.company_members (company_id, user_id, role, permissions) values
    ('${CA}', '${U.owner}', 'owner', '{}'),
    ('${CA}', '${U.adminFin}', 'admin', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.admin}', 'admin', '{}'),
    ('${CA}', '${U.acc}', 'accountant', '{}'),
    ('${CA}', '${U.emp}', 'employee', '{"finance":{"view":true,"manage":true}}'),
    ('${CA}', '${U.emp2}', 'employee', '{}'),
    ('${CB}', '${U.b}', 'owner', '{}');
  insert into public.vehicles (id, company_id, spz) values
    ('c0000000-0000-4000-8000-00000000000a', '${CA}', 'BA111AA'),
    ('c0000000-0000-4000-8000-00000000000b', '${CB}', 'KE222BB');
`);
const VEH_A = "c0000000-0000-4000-8000-00000000000a";
const VEH_B = "c0000000-0000-4000-8000-00000000000b";

/** Spustí fn ako `authenticated` s JWT daného používateľa, v transakcii s rollbackom pri chybe. */
async function as<T>(uid: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await db.exec("set local role authenticated");
    const result = await fn();
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}
async function allowed(uid: string, sql: string, params: unknown[] = []): Promise<boolean> {
  try {
    await as(uid, () => db.query(sql, params));
    return true;
  } catch {
    return false;
  }
}
const uuid = () => crypto.randomUUID();
const own = (uid: string) => `${uid}/${uuid()}.webp`;
/** SHA-256 náhodných „bajtov originálu" — každý záznam má vlastný súbor. */
const fileHash = () => sha256HexBytes(new TextEncoder().encode(`original-${uuid()}`));
async function rowHash(table: "documents" | "ai_evidence", id: string): Promise<string> {
  const { rows } = await db.query<{ h: string }>(`select content_sha256 h from public.${table} where id = $1`, [id]);
  return rows[0]?.h ?? "0".repeat(64);
}

function insertSql(table: string, row: Row): [string, unknown[]] {
  const keys = Object.keys(row);
  const values = keys.map((k) => (row[k] !== null && typeof row[k] === "object" ? JSON.stringify(row[k]) : row[k]));
  return [`insert into public.${table} (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, values];
}
async function canInsert(uid: string, table: string, row: Row) {
  const [sql, params] = insertSql(table, row);
  return allowed(uid, sql, params);
}

// =============================================================================
// AI_EVIDENCE — INSERT podľa roly a tvaru
// =============================================================================
const evidenceIntake = (uid: string) =>
  buildEvidenceIntakeInsert({ evidenceId: uuid(), userId: uid, photoPath: own(uid), documentTypeLabel: "dodací list", contentSha256: fileHash() });
const weigh = (uid: string, extra: Row = {}) => ({
  id: uuid(), user_id: uid, evidence_kind: "weigh_ticket", document_type: "vážny lístok",
  review_status: "confirmed_candidate", supplier: "Váha s.r.o.", netto: 12.5, photo_url: own(uid), ...extra,
});
const weighIntake = (uid: string) =>
  buildEvidenceIntakeInsert({ evidenceId: uuid(), userId: uid, photoPath: own(uid), documentTypeLabel: "vážny lístok", kind: "weigh_ticket", contentSha256: fileHash() });
const noteWithData = (uid: string, extra: Row = {}) => ({
  id: uuid(), user_id: uid, evidence_kind: "delivery_note", document_type: "dodací list",
  review_status: "needs_review", supplier: "Dodávateľ", quantity: 10, photo_url: own(uid), ...extra,
});

await check("ai_evidence: zamestnanec — platný príjem dodacieho listu povolený", async () => {
  assert.equal(await canInsert(U.emp2, "ai_evidence", evidenceIntake(U.emp2)), true);
});
await check("ai_evidence: zamestnanec — vážny lístok IBA ako príjem (s údajmi priamo nie, ani „confirmed“)", async () => {
  assert.equal(await canInsert(U.emp2, "ai_evidence", weigh(U.emp2)), false, "s údajmi");
  assert.equal(await canInsert(U.emp2, "ai_evidence", weigh(U.emp2, { review_status: "confirmed" })), false, "confirmed");
  assert.equal(await canInsert(U.emp2, "ai_evidence", weighIntake(U.emp2)), true, "príjem");
  assert.equal(await canInsert(U.owner, "ai_evidence", weigh(U.owner, { review_status: "confirmed" })), true, "owner: vlastná kontrola = potvrdenie");
  assert.equal(await canInsert(U.admin, "ai_evidence", weigh(U.admin)), true, "admin");
});
await check("ai_evidence: zamestnanec — dodací list s údajmi ZAKÁZANÝ (aj s podvrhnutým permissions.finance)", async () => {
  assert.equal(await canInsert(U.emp2, "ai_evidence", noteWithData(U.emp2)), false);
  assert.equal(await canInsert(U.emp, "ai_evidence", noteWithData(U.emp)), false);
  for (const forged of [{ netto: 99 }, { raw_text: "x" }, { confidence_score: 0.99 }, { document_date: "2026-01-01" }, { spz: "BA111AA" }, { movement_type: "in" }]) {
    assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), ...forged }), false, JSON.stringify(forged));
  }
});
await check("ai_evidence: ľubovoľný typ / stav zakázaný", async () => {
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), evidence_kind: null }), false, "bez druhu");
  for (const status of ["confirmed", "reviewed", "approved", "processed", null]) {
    assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), review_status: status }), false, `intake ${status}`);
    if (status !== "confirmed") assert.equal(await canInsert(U.owner, "ai_evidence", weigh(U.owner, { review_status: status })), false, `owner weigh ${status}`);
  }
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), review_status: "pending" }), false, "príjem iba needs_review");
});
await check("ai_evidence: iný používateľ, cudzí súbor, zmazané, spätný dátum zakázané", async () => {
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), user_id: U.owner }), false, "user_id");
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), photo_url: own(U.owner) }), false, "photo_url");
  assert.equal(await canInsert(U.admin, "ai_evidence", weigh(U.admin, { photo_url: own(U.owner) })), false, "weigh photo_url");
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), deleted_at: new Date().toISOString() }), false, "deleted_at");
  assert.equal(await canInsert(U.admin, "ai_evidence", weigh(U.admin, { created_at: "2020-01-01T00:00:00Z" })), false, "created_at");
});
await check("ai_evidence: inú firmu si nevyberie (trigger ju prepíše), cudzie vozidlo zakázané", async () => {
  const row = { ...weighIntake(U.emp2), company_id: CB };
  assert.equal(await canInsert(U.emp2, "ai_evidence", row), true);
  const { rows } = await db.query<{ company_id: string }>("select company_id from public.ai_evidence where id = $1", [row.id]);
  assert.equal(rows[0]?.company_id, CA, "riadok patrí aktívnej firme volajúceho");
  assert.equal(await canInsert(U.admin, "ai_evidence", weigh(U.admin, { vehicle_id: VEH_B })), false, "vozidlo firmy B");
  assert.equal(await canInsert(U.admin, "ai_evidence", weigh(U.admin, { vehicle_id: VEH_A })), true, "vlastné vozidlo");
});
await check("ai_evidence: owner / admin+finance dodací list s údajmi áno; admin bez financií iba príjem; účtovník nič", async () => {
  assert.equal(await canInsert(U.owner, "ai_evidence", noteWithData(U.owner)), true, "owner");
  assert.equal(await canInsert(U.adminFin, "ai_evidence", noteWithData(U.adminFin)), true, "admin+finance");
  assert.equal(await canInsert(U.admin, "ai_evidence", noteWithData(U.admin)), false, "admin bez financií s údajmi");
  assert.equal(await canInsert(U.admin, "ai_evidence", evidenceIntake(U.admin)), true, "admin bez financií príjem");
  assert.equal(await canInsert(U.acc, "ai_evidence", evidenceIntake(U.acc)), false, "účtovník príjem");
  assert.equal(await canInsert(U.acc, "ai_evidence", weigh(U.acc)), false, "účtovník vážny lístok");
  // Owner/admin s finance.manage kontrolujú dodací list priamo vo formulári —
  // ich uloženie JE potvrdenie (appka posiela "confirmed"). Admin bez financií nie.
  assert.equal(await canInsert(U.owner, "ai_evidence", noteWithData(U.owner, { review_status: "confirmed" })), true, "owner potvrdí svoju kontrolu");
  assert.equal(await canInsert(U.admin, "ai_evidence", noteWithData(U.admin, { review_status: "confirmed" })), false, "admin bez financií nie");
  assert.equal(await canInsert(U.emp2, "ai_evidence", noteWithData(U.emp2, { review_status: "confirmed" })), false, "zamestnanec nie");
});
await check("ai_evidence: cudzia firma (owner B) nevloží do firmy A ani neuvidí jej riadky", async () => {
  const row = { ...weigh(U.b), company_id: CA };
  assert.equal(await canInsert(U.b, "ai_evidence", row), true);
  const { rows } = await db.query<{ company_id: string }>("select company_id from public.ai_evidence where id = $1", [row.id]);
  assert.equal(rows[0]?.company_id, CB);
  const seen = await as(U.b, () => db.query<{ n: number }>("select count(*)::int n from public.ai_evidence where company_id = $1", [CA]));
  assert.equal(seen.rows[0].n, 0);
});
await check("ai_evidence: zamestnanec nemení ani nemaže (ani vlastný) záznam", async () => {
  const row = weighIntake(U.emp2);
  assert.equal(await canInsert(U.emp2, "ai_evidence", row), true);
  const upd = await as(U.emp2, () => db.query("update public.ai_evidence set review_status = 'confirmed', netto = 999 where id = $1 returning id", [row.id]));
  assert.equal(upd.rows.length, 0, "update");
  const del = await as(U.emp2, () => db.query("delete from public.ai_evidence where id = $1 returning id", [row.id]));
  assert.equal(del.rows.length, 0, "delete");
});

// =============================================================================
// DOCUMENTS — INSERT podľa roly a tvaru (skrátená matica; plná v SQL matici)
// =============================================================================
const docIntake = (uid: string, type: "invoice" | "receipt" = "receipt") =>
  buildIntakeInsert({ documentId: uuid(), userId: uid, storagePath: own(uid), documentType: type, originalFilename: null, mimeType: null, fileSize: null, contentSha256: fileHash(), note: null });

await check("documents: zamestnanec — príjem áno; iný typ, stav, polia, cudzí súbor nie", async () => {
  assert.equal(await canInsert(U.emp2, "documents", docIntake(U.emp2)), true);
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), document_type: "vehicle_registration" }), false);
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), status: "confirmed" }), false);
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), extracted_fields: { total: 1 } }), false);
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), storage_path: own(U.owner) }), false);
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), user_id: U.owner }), false);
});
await check("documents: owner TP áno, účtovník TP nie, účtovník faktúra s údajmi áno", async () => {
  const tp = (uid: string) => ({ id: uuid(), user_id: uid, storage_bucket: "ai-inbox-documents", storage_path: own(uid), document_type: "vehicle_registration", status: "confirmed", extracted_fields: { vin: "X" } });
  assert.equal(await canInsert(U.owner, "documents", tp(U.owner)), true);
  assert.equal(await canInsert(U.acc, "documents", tp(U.acc)), false);
  assert.equal(await canInsert(U.acc, "documents", { ...docIntake(U.acc, "invoice"), status: "confirmed", extracted_fields: { total: 1 } }), true);
});

// =============================================================================
// HMAC / RPC — Node podpis ↔ PostgreSQL overenie
// =============================================================================
const expires = (delta = 300) => Math.floor(Date.now() / 1000) + delta;

async function newDocIntake(uid: string, type: "invoice" | "receipt" = "receipt") {
  const row = docIntake(uid, type);
  assert.equal(await canInsert(uid, "documents", row), true, "príprava dokladu");
  return row.id as string;
}
async function newEvidenceIntake(uid: string) {
  const row = evidenceIntake(uid);
  assert.equal(await canInsert(uid, "ai_evidence", row), true, "príprava dodacieho listu");
  return row.id as string;
}
async function attachDoc(caller: string, id: string, payloadText: string, exp: number, sig: string) {
  const { rows } = await as(caller, () =>
    db.query<{ ok: boolean }>("select public.esblu_attach_intake_extraction($1, $2, $3, $4) ok", [id, payloadText, exp, sig])
  );
  return rows[0].ok;
}
async function attachEv(caller: string, id: string, payloadText: string, exp: number, sig: string) {
  const { rows } = await as(caller, () =>
    db.query<{ ok: boolean }>("select public.esblu_attach_evidence_intake_extraction($1, $2, $3, $4) ok", [id, payloadText, exp, sig])
  );
  return rows[0].ok;
}
const docPayload = (type: "invoice" | "receipt", total: number) =>
  JSON.stringify(buildIntakeExtractionPatch(type, {
    documentType: type, confidenceScore: 0.9, reviewStatus: "needs_review", rawText: "Ž účtenka €",
    documentLanguage: "sk", fieldConfidence: { total: 0.9 }, fields: { supplier: "Čerpacia stanica ľšť", total },
  }));
const evPayload = () =>
  JSON.stringify(buildEvidenceIntakePatch({
    documentType: "delivery_note", confidenceScore: 0.8, reviewStatus: "needs_review", rawText: "Dodací list č. 5 — štrk",
    documentLanguage: "sk", fieldConfidence: null,
    fields: { supplier: "Kameňolom Žilina", quantity: 12.5, unit: "t", netto: 12.5, documentDate: "2026-09-28", spz: "BA111AA" },
  }));
const signDoc = async (id: string, uid: string, type: string, exp: number, payloadText: string, secret = KEY, hash?: string) =>
  signIntakeAttestation({ target: "documents", rowId: id, userId: uid, kind: type, contentSha256: hash ?? (await rowHash("documents", id)), expiresAt: exp, payloadText, secret });
const signEv = async (id: string, uid: string, exp: number, payloadText: string, secret = KEY, hash?: string) =>
  signIntakeAttestation({ target: "ai_evidence", rowId: id, userId: uid, kind: "delivery_note", contentSha256: hash ?? (await rowHash("ai_evidence", id)), expiresAt: exp, payloadText, secret });

await check("HMAC: správny podpis (Node) prejde v PostgreSQL a údaje sa pripoja — documents (UTF-8 diakritika)", async () => {
  const id = await newDocIntake(U.emp2);
  const payload = docPayload("receipt", 42.5);
  const exp = expires();
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "receipt", exp, payload)), true);
  const { rows } = await db.query<{ f: Row }>("select extracted_fields f from public.documents where id = $1", [id]);
  assert.equal(rows[0].f.supplier, "Čerpacia stanica ľšť");
});
await check("HMAC: správny podpis prejde — ai_evidence (dodací list), hodnoty a typy", async () => {
  const id = await newEvidenceIntake(U.emp2);
  const payload = evPayload();
  const exp = expires();
  assert.equal(await attachEv(U.emp2, id, payload, exp, await signEv(id, U.emp2, exp, payload)), true);
  const { rows } = await db.query<Row>("select supplier, quantity::text q, document_date::text d, review_status, vehicle_id from public.ai_evidence where id = $1", [id]);
  assert.equal(rows[0].supplier, "Kameňolom Žilina");
  assert.equal(rows[0].q, "12.5");
  assert.equal(rows[0].d, "2026-09-28");
  assert.equal(rows[0].review_status, "extracted", "needs_review → extracted (atestovaný AI návrh)");
  assert.equal(rows[0].vehicle_id, null, "žiadna väzba z payloadu");
});
await check("HMAC: zmenený document_id / user / typ / dáta / tabuľka → false", async () => {
  const id = await newDocIntake(U.emp2);
  const other = await newDocIntake(U.emp2);
  const payload = docPayload("receipt", 10);
  const exp = expires();
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(other, U.emp2, "receipt", exp, payload)), false, "iný doklad");
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp, "receipt", exp, payload)), false, "iný používateľ");
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "invoice", exp, payload)), false, "iný typ");
  assert.equal(await attachDoc(U.emp2, id, docPayload("receipt", 11), exp, await signDoc(id, U.emp2, "receipt", exp, payload)), false, "iné dáta");
  assert.equal(await attachDoc(U.emp2, id, payload, exp + 1, await signDoc(id, U.emp2, "receipt", exp, payload)), false, "iná expirácia");
  const cross = signIntakeAttestation({ target: "ai_evidence", rowId: id, userId: U.emp2, kind: "receipt", contentSha256: await rowHash("documents", id), expiresAt: exp, payloadText: payload, secret: KEY });
  assert.equal(await attachDoc(U.emp2, id, payload, exp, cross), false, "iná tabuľka");
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "receipt", exp, payload, "wrong-" + "k".repeat(40))), false, "zlý kľúč");
  // ... a riadok ostal bez údajov, správny podpis stále prejde
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "receipt", exp, payload)), true, "správny podpis");
});
await check("HMAC: expirovaný podpis a podpis ďaleko do budúcnosti → false", async () => {
  const id = await newDocIntake(U.emp2);
  const payload = docPayload("receipt", 1);
  const past = expires(-5);
  assert.equal(await attachDoc(U.emp2, id, payload, past, await signDoc(id, U.emp2, "receipt", past, payload)), false, "expirovaný");
  const far = expires(3600);
  assert.equal(await attachDoc(U.emp2, id, payload, far, await signDoc(id, U.emp2, "receipt", far, payload)), false, "> 600 s");
});
await check("HMAC: druhé použitie toho istého podpisu → false (aj keby riadok znova vyzeral nevyplnený)", async () => {
  const id = await newEvidenceIntake(U.emp2);
  const payload = evPayload();
  const exp = expires();
  const sig = await signEv(id, U.emp2, exp, payload);
  assert.equal(await attachEv(U.emp2, id, payload, exp, sig), true, "prvé");
  assert.equal(await attachEv(U.emp2, id, payload, exp, sig), false, "druhé (riadok už vyplnený)");
  // Postgres vynuluje údaje → riadok znova spĺňa podmienky; podpis je aj tak spotrebovaný.
  await db.query("update public.ai_evidence set review_status = 'needs_review', spz = null, supplier = null, quantity = null, unit = null, netto = null, document_date = null, document_language = null, confidence_score = null, raw_text = null where id = $1", [id]);
  assert.equal(await attachEv(U.emp2, id, payload, exp, sig), false, "replay po vynulovaní");
});
await check("HMAC: cudzí doklad / cudzí dodací list → false aj so správnym podpisom pre vlastníka", async () => {
  const id = await newDocIntake(U.emp);
  const payload = docPayload("receipt", 5);
  const exp = expires();
  // Útočník (emp2) má podpis platný pre vlastníka (emp) — RPC berie identitu z auth.uid().
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp, "receipt", exp, payload)), false, "podpis vlastníka");
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "receipt", exp, payload)), false, "podpis útočníka");
  assert.equal(await attachDoc(U.b, id, payload, exp, await signDoc(id, U.b, "receipt", exp, payload)), false, "cudzia firma");
  const ev = await newEvidenceIntake(U.emp);
  const evp = evPayload();
  assert.equal(await attachEv(U.emp2, ev, evp, exp, await signEv(ev, U.emp2, exp, evp)), false, "cudzí dodací list");
});
await check("HMAC: payload dodacieho listu s nepovoleným kľúčom (vehicle_id, review_status) → false", async () => {
  const id = await newEvidenceIntake(U.emp2);
  for (const extra of [{ vehicle_id: VEH_A }, { review_status: "confirmed" }, { user_id: U.owner }]) {
    const payload = JSON.stringify({ ...JSON.parse(evPayload()), ...extra });
    const exp = expires();
    assert.equal(await attachEv(U.emp2, id, payload, exp, await signEv(id, U.emp2, exp, payload)), false, JSON.stringify(extra));
  }
});
await check("HMAC: rotácia — podpis starým kľúčom prejde iba kým existuje _prev", async () => {
  const payload = docPayload("receipt", 7);
  const exp = expires();
  const id1 = await newDocIntake(U.emp2);
  assert.equal(await attachDoc(U.emp2, id1, payload, exp, await signDoc(id1, U.emp2, "receipt", exp, payload, PREV_KEY)), false, "bez _prev");
  await db.query("insert into vault.decrypted_secrets values ('esblu_intake_attest_key_prev', $1)", [PREV_KEY]);
  const id2 = await newDocIntake(U.emp2);
  assert.equal(await attachDoc(U.emp2, id2, payload, exp, await signDoc(id2, U.emp2, "receipt", exp, payload, PREV_KEY)), true, "s _prev");
  await db.query("delete from vault.decrypted_secrets where name = 'esblu_intake_attest_key_prev'");
});
await check("HMAC: bez kľúča vo Vault → false (príjem ostane bez polí, nič nepadne)", async () => {
  await db.query("update vault.decrypted_secrets set decrypted_secret = null where name = 'esblu_intake_attest_key'");
  const id = await newDocIntake(U.emp2);
  const payload = docPayload("receipt", 3);
  const exp = expires();
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "receipt", exp, payload)), false);
  await db.query("update vault.decrypted_secrets set decrypted_secret = $1 where name = 'esblu_intake_attest_key'", [KEY]);
});
await check("tajomstvo a helper sú pre klienta nedostupné", async () => {
  await assert.rejects(as(U.owner, () => db.query("select decrypted_secret from vault.decrypted_secrets")), /permission denied/);
  await assert.rejects(
    as(U.owner, () => db.query("select public.esblu_intake_attestation_consume('documents', $1, 'receipt', repeat('a', 64), '{}', 1, repeat('0', 64))", [uuid()])),
    /permission denied/
  );
  await assert.rejects(as(U.owner, () => db.query("select * from public.esblu_intake_attestations_used")), /permission denied/);
});

// =============================================================================
// REVIEW UPLOADEROM — needs_review → extracted → confirmed (M1 produktová korekcia)
// =============================================================================
async function extractedDoc(uid: string, type: "invoice" | "receipt" = "receipt") {
  const id = await newDocIntake(uid, type);
  const payload = docPayload(type, 42.5);
  const exp = expires();
  assert.equal(await attachDoc(uid, id, payload, exp, await signDoc(id, uid, type, exp, payload)), true, "attach");
  return id;
}
async function extractedEvidence(uid: string, kind: "delivery_note" | "weigh_ticket" = "delivery_note") {
  const row = kind === "weigh_ticket" ? weighIntake(uid) : evidenceIntake(uid);
  assert.equal(await canInsert(uid, "ai_evidence", row), true, "príprava");
  const payload = evPayload();
  const exp = expires();
  const sig = signIntakeAttestation({ target: "ai_evidence", rowId: row.id as string, userId: uid, kind, contentSha256: row.content_sha256 as string, expiresAt: exp, payloadText: payload, secret: KEY });
  assert.equal(await attachEv(uid, row.id as string, payload, exp, sig), true, "attach");
  return row.id as string;
}
async function confirmDoc(caller: string, id: string, fields: Row, note: string | null = null) {
  const { rows } = await as(caller, () =>
    db.query<{ ok: boolean }>("select public.esblu_confirm_intake_document($1, $2::jsonb, $3) ok", [id, JSON.stringify(fields), note])
  );
  return rows[0].ok;
}
async function confirmEv(caller: string, id: string, values: Row) {
  const { rows } = await as(caller, () =>
    db.query<{ ok: boolean }>("select public.esblu_confirm_evidence_intake($1, $2::jsonb) ok", [id, JSON.stringify(values)])
  );
  return rows[0].ok;
}
const visible = async (uid: string, table: string, id: string) =>
  (await as(uid, () => db.query<{ n: number }>(`select count(*)::int n from public.${table} where id = $1`, [id]))).rows[0].n;

await check("REVIEW doklad: zamestnanec opraví/doplní/potvrdí vlastný bloček; audit AI → používateľ; potom ho nevidí", async () => {
  const id = await extractedDoc(U.emp2);
  assert.equal(await visible(U.emp2, "documents", id), 0, "ani počas review nemá browse (údaje má z odpovede skenu)");
  const ok = await confirmDoc(U.emp2, id, { supplier: "Čerpacia stanica OMV", total: 43.1, vat: 7.18 }, "tankovanie D1");
  assert.equal(ok, true);
  const { rows } = await db.query<Row>("select status, extracted_fields f, note, user_id from public.documents where id = $1", [id]);
  assert.equal(rows[0].status, "confirmed");
  assert.equal((rows[0].f as Row).supplier, "Čerpacia stanica OMV");
  const log = await db.query<Row>("select action, field_name, old_value, new_value, user_id from public.document_review_log where document_ref = $1 order by created_at, action", [id]);
  const edits = log.rows.filter((r) => r.action === "field_edited").map((r) => r.field_name).sort();
  assert.deepEqual(edits, ["note", "supplier", "total", "vat"], "oprava, doplnenie aj poznámka");
  const supplierEdit = log.rows.find((r) => r.field_name === "supplier");
  assert.equal(supplierEdit?.old_value, "Čerpacia stanica ľšť", "pôvodná AI hodnota");
  assert.equal(supplierEdit?.new_value, "Čerpacia stanica OMV");
  assert.ok(log.rows.every((r) => r.user_id === U.emp2), "aktér = auth.uid()");
  assert.equal(log.rows.filter((r) => r.action === "confirmed").length, 1);
  assert.equal(await visible(U.emp2, "documents", id), 0, "po potvrdení žiadny browse");
  assert.equal(await visible(U.owner, "documents", id), 1, "owner ho vidí v evidencii");
});
await check("REVIEW doklad: bez atestácie, cudzí, dvakrát, nesprávny typ/stav → false; priamy UPDATE na confirmed nič nespraví", async () => {
  const plain = await newDocIntake(U.emp2); // bez pripojeného AI návrhu (stav needs_review)
  assert.equal(await confirmDoc(U.emp2, plain, { total: 1 }), false, "bez atestovaného návrhu");
  const id = await extractedDoc(U.emp);
  assert.equal(await confirmDoc(U.emp2, id, { total: 1 }), false, "cudzí doklad (rovnaká firma)");
  assert.equal(await confirmDoc(U.b, id, { total: 1 }), false, "cudzia firma");
  assert.equal(await confirmDoc(U.emp, id, [] as unknown as Row), false, "polia nie sú objekt");
  assert.equal(await confirmDoc(U.emp, id, { total: 1 }), true, "vlastník");
  assert.equal(await confirmDoc(U.emp, id, { total: 2 }), false, "druhé potvrdenie");
  const upd = await as(U.emp2, () => db.query("update public.documents set status = 'confirmed' where id = $1 returning id", [plain]));
  assert.equal(upd.rows.length, 0, "priamy UPDATE zamestnanca");
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), status: "extracted" }), false, "INSERT rovno do extracted");
});
await check("REVIEW dodací list: zamestnanec opraví a potvrdí; po potvrdení nevidí; audit po poliach", async () => {
  const id = await extractedEvidence(U.emp2, "delivery_note");
  const ok = await confirmEv(U.emp2, id, { supplier: "Kameňolom Žilina a.s.", netto: 12.4, customer: "Stavba D1", vehicle_id: VEH_A, document_date: "2026-09-27" });
  assert.equal(ok, true);
  const { rows } = await db.query<Row>("select review_status, supplier, netto::text n, customer, vehicle_id, document_date::text d from public.ai_evidence where id = $1", [id]);
  assert.equal(rows[0].review_status, "confirmed");
  assert.equal(rows[0].supplier, "Kameňolom Žilina a.s.");
  assert.equal(rows[0].n, "12.4");
  assert.equal(rows[0].vehicle_id, VEH_A);
  assert.equal(rows[0].d, "2026-09-27");
  const log = await db.query<Row>("select action, field_name, user_id from public.ai_evidence_review_log where evidence_ref = $1", [id]);
  assert.deepEqual(log.rows.filter((r) => r.action === "field_edited").map((r) => r.field_name).sort(), ["customer", "document_date", "netto", "supplier", "vehicle_id"]);
  assert.equal(log.rows.filter((r) => r.action === "confirmed").length, 1);
  assert.ok(log.rows.every((r) => r.user_id === U.emp2));
  assert.equal(await visible(U.emp2, "ai_evidence", id), 0, "dodací list po potvrdení nevidí");
  assert.equal(await visible(U.owner, "ai_evidence", id), 1, "owner áno");
  const seenLog = await as(U.emp2, () => db.query<{ n: number }>("select count(*)::int n from public.ai_evidence_review_log where evidence_ref = $1", [id]));
  assert.equal(seenLog.rows[0].n, 0, "ani audit dodacieho listu");
});
await check("REVIEW vážny lístok: zamestnanec potvrdí vlastný bez ownera; vidí ho aj audit (prevádzkový doklad)", async () => {
  const id = await extractedEvidence(U.emp2, "weigh_ticket");
  assert.equal(await confirmEv(U.emp2, id, { netto: 11.9, material: "štrk 0-32" }), true);
  const { rows } = await db.query<Row>("select review_status from public.ai_evidence where id = $1", [id]);
  assert.equal(rows[0].review_status, "confirmed");
  assert.equal(await visible(U.emp2, "ai_evidence", id), 1);
  const seenLog = await as(U.emp2, () => db.query<{ n: number }>("select count(*)::int n from public.ai_evidence_review_log where evidence_ref = $1", [id]));
  assert.ok(seenLog.rows[0].n >= 2);
});
await check("REVIEW evidencia: nepovolený kľúč, zlé typy, cudzie vozidlo, cudzí záznam, dvakrát, bez atestácie → false", async () => {
  const id = await extractedEvidence(U.emp2, "delivery_note");
  for (const [label, values] of [
    ["review_status", { review_status: "confirmed" }],
    ["user_id", { user_id: U.owner }],
    ["company_id", { company_id: CB }],
    ["evidence_kind", { evidence_kind: "weigh_ticket" }],
    ["photo_url", { photo_url: own(U.owner) }],
    ["raw_text", { raw_text: "podvrh" }],
    ["číslo ako text", { netto: "12" }],
    ["text ako číslo", { supplier: 5 }],
    ["zlý dátum", { document_date: "2026-02-31" }],
    ["cudzie vozidlo", { vehicle_id: VEH_B }],
    ["nie objekt", [1, 2]],
  ] as Array<[string, unknown]>) {
    assert.equal(await confirmEv(U.emp2, id, values as Row), false, label);
  }
  assert.equal(await confirmEv(U.emp, id, { netto: 1 }), false, "cudzí záznam");
  const plainRow = evidenceIntake(U.emp2);
  assert.equal(await canInsert(U.emp2, "ai_evidence", plainRow), true);
  assert.equal(await confirmEv(U.emp2, plainRow.id as string, { netto: 1 }), false, "bez atestovaného návrhu");
  assert.equal(await confirmEv(U.emp2, id, { netto: 1 }), true, "vlastník, platné hodnoty");
  assert.equal(await confirmEv(U.emp2, id, { netto: 2 }), false, "druhé potvrdenie");
  const { rows } = await db.query<Row>("select netto::text n, review_status from public.ai_evidence where id = $1", [id]);
  assert.equal(rows[0].n, "1");
});
await check("REVIEW audit: klient ho nevie zapísať ani zmeniť", async () => {
  await assert.rejects(as(U.emp2, () => db.query("insert into public.ai_evidence_review_log (evidence_ref, company_id, user_id, action) values ($1, $2, $3, 'confirmed')", [uuid(), CA, U.emp2])), /permission denied/);
  await assert.rejects(as(U.owner, () => db.query("update public.ai_evidence_review_log set action = 'confirmed'")), /permission denied/);
  await assert.rejects(as(U.owner, () => db.query("delete from public.ai_evidence_review_log")), /permission denied/);
});

// =============================================================================
// FILE BINDING — AI návrh, review aj potvrdenie patria k tým istým bajtom
// =============================================================================
await check("FILE: správny hash prejde; podpis s iným hashom zlyhá; ten istý podpis nejde použiť na iný súbor", async () => {
  const id = await newDocIntake(U.emp2);
  const payload = docPayload("receipt", 9);
  const exp = expires();
  assert.equal(await attachDoc(U.emp2, id, payload, exp, await signDoc(id, U.emp2, "receipt", exp, payload, KEY, fileHash())), false, "iný hash");
  const sig = await signDoc(id, U.emp2, "receipt", exp, payload);
  assert.equal(await attachDoc(U.emp2, id, payload, exp, sig), true, "hash z riadku");
  // Ten istý podpis na inom súbore (iný riadok / iný hash) nefunguje.
  const other = await newDocIntake(U.emp2);
  assert.equal(await attachDoc(U.emp2, other, payload, exp, sig), false, "iný súbor");
  const { rows } = await db.query<Row>("select ai_raw_output ->> 'attested_content_sha256' a, content_sha256 h, ai_raw_output ->> 'attested_storage_path' p, storage_path sp from public.documents where id = $1", [id]);
  assert.equal(rows[0].a, rows[0].h, "atestácia = hash riadku");
  assert.equal(rows[0].p, rows[0].sp, "atestácia = cesta riadku");
});
await check("FILE: príjem bez hashu originálu sa nevloží (documents aj ai_evidence)", async () => {
  assert.equal(await canInsert(U.emp2, "documents", { ...docIntake(U.emp2), content_sha256: null }), false, "documents");
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), content_sha256: null }), false, "ai_evidence");
  assert.equal(await canInsert(U.emp2, "ai_evidence", { ...evidenceIntake(U.emp2), intake_attestation: { content_sha256: "x" } }), false, "podvrhnutá atestácia");
});
await check("FILE: výmena cesty/hashu po extrakcii nedovolí potvrdenie a po potvrdení je originál nemenný (aj pre ownera)", async () => {
  const id = await extractedDoc(U.emp2);
  // Owner (finance manage) sa pokúsi vymeniť súbor pod rozpracovaným záznamom.
  await assert.rejects(as(U.owner, () => db.query("update public.documents set storage_path = $2 where id = $1", [id, own(U.emp2)])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
  await assert.rejects(as(U.owner, () => db.query("update public.documents set content_sha256 = $2 where id = $1", [id, fileHash()])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
  // Ani postgres (napr. omylom v migrácii) — trigger platí pre všetkých.
  await assert.rejects(db.query("update public.documents set storage_path = 'x/y.webp' where id = $1", [id]), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
  assert.equal(await confirmDoc(U.emp2, id, { total: 1 }), true, "nezmenený originál sa potvrdí");
  await assert.rejects(as(U.owner, () => db.query("update public.documents set storage_path = $2 where id = $1", [id, own(U.owner)])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "po potvrdení");
  const ev = await extractedEvidence(U.emp2, "delivery_note");
  await assert.rejects(as(U.owner, () => db.query("update public.ai_evidence set photo_url = $2 where id = $1", [ev, own(U.owner)])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
  await assert.rejects(as(U.owner, () => db.query("update public.ai_evidence set intake_attestation = '{}'::jsonb where id = $1", [ev])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
});
await check("FILE: potvrdenie vyžaduje atestáciu zhodnú s riadkom (simulovaná výmena mimo triggera)", async () => {
  const id = await extractedDoc(U.emp2);
  // Obídeme trigger (iba test) a zmeníme atestovanú cestu → potvrdenie musí zlyhať.
  await db.exec("alter table public.documents disable trigger esblu_lock_original_file_before_update");
  await db.query("update public.documents set ai_raw_output = ai_raw_output || jsonb_build_object('attested_storage_path', 'iny/subor.webp') where id = $1", [id]);
  await db.exec("alter table public.documents enable trigger esblu_lock_original_file_before_update");
  assert.equal(await confirmDoc(U.emp2, id, { total: 1 }), false);
});

// =============================================================================
// STORAGE — originál sa nedá prepísať ani znova nahrať pod existujúci záznam
// =============================================================================
async function upload(uid: string, bucket: string, name: string) {
  return allowed(uid, "insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]);
}
await check("STORAGE: uploader už NEVIE prepísať (UPDATE) svoj originál v ai-inbox-documents", async () => {
  const name = own(U.emp2);
  assert.equal(await upload(U.emp2, "ai-inbox-documents", name), true, "nový upload na novú cestu");
  const upd = await as(U.emp2, () => db.query("update storage.objects set updated_at = now(), name = name where bucket_id = 'ai-inbox-documents' and name = $1 returning id", [name]));
  assert.equal(upd.rows.length, 0, "prepis (upsert/update/move)");
});
await check("STORAGE: znova nahrať objekt na cestu, na ktorú už odkazuje záznam, nejde (documents aj ai_evidence)", async () => {
  const doc = docIntake(U.emp2);
  assert.equal(await canInsert(U.emp2, "documents", doc), true);
  assert.equal(await upload(U.emp2, "ai-inbox-documents", doc.storage_path as string), false, "documents");
  const ev = evidenceIntake(U.emp2);
  assert.equal(await canInsert(U.emp2, "ai_evidence", ev), true);
  assert.equal(await upload(U.emp2, "ai-evidence-documents", ev.photo_url as string), false, "ai_evidence");
  assert.equal(await upload(U.emp2, "ai-inbox-documents", own(U.owner)), false, "cudzí priečinok");
});
async function canRead(uid: string, bucket: string, name: string) {
  const { rows } = await as(uid, () => db.query<{ n: number }>("select count(*)::int n from storage.objects where bucket_id = $1 and name = $2", [bucket, name]));
  return rows[0].n === 1;
}
await check("STORAGE: uploader číta SVOJ originál iba počas review; po potvrdení finančný originál iba finance", async () => {
  const doc = docIntake(U.emp2);
  await db.query("insert into storage.objects (bucket_id, name) values ('ai-inbox-documents', $1)", [doc.storage_path]);
  assert.equal(await canInsert(U.emp2, "documents", doc), true);
  const payload = docPayload("receipt", 1);
  const exp = expires();
  assert.equal(await attachDoc(U.emp2, doc.id as string, payload, exp, await signDoc(doc.id as string, U.emp2, "receipt", exp, payload)), true);
  assert.equal(await canRead(U.emp2, "ai-inbox-documents", doc.storage_path as string), true, "review: vlastný originál");
  assert.equal(await canRead(U.emp, "ai-inbox-documents", doc.storage_path as string), false, "iný zamestnanec");
  assert.equal(await confirmDoc(U.emp2, doc.id as string, { total: 1 }), true);
  assert.equal(await canRead(U.emp2, "ai-inbox-documents", doc.storage_path as string), false, "po potvrdení nie");
  assert.equal(await canRead(U.owner, "ai-inbox-documents", doc.storage_path as string), true, "owner áno");
  assert.equal(await canRead(U.acc, "ai-inbox-documents", doc.storage_path as string), true, "účtovník áno");
  assert.equal(await canRead(U.admin, "ai-inbox-documents", doc.storage_path as string), false, "admin bez financií nie");
  // dodací list
  const ev = evidenceIntake(U.emp2);
  await db.query("insert into storage.objects (bucket_id, name) values ('ai-evidence-documents', $1)", [ev.photo_url]);
  assert.equal(await canInsert(U.emp2, "ai_evidence", ev), true);
  assert.equal(await canRead(U.emp2, "ai-evidence-documents", ev.photo_url as string), true, "review dodacieho listu");
  await db.query("update public.ai_evidence set review_status = 'confirmed' where id = $1", [ev.id]);
  assert.equal(await canRead(U.emp2, "ai-evidence-documents", ev.photo_url as string), false, "po potvrdení dodací list nie");
  assert.equal(await canRead(U.owner, "ai-evidence-documents", ev.photo_url as string), true, "owner áno");
});

// =============================================================================
// RESUME REVIEW — iba vlastný, čerstvý, nepotvrdený, bez enumerácie
// =============================================================================
async function listMine(uid: string) {
  return (await as(uid, () => db.query<Row>("select * from public.esblu_list_my_intake_reviews()"))).rows;
}
async function getMine(uid: string, target: string, id: string) {
  return (await as(uid, () => db.query<{ r: Row | null }>("select public.esblu_get_my_intake_review($1, $2) r", [target, id]))).rows[0].r;
}
await check("RESUME: zamestnanec obnoví vlastný čerstvý extracted review (AI návrh, hodnoty, originál, expirácia) a dokončí ho", async () => {
  const id = await extractedDoc(U.emp2);
  const list = await listMine(U.emp2);
  assert.ok(list.some((r) => r.id === id && r.target === "documents" && r.status === "extracted"));
  const got = await getMine(U.emp2, "documents", id);
  assert.ok(got);
  assert.equal(got!.can_confirm, true);
  assert.equal((got!.ai_fields as Row).supplier, "Čerpacia stanica ľšť", "pôvodný AI návrh");
  assert.equal(got!.content_sha256, await rowHash("documents", id));
  assert.ok(typeof got!.storage_path === "string" && String(got!.review_expires_at).length > 0);
  assert.equal(await confirmDoc(U.emp2, id, { supplier: "Opravené", total: 42.5 }), true, "dokončenie po obnovení");
  assert.equal(await getMine(U.emp2, "documents", id), null, "po potvrdení nič");
  assert.ok(!(await listMine(U.emp2)).some((r) => r.id === id), "ani v zozname");
});
await check("RESUME: cudzí, inej firmy, potvrdený, expirovaný, zlý target → nič; bez enumerácie", async () => {
  const foreign = await extractedDoc(U.emp);
  assert.equal(await getMine(U.emp2, "documents", foreign), null, "cudzí (rovnaká firma)");
  assert.equal(await getMine(U.b, "documents", foreign), null, "iná firma");
  assert.equal(await getMine(U.owner, "documents", foreign), null, "ani owner cez resume (má bežné finančné čítanie)");
  assert.ok(!(await listMine(U.emp2)).some((r) => r.id === foreign), "zoznam iba vlastné");
  assert.ok(!(await listMine(U.b)).some((r) => r.id === foreign));
  const expired = await extractedEvidence(U.emp2, "weigh_ticket");
  await db.query("update public.ai_evidence set created_at = now() - interval '25 hours' where id = $1", [expired]);
  assert.equal(await getMine(U.emp2, "ai_evidence", expired), null, "expirovaný");
  assert.ok(!(await listMine(U.emp2)).some((r) => r.id === expired));
  assert.equal(await confirmEv(U.emp2, expired, { netto: 1 }), false, "expirovaný nejde potvrdiť");
  assert.equal(await getMine(U.emp2, "ai_evidence", foreign), null, "zlý target");
  assert.equal(await getMine(U.emp2, "documents", uuid()), null, "neexistujúci");
  assert.equal(await getMine(U.emp2, "vehicles", uuid()), null, "nepovolený target");
  // Výsledok pre cudzí a neexistujúci je rovnaký (null) — nič sa neprezradí.
});

// =============================================================================
// AUDIT — AI hodnoty zachované, old/new, aktér, rovnaký hash originálu
// =============================================================================
await check("AUDIT: owner vidí AI návrh, finálne hodnoty, zmeny old/new, uploadera, potvrdzovateľa, časy a hash originálu", async () => {
  const id = await extractedEvidence(U.emp2, "delivery_note");
  const hash = await rowHash("ai_evidence", id);
  assert.equal(await confirmEv(U.emp2, id, { supplier: "Kameňolom — opravené", netto: 13 }), true);
  const log = await as(U.owner, () => db.query<Row>("select action, field_name, old_value, new_value, user_id, snapshot from public.ai_evidence_review_log where evidence_ref = $1", [id]));
  const edits = log.rows.filter((r) => r.action === "field_edited");
  const supplier = edits.find((r) => r.field_name === "supplier");
  assert.equal(supplier?.old_value, "Kameňolom Žilina", "AI hodnota");
  assert.equal(supplier?.new_value, "Kameňolom — opravené");
  assert.ok(log.rows.every((r) => r.user_id === U.emp2), "aktér");
  assert.ok(edits.every((r) => (r.snapshot as Row).content_sha256 === hash), "každá oprava odkazuje na hash originálu");
  const confirmed = log.rows.find((r) => r.action === "confirmed")!.snapshot as Row;
  assert.equal(confirmed.content_sha256, hash);
  assert.equal((confirmed.ai_values as Row).supplier, "Kameňolom Žilina", "AI návrh zachovaný");
  assert.equal((confirmed.confirmed_values as Row).supplier, "Kameňolom — opravené");
  assert.equal(confirmed.uploaded_by, U.emp2);
  assert.equal(confirmed.confirmed_by, U.emp2);
  for (const key of ["created_at", "extracted_at", "confirmed_at", "photo_url"]) assert.ok(confirmed[key], key);
  // AI návrh ostáva uložený aj v riadku (intake_attestation.ai_values) — nemenný.
  const { rows } = await db.query<Row>("select intake_attestation -> 'ai_values' ->> 'supplier' s from public.ai_evidence where id = $1", [id]);
  assert.equal(rows[0].s, "Kameňolom Žilina");
});
await check("AUDIT: doklad — snímka potvrdenia nesie hash, cestu, AI polia, finálne polia, uploadera a časy", async () => {
  const id = await extractedDoc(U.emp2);
  const hash = await rowHash("documents", id);
  assert.equal(await confirmDoc(U.emp2, id, { supplier: "OMV", total: 42.5 }), true);
  const { rows } = await db.query<Row>("select action, field_name, user_id, document_snapshot s from public.document_review_log where document_ref = $1", [id]);
  const confirmed = rows.find((r) => r.action === "confirmed")!.s as Row;
  assert.equal(confirmed.content_sha256, hash);
  assert.equal((confirmed.ai_fields as Row).supplier, "Čerpacia stanica ľšť");
  assert.equal((confirmed.confirmed_fields as Row).supplier, "OMV");
  for (const key of ["uploaded_by", "confirmed_by", "created_at", "extracted_at", "confirmed_at", "storage_path"]) assert.ok(confirmed[key], key);
  assert.ok(rows.filter((r) => r.action === "field_edited").every((r) => (r.s as Row).content_sha256 === hash && r.user_id === U.emp2));
});

// =============================================================================
// LEGACY — riadky spred modelu content_sha256 (hash NULL) sa nedajú prelinkovať
// =============================================================================
async function legacyDoc(type = "receipt", status = "confirmed") {
  const id = uuid();
  const path = own(U.owner);
  // ako postgres, bez hashu — presne ako historické produkčné riadky
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U.owner })]);
  await db.query("insert into public.documents (id, user_id, storage_bucket, storage_path, document_type, status, company_id) values ($1, $2, 'ai-inbox-documents', $3, $4, $5, $6)", [id, U.owner, path, type, status, CA]);
  await db.query("select set_config('request.jwt.claims', '', false)");
  return { id, path };
}
async function legacyEvidence(kind = "delivery_note") {
  const id = uuid();
  const photo = own(U.emp2);
  await db.query("insert into public.ai_evidence (id, user_id, company_id, evidence_kind, document_type, review_status, supplier, photo_url) values ($1, $2, $3, $4, 'dodací list', 'confirmed', 'Starý dodávateľ', $5)", [id, U.emp2, CA, kind, photo]);
  return { id, photo };
}
await check("LEGACY documents: owner/účtovník/admin+fin nezmení storage_path / storage_bucket; hash si nevymyslí", async () => {
  for (const actor of [U.owner, U.acc, U.adminFin]) {
    const { id } = await legacyDoc();
    const b = own(actor); // iný existujúci (napr. práve nahratý) súbor B
    await assert.rejects(as(actor, () => db.query("update public.documents set storage_path = $2 where id = $1", [id, b])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, `${actor} path`);
    await assert.rejects(as(actor, () => db.query("update public.documents set storage_bucket = 'ai-evidence-documents' where id = $1", [id])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, `${actor} bucket`);
    await assert.rejects(as(actor, () => db.query("update public.documents set content_sha256 = $2 where id = $1", [id, fileHash()])), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/, `${actor} hash`);
  }
  // Bežné úpravy legacy dokladu ostávajú (napr. poznámka, polia).
  const { id } = await legacyDoc();
  const ok = await as(U.owner, () => db.query("update public.documents set note = 'kontrola' where id = $1 returning id", [id]));
  assert.equal(ok.rows.length, 1, "bežná úprava funguje");
});
await check("LEGACY ai_evidence: owner/admin nezmení photo_url, hash ani atestáciu; ani na NULL", async () => {
  for (const actor of [U.owner, U.adminFin]) {
    const { id } = await legacyEvidence();
    await assert.rejects(as(actor, () => db.query("update public.ai_evidence set photo_url = $2 where id = $1", [id, own(actor)])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "photo_url → B");
    await assert.rejects(as(actor, () => db.query("update public.ai_evidence set photo_url = null where id = $1", [id])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "photo_url → NULL");
    await assert.rejects(as(actor, () => db.query("update public.ai_evidence set content_sha256 = $2 where id = $1", [id, fileHash()])), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/, "hash");
    await assert.rejects(as(actor, () => db.query("update public.ai_evidence set intake_attestation = '{}'::jsonb where id = $1", [id])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "atestácia");
  }
  // Vážny lístok BEZ fotky: prvé priradenie fotky klientom tiež nie (appka to nerobí).
  const noPhoto = uuid();
  await db.query("insert into public.ai_evidence (id, user_id, company_id, evidence_kind, review_status) values ($1, $2, $3, 'weigh_ticket', 'confirmed')", [noPhoto, U.emp2, CA]);
  await assert.rejects(as(U.owner, () => db.query("update public.ai_evidence set photo_url = $2 where id = $1", [noPhoto, own(U.owner)])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
  const ok = await as(U.owner, () => db.query("update public.ai_evidence set supplier = 'opravené' where id = $1 returning id", [noPhoto]));
  assert.equal(ok.rows.length, 1, "bežná úprava funguje");
});
await check("LEGACY attachments: prílohu (napr. zadná strana TP) nejde prelinkovať — ani postgres", async () => {
  const { id } = await legacyDoc("vehicle_registration", "confirmed");
  const att = uuid();
  await db.query("insert into public.document_attachments (id, document_id, company_id, user_id, storage_bucket, storage_path) values ($1, $2, $3, $4, 'ai-inbox-documents', $5)", [att, id, CA, U.owner, own(U.owner)]);
  await assert.rejects(db.query("update public.document_attachments set storage_path = $2 where id = $1", [att, own(U.owner)]), /ESBLU_ORIGINAL_FILE_IMMUTABLE/);
  await assert.rejects(db.query("update public.documents set storage_path = $2 where id = $1", [id, own(U.owner)]), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "ani legacy doklad");
});
await check("ROLE: legacy hash backfill iba privilegovaná rola S výslovným príznakom; klient nikdy (ani s príznakom)", async () => {
  const withFlag = async (role: string | null, fn: () => Promise<unknown>) => {
    await db.exec("begin");
    try {
      await db.query("select set_config('esblu.original_hash_backfill', 'on', true)");
      if (role) await db.exec(`set local role ${role}`);
      await fn();
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  };
  // postgres (migrácia / SQL editor) BEZ príznaku → nie
  const d1 = await legacyDoc();
  await assert.rejects(db.query("update public.documents set content_sha256 = $2 where id = $1", [d1.id, fileHash()]), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/, "postgres bez príznaku");
  // postgres S príznakom → áno, iba raz
  await withFlag(null, () => db.query("update public.documents set content_sha256 = $2 where id = $1", [d1.id, fileHash()]));
  await assert.rejects(withFlag(null, () => db.query("update public.documents set content_sha256 = $2 where id = $1", [d1.id, fileHash()])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "prepis ani s príznakom");
  // service_role (DB rola) S príznakom → áno; bez príznaku → nie
  const d2 = await legacyDoc();
  await db.exec("grant select, update on public.documents, public.ai_evidence to service_role");
  await assert.rejects((async () => { await db.exec("begin; set local role service_role"); try { await db.query("update public.documents set content_sha256 = $2 where id = $1", [d2.id, fileHash()]); } finally { await db.exec("rollback"); } })(), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/, "service_role bez príznaku");
  await withFlag("service_role", () => db.query("update public.documents set content_sha256 = $2 where id = $1", [d2.id, fileHash()]));
  // KLIENT (authenticated) — ani keby si príznak nastavil, nie
  const d3 = await legacyDoc();
  await assert.rejects(withFlag("authenticated", async () => {
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.owner })]);
    await db.query("update public.documents set content_sha256 = $2 where id = $1", [d3.id, fileHash()]);
  }), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/, "klient s príznakom");
  // ai_evidence rovnako
  const ev = await legacyEvidence();
  await assert.rejects(db.query("update public.ai_evidence set content_sha256 = $2 where id = $1", [ev.id, fileHash()]), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/);
  await withFlag(null, () => db.query("update public.ai_evidence set content_sha256 = $2 where id = $1", [ev.id, fileHash()]));
});
await check("ROLE: SECURITY DEFINER mení current_user na vlastníka; bez príznaku ani definer funkcia hash/atestáciu nezapíše", async () => {
  await db.exec(`
    create or replace function public.__test_whoami() returns text language sql security definer set search_path to '' as $f$ select current_user::text $f$;
    grant execute on function public.__test_whoami() to authenticated;
    create or replace function public.__test_definer_backfill(p_id uuid, p_hash text) returns void language plpgsql security definer set search_path to '' as $f$
      begin update public.documents set content_sha256 = p_hash where id = p_id; end $f$;
    create or replace function public.__test_definer_attest(p_id uuid) returns void language plpgsql security definer set search_path to '' as $f$
      begin update public.ai_evidence set intake_attestation = '{"x":1}'::jsonb where id = p_id; end $f$;
    grant execute on function public.__test_definer_backfill(uuid, text) to authenticated;
    grant execute on function public.__test_definer_attest(uuid) to authenticated;
  `);
  const who = await as(U.emp2, () => db.query<{ w: string; c: string }>("select public.__test_whoami() w, current_user::text c"));
  assert.equal(who.rows[0].c, "authenticated", "klient = authenticated");
  assert.equal(who.rows[0].w, "postgres", "SECURITY DEFINER = vlastník funkcie");
  const d = await legacyDoc();
  await assert.rejects(as(U.owner, () => db.query("select public.__test_definer_backfill($1, $2)", [d.id, fileHash()])), /ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY/, "definer bez príznaku");
  const ev = await legacyEvidence();
  await assert.rejects(as(U.owner, () => db.query("select public.__test_definer_attest($1)", [ev.id])), /ESBLU_ORIGINAL_FILE_IMMUTABLE/, "atestácia bez príznaku");
  // Podpísané attach RPC (príznak + definer) atestáciu zapísať smie — pokryté testami HMAC vyššie.
  await db.exec("drop function public.__test_whoami(); drop function public.__test_definer_backfill(uuid, text); drop function public.__test_definer_attest(uuid);");
});
// =============================================================================
// STORAGE DELETE — originál naviazaného (potvrdeného, rozpracovaného, legacy) záznamu
// =============================================================================
async function canDelete(uid: string, bucket: string, name: string) {
  const { rows } = await as(uid, () => db.query<{ id: string }>("delete from storage.objects where bucket_id = $1 and name = $2 returning id", [bucket, name]));
  return rows.length === 1;
}
async function putObject(bucket: string, name: string) {
  await db.query("insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]);
}
await check("DELETE: potvrdený finančný originál nezmaže zamestnanec, owner, admin+fin ani účtovník", async () => {
  const id = await extractedDoc(U.emp2);
  const { rows } = await db.query<{ p: string }>("select storage_path p from public.documents where id = $1", [id]);
  await putObject("ai-inbox-documents", rows[0].p);
  assert.equal(await confirmDoc(U.emp2, id, { total: 1 }), true);
  for (const actor of [U.emp2, U.owner, U.adminFin, U.acc, U.admin, U.b]) {
    assert.equal(await canDelete(actor, "ai-inbox-documents", rows[0].p), false, actor);
  }
});
await check("DELETE: potvrdený dodací list / vážny lístok a rozpracovaný príjem — originál ostáva", async () => {
  for (const kind of ["delivery_note", "weigh_ticket"] as const) {
    const id = await extractedEvidence(U.emp2, kind);
    const { rows } = await db.query<{ p: string }>("select photo_url p from public.ai_evidence where id = $1", [id]);
    await putObject("ai-evidence-documents", rows[0].p);
    for (const actor of [U.emp2, U.owner, U.adminFin]) assert.equal(await canDelete(actor, "ai-evidence-documents", rows[0].p), false, `draft ${kind} ${actor}`);
    assert.equal(await confirmEv(U.emp2, id, { netto: 1 }), true);
    for (const actor of [U.emp2, U.owner, U.adminFin, U.b]) assert.equal(await canDelete(actor, "ai-evidence-documents", rows[0].p), false, `confirmed ${kind} ${actor}`);
  }
});
await check("DELETE: legacy potvrdený záznam (bez hashu) aj príloha sú chránené", async () => {
  const { id, path } = await legacyDoc("vehicle_registration", "confirmed");
  await putObject("ai-inbox-documents", path);
  assert.equal(await canDelete(U.owner, "ai-inbox-documents", path), false, "legacy TP");
  const attPath = own(U.owner);
  await putObject("ai-inbox-documents", attPath);
  await db.query("insert into public.document_attachments (document_id, company_id, user_id, storage_bucket, storage_path) values ($1, $2, $3, 'ai-inbox-documents', $4)", [id, CA, U.owner, attPath]);
  assert.equal(await canDelete(U.owner, "ai-inbox-documents", attPath), false, "príloha");
  const ev = await legacyEvidence();
  await putObject("ai-evidence-documents", ev.photo);
  assert.equal(await canDelete(U.owner, "ai-evidence-documents", ev.photo), false, "legacy dodací list");
});
await check("DELETE: upratanie neúspešného uploadu (bez záznamu) — iba uploader; retenčný workflow: najprv riadok, potom súbor", async () => {
  const orphan = own(U.emp2);
  await putObject("ai-inbox-documents", orphan);
  assert.equal(await canDelete(U.emp, "ai-inbox-documents", orphan), false, "iný používateľ");
  assert.equal(await canDelete(U.b, "ai-inbox-documents", orphan), false, "cudzia firma");
  assert.equal(await canDelete(U.emp2, "ai-inbox-documents", orphan), true, "uploader");
  // Owner zmaže vlastný nefinančný doklad: DB riadok najprv (ako lib/document-retention.ts), súbor potom.
  const { id, path } = await legacyDoc("vehicle_registration", "confirmed");
  await putObject("ai-inbox-documents", path);
  assert.equal(await canDelete(U.owner, "ai-inbox-documents", path), false, "kým odkazuje riadok");
  await db.query("delete from public.documents where id = $1", [id]);
  assert.equal(await canDelete(U.owner, "ai-inbox-documents", path), true, "po zmazaní riadku (osirelý súbor)");
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo (PGlite ${(await db.query<{ v: string }>("select version() v")).rows[0].v.split(" ").slice(0, 2).join(" ")})`);
if (failed > 0) process.exit(1);
