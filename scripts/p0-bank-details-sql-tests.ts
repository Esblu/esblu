// =============================================================================
// P0 review 2026-09-27 — IBAN/BIC pravidlá SPUSTENÉ v skutočnom Postgrese.
//
// SPUSTENIE
//   npm run test:p0-bank-sql
//
// Používa PGlite (Postgres 17 vo WASM) — nič sa nepripája na Supabase a
// nepoužívajú sa produkčné dáta. PGlite nie je závislosťou projektu; ak nie
// je dostupný, test sa ukončí s chybou a vypíše, ako ho spustiť:
//   PGLITE_MODULE=/cesta/k/node_modules/@electric-sql/pglite/dist/index.js
//
// Harness vytvorí minimálnu kópiu produkčnej schémy (stĺpce, ktoré pravidlá
// čítajú) s PRODUKČNÝMI RLS politikami invoices / company_billing_profile,
// produkčnou funkciou esblu_my_finance_manage a produkčným triggerom
// nemennosti finalizovanej faktúry (prečítané z katalógu 2026-09-27), a potom
// vykoná PRESNÝ text sekcie „Rozhodnutie 2" z migrácie
// 20260929100000_closed_beta_p0_hardening.sql. Volania bežia ako rola
// `authenticated` cez SET SESSION AUTHORIZATION, takže RLS aj session_user
// sa správajú ako v PostgREST.
// =============================================================================

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

type PG = { exec(sql: string): Promise<unknown>; query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

async function loadPglite(): Promise<new () => PG> {
  const candidates = [process.env.PGLITE_MODULE, "@electric-sql/pglite"].filter(Boolean) as string[];
  for (const specifier of candidates) {
    try {
      const mod = await import(specifier);
      return mod.PGlite;
    } catch {
      // ďalší kandidát
    }
  }
  console.error("PGlite nie je dostupný. Nastavte PGLITE_MODULE na .../@electric-sql/pglite/dist/index.js");
  process.exit(2);
}

const MIGRATION = readFileSync(new URL("../supabase/migrations/20260929100000_closed_beta_p0_hardening.sql", import.meta.url), "utf8");
const sectionStart = MIGRATION.indexOf("-- Rozhodnutie 2 — IBAN/BIC firmy mení iba owner");
const sectionEnd = MIGRATION.indexOf("-- Rozhodnutie 1 — kmeňové dáta strojov");
assert.ok(sectionStart > 0 && sectionEnd > sectionStart, "sekcia Rozhodnutie 2 v migrácii chýba");
const BANK_SECTION = MIGRATION.slice(MIGRATION.lastIndexOf("\n", sectionStart), MIGRATION.lastIndexOf("-- ----", sectionEnd));

const CO_A = "00000000-0000-4000-8000-00000000000a";
const CO_B = "00000000-0000-4000-8000-00000000000b";
const U = {
  owner: "00000000-0000-4000-8000-0000000000a1",
  accountant: "00000000-0000-4000-8000-0000000000a2",
  adminFinance: "00000000-0000-4000-8000-0000000000a3",
  adminPlain: "00000000-0000-4000-8000-0000000000a4",
  employee: "00000000-0000-4000-8000-0000000000a5",
  ownerB: "00000000-0000-4000-8000-0000000000b1",
};
const COMPANY_IBAN = "SK3112000000198742637541";
const OTHER_IBAN = "SK0809000000000123123123";

const SCHEMA = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
grant usage on schema auth to authenticated, anon;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;

create table public.company_members (user_id uuid, company_id uuid, role text, status text, permissions jsonb default '{}'::jsonb);

create function public.esblu_my_active_company_id() returns uuid language sql stable security definer set search_path to '' as $$
  select cm.company_id from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1 $$;
create function public.esblu_my_active_role() returns text language sql stable security definer set search_path to '' as $$
  select cm.role from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1 $$;
-- produkčná definícia (pg_get_functiondef 2026-09-27)
create function public.esblu_my_finance_manage() returns boolean language sql stable security definer set search_path to '' as $$
  select coalesce((select case when cm.role = 'employee' then false when cm.role in ('owner', 'accountant') then true
    else coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false) end
    from public.company_members cm where cm.user_id = auth.uid() and cm.status = 'active' limit 1), false) $$;
