// =============================================================================
// STATICKÝ GUARD: každá NOVÁ migrácia, ktorá vytvorí objekt v `public`, musí
// výslovne rozhodnúť o Data API oprávneniach (Supabase 2026-10-30: nič nie je
// automatické). Nevyžaduje CRUD grant — vyžaduje ROZHODNUTIE.
//
// Pre migrácie s verziou > 20261021100000 (explicit_data_api_grants):
//   CREATE TABLE public.X
//     - ALTER TABLE public.X ENABLE ROW LEVEL SECURITY
//     - pre KAŽDÚ rolu anon / authenticated / service_role grant alebo revoke
//       na public.X (napr. `revoke all on table public.X from public, anon,
//       authenticated, service_role;` + iba potrebné granty)
//     - X je v supabase/grants/public-data-api-grants.json (replay test potom
//       overí skutočný ACL == manifest)
//   CREATE FUNCTION public.f
//     - aspoň jeden `grant execute` / `revoke … on function public.f`
//       (inak by RPC po čistom replayi nebolo dostupné, alebo by ostalo PUBLIC)
//   CREATE/ALTER POLICY: explicitné TO <rola>, nikdy TO public (20261022100000).
//   Zakázané: ALTER DEFAULT PRIVILEGES … GRANT, GRANT … ON ALL TABLES/FUNCTIONS
//   IN SCHEMA public, GRANT ALL na tabuľku pre anon/authenticated.
// Staršie migrácie sú pokryté reconciliation migráciou; guard iba overí, že
// každá nimi vytvorená (a nezmazaná) tabuľka má záznam v manifeste.
//   npm run test:grants-guard
// =============================================================================
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = path.join(ROOT, "supabase/migrations");
const RECONCILE_VERSION = "20261021100000";
const ROLES = ["anon", "authenticated", "service_role"] as const;
const manifest = JSON.parse(readFileSync(path.join(ROOT, "supabase/grants/public-data-api-grants.json"), "utf8")) as {
  tables: Record<string, unknown>;
};

