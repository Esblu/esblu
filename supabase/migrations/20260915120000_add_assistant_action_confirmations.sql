begin;

-- =============================================================================
-- Esblu — assistant_action_confirmations (doplnenie zadania: "Intent Engine
-- ako bezpečný príkazový asistent nad celou aplikáciou" — hardening
-- potvrdzovacieho toku pre WRITE akcie).
-- =============================================================================
-- Kontext (1. iterácia): pôvodná implementácia write-akcií
-- (CREATE_DOCUMENT_CATEGORY/RENAME_DOCUMENT_CATEGORY/
-- ASSIGN_DOCUMENTS_TO_CATEGORY) posielala preview klientovi ako obyčajné
-- kanonické args, ktoré klient pri potvrdení poslal NEZMENENÉ späť na
-- /api/assistant/action/execute. Server síce vždy nanovo overoval
-- rolu/company/dotknuté entity, ale TOTO SAMO OSEBE nepreukazovalo, že
-- používateľ skutočne videl a potvrdil KONKRÉTNY preview.
--
-- Kontext (2. iterácia): pôvodný návrh tejto tabuľky mal RLS politiky, ktoré
-- dovoľovali authenticated používateľovi PRIAMY INSERT/UPDATE cez bežný
-- Supabase/PostgREST klient (reálny bypass — vlastný "pending action" riadok
-- bez toho, aby appka predtým zobrazila preview). Oprava presunula
-- INSERT/UPDATE do dvoch úzkych SECURITY DEFINER RPC funkcií
-- (esblu_create_action_confirmation/esblu_claim_action_confirmation) —
-- tabuľka samotná nemá pre authenticated/anon žiadnu RLS policy ani
-- table-level grant.
--
-- Kontext (3. iterácia — TÁTO verzia, pred prvou produkčnou aplikáciou tejto
-- migrácie nahradená ďalším bezpečnostným auditom): `esblu_create_action_confirmation`
-- MUSÍ zostať `GRANT EXECUTE TO authenticated` (Next.js server ju volá pod
-- identitou prihláseného používateľa cez user-scoped klienta — appka nikdy
-- nepoužíva service_role). To ale znamená, že AJ authenticated používateľ z
-- browser konzoly ju vie zavolať priamo (`supabase.rpc("esblu_create_action_confirmation",
-- {...})`), s vlastným intentom/canonical_args/expected_count — RPC by mu
-- vytvorila plnohodnotný confirmationId BEZ toho, aby cez toto ID kedy
-- prešiel skutočný serverový buildActionPreview() flow. Pôvodný INSERT
-- bypass sa teda iba presunul na CREATE RPC.
--
-- OPRAVA (finálny, bezpečný stav — appka túto migráciu ešte NIKDY
-- neaplikovala produkčne, preto sa opravuje PRIAMO tento súbor): DB
-- samotná už nerozhoduje o platnosti confirmation na základe toho, KTO ju
-- vytvoril (browser vs. Next.js server vyzerajú z pohľadu DB identicky —
-- obe sú "authenticated" rola s rovnakým JWT) — namiesto toho pridáva
-- kryptografický HMAC-SHA256 "server proof" (`nonce`/`server_proof`
-- stĺpce), ktorý vie vypočítať/overiť VÝHRADNE Next.js server (má prístup k
-- server-only env secretu `ESBLU_ACTION_CONFIRMATION_SECRET`, ktorý sa
-- NIKDE v DB neukladá a teda ani RPC funkcia — hoci beží ako SECURITY
-- DEFINER — nemá k nemu prístup). Riadok vytvorený priamym RPC volaním z
-- browsera bez platného proof v DB PRETRVÁVA (RPC ho neodmietne — nevie, čo
-- je "platné"), ale `lib/intents/actions.ts#executeAction` ho pri execute
-- kroku odmietne vykonať, lebo prepočítaný očakávaný HMAC sa nezhoduje s
-- uloženým `server_proof` (fail closed, žiadny business write). Pozri
-- lib/intents/action-confirmation-proof.ts pre presný kryptografický návrh.
--
-- EXPORT_DOCUMENTS túto tabuľku NEPOUŽÍVA — nezapisuje nič do DB (klientsky
-- ExcelJS export), takže rovnaká infraštruktúra (vrátane HMAC proof) by tam
-- bola zbytočný overengineering (pozri lib/intents/actions.ts).
--
-- Táto migrácia je ČISTO ADITÍVNA (nová tabuľka + 2 nové funkcie, žiadna
-- zmena existujúcich tabuliek/CHECK/RLS/dát) — bezpečná na aplikáciu bez
-- rizika straty dát.
-- =============================================================================