grant execute on function public.esblu_my_active_company_id(), public.esblu_my_active_role(), public.esblu_my_finance_manage() to authenticated;

create table public.company_billing_profile (
  company_id uuid primary key, legal_name text, iban text, bic text, updated_by uuid, updated_at timestamptz default now());
create table public.invoices (
  id uuid primary key default gen_random_uuid(), company_id uuid not null, direction text not null default 'issued',
  kind text not null default 'regular_invoice', document_status text not null default 'draft', invoice_number text,
  iban text, variable_symbol text, payment_status text default 'unpaid', created_by uuid, updated_by uuid, updated_at timestamptz default now());
grant select, insert, update on public.company_billing_profile, public.invoices to authenticated;

alter table public.company_billing_profile enable row level security;
alter table public.invoices enable row level security;
-- produkčné politiky (pg_policies 2026-09-27)
create policy company_billing_profile_insert_finance on public.company_billing_profile for insert with check
  ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage() and ((updated_by is null) or (updated_by = auth.uid())));
create policy company_billing_profile_select_finance on public.company_billing_profile for select using
  ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage());
create policy company_billing_profile_update_finance on public.company_billing_profile for update
  using ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage())
  with check ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage() and ((updated_by is null) or (updated_by = auth.uid())));
create policy invoices_insert_finance_draft on public.invoices for insert with check
  ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage() and (document_status = 'draft') and (invoice_number is null)
   and ((created_by is null) or (created_by = auth.uid())) and ((updated_by is null) or (updated_by = auth.uid())));
create policy invoices_select_finance on public.invoices for select using
  ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage());
create policy invoices_update_finance_draft on public.invoices for update
  using ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage() and (document_status = 'draft'))
  with check ((company_id = public.esblu_my_active_company_id()) and public.esblu_my_finance_manage() and (document_status = 'draft')
   and (invoice_number is null) and ((updated_by is null) or (updated_by = auth.uid())));

-- produkčný trigger nemennosti (pg_get_functiondef 2026-09-27)
create function public.esblu_block_finalized_invoice_mutation() returns trigger language plpgsql security definer set search_path to '' as $function$
declare
  v_allowed constant text[] := array['payment_status', 'updated_at', 'updated_by'];
  v_changed text;
begin
  if OLD.document_status <> 'finalized' then return NEW; end if;
  select string_agg(k.key, ', ' order by k.key) into v_changed
  from jsonb_each(to_jsonb(OLD)) k
  where not (k.key = any (v_allowed)) and k.value is distinct from (to_jsonb(NEW) -> k.key);
  if v_changed is not null then
    raise exception using errcode = 'P0001', message = 'ESBLU_INVOICE_FINALIZED_IMMUTABLE';
  end if;
  return NEW;
end;
$function$;
create trigger esblu_invoices_immutability_guard before update on public.invoices for each row execute function public.esblu_block_finalized_invoice_mutation();
`;

const SEED = `
insert into public.company_members values
  ('${U.owner}', '${CO_A}', 'owner', 'active', '{}'),
  ('${U.accountant}', '${CO_A}', 'accountant', 'active', '{}'),
  ('${U.adminFinance}', '${CO_A}', 'admin', 'active', '{"finance":{"view":true,"manage":true}}'),
  ('${U.adminPlain}', '${CO_A}', 'admin', 'active', '{}'),
  ('${U.employee}', '${CO_A}', 'employee', 'active', '{"finance":{"view":true,"manage":true}}'),
  ('${U.ownerB}', '${CO_B}', 'owner', 'active', '{}');
insert into public.company_billing_profile (company_id, legal_name, iban, bic) values
  ('${CO_A}', 'Syntetická A s.r.o.', '${COMPANY_IBAN}', 'TATRSKBX'),
  ('${CO_B}', 'Syntetická B s.r.o.', '${OTHER_IBAN}', 'GIBASKBX');