let passed = 0;
let failed = 0;
function check(label: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${label}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message.split("\n").slice(0, 12).join("\n       ") : String(error)}`);
  }
}

// Komentáre preč, aby `-- create table public.x` v texte neplatil ako DDL ani ako rozhodnutie.
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}
const TABLE_RE = /create\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?public\."?([a-z_][a-z0-9_]*)"?/g;
const DROP_RE = /drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/g;

export function createdTables(sql: string): string[] {
  return [...stripSqlComments(sql).toLowerCase().matchAll(TABLE_RE)].map((m) => m[1]);
}
export function droppedTables(sql: string): string[] {
  return [...stripSqlComments(sql).toLowerCase().matchAll(DROP_RE)].map((m) => m[1]);
}
export function createdFunctions(sql: string): string[] {
  const s = stripSqlComments(sql).toLowerCase();
  return [...s.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_][a-z0-9_]*)\s*\(/g)].map((m) => m[1]);
}

function statements(sql: string): string[] {
  return stripSqlComments(sql).toLowerCase().split(";").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/** Problémy novej migrácie (prázdne pole = OK). */
export function auditMigration(sql: string): string[] {
  const problems: string[] = [];
  const stmts = statements(sql);
  const onTable = (st: string, t: string) => new RegExp(String.raw`\bon\s+(?:table\s+)?(?:public\.)?"?${t}"?(?:\s|,|$)`).test(st)
    || new RegExp(String.raw`\bon\s+(?:table\s+)?[^;]*\bpublic\.${t}\b`).test(st);
  for (const t of createdTables(sql)) {
    if (!stmts.some((st) => new RegExp(String.raw`alter table (?:if exists )?(?:only )?(?:public\.)?"?${t}"? enable row level security`).test(st)))
      problems.push(`public.${t}: chýba ENABLE ROW LEVEL SECURITY`);
    for (const role of ROLES) {
      const decided = stmts.some((st) => /^(grant|revoke)\b/.test(st) && onTable(st, t)
        && new RegExp(String.raw`\b(to|from)\b[^]*\b${role}\b`).test(st));
      if (!decided) problems.push(`public.${t}: chýba explicitný GRANT/REVOKE pre ${role}`);
    }
    if (stmts.some((st) => /^grant all\b/.test(st) && onTable(st, t) && /\bto\b.*\b(anon|authenticated)\b/.test(st)))
      problems.push(`public.${t}: GRANT ALL pre klientsku rolu je zakázaný (vymenuj potrebné operácie)`);
    if (!(t in manifest.tables)) problems.push(`public.${t}: chýba v supabase/grants/public-data-api-grants.json`);
  }
  for (const f of new Set(createdFunctions(sql))) {
    if (!stmts.some((st) => /^(grant|revoke)\b/.test(st) && new RegExp(String.raw`\bon function public\.${f}\s*\(`).test(st)))
      problems.push(`public.${f}(): chýba explicitný GRANT/REVOKE EXECUTE`);
  }
  for (const st of stmts) {
    if (/^create policy\b/.test(st) && !/\bto\s+[a-z_]/.test(st.replace(/\b(using|with check)\b[^]*$/, "")))
      problems.push(`CREATE POLICY bez explicitného TO <rola>: ${st.slice(0, 100)}`);
    if (/^(create|alter) policy\b/.test(st) && /\bto\s+([a-z_, ]*\b)?public\b/.test(st.replace(/\b(using|with check)\b[^]*$/, "")))
      problems.push(`politika TO public je v public schéme zakázaná (použi TO authenticated / anon výslovne): ${st.slice(0, 100)}`);
    if (/^alter default privileges\b.*\bgrant\b/.test(st)) problems.push(`ALTER DEFAULT PRIVILEGES … GRANT je zakázaný: ${st.slice(0, 120)}`);
    if (/^grant\b.*\bon all (tables|functions|routines|sequences) in schema public\b/.test(st))
      problems.push(`plošný GRANT ON ALL … IN SCHEMA public je zakázaný: ${st.slice(0, 120)}`);
  }
  return problems;
}

// ----------------------------------------------------------------------------- self-test guardu
check("guard: tabuľka bez rozhodnutia o grantoch je zachytená", () => {
  const p = auditMigration("create table public.ai_scan_usage (id int primary key);");
  assert.ok(p.some((x) => /ENABLE ROW LEVEL SECURITY/.test(x)));
  for (const r of ROLES) assert.ok(p.some((x) => x.includes(`pre ${r}`)), `rola ${r} nezachytená`);
});
check("guard: revoke all + cielené granty + RLS = OK (service-only tabuľka nemusí mať CRUD)", () => {
  assert.deepEqual(auditMigration(`
    create table if not exists public.trial_claims (id int primary key);
    alter table public.trial_claims enable row level security;
    revoke all on table public.trial_claims from public, anon, authenticated, service_role;
    grant select, insert on table public.trial_claims to service_role;`), []);
});
check("guard: komentár s CREATE TABLE sa nepočíta; komentár s GRANT nie je rozhodnutie", () => {
  assert.deepEqual(auditMigration("-- create table public.foo (id int);"), []);
  const p = auditMigration(`create table public.vehicles (id int);
    alter table public.vehicles enable row level security;
    -- grant select on public.vehicles to anon, authenticated, service_role;`);
  assert.equal(p.filter((x) => /chýba explicitný/.test(x)).length, 3);
});
check("guard: neznáma tabuľka mimo manifestu, GRANT ALL, default privileges GRANT a ON ALL sú zachytené", () => {
  const p = auditMigration(`create table public.zz_new (id int);
    alter table public.zz_new enable row level security;
    grant all on public.zz_new to anon, authenticated, service_role;
    alter default privileges in schema public grant select on tables to authenticated;
    grant select on all tables in schema public to authenticated;`);
  assert.ok(p.some((x) => /chýba v supabase\/grants/.test(x)));
  assert.ok(p.some((x) => /GRANT ALL pre klientsku rolu/.test(x)));
  assert.ok(p.some((x) => /ALTER DEFAULT PRIVILEGES/.test(x)));
  assert.ok(p.some((x) => /ON ALL/.test(x)));
});
check("guard: politika bez TO alebo TO public je zachytená; TO authenticated OK", () => {
  assert.ok(auditMigration("create policy p on public.vehicles for select using (true);").some((x) => /bez explicitného TO/.test(x)));
  assert.ok(auditMigration("create policy p on public.vehicles for select to public using (true);").some((x) => /TO public/.test(x)));
  assert.ok(auditMigration("alter policy p on public.vehicles to anon, public;").some((x) => /TO public/.test(x)));
  assert.deepEqual(auditMigration("create policy p on public.vehicles for select to authenticated using (company_id = public.esblu_my_active_company_id());"), []);
  assert.deepEqual(auditMigration("alter policy p on public.vehicles to authenticated;"), []);
});
check("guard: nová funkcia bez GRANT/REVOKE EXECUTE je zachytená", () => {
  assert.equal(auditMigration("create or replace function public.esblu_x() returns int language sql as $$ select 1 $$;").length, 1);
  assert.deepEqual(auditMigration(`create function public.esblu_x() returns int language sql as $$ select 1 $$;
    revoke all on function public.esblu_x() from public, anon;
    grant execute on function public.esblu_x() to authenticated;`), []);
});

// ----------------------------------------------------------------------------- repo
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();

check("repo: reconciliation migrácia existuje a je posledná pred novými migráciami s rozhodnutím", () => {
  assert.ok(files.some((f) => f.startsWith(`${RECONCILE_VERSION}_`)));
});

check(`repo: každá migrácia po ${RECONCILE_VERSION} má explicitné rozhodnutie o grantoch`, () => {
  const problems = files.filter((f) => f.slice(0, 14) > RECONCILE_VERSION)
    .flatMap((f) => auditMigration(readFileSync(path.join(MIG_DIR, f), "utf8")).map((p) => `${f}: ${p}`));
  assert.deepEqual(problems, []);
});

check("repo: manifest == tabuľky vytvorené migráciami (mínus zmazané) — žiadna tabuľka bez rozhodnutia", () => {
  const live = new Set<string>();
  for (const f of files) {
    const sql = readFileSync(path.join(MIG_DIR, f), "utf8");
    // poradie v súbore: drop pred create (napr. push_devices, einvoice_*) → spracuj sekvenčne
    const s = stripSqlComments(sql).toLowerCase();
    const events = [
      ...[...s.matchAll(TABLE_RE)].map((m) => ({ i: m.index ?? 0, t: m[1], op: "c" })),
      ...[...s.matchAll(DROP_RE)].map((m) => ({ i: m.index ?? 0, t: m[1], op: "d" })),
    ].sort((a, b) => a.i - b.i);
    for (const e of events) {
      if (e.op === "c") live.add(e.t);
      else live.delete(e.t);
    }
  }
  assert.deepEqual([...live].sort(), Object.keys(manifest.tables).sort());
});

check("repo: žiadna migrácia neudeľuje default privileges ani plošné GRANT ON ALL TABLES klientskym rolám", () => {
  const bad = files.flatMap((f) => statements(readFileSync(path.join(MIG_DIR, f), "utf8"))
    .filter((st) => /^alter default privileges\b.*\bgrant\b/.test(st) || /^grant\b.*\bon all tables in schema public\b/.test(st))
    .map((st) => `${f}: ${st.slice(0, 100)}`));
  assert.deepEqual(bad, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