create table public.assistant_action_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  -- Striktný allowlist — presne tie WRITE intenty, ktoré túto tabuľku
  -- používajú (lib/intents/registry.ts#isRegisteredWriteIntent MÍNUS
  -- EXPORT_DOCUMENTS, pozri komentár vyššie). Nový write intent v
  -- budúcnosti musí tento CHECK explicitne rozšíriť — fail closed, nie
  -- tichý "hocijaký text sa zapíše". Rovnaký allowlist je ZNOVU (nezávisle)
  -- vynútený aj v esblu_create_action_confirmation() nižšie — dve nezávislé
  -- vrstvy, nie jedna.
  intent text not null check (
    intent in (
      'CREATE_DOCUMENT_CATEGORY',
      'RENAME_DOCUMENT_CATEGORY',
      'ASSIGN_DOCUMENTS_TO_CATEGORY'
    )
  ),
  -- Presne tie kanonické, appkou už sanitizované args, z ktorých
  -- buildActionPreview() vytvoril zobrazený `summary` (categoryName/
  -- newCategoryName/targetCategoryName/documentTypes/dateFrom/dateTo/query)
  -- — appka sem zapisuje výhradne to, čo sama vypočítala (cez
  -- esblu_create_action_confirmation(), nikdy priamym INSERTom klienta —
  -- pozri RLS/REVOKE nižšie). Execute krok z tohto stĺpca args nanovo
  -- PREČÍTA (cez esblu_claim_action_confirmation()), nikdy neprijíma args
  -- z tela execute requestu. POZOR: tento stĺpec je súčasťou HMAC payloadu
  -- (pozri `server_proof` nižšie) — hodnota v DB sama osebe NIE JE
  -- "dôveryhodná" iba preto, že prešla cez RPC; execute krok ju musí overiť
  -- proti proof pred akýmkoľvek použitím.
  canonical_args jsonb not null,
  -- Iba pre ASSIGN_DOCUMENTS_TO_CATEGORY (bulk) — počet dokumentov, ktoré
  -- preview našiel. Execute krok pri spotrebovaní tohto potvrdenia
  -- dotknuté dokumenty NANOVO spočíta a porovná s touto hodnotou — ak sa
  -- medzičasom zmenili (pribudol/ubudol dokument vyhovujúci filtru), appka
  -- akciu NEVYKONÁ a požiada o nový preview (fail-safe, nikdy "tichy"
  -- rozšírený/zúžený zásah oproti tomu, čo používateľ videl).
  expected_count integer,
  -- Kryptograficky náhodný, jedinečný token (hex) — súčasť HMAC payloadu.
  -- UNIQUE constraint nižšie zabraňuje tomu, aby sa aj v hypotetickom
  -- scenári "útočník niekedy získa platný (nonce, server_proof) pár"
  -- (napr. z inej zraniteľnosti) tento pár dal znovu vložiť ako NOVÝ pending
  -- confirmation riadok (bod 7 zadania).
  nonce text not null unique,
  -- HMAC-SHA256(ESBLU_ACTION_CONFIRMATION_SECRET, kanonický payload) — hex,
  -- vždy presne 64 znakov (32 bajtov). Vypočíta VÝHRADNE Next.js server pred
  -- volaním esblu_create_action_confirmation (appka teda posiela už
  -- HOTOVÝ proof, RPC/DB samotná secret nikdy nevidí a nevie ho overiť —
  -- overenie je výhradne v lib/intents/actions.ts#executeAction, PO
  -- claim-e). Pozri lib/intents/action-confirmation-proof.ts.
  server_proof text not null,
  -- Krátka platnosť (5 minút od vytvorenia, POČÍTA Next.js server a posiela
  -- ju cez p_expires_at_epoch — RPC ju iba prevezme a overí, že je v
  -- rozumnom okne; NIE je to "klient si vymyslí ľubovoľnú expiráciu", lebo
  -- akákoľvek hodnota, ktorú appka podpíše iným expiresAt než skutočne
  -- uložený, zlyhá pri HMAC verifikácii rovnako ako čokoľvek iné pozmenené)
  -- — dostatočná na bežné kliknutie [Potvrdiť], no dostatočne krátka, aby
  -- "zabudnutý" otvorený preview nebolo možné potvrdiť o hodiny/dni neskôr.
  expires_at timestamptz not null,
  -- NULL = zatiaľ nespotrebované. Nastavuje sa VÝHRADNE atomickým
  -- "UPDATE ... WHERE consumed_at IS NULL" vnútri
  -- esblu_claim_action_confirmation() (replay protection) — appka nikdy
  -- nečíta consumed_at ako "informatívne pole", vždy ako súčasť podmienky
  -- WHERE pri claim-e.
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  -- Defense-in-depth (bezpečnostný audit, bod 4 zadania) — platí VŽDY, pre
  -- KAŽDÉHO volajúceho (CHECK constraint sa na rozdiel od RLS nedá obísť
  -- ani cez SECURITY DEFINER/table owner/superuser), takže aj prípadná
  -- budúca chyba v RPC funkcii nižšie by nikdy nemohla zapísať zápornú/NULL
  -- expected_count, expires_at <= created_at, alebo štrukturálne
  -- nesprávny nonce/server_proof tvar.
  constraint assistant_action_confirmations_expected_count_valid
    check (expected_count is null or expected_count >= 0),
  constraint assistant_action_confirmations_expires_after_created
    check (expires_at > created_at),
  constraint assistant_action_confirmations_nonce_shape
    check (nonce ~ '^[0-9a-f]{16,128}$'),
  constraint assistant_action_confirmations_server_proof_shape
    check (server_proof ~ '^[0-9a-f]{64}$')
);