insert into public.invoices (id, company_id, direction, document_status, invoice_number, iban) values
  ('10000000-0000-4000-8000-000000000001', '${CO_A}', 'issued', 'draft', null, '${COMPANY_IBAN}'),
  ('10000000-0000-4000-8000-000000000002', '${CO_A}', 'issued', 'finalized', 'FA20260001', '${COMPANY_IBAN}'),
  ('10000000-0000-4000-8000-000000000003', '${CO_A}', 'received', 'draft', null, 'DE89370400440532013000'),
  ('10000000-0000-4000-8000-000000000004', '${CO_A}', 'issued', 'draft', null, null);
`;

const PGlite = await loadPglite();
const db = new PGlite();
await db.exec(SCHEMA);
await db.exec(BANK_SECTION);
await db.exec(SEED);

/** Spustí SQL ako používateľ cez rolu authenticated (ako PostgREST). */
async function as(userId: string, sql: string, params: unknown[] = []): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  await db.exec(`set session authorization postgres; select set_config('request.jwt.claim.sub', '${userId}', false), set_config('request.jwt.claim.role', 'authenticated', false); set session authorization authenticated;`);
  try {
    const result = await db.query(sql, params);
    return { ok: true, rows: result.rows as Record<string, unknown>[] };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await db.exec("set session authorization postgres;");
  }
}
async function superRead<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await db.exec("set session authorization postgres;");
  return (await db.query<T>(sql)).rows;
}

let passed = 0;
let failed = 0;
async function check(label: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
  } catch (error) {
    failed++;
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

const insertIssued = (userId: string, iban: string | null, companyId = CO_A) =>
  as(userId, `insert into public.invoices (company_id, direction, document_status, iban, created_by) values ($1, 'issued', 'draft', $2, $3) returning id`, [companyId, iban, userId]);
const DENIED_IBAN = "ESBLU_INVOICE_IBAN_NOT_COMPANY_ACCOUNT";
const RLS = /row-level security|violates row-level/i;

// A–C: vytvorenie vydanej faktúry
await check("A: owner vytvorí vydanú faktúru s IBAN firmy → povolené", async () => {
  const r = await insertIssued(U.owner, COMPANY_IBAN);
  assert.ok(r.ok, JSON.stringify(r));
});
await check("B: accountant vytvorí vydanú faktúru s presným IBAN firmy → povolené (aj s medzerami/malými písmenami)", async () => {
  assert.ok((await insertIssued(U.accountant, COMPANY_IBAN)).ok);
  assert.ok((await insertIssued(U.accountant, "sk31 1200 0000 1987 4263 7541")).ok);
  assert.ok((await insertIssued(U.adminFinance, COMPANY_IBAN)).ok, "admin s financiami");
  assert.ok((await insertIssued(U.accountant, null)).ok, "bez IBAN");
});
await check("C: accountant / admin s financiami s iným IBAN → zamietnuté", async () => {
  for (const user of [U.accountant, U.adminFinance]) {
    const r = await insertIssued(user, OTHER_IBAN);
    assert.ok(!r.ok && r.error.includes(DENIED_IBAN), JSON.stringify(r));
  }
});
await check("C2: faktúra pre cudziu firmu (podvrhnuté company_id) → zamietnuté bez ohľadu na IBAN", async () => {
  for (const iban of [OTHER_IBAN, COMPANY_IBAN]) {
    const r = await insertIssued(U.accountant, iban, CO_B);
    assert.ok(!r.ok, JSON.stringify(r));
  }
});
await check("C3: owner smie výslovne zadať iný účet na koncepte", async () => {
  assert.ok((await insertIssued(U.owner, OTHER_IBAN)).ok);
});

// D–E: oprávnenia sa nerozšírili
await check("D: admin bez financií nezíska prístup k faktúram (ani s IBAN firmy)", async () => {
  for (const iban of [COMPANY_IBAN, null]) {
    const r = await insertIssued(U.adminPlain, iban);
    assert.ok(!r.ok && RLS.test(r.error), JSON.stringify(r));
  }
  const upd = await as(U.adminPlain, `update public.invoices set variable_symbol = '1' where id = '10000000-0000-4000-8000-000000000001' returning id`);
  assert.ok(upd.ok && upd.rows.length === 0, "RLS: 0 riadkov");
});
await check("E: zamestnanec (aj s podvrhnutým permissions.finance) zamietnutý", async () => {
  for (const iban of [COMPANY_IBAN, null]) {
    const r = await insertIssued(U.employee, iban);
    assert.ok(!r.ok && RLS.test(r.error), JSON.stringify(r));
  }
  const cbp = await as(U.employee, `update public.company_billing_profile set legal_name = 'x' where company_id = '${CO_A}' returning company_id`);
  assert.ok(cbp.ok && cbp.rows.length === 0);
});

// UPDATE vydanej faktúry
await check("UPDATE: accountant upraví koncept bez zmeny IBAN → povolené (aj po zmene IBAN firmy)", async () => {
  assert.ok((await as(U.accountant, `update public.invoices set variable_symbol = '2026001', iban = iban where id = '10000000-0000-4000-8000-000000000001' returning id`)).ok);
  await superRead(`update public.company_billing_profile set iban = 'SK6807200002891987426353' where company_id = '${CO_A}'`);
  const r = await as(U.accountant, `update public.invoices set variable_symbol = '2026002', iban = $1 where id = '10000000-0000-4000-8000-000000000001' returning id`, [COMPANY_IBAN]);
  assert.ok(r.ok && r.rows.length === 1, JSON.stringify(r));
  await superRead(`update public.company_billing_profile set iban = '${COMPANY_IBAN}' where company_id = '${CO_A}'`);
});
await check("UPDATE: accountant nahradí IBAN iným účtom → zamietnuté; na IBAN firmy / NULL → povolené", async () => {
  const bad = await as(U.accountant, `update public.invoices set iban = $1 where id = '10000000-0000-4000-8000-000000000001' returning id`, [OTHER_IBAN]);
  assert.ok(!bad.ok && bad.error.includes(DENIED_IBAN), JSON.stringify(bad));
  const [row] = await superRead<{ iban: string }>(`select iban from public.invoices where id = '10000000-0000-4000-8000-000000000001'`);
  assert.equal(row.iban, COMPANY_IBAN);
  assert.ok((await as(U.accountant, `update public.invoices set iban = null where id = '10000000-0000-4000-8000-000000000004' returning id`)).ok);
  assert.ok((await as(U.accountant, `update public.invoices set iban = $1 where id = '10000000-0000-4000-8000-000000000004' returning id`, [COMPANY_IBAN])).ok);
});
await check("UPDATE: prepnutie prijatej faktúry s IBAN dodávateľa na vydanú ne-ownerom → zamietnuté", async () => {
  const r = await as(U.accountant, `update public.invoices set direction = 'issued' where id = '10000000-0000-4000-8000-000000000003' returning id`);
  assert.ok(!r.ok && r.error.includes(DENIED_IBAN), JSON.stringify(r));
});
await check("UPDATE: owner zmení IBAN konceptu na iný účet → povolené", async () => {
  const r = await as(U.owner, `update public.invoices set iban = $1 where id = '10000000-0000-4000-8000-000000000004' returning id`, [OTHER_IBAN]);
  assert.ok(r.ok && r.rows.length === 1, JSON.stringify(r));
});

// G: prijatá faktúra
await check("G: IBAN dodávateľa na prijatej faktúre nie je obmedzený", async () => {
  const ins = await as(U.accountant, `insert into public.invoices (company_id, direction, document_status, iban, created_by) values ($1, 'received', 'draft', $2, $3) returning id`, [CO_A, "AT611904300234573201", U.accountant]);
  assert.ok(ins.ok, JSON.stringify(ins));
  const upd = await as(U.accountant, `update public.invoices set iban = 'FR1420041010050500013M02606' where id = '10000000-0000-4000-8000-000000000003' returning id`);
  assert.ok(upd.ok && upd.rows.length === 1, JSON.stringify(upd));
});

// H: nemennosť finalizovanej faktúry
await check("H: finalizovaná faktúra — IBAN nezmení ani owner, ani superuser mimo RLS (trigger nemennosti)", async () => {
  const owner = await as(U.owner, `update public.invoices set iban = $1 where id = '10000000-0000-4000-8000-000000000002' returning id`, [OTHER_IBAN]);
  assert.ok(owner.ok && owner.rows.length === 0, "RLS: finalizovaná faktúra sa neupravuje");
  await assert.rejects(() => superRead(`update public.invoices set iban = '${OTHER_IBAN}' where id = '10000000-0000-4000-8000-000000000002'`), /ESBLU_INVOICE_FINALIZED_IMMUTABLE/);
  const [row] = await superRead<{ iban: string }>(`select iban from public.invoices where id = '10000000-0000-4000-8000-000000000002'`);
  assert.equal(row.iban, COMPANY_IBAN);
});

// F: bankové údaje firmy
await check("F: ne-owner nezmení IBAN ani BIC firmy (update aj upsert)", async () => {
  for (const user of [U.accountant, U.adminFinance]) {
    const iban = await as(user, `update public.company_billing_profile set iban = $1 where company_id = '${CO_A}'`, [OTHER_IBAN]);
    assert.ok(!iban.ok && iban.error.includes("ESBLU_BANK_DETAILS_OWNER_ONLY"), JSON.stringify(iban));
    const bic = await as(user, `update public.company_billing_profile set bic = 'GIBASKBX' where company_id = '${CO_A}'`);
    assert.ok(!bic.ok && bic.error.includes("ESBLU_BANK_DETAILS_OWNER_ONLY"), JSON.stringify(bic));
    const upsert = await as(user, `insert into public.company_billing_profile (company_id, legal_name, iban) values ('${CO_A}', 'X', $1)
      on conflict (company_id) do update set legal_name = excluded.legal_name, iban = excluded.iban`, [OTHER_IBAN]);
    assert.ok(!upsert.ok && upsert.error.includes("ESBLU_BANK_DETAILS_OWNER_ONLY"), JSON.stringify(upsert));
  }
  const [row] = await superRead<{ iban: string; bic: string }>(`select iban, bic from public.company_billing_profile where company_id = '${CO_A}'`);
  assert.deepEqual(row, { iban: COMPANY_IBAN, bic: "TATRSKBX" });
});
await check("F2: ne-owner upraví ostatné fakturačné údaje (bez IBAN/BIC) aj cez upsert → povolené", async () => {
  const upd = await as(U.accountant, `update public.company_billing_profile set legal_name = 'Syntetická A2 s.r.o.' where company_id = '${CO_A}' returning company_id`);
  assert.ok(upd.ok && upd.rows.length === 1, JSON.stringify(upd));
  const upsert = await as(U.accountant, `insert into public.company_billing_profile (company_id, legal_name) values ('${CO_A}', 'Syntetická A3 s.r.o.')
    on conflict (company_id) do update set legal_name = excluded.legal_name returning company_id`);
  assert.ok(upsert.ok, JSON.stringify(upsert));
});
await check("F3: owner zmení IBAN/BIC firmy → povolené", async () => {
  const r = await as(U.owner, `update public.company_billing_profile set iban = $1, bic = 'SUBASKBX' where company_id = '${CO_A}' returning company_id`, ["SK6807200002891987426353"]);
  assert.ok(r.ok && r.rows.length === 1, JSON.stringify(r));
  await superRead(`update public.company_billing_profile set iban = '${COMPANY_IBAN}', bic = 'TATRSKBX' where company_id = '${CO_A}'`);
});

await check("service_role (operátor) nie je blokovaný", async () => {
  await db.exec(`select set_config('request.jwt.claim.sub', '', false), set_config('request.jwt.claim.role', 'service_role', false)`);
  await superRead(`insert into public.invoices (company_id, direction, iban) values ('${CO_A}', 'issued', '${OTHER_IBAN}')`);
});

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
