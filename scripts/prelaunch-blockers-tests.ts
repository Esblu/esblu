// =============================================================================
// PRE-LAUNCH TECHNICAL BLOCKERS — statické kontroly (bez siete, bez DB).
//
//  1. scripts/sql/prod-migration-precheck.sql je striktne READ ONLY a jeho
//     zoznamy (RC verzie, tabuľky pred/po RC) sedia s repom a grants manifestom.
//  2. Runbook uvádza presne rovnaké poradie RC migrácií ako repo.
//  3. vercel.json crony: platný formát, ≤ 100, každá route existuje a je
//     chránená CRON_SECRET (timingSafeEqual, 401), 1-min interval iba eInvoice send.
//  4. scripts/storage-signed-url-http-smoke.ts: odmietne produkciu, nevypisuje
//     tokeny, TTL = SIGNED_MEDIA_TTL_SECONDS.
// Spustenie: npm run test:prelaunch-blockers
// =============================================================================
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertStagingTarget,
  EXPECTED_TTL_SECONDS,
  identityGuardError,
  PROD_REF,
  redact,
  SIGNED_URL_ALLOWED_CLAIMS,
  signedDownloadTokenError,
  signedTokenClaims,
  signedUrlTtlSeconds,
  STAGING_REF,
} from "./storage-signed-url-http-smoke.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let passed = 0;
const failures: string[] = [];
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failures.push(label);
    console.log(`  ✗ ${label}\n    ${(e as Error).message}`);
  }
}

const PRECHECK = read("scripts/sql/prod-migration-precheck.sql");
const BODY = PRECHECK.split("-- BEGIN-CHECKS")[1]?.split("-- END-CHECKS")[0] ?? "";
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const listCte = (name: string): string[] => {
  const m = BODY.match(new RegExp(`${name}\\(t\\) as \\(select unnest\\(string_to_array\\(([\\s\\S]*?), ','\\)\\)\\)`));
  assert.ok(m, `CTE ${name} not found`);
  return m[1].replace(/'\s*\n\s*'/g, "").replace(/'/g, "").split(",").map((s) => s.trim()).filter(Boolean);
};

const MIGRATIONS = readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
// Produkcia (2026-10-22): posledná = 20261005091000_private_media_buckets. RC rozdiel = baseline + všetko od 20261002100000
// okrem dvoch media migrácií a 20261001130000, ktoré produkcia už má.
const PROD_HAS = new Set(["20261001130000", "20261005090000", "20261005091000"]);
const RC_ABSENT = MIGRATIONS.map((f) => f.replace(/\.sql$/, "")).filter((b) => {
  const v = b.slice(0, 14);
  return v === "20260720000000" || (v >= "20261002100000" && !PROD_HAS.has(v));
});

console.log("precheck SQL");
check("transaction is BEGIN; SET TRANSACTION READ ONLY; … ROLLBACK;", () => {
  const code = stripComments(PRECHECK);
  assert.match(code, /^\s*begin;\s*set transaction read only;/i);
  assert.match(code, /rollback;\s*$/i);
  assert.doesNotMatch(code, /\bcommit\b/i);
});
check("no DML / DDL / privilege statements", () => {
  const code = stripComments(BODY).replace(/'[^']*'/g, "''");
  assert.doesNotMatch(code, /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|create\s+(table|function|policy|index|or)|alter\s+(table|function|policy|role)|drop\s+\w+|grant\s+\w+|revoke\s+\w+|set\s+role|copy\s+)/i);
  assert.doesNotMatch(code, /pg_read_file|lo_import|dblink|pg_terminate/i);
});
check("rc_versions == repo migrations absent in production (38, ordered)", () => {
  const v = [...BODY.matchAll(/\('(\d{14})'\)/g)].map((m) => m[1]);
  assert.deepEqual(v, RC_ABSENT.map((b) => b.slice(0, 14)));
  assert.equal(v.length, 38);
});
check("pre_rc (61) ∪ rc_tables (33) == grants manifest, disjoint", () => {
  const manifest = Object.keys(JSON.parse(read("supabase/grants/public-data-api-grants.json")).tables).sort();
  const pre = listCte("pre_rc");
  const rc = listCte("rc_tables");
  assert.equal(pre.length, 61);
  assert.equal(rc.length, 33);
  assert.deepEqual(pre.filter((t) => rc.includes(t)), []);
  assert.deepEqual([...pre, ...rc].sort(), manifest);
});
check("every rc table is created by an RC migration file", () => {
  const rcSql = RC_ABSENT.map((b) => read(`supabase/migrations/${b}.sql`)).join("\n").toLowerCase();
  for (const t of listCte("rc_tables")) assert.ok(rcSql.includes(`public.${t}`), `${t} not found in RC migrations`);
});