comment on table public.assistant_action_confirmations is
  'Krátkodobý server-side "pending write action" záznam pre Intent Engine Action Engine (CREATE/RENAME/ASSIGN_DOCUMENTS_TO_CATEGORY) — vzniká VÝHRADNE cez esblu_create_action_confirmation(), klient dostane iba jeho id (confirmationId), esblu_claim_action_confirmation() ho atomicky spotrebuje presne raz (replay protection). Tabuľka nemá žiadnu RLS politiku ani table-level grant pre authenticated/anon — je pre bežný Supabase/PostgREST klient prakticky neprístupná, jediný povolený prístup je cez tieto dve SECURITY DEFINER RPC funkcie. Riadok sám osebe NIE JE dôkazom platnosti — až Next.js server overí `server_proof` (HMAC) proti server-only secretu pred vykonaním zápisu (pozri lib/intents/action-confirmation-proof.ts); RPC funkcie samotné secret nepoznajú. EXPORT_DOCUMENTS túto tabuľku nepoužíva (nezapisuje nič do DB).';

create index assistant_action_confirmations_user_id_idx
  on public.assistant_action_confirmations (user_id);

-- Podporuje prípadný budúci cleanup job vyexpirovaných/spotrebovaných
-- riadkov (nie je súčasťou tejto úlohy — appka dnes staré riadky
-- neuprace, iba ich nikdy znova nepoužije, pozri claim funkciu nižšie) A
-- spam-protection COUNT v esblu_create_action_confirmation() nižšie.
create index assistant_action_confirmations_expires_at_idx
  on public.assistant_action_confirmations (expires_at)
  where consumed_at is null;

-- Spam protection (bod 4 zadania) — rýchly COUNT nespotrebovaných/
-- neexpirovaných confirmations PER USER.
create index assistant_action_confirmations_user_pending_idx
  on public.assistant_action_confirmations (user_id)
  where consumed_at is null;

alter table public.assistant_action_confirmations enable row level security;

