# Esblu — Data API grants (pravidlo pre každú migráciu)

Od **2026-10-30** Supabase neudeľuje novým objektom v `public` žiadne Data API oprávnenia automaticky
(tabuľky, funkcie, sekvencie; `anon`, `authenticated`, `service_role`). Esblu sa na toto správanie prepla už
migráciou `20261021100000_explicit_data_api_grants.sql` (default privileges neudeľujú nič) — staging, produkcia
aj čistý replay majú **rovnaký** model.

**GRANT ≠ RLS.** GRANT rozhoduje, či rola na objekt vôbec siahne (inak `42501 permission denied`).
RLS rozhoduje, ktoré riadky. Musí platiť oboje; jedno nenahrádza druhé.

## Každá migrácia, ktorá vytvorí `public.X`

V tej istej migrácii:

1. `alter table public.X enable row level security;` (+ `force`, ak má byť chránená aj pred vlastníkom)
2. politiky s **explicitným `TO authenticated`** (alebo `TO anon, authenticated` iba pre skutočne verejný flow) — nikdy `TO public` ani bez `TO` (guard to odmietne; od `20261022100000` v public schéme nie je žiadna `TO public` politika); firma cez `esblu_my_active_company_id()`, finance cez `esblu_my_finance_view()` / `esblu_my_finance_manage()`
3. `revoke all on table public.X from public, anon, authenticated, service_role;`
4. iba potrebné granty — napr. `grant select on table public.X to authenticated;` /
   `grant select, insert, update, delete on table public.X to service_role;`
   Service-only alebo RPC-only tabuľka nemá pre `authenticated` žiadny grant (prístup cez SECURITY DEFINER RPC).
5. záznam do `supabase/grants/public-data-api-grants.json` (trieda A–E, granty, dôvod)

Nová funkcia `public.f(...)`: `revoke all on function public.f(...) from public, anon;` a výslovné
`grant execute … to authenticated` / `service_role` podľa toho, kto ju volá. SECURITY DEFINER vždy
`set search_path = ''` a overenie členstva/roly/session vo funkcii.

Stĺpcový grant (napr. `settings`): pri novom klientsky zapisovanom stĺpci pridaj `grant update (stĺpec)` — inak zápis zlyhá s `42501` (príklad: `settings.locale`, oprava `20261022100000`). Klient pri zápise cez supabase-js vždy kontroluje `error`.

Reconciliation `20261021100000` robí `revoke all` → ak by sa niekedy spúšťala znova, musí po nej nasledovať aj `20261022100000` (locale grant).

Zakázané: `alter default privileges … grant`, `grant … on all tables/functions in schema public`,
`grant all` pre `anon`/`authenticated`, plošné CRUD „aby prešli testy“. Billing autorita je **owner-only** cez RPC —
žiadna billing tabuľka nemá grant pre `authenticated`.

## Triedy

| trieda | anon | authenticated | service_role |
|---|---|---|---|
| A — klient číta/zapisuje cez RLS | – | potrebné z SIUD | SIUD |
| B — klient iba číta | – | SELECT | SIUD (append-only užšie) |
| C — RPC/server-only | – | – | SIUD |
| D — service-role only | – | – | potrebné z SIUD |
| E — verejné | SELECT | SELECT | SIUD |

## Kontroly

- `npm run test:grants-guard` — statický guard: každá migrácia po `20261021100000` s `CREATE TABLE public.X`
  musí mať RLS + GRANT/REVOKE pre každú z rolí anon / authenticated / service_role + záznam v manifeste;
  nová funkcia musí mať GRANT/REVOKE EXECUTE. Nevyžaduje CRUD — vyžaduje rozhodnutie.
- `npm run test:grants-replay-db` — čistý replay všetkých migrácií od nuly v PGlite **bez** auto-grantov; reconciliation
  sa overuje v stave po `20261022100000`, každá neskoršia migrácia musí byť idempotentná a jej rollback → re-apply
  musí vrátiť rovnaké ACL aj politiky (preto každá nová migrácia potrebuje `supabase/rollback/<názov>_rollback.sql`);
  (`scripts/sql/pglite/supabase-platform-stub.sql`), ACL každej tabuľky == manifest, rolová matica
  (anon / owner / admin / accountant / employee / service_role; privilege vs RLS).
- Staging: `scripts/sql/grants-data-api-matrix.sql` (výsledok vo výnimke, nič nezostane). Nikdy nie produkcia.

## Replay poradie

Čistý replay = poradie súborov okrem dvoch historických závislostí (produkcia ich aplikovala skôr, než
naznačuje prefix): `20260916120000` a `20260916140000` pred `20260916094000`
(`REPLAY_ORDER_OVERRIDES` v `scripts/grants-replay-pglite-tests.ts`). Súbory sa nepremenúvajú
(MIGRATIONS.md §5). `20260720000000_legacy_pre_migration_baseline.sql` vytvorí 9 tabuliek, ktoré pred repo
migráciami vznikli v Dashboarde (na existujúcich DB no-op). Supabase CLI `db reset` v tomto repe nie je
nakonfigurovaný (`supabase/config.toml` neexistuje); kanonický čistý reset je `test:grants-replay-db`.
