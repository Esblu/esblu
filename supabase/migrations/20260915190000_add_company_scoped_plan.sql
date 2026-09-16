-- =============================================================================
-- Company-scoped subscription plan (oprava BLOCKER A/B z Fázy 1A auditu)
-- =============================================================================
-- KONTEXT (viď docs/invoicing-efaktura-architecture-2026-09-15.md, sekcia
-- "FÁZA 1A" + report k tejto úlohe):
--
--   BLOCKER A — settings.plan sa dnes číta DVOMA nekonzistentnými spôsobmi:
--     1. Server-side DB enforcement (trigger esblu_enforce_plan_limit ->
--        funkcia esblu_company_plan(company_id)) UŽ DNES správne rieši plán
--        na úrovni firmy — JOIN cez company_members (role='owner') na
--        settings.plan ownera. Toto je autoritatívna, bezpečná hranica a
--        FUNGUJE SPRÁVNE už dnes (potvrdené priamym čítaním definície
--        funkcie v produkcii, 15.9.2026).
--     2. Client-side UI hook (hooks/use-plan-usage.ts) číta VLASTNÝ
--        settings.plan riadok prihláseného používateľa (nie ownera firmy) —
--        toto JE bug, ale iba UI/UX bug (nesprávne zobrazenie), nie
--        bezpečnostný bypass, keďže skutočné vynútenie limitu ide vždy cez
--        server-side trigger (bod 1), ktorý appka nemôže obísť.
--
--   BLOCKER B — usage counting: server-side trigger UŽ DNES počíta usage
--     cez `count(*) from public.<table> where company_id = $1` (company-
--     scoped, s advisory lockom na company_id+tabuľka pre concurrency-
--     safety) — TOTO JE SPRÁVNE a bolo tak už pred touto migráciou. Bug bol
--     iba v client-side hooku, ktorý počítal `.eq("user_id", ...)` namiesto
--     `.eq("company_id", ...)`.
--
-- ROZHODNUTIE PRODUKTU (od používateľa, táto úloha):
--   1. Plán je COMPANY-SCOPED, nie USER-SCOPED.
--   2. Usage limity sú COMPANY-SCOPED (už boli, na DB úrovni — potvrdzujeme).
--   3. Plán/subscription NESMIE byť súčasťou budúcej company_billing_profile
--      (Fáza 1B, fakturačný modul) — musí mať vlastný, nezávislý zdroj
--      pravdy.
--   4. Preferovať existujúci company model — najmenšia bezpečná zmena je
--      nový stĺpec priamo na `companies` (existujúca multi-tenant kotva),
--      NIE nová samostatná tabuľka (subscription dnes nemá žiadne ďalšie
--      metadáta — fakturačný cyklus, dátum obnovy a pod. — jedna hodnota
--      typu text si novú tabuľku nevyžaduje; ak sa to v budúcnosti zmení,
--      pridanie `company_subscriptions` je jednoduchý ďalší krok, nie
--      spätná migrácia tejto).
--
-- STRATÉGIA: EXPAND-ONLY migrácia (žiadny CONTRACT krok teraz):
--   - Pridáva sa `companies.plan` (nový zdroj pravdy).
--   - Backfilluje sa z DNEŠNÉHO stavu (owner settings.plan cez rovnaký JOIN,
--     aký používa existujúca esblu_company_plan()) — žiadna strata dát.
--   - `esblu_company_plan()` sa PREPÍŠE, aby čítala z `companies.plan`
--     namiesto JOIN cez settings — signatúra (názov/argumenty/návratový typ)
--     ostáva IDENTICKÁ, takže trigger esblu_enforce_plan_limit (ktorý ju
--     volá) sa vôbec nemusí meniť.
--   - `settings.plan` stĺpec SA NEMAŽE a `esblu_create_settings_for_new_user`
--     sa nemení — zostáva vestigiálny/historický, kým sa CONTRACT krok
--     (odstránenie) neschváli samostatne, v budúcej úlohe. Žiadna strata dát.
--
-- BEZPEČNOSŤ: na `companies` existuje iba RLS SELECT politika
-- (companies_select_member) pre aktívnych členov firmy — ŽIADNA UPDATE
-- politika neexistuje ani sa touto migráciou nepridáva. Nový stĺpec `plan`
-- je preto od začiatku chránený default-deny správaním RLS: žiadny
-- prihlásený používateľ (owner/admin/employee) nemôže sám zmeniť plán
-- priamym UPDATE — zmena plánu je zámerne mimo rozsahu tejto úlohy
-- (budúci billing/administratívny mechanizmus, samostatné rozhodnutie).
--
-- TÁTO MIGRÁCIA NEBOLA V RÁMCI TEJTO ÚLOHY APLIKOVANÁ DO PRODUKCIE —
-- iba pripravená na review. Aplikácia vyžaduje samostatný pokyn používateľa.
-- =============================================================================