-- =============================================================================
-- ZÁMERNE ŽIADNA RLS POLICY.
-- =============================================================================
-- RLS je ENABLED, ale pre `assistant_action_confirmations` NEEXISTUJE ani
-- jedna SELECT/INSERT/UPDATE/DELETE policy. V Postgrese to znamená úplný
-- default-deny pre KAŽDÚ rolu, ktorá nie je vlastníkom tabuľky/nemá
-- BYPASSRLS (teda pre `authenticated` aj `anon` — appka nikdy nepoužíva
-- service_role klienta, pozri lib/server-supabase-user-client.ts) — priamy
-- `.from("assistant_action_confirmations").select()/.insert()/.update()`
-- cez bežný Supabase klient tak nevráti/nezapíše ŽIADNY riadok.
--
-- DÔLEŽITÉ (3. iterácia): toto NEBRÁNI authenticated používateľovi zavolať
-- `esblu_create_action_confirmation` RPC priamo (tá je zámerne
-- `GRANT EXECUTE TO authenticated` — Next.js server ju potrebuje volať pod
-- identitou prihláseného používateľa). RLS/REVOKE tu rieši iba "surový"
-- INSERT/UPDATE/SELECT na tabuľku — ochranu proti "priame RPC volanie s
-- vlastným obsahom vytvorí kryptograficky PLATNÝ confirmation" rieši
-- VÝHRADNE HMAC `server_proof`, ktorý RPC nevie vypočítať (nepozná
-- secret) — pozri lib/intents/action-confirmation-proof.ts a
-- lib/intents/actions.ts#executeAction.
--
-- Appka NEPOTREBUJE priamy SELECT z klienta — obe RPC funkcie nižšie vrátia
-- presne tie stĺpce, ktoré appka potrebuje, takže ani SELECT policy nie je
-- potrebná (tabuľka má byť pre bežný klient prakticky neprístupná).
--
-- Nasledujúci explicitný REVOKE je DRUHÁ, nezávislá vrstva nad RLS — aj keby
-- RLS na tejto tabuľke niekedy omylom bolo vypnuté (`disable row level
-- security`), `authenticated`/`anon` by AJ TAK nemali table-level privilégium
-- SELECT/INSERT/UPDATE/DELETE (Supabase ich inak automaticky grantuje cez
-- ALTER DEFAULT PRIVILEGES pri vytvorení každej novej public tabuľky).
revoke insert, update, delete, select
  on public.assistant_action_confirmations
  from authenticated, anon;

-- Žiadny DELETE — appka riadky nikdy nemaže (spotrebovaný/expirovaný riadok
-- je neškodný, WHERE podmienky pri claim-e ho už nikdy znova nepoužijú).