console.log("runbook");
check("runbook lists the exact ordered RC migration list", () => {
  const doc = read("docs/production-migration-runbook-2026-10-22.md");
  const listed = [...doc.matchAll(/^\|\s*\d+\s*\|\s*`(\d{14}_[a-z0-9_]+)`/gm)].map((m) => m[1]);
  assert.deepEqual(listed, RC_ABSENT);
});
check("rollback file exists where runbook claims RB", () => {
  const doc = read("docs/production-migration-runbook-2026-10-22.md");
  for (const m of doc.matchAll(/^\|\s*\d+\s*\|\s*`(\d{14}_[a-z0-9_]+)`[^\n]*\|\s*RB\s*\|/gm)) {
    assert.ok(existsSync(path.join(ROOT, `supabase/rollback/${m[1]}_rollback.sql`)), `${m[1]} rollback missing`);
  }
});

console.log("vercel.json crons");
const crons: { path: string; schedule: string }[] = JSON.parse(read("vercel.json")).crons;
check("≤ 100 cron jobs, 5-field schedules", () => {
  assert.ok(crons.length <= 100);
  for (const c of crons) assert.match(c.schedule, /^(\S+\s+){4}\S+$/, c.path);
});
check("only eInvoice send runs every minute", () => {
  const perMinute = crons.filter((c) => c.schedule === "* * * * *").map((c) => c.path);
  assert.deepEqual(perMinute, ["/api/cron/einvoice-outbound?mode=send"]);
});
check("each cron route exists and is CRON_SECRET-protected (timingSafeEqual + 401)", () => {
  for (const c of crons) {
    const route = `app${c.path.split("?")[0]}/route.ts`;
    assert.ok(existsSync(path.join(ROOT, route)), `${route} missing`);
    const src = read(route);
    assert.match(src, /process\.env\.CRON_SECRET/, route);
    assert.match(src, /timingSafeEqual/, route);
    assert.match(src, /status:\s*401/, route);
    assert.match(src, /secret\.length\s*<\s*16/, route);
  }
});
check("account deletion cleanup cron present and daily", () => {
  const c = crons.find((x) => x.path === "/api/cron/account-deletion-cleanup");
  assert.ok(c);
  assert.match(c.schedule, /^\d+ \d+ \* \* \*$/);
});
check("frequent crons set maxDuration ≤ 60 s (fits schedule)", () => {
  for (const c of crons.filter((x) => /^(\*|\*\/\d+|\d+) /.test(x.schedule) && x.schedule.split(" ")[1] === "*")) {
    const src = read(`app${c.path.split("?")[0]}/route.ts`);
    const m = src.match(/maxDuration\s*=\s*(\d+)/);
    assert.ok(m && Number(m[1]) <= 60, `${c.path} maxDuration`);
  }
});