-- 1) EXPAND: nový company-scoped stĺpec, rovnaká doména hodnôt ako
--    settings.plan (settings_plan_check), s rovnakým predvoleným 'free'.
alter table public.companies
  add column plan text not null default 'free';

alter table public.companies
  add constraint companies_plan_check
  check (plan = any (array['free'::text, 'pro'::text, 'admin'::text]));

-- 2) BACKFILL: prevezmi DNEŠNÝ efektívny plán každej firmy (presne ten istý
--    JOIN, aký dnes robí esblu_company_plan()) — po tomto kroku je
--    companies.plan zhodné s tým, čo appka už dnes efektívne vynucuje.
--    Firmy bez aktívneho ownera (nemalo by nastať, ale defenzívne) alebo bez
--    settings riadku ownera ostávajú na DEFAULT 'free' (rovnaký fallback,
--    aký má dnešná esblu_company_plan cez coalesce(v_plan, 'free')).
-- DETERMINIZMUS (doplnené počas finálneho security review, 15.9.2026): DB
-- neexistuje žiadny UNIQUE/CHECK, ktorý by vynucoval najviac jedného
-- aktívneho 'owner' na firmu — company_members_unique_company_user je iba
-- UNIQUE(company_id, user_id), nie čiastočný unique index na (company_id)
-- WHERE role='owner'. V produkcii k 15.9.2026 nemá ŽIADNA firma viac než
-- jedného aktívneho ownera (overené: `SELECT company_id, count(*) FROM
-- company_members WHERE role='owner' AND status='active' GROUP BY
-- company_id HAVING count(*) > 1` vrátilo 0 riadkov), takže na dnešných
-- dátach je výsledok backfillu identický s/bez ORDER BY. Explicitný
-- `ORDER BY cm.created_at ASC` nižšie je čisto defenzívny — zaručí
-- deterministický (najstarší aktívny owner) výsledok aj v hypotetickom
-- budúcom stave s viacerými aktívnymi 'owner' riadkami, namiesto
-- nedefinovaného poradia, aké by malo holé `LIMIT 1`.
update public.companies c
set plan = coalesce(
  (
    select s.plan
    from public.company_members cm
    join public.settings s on s.user_id = cm.user_id
    where cm.company_id = c.id
      and cm.role = 'owner'
      and cm.status = 'active'
    order by cm.created_at asc
    limit 1
  ),
  'free'
);

-- 3) Presmeruj esblu_company_plan() na nový zdroj pravdy. Signatúra
--    (public.esblu_company_plan(uuid) returns text) je IDENTICKÁ ako dnes,
--    takže esblu_enforce_plan_limit() (trigger na ai_evidence/vehicles/
--    inventory_items/machines) sa nemusí meniť vôbec — automaticky začne
--    čítať z companies.plan cez túto funkciu.
create or replace function public.esblu_company_plan(p_company_id uuid)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(c.plan, 'free')
  from public.companies c
  where c.id = p_company_id;
$function$;