-- =============================================================================
-- esblu_create_action_confirmation — VÝHRADNÝ spôsob, ako vznikne nový
-- "pending action" riadok. Volá sa z
-- lib/intents/actions.ts#insertActionConfirmation (cez user-scoped Supabase
-- klienta, teda pod identitou prihláseného používateľa — RPC si napriek
-- tomu auth.uid()/company_id VŽDY overuje samo, nikdy neverí ničomu, čo
-- appka "vie" o volajúcom).
--
-- POZOR (3. iterácia): táto funkcia JE `GRANT EXECUTE TO authenticated` a
-- teda VOLATEĽNÁ aj priamo z browser konzoly pod identitou prihláseného
-- používateľa — to je OČAKÁVANÉ a NEODSTRÁNITEĽNÉ (Next.js server ju
-- potrebuje volať presne takto). Funkcia preto SAMA OSEBE nerozhoduje o
-- tom, či je výsledný riadok "dôveryhodný" — iba uloží presne to, čo
-- dostala (po validácii tvaru/allowlistu/rozumných hraníc), vrátane
-- `nonce`/`server_proof`, ktoré prišli AKO PARAMETRE. Skutočnú
-- dôveryhodnosť (že `server_proof` zodpovedá HMAC vypočítanému zo secretu,
-- ktorý RPC nepozná) overuje AŽ execute krok — pozri komentár na začiatku
-- súboru.
-- =============================================================================
create or replace function public.esblu_create_action_confirmation(
  p_intent text,
  p_canonical_args jsonb,
  p_expected_count integer,
  p_nonce text,
  p_server_proof text,
  p_expires_at_epoch bigint
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
  v_id uuid;
  v_expires_at timestamptz;
  v_pending_count integer;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  -- Nezávislý allowlist check — RPC parameter `p_intent` NEDÔVERUJE ani
  -- appke, ktorá ho volá (appka ho aj tak posiela iba z pevného switch-u v
  -- lib/intents/actions.ts, ale RPC je posledná, nezávislá poistka presne
  -- tak, ako to má aj CHECK constraint na stĺpci `intent`).
  if p_intent is null or p_intent not in (
    'CREATE_DOCUMENT_CATEGORY',
    'RENAME_DOCUMENT_CATEGORY',
    'ASSIGN_DOCUMENTS_TO_CATEGORY'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_ACTION_INTENT';
  end if;

  if p_canonical_args is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_MISSING_CANONICAL_ARGS';
  end if;

  if p_expected_count is not null and p_expected_count < 0 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_EXPECTED_COUNT';
  end if;

  if p_nonce is null or p_nonce !~ '^[0-9a-f]{16,128}$' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_NONCE';
  end if;

  if p_server_proof is null or p_server_proof !~ '^[0-9a-f]{64}$' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_SERVER_PROOF';
  end if;

  if p_expires_at_epoch is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_EXPIRY';
  end if;

  -- `to_timestamp` je pg_catalog built-in (vždy dostupný aj so
  -- `search_path = ''`). Rozumné okno (max. 6 minút od teraz — appka sama
  -- podpisuje 5 minút, +60s tolerancia) je iba defense-in-depth proti DB
  -- bloatu/absurdným hodnotám; skutočnú platnosť aj tak rieši HMAC pri
  -- execute, nie táto hranica.
  v_expires_at := to_timestamp(p_expires_at_epoch);
  if v_expires_at <= now() or v_expires_at > now() + interval '6 minutes' then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_EXPIRY';
  end if;

  -- Company sa VŽDY odvodí zo session (rovnaký helper ako v RLS na iných
  -- tabuľkách) — nikdy sa neprijíma ako parameter funkcie, takže volajúci
  -- nemôže vytvoriť confirmation "pre inú firmu".
  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  -- Spam protection (bod 4 zadania) — rozumný limit nespotrebovaných/
  -- neexpirovaných confirmations na používateľa. Toto NIE JE bezpečnostná
  -- hranica proti kryptograficky neplatným confirmation (to rieši HMAC pri
  -- execute) — je to iba ochrana pred neobmedzeným DB spamom cez priame RPC
  -- volania z browser konzoly.
  select count(*) into v_pending_count
  from public.assistant_action_confirmations
  where user_id = v_uid
    and consumed_at is null
    and expires_at > now();

  if v_pending_count >= 20 then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_TOO_MANY_PENDING_CONFIRMATIONS';
  end if;

  insert into public.assistant_action_confirmations (
    user_id, company_id, intent, canonical_args, expected_count, nonce, server_proof, expires_at
  ) values (
    v_uid, v_company_id, p_intent, p_canonical_args, p_expected_count, p_nonce, p_server_proof, v_expires_at
  )
  returning id into v_id;

  return v_id;
end;
$function$;

comment on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) is
  'Vytvorí nový krátkodobý "pending write action" záznam (max. ~5-6 min TTL) pre presne jeden z povolených write intentov. user_id/company_id sa VŽDY odvodia zo session, nikdy z parametra. `nonce`/`server_proof`/`p_expires_at_epoch` prichádzajú ako parametre (appka ich vypočíta PRED volaním, RPC secret nepozná) — táto funkcia iba ukladá, PLATNOSŤ proof overuje výhradne Next.js server pri execute. Volateľná priamo z authenticated klienta (zámerne — Next.js server ju tak aj volá); DB confirmation bez platného proof jednoducho nebude executable. Volá sa VÝHRADNE z lib/intents/actions.ts#insertActionConfirmation.';

-- Zúženie bežných privilégií (Supabase inak funkcii automaticky grantuje
-- EXECUTE pre PUBLIC pri CREATE FUNCTION) — explicitný REVOKE + GRANT iba
-- pre `authenticated` presne podľa konvencie prísnejších RPC v projekte
-- (napr. esblu_member_delete_self). `anon` (neprihlásený) EXECUTE nemá —
-- funkcia by aj tak zlyhala na NOT_AUTHENTICATED, ale nemá zmysel ju
-- vystavovať neprihláseným vôbec.
revoke all on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) from public;
grant execute on function public.esblu_create_action_confirmation(text, jsonb, integer, text, text, bigint) to authenticated;