console.log("signed URL smoke script");
check("refuses production and non-staging targets", () => {
  assert.throws(() => assertStagingTarget(`https://${PROD_REF}.supabase.co`), /PRODUCTION/);
  assert.throws(() => assertStagingTarget("https://example.supabase.co"), /not staging/);
  assert.doesNotThrow(() => assertStagingTarget(`https://${STAGING_REF}.supabase.co`));
});
check("TTL matches app SIGNED_MEDIA_TTL_SECONDS", () => {
  const src = read("lib/storage/signed-media.ts");
  assert.match(src, /SIGNED_MEDIA_TTL_SECONDS = 60 \* 60;/);
  assert.equal(EXPECTED_TTL_SECONDS, 3600);
});
check("token helpers decode exp-iat and claims locally", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const url = `https://${STAGING_REF}.supabase.co/storage/v1/object/sign/b/p.png?token=${b64({ alg: "HS256" })}.${b64({ url: "b/p.png", iat: 100, exp: 3700 })}.sig`;
  assert.equal(signedUrlTtlSeconds(url), 3600);
  assert.deepEqual(signedTokenClaims(url), ["exp", "iat", "url"]);
  assert.equal(signedUrlTtlSeconds("not a url"), null);
});
check("signed token claim allowlist: scope=download OK, privileged/identity claims FAIL", () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const mk = (p: object) => `https://${STAGING_REF}.supabase.co/storage/v1/object/sign/b/p.png?token=${b64({ alg: "HS256" })}.${b64(p)}.sig`;
  const base = { url: "b/p.png", iat: 100, exp: 3700, scope: "download" };
  // reálny staging formát (2026-10-22 Windows smoke): exp,iat,scope,url
  assert.equal(signedDownloadTokenError(mk(base), "b/p.png"), null);
  assert.equal(signedDownloadTokenError(mk({ ...base, versionId: "v1", transformations: "width=10" }), "b/p.png"), null);
  for (const bad of ["role", "sub", "aud", "email", "session_id", "service_role", "owner", "upsert", "is_anonymous"]) {
    assert.match(String(signedDownloadTokenError(mk({ ...base, [bad]: "x" }), "b/p.png")), /unexpected claims/, bad);
  }
  assert.match(String(signedDownloadTokenError(mk({ ...base, scope: "upload" }), "b/p.png")), /scope is not/);
  assert.match(String(signedDownloadTokenError(mk({ url: "b/p.png", iat: 1, exp: 2 }), "b/p.png")), /scope is not/);
  assert.match(String(signedDownloadTokenError(mk(base), "b/other.png")), /url claim/);
  assert.match(String(signedDownloadTokenError(mk({ url: "b/p.png", scope: "download", exp: 2 }), "b/p.png")), /missing claim: iat/);
  assert.match(String(signedDownloadTokenError("garbage", "b/p.png")), /not decodable/);
  assert.deepEqual([...SIGNED_URL_ALLOWED_CLAIMS].sort(), ["exp", "iat", "scope", "transformations", "url", "versionId"]);
});
check("smoke script still asserts signed URL carries no anon/service key", () => {
  const src = read("scripts/storage-signed-url-http-smoke.ts");
  assert.match(src, /!url1\.includes\(ANON\) && !\/service_role\/i\.test\(url1\)/);
});
check("redact() strips JWTs, token= and URLs", () => {
  const s = redact("x https://a.b/c?token=eyJa.eyJb.c eyJhbGc.eyJzdWI.sig token=abc");
  assert.doesNotMatch(s, /eyJ|token=abc|https:/);
});
check("script never logs signed URLs / tokens / credentials", () => {
  const src = read("scripts/storage-signed-url-http-smoke.ts");
  for (const line of src.split("\n").filter((l) => /console\.(log|error)/.test(l))) {
    assert.doesNotMatch(line, /\b(url1|urlShort|signedUrl|oldAccess|password|ANON)\b/, line.trim());
  }
  assert.doesNotMatch(src, /SUPABASE_SERVICE_ROLE_KEY|getSupabaseAdmin/);
});

check("identity guard: A only in Firma A, B only in Firma B, no shared membership", () => {
  const A = { company_id: "a", company_name: "QA UX Firma A" };
  const B = { company_id: "b", company_name: "QA UX Firma B" };
  const X = { company_id: "x", company_name: "Iná firma" };
  const g = (a: object, b: object) => identityGuardError(a as never, b as never, "QA UX Firma A", "QA UX Firma B");
  assert.equal(g({ active: "a", companies: [A] }, { active: "b", companies: [B] }), null);
  assert.match(String(g({ active: "b", companies: [A, B] }, { active: "b", companies: [B] })), /identity A: active/);
  assert.match(String(g({ active: "a", companies: [A, B] }, { active: "b", companies: [B] })), /share a company/);
  assert.match(String(g({ active: "a", companies: [A] }, { active: "b", companies: [B, A] })), /share a company/);
  assert.match(String(g({ active: "a", companies: [A, X] }, { active: "b", companies: [B, X] })), /share a company/);
  assert.match(String(g({ active: "a", companies: [A] }, { active: null, companies: [] })), /identity B: active/);
});
check("smoke script never calls process.exit() (Windows UV_HANDLE_CLOSING)", () => {
  const code = read("scripts/storage-signed-url-http-smoke.ts").replace(/\/\/[^\n]*|\/\*\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /process\.exit\(/);
  assert.match(code, /process\.exitCode = /);
});

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} prelaunch-blockers: ${passed} ok, ${failures.length} fail`);
if (failures.length) process.exit(1);