-- 4) LEAST-PRIVILEGE HARDENING (doplnené počas finálneho security review,
--    15.9.2026 — zapracované SEM, do bodu A, pretože táto migrácia ešte
--    NEBOLA nikde aplikovaná, takže nejde o spätnú úpravu histórie, iba o
--    finalizáciu obsahu pred prvou aplikáciou).
--
--    PREČO je toto vôbec potrebné: `CREATE OR REPLACE FUNCTION` vyššie (bod
--    3) automaticky (znova) udelí EXECUTE aj anon/authenticated, pretože
--    tento projekt má na schéme public nastavené (overené priamo z
--    pg_default_acl, 15.9.2026):
--      ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--        GRANT EXECUTE ON FUNCTIONS TO postgres, anon, authenticated, service_role;
--    Presne ten istý mechanizmus, pre ktorý bola v predchádzajúcom kole
--    potrebná korektívna migrácia 20260915173000_restrict_action_confirmation_rpc_execute.sql
--    pre HMAC action-confirmation RPC. Tu sa rovnaký problém rieši HNEĎ, v
--    tej istej (ešte neaplikovanej) migrácii, nie dodatočnou opravou.
--
--    OVERENÝ CALL GRAPH (presne, nie predpoklad — 15.9.2026):
--      - V CELEJ produkčnej DB existuje IBA JEDNO miesto, ktoré volá
--        esblu_company_plan(): funkcia esblu_enforce_plan_limit() (BEFORE
--        INSERT trigger na ai_evidence/vehicles/inventory_items/machines).
--        Overené: `SELECT routine_name FROM information_schema.routines
--        WHERE routine_schema='public' AND routine_definition ILIKE
--        '%esblu_company_plan%'` vrátilo VÝHRADNE 'esblu_enforce_plan_limit'.
--      - V CELOM frontend/server repozitári Esblu (grep na
--        "esblu_company_plan" naprieč všetkými .ts/.tsx/.sql súbormi)
--        NEEXISTUJE žiadne priame `supabase.rpc("esblu_company_plan", ...)`
--        volanie — nový hooks/use-plan-usage.ts číta `companies.plan`
--        PRIAMO (cez RLS politiku companies_select_member), nie cez túto
--        RPC funkciu. Jediný textový výskyt mimo tejto migrácie je
--        komentár v use-plan-usage.ts (prozaická zmienka, nie volanie).
--      - Obe funkcie (esblu_company_plan AJ esblu_enforce_plan_limit) sú
--        vlastnené rolou `postgres` (overené cez pg_proc.proowner). Keď
--        esblu_enforce_plan_limit (SECURITY DEFINER) beží ako trigger, jej
--        telo — vrátane interného volania esblu_company_plan — sa
--        vykonáva s právami VLASTNÍKA (`postgres`) po celú dobu jej behu.
--        Vlastník objektu má na svoj vlastný objekt VŽDY implicitné
--        EXECUTE, nezávisle od explicitných GRANT/REVOKE voči iným rolám
--        (základná Postgres sémantika vlastníctva). REVOKE nižšie preto
--        interný trigger flow nijako neovplyvní — postgres oň nijako
--        nepríde.
--
--    ZÁVER: na rozdiel od HMAC action-confirmation RPC (kde authenticated
--    EXECUTE zostal zámerne zachovaný, lebo frontend ich volá PRIAMO cez
--    supabase.rpc(...)), tu authenticated klient túto funkciu NIKDY
--    nevolá — preto môže byť EXECUTE odobraté VŠETKÝM netriviálnym rolám
--    (PUBLIC, anon, authenticated) bez zmeny funkčnosti, a ponechané iba
--    pre interný DB flow (postgres ako vlastník) + service_role
--    (administratívne/skriptové použitie, rovnaká dôvera ako pri iných
--    SECURITY DEFINER funkciách v projekte — service_role dnes túto
--    funkciu nikde priamo nevolá, ale ponecháva sa preň konzistentne s
--    ostatnými RPC v projekte a keďže tak či tak dostane EXECUTE
--    automaticky z default privileges vyššie).
--
--    revoke ... from public NESTAČÍ samo osebe (rovnaké poučenie ako pri
--    20260915173000) — anon/authenticated majú EXECUTE grantnuté PRIAMO
--    (cez default privileges pri CREATE), nie odvodene cez PUBLIC, takže
--    sa musia revokovať MENOVITE.
revoke all on function public.esblu_company_plan(uuid) from public;
revoke all on function public.esblu_company_plan(uuid) from anon;
revoke all on function public.esblu_company_plan(uuid) from authenticated;

-- Explicitný (nie iba implicitný z default privileges) grant pre
-- service_role — pre auditovateľnosť: budúci čitateľ tejto migrácie vidí
-- priamo v texte, že service_role prístup je zámerný, nie náhodný
-- pozostatok default privileges.
grant execute on function public.esblu_company_plan(uuid) to service_role;

comment on function public.esblu_company_plan(uuid) is
  'Vráti company-scoped subscription plán danej firmy z public.companies.plan '
  '(zdroj pravdy od 20260915190000_add_company_scoped_plan.sql). '
  'Predtým čítala settings.plan ownera cez JOIN — settings.plan zostáva '
  'v DB ako historický/vestigiálny stĺpec (CONTRACT krok jeho odstránenia '
  'nie je súčasťou tejto migrácie, vyžaduje samostatné schválenie). '
  'EXECUTE je zámerne obmedzené iba na postgres (vlastník, interné volanie '
  'z esblu_enforce_plan_limit) a service_role — overený call graph '
  '(15.9.2026) potvrdzuje, že žiadny frontend/klientsky kód ju nevolá '
  'priamo, preto authenticated/anon/PUBLIC EXECUTE nemajú a nepotrebujú. '
  'POZOR pre budúce zmeny: každý ďalší CREATE OR REPLACE FUNCTION na tomto '
  'mene v tejto schéme znova automaticky udelí EXECUTE aj anon/authenticated '
  '(default privileges tohto projektu) — každá budúca migrácia, ktorá túto '
  'funkciu nahradí, MUSÍ znova zopakovať REVOKE sekciu vyššie, inak sa '
  'hardening ticho stratí.';

comment on column public.companies.plan is
  'Company-scoped subscription plán (free|pro|admin) — jediný zdroj pravdy '
  'pre plán a limity firmy. NIKDY nemieša s company_billing_profile '
  '(fakturačný modul, samostatná budúca tabuľka) — subscription a fakturačná '
  'identita firmy sú zámerne oddelené. Zmena hodnoty ide výhradne cez '
  'privilegovaný/administratívny prístup (žiadna RLS UPDATE politika pre '
  'bežných používateľov neexistuje ani sa touto migráciou nepridáva).';