-- =============================================================================
-- esblu_claim_action_confirmation — VÝHRADNÝ spôsob, ako sa "pending action"
-- riadok prečíta A spotrebuje. Volá sa z
-- lib/intents/actions.ts#executeAction, PO potvrdení v UI. Vracia AJ
-- nonce/server_proof/expires_at_epoch/user_id/company_id — Next.js server z
-- nich rekonštruuje presne ten istý kanonický payload, aký bol podpísaný pri
-- vytvorení, a overí HMAC PRED akýmkoľvek business zápisom.
-- =============================================================================
create or replace function public.esblu_claim_action_confirmation(
  p_confirmation_id uuid
)
returns table (
  intent text,
  canonical_args jsonb,
  expected_count integer,
  nonce text,
  server_proof text,
  expires_at_epoch bigint,
  user_id uuid,
  company_id uuid
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid;
  v_company_id uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception using
      errcode = '28000',
      message = 'NOT_AUTHENTICATED';
  end if;

  if p_confirmation_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_INVALID_CONFIRMATION';
  end if;

  v_company_id := public.esblu_my_active_company_id();
  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY';
  end if;

  -- JEDINÝ atomický krok — UPDATE ... WHERE ... RETURNING v rámci JEDNEJ
  -- SQL statement. Toto JEDNÝM krokom:
  --   1) overí vlastníctvo (user_id = v_uid),
  --   2) overí firmu (company_id = v_company_id),
  --   3) overí, že confirmation ešte NEBOLA použitá (consumed_at is null),
  --   4) overí expiráciu (expires_at > now()),
  --   5) OKAMŽITE nastaví consumed_at = now() — teda "claim-ne" riadok.
  -- Postgres row-level locking garantuje, že pri dvoch súbežných/replay
  -- volaniach s tým istým confirmationId iba JEDNO z nich nájde riadok so
  -- `consumed_at IS NULL` — druhé už nenájde žiadny riadok (0 riadkov
  -- vrátených), presne preto, že prvé ho medzitým spotrebovalo. Appka
  -- nepotrebuje žiadny vlastný mutex/advisory lock.
  --
  -- POZOR: úspešný claim SÁM OSEBE ešte NEZNAMENÁ kryptograficky platné
  -- potvrdenie — iba že riadok existuje, patrí volajúcemu, nie je
  -- expirovaný/spotrebovaný. HMAC verifikáciu (jediný skutočný dôkaz, že
  -- tento riadok vznikol zo skutočného preview flow) robí AŽ Next.js
  -- server po tomto volaní — a keďže claim je nezvratný (riadok je odteraz
  -- `consumed_at` bez ohľadu na výsledok HMAC verifikácie), replay
  -- rovnakého confirmationId nie je možný ani keby proof nesedel.
  return query
  update public.assistant_action_confirmations c
  set consumed_at = now()
  where c.id = p_confirmation_id
    and c.user_id = v_uid
    and c.company_id = v_company_id
    and c.consumed_at is null
    and c.expires_at > now()
  returning
    c.intent,
    c.canonical_args,
    c.expected_count,
    c.nonce,
    c.server_proof,
    extract(epoch from c.expires_at)::bigint,
    c.user_id,
    c.company_id;

  -- Zámerne ŽIADNA vetva "if not found then raise exception" — appka
  -- (lib/intents/actions.ts#executeAction) rozlišuje "claim úspešný" od
  -- "claim zlyhal" podľa toho, či RPC vrátilo 0 alebo 1 riadok (rovnaké
  -- fail-closed správanie, žiadny rozdiel v tom, PREČO claim zlyhal — cudzí/
  -- expirovaný/použitý/neexistujúci confirmationId vyzerajú navonok
  -- identicky, presne ako to vyžaduje bezpečnostné review).
end;
$function$;

comment on function public.esblu_claim_action_confirmation(uuid) is
  'Atomicky načíta A spotrebuje (consumed_at = now()) presne jeden pending confirmation riadok — vlastný, nespotrebovaný, neexpirovaný, pre aktívnu firmu volajúceho. Replay/cross-user/cross-company/expired/random-id všetky zlyhajú rovnako (0 vrátených riadkov). Vracia aj nonce/server_proof/expires_at_epoch/user_id/company_id na rekonštrukciu HMAC payloadu — úspešný claim NIE JE sám osebe dôkaz platnosti, tú overuje Next.js server po tomto volaní. Volá sa VÝHRADNE z lib/intents/actions.ts#executeAction.';

revoke all on function public.esblu_claim_action_confirmation(uuid) from public;
grant execute on function public.esblu_claim_action_confirmation(uuid) to authenticated;

commit;
