-- =============================================================================
-- 20260921120000_finance_document_access_hardening.sql
--
-- Finančne citlivý dokument musí byť chránený rovnako prísne ako finančné dáta.
--
-- POTVRDENÝ NÁLEZ
-- ---------------
-- invoices/invoice_items/invoice_parties sú od 20260916140000 finance-gated
-- (esblu_my_finance_view / esblu_my_finance_manage). OBRÁZOK tej istej faktúry
-- však finance-gated nebol:
--
--   documents_select_company             company_id = aktívna firma. Nič viac.
--   document_links_select_company        to isté.
--   document_attachments_select_company  to isté.
--   esblu_can_read_ai_inbox_object()     overuje IBA členstvo vo firme
--                                        dokumentu — teda aj storage signed
--                                        URL vydá komukoľvek z firmy.
--
-- Dôsledok: zamestnanec ani admin bez finance nevidel faktúru v /faktury, ale
-- jej fotku v Inboxe si otvoril bez obmedzenia — a cez createSignedUrl si ju
-- vedel aj stiahnuť. Skryť riadok v UI nestačí; kto pozná UUID alebo storage
-- path, obíde UI úplne.
--
-- ČO SA MENÍ
-- ----------
--   1. esblu_document_requires_finance() — jediná definícia toho, ktorý
--      dokument je finančne citlivý. Jedno miesto, nie štyri kópie zoznamu.
--   2. esblu_has_finance_view_in_company() — finance.view voči KONKRÉTNEJ
--      firme. esblu_my_finance_view() hodnotí aktívnu firmu, čo pri storage
--      helperi (ktorý pracuje s firmou dokumentu) nie je to isté.
--   3. esblu_can_read_document() — autoritatívna odpoveď pre naviazané
--      tabuľky a pre storage.
--   4. Zúžené SELECT politiky na documents / document_links /
--      document_attachments.
--   5. documents UPDATE/DELETE pre finančné doklady vyžaduje finance.manage —
--      admin bez finance nesmie mazať účtovný podklad.
--   6. esblu_can_read_ai_inbox_object() doplnené o finance gate.
--
-- ČO SA NEMENÍ (zámerne)
-- ----------------------
--   • Nefinančné dokumenty (PZP, technický preukaz, servisné doklady, ostatné
--     prevádzkové) — presne dnešný company-scoped prístup. Zamestnanec, ktorý
--     ich dnes legitímne vidí, ich vidí aj po tejto migrácii.
--   • INSERT na documents. Zamestnanec na stavbe smie odfotiť dodávateľskú
--     faktúru a poslať ju do firemného Inboxu — len si ju potom nepozrie.
--     Blokovať insert by znamenalo, že doklad sa k účtovníčke vôbec nedostane.
--   • Žiadna zmena invoices/invoice_* RLS, finalize, payment modelu ani
--     ai_evidence (vážne lístky/dodacie listy nie sú finančné doklady).
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Klasifikácia — čo je finančne citlivý dokument
-- ---------------------------------------------------------------------------
-- Rozhoduje VÝHRADNE canonical documents.document_type, nikdy názov súboru,
-- nikdy custom kategória (tú si používateľ pomenuje ľubovoľne a nesmie ňou
-- prepnúť doklad do/z finančného režimu).
--
-- FINANČNÉ:
--   invoice  faktúra (vydaná aj prijatá — smer je vlastnosť invoices, nie
--            dokumentu; obrázok oboch obsahuje sumy, IBAN a identifikáciu strán)
--   receipt  bloček — nákupný doklad so sumou a DPH, vstupuje do účtovníctva
--
-- NEFINANČNÉ (prevádzkové, zamestnanci ich bežne potrebujú):
--   insurance (PZP), vehicle_registration (TP), service_document,
--   weigh_ticket, delivery_note, other
--
-- NEKLASIFIKOVANÝ STAV: status 'uploaded'/'processing' znamená, že typ ešte
-- nie je potvrdený. documents.document_type má DEFAULT 'other', takže riadok
-- vložený bez explicitného typu by inak automaticky vyzeral ako nefinančný —
-- presne ten fail-open, ktorému treba zabrániť. Kým nie je doklad
-- klasifikovaný, správa sa ako finančný (prístup má uploader + finance).
-- Dnes je takýchto riadkov v produkcii nula: Inbox ukladá rovno s typom a so
-- statusom 'needs_review'/'confirmed'. Ide teda o poistku do budúcnosti, nie
-- o zmenu správania.
create or replace function public.esblu_document_requires_finance(
  p_document_type text,
  p_status text
)
returns boolean
language sql
immutable
set search_path to ''
as $function$
  select coalesce(p_document_type, '') in ('invoice', 'receipt')
      or coalesce(p_status, '') in ('uploaded', 'processing');
$function$;

comment on function public.esblu_document_requires_finance(text, text) is
  'Jediná definícia finančne citlivého dokumentu: document_type invoice/receipt, alebo ešte neklasifikovaný stav (status uploaded/processing — fail-closed kvôli DEFAULT ''other''). Používa ju documents RLS, esblu_can_read_document() aj storage helper, aby zoznam nedriftoval na štyroch miestach.';

revoke execute on function public.esblu_document_requires_finance(text, text) from public;
revoke execute on function public.esblu_document_requires_finance(text, text) from anon;
grant execute on function public.esblu_document_requires_finance(text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 2. finance.view voči konkrétnej firme
-- ---------------------------------------------------------------------------
-- esblu_my_finance_view() hodnotí AKTÍVNU firmu. Storage helper však pracuje
-- s firmou, ktorej dokument patrí — pri používateľovi s členstvom vo viacerých
-- firmách to nie je tá istá otázka. Táto funkcia odpovedá presne na tú, na
-- ktorú sa pýtame.
--
-- Rovnaké pravidlo ako esblu_my_finance_view(): owner vždy, inak explicitné
-- permissions.finance.view alebo .manage.
create or replace function public.esblu_has_finance_view_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select coalesce(
    (
      select
        cm.role = 'owner'
        or coalesce((cm.permissions -> 'finance' ->> 'view')::boolean, false)
        or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
        and cm.company_id = p_company_id
      limit 1
    ),
    false
  );
$function$;

comment on function public.esblu_has_finance_view_in_company(uuid) is
  'finance.view voči KONKRÉTNEJ firme (nie aktívnej). Owner vždy, inak permissions.finance.view/manage. company_id sa nikdy nepreberá ako dôveryhodné — volajúci ho len pomenúva, identitu určuje auth.uid().';

revoke execute on function public.esblu_has_finance_view_in_company(uuid) from public;
revoke execute on function public.esblu_has_finance_view_in_company(uuid) from anon;
grant execute on function public.esblu_has_finance_view_in_company(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Autoritatívna odpoveď "smiem čítať tento dokument?"
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER, takže dokument dohľadá bez ohľadu na documents RLS —
-- inak by sa politika na document_attachments pýtala cez už zúženú politiku
-- na documents a výsledok by sa dvojito filtroval.
--
-- Poradie kontrol je zámerné: najprv existencia a členstvo (cudzí tenant a
-- neprihlásený nedostanú ani informáciu, že dokument existuje), až potom
-- finance.
create or replace function public.esblu_can_read_document(p_document_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_type text;
  v_status text;
  v_user_id uuid;
begin
  if v_uid is null or p_document_id is null then
    return false;
  end if;

  select d.company_id, d.document_type, d.status, d.user_id
    into v_company_id, v_type, v_status, v_user_id
  from public.documents d
  where d.id = p_document_id;

  if v_company_id is null then
    return false;
  end if;

  if not exists (
    select 1 from public.company_members cm
    where cm.user_id = v_uid
      and cm.status = 'active'
      and cm.company_id = v_company_id
  ) then
    return false;
  end if;

  if not public.esblu_document_requires_finance(v_type, v_status) then
    return true;
  end if;

  if public.esblu_has_finance_view_in_company(v_company_id) then
    return true;
  end if;

  -- Uploader vidí VÝHRADNE svoj ešte neklasifikovaný doklad, aby mu
  -- rozpracovaný upload nezmizol pod rukami. Na hotovú faktúru/bloček sa
  -- táto výnimka NEVZŤAHUJE — inak by stačilo doklad nahrať a obísť tým
  -- celé finance obmedzenie.
  return coalesce(v_status, '') in ('uploaded', 'processing') and v_user_id = v_uid;
end;
$function$;

comment on function public.esblu_can_read_document(uuid) is
  'Autoritatívna kontrola čitateľnosti dokumentu: existencia + aktívne členstvo vo firme dokumentu, a pri finančne citlivom doklade navyše finance.view. Uploader má výnimku iba pre vlastný ešte neklasifikovaný upload. Používajú ju RLS na document_links/document_attachments a storage helper.';

revoke execute on function public.esblu_can_read_document(uuid) from public;
revoke execute on function public.esblu_can_read_document(uuid) from anon;
grant execute on function public.esblu_can_read_document(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 4. documents — SELECT
-- ---------------------------------------------------------------------------
-- Nefinančná vetva je doslova pôvodná politika. Pribúda len podmienka pre
-- finančné doklady, takže prevádzkové dokumenty (PZP, TP, servis, ostatné)
-- sa správajú presne ako doteraz.
drop policy if exists documents_select_company on public.documents;

create policy documents_select_company
  on public.documents
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_view()
      or (status in ('uploaded', 'processing') and user_id = (select auth.uid()))
    )
  );


-- ---------------------------------------------------------------------------
-- 5. documents — UPDATE / DELETE
-- ---------------------------------------------------------------------------
-- Účtovný podklad nesmie zmazať ani prepísať admin, ktorý naň nemá vidieť.
-- Owner má finance implicitne, takže pre neho sa nemení nič.
drop policy if exists documents_update_owner_admin on public.documents;

create policy documents_update_owner_admin
  on public.documents
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_manage()
    )
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_manage()
    )
  );

drop policy if exists documents_delete_owner_admin on public.documents;

create policy documents_delete_owner_admin
  on public.documents
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_active_role() = any (array['owner', 'admin'])
    and (
      not public.esblu_document_requires_finance(document_type, status)
      or public.esblu_my_finance_manage()
    )
  );


-- ---------------------------------------------------------------------------
-- 6. document_links — SELECT
-- ---------------------------------------------------------------------------
-- Link sám osebe prezrádza, že z dokumentu X vznikla faktúra Y. To je finančná
-- informácia rovnako ako samotný doklad.
drop policy if exists document_links_select_company on public.document_links;

create policy document_links_select_company
  on public.document_links
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_can_read_document(document_id)
  );


-- ---------------------------------------------------------------------------
-- 7. document_attachments — SELECT
-- ---------------------------------------------------------------------------
-- Príloha faktúry je ten istý obsah ako faktúra.
drop policy if exists document_attachments_select_company on public.document_attachments;

create policy document_attachments_select_company
  on public.document_attachments
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_can_read_document(document_id)
  );


-- ---------------------------------------------------------------------------
-- 8. Storage — ai-inbox-documents
-- ---------------------------------------------------------------------------
-- KĽÚČOVÉ: bez tejto časti by celá migrácia bola kozmetická. Bucket nie je
-- public, ale createSignedUrl() prejde cez storage.objects SELECT politiku —
-- a tá volá tento helper. Doteraz overoval iba členstvo vo firme, takže
-- zamestnanec bez finance si vedel vydať podpísanú URL na faktúru.
--
-- Zachované bez zmeny: väzba cez documents aj cez document_attachments,
-- a pravidlo, že nereferencovaný objekt (rozpracovaný upload) patrí výhradne
-- nahrávateľovi.
create or replace function public.esblu_can_read_ai_inbox_object(p_object_name text)
returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_uploader_uid text;
  v_document_id uuid;
  v_document_company_id uuid;
  v_document_type text;
  v_document_status text;
  v_document_user_id uuid;
  v_attachment_document_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  v_uploader_uid := (storage.foldername(p_object_name))[1];

  -- Referencovaný cez documents — SECURITY DEFINER, beží MIMO
  -- documents_select_company RLS, takže company_id je autoritatívny bez
  -- ohľadu na to, čo by caller bežne videl.
  select d.id, d.company_id, d.document_type, d.status, d.user_id
    into v_document_id, v_document_company_id, v_document_type, v_document_status, v_document_user_id
  from public.documents d
  where d.storage_bucket = 'ai-inbox-documents'
    and d.storage_path = p_object_name
  limit 1;

  if v_document_id is not null then
    if not exists (
      select 1 from public.company_members cm
      where cm.user_id = v_uid
        and cm.status = 'active'
        and cm.company_id = v_document_company_id
    ) then
      return false;
    end if;

    if not public.esblu_document_requires_finance(v_document_type, v_document_status) then
      return true;
    end if;

    if public.esblu_has_finance_view_in_company(v_document_company_id) then
      return true;
    end if;

    return coalesce(v_document_status, '') in ('uploaded', 'processing')
      and v_document_user_id = v_uid;
  end if;

  -- Referencovaný cez document_attachments — o finančnej citlivosti
  -- rozhoduje RODIČOVSKÝ dokument, nie príloha.
  select da.document_id
    into v_attachment_document_id
  from public.document_attachments da
  where da.storage_bucket = 'ai-inbox-documents'
    and da.storage_path = p_object_name
  limit 1;

  if v_attachment_document_id is not null then
    return public.esblu_can_read_document(v_attachment_document_id);
  end if;

  -- Nereferencovaný nikde = rozpracovaný upload — iba pôvodný nahrávateľ.
  return v_uploader_uid = v_uid::text;
end;
$function$;

comment on function public.esblu_can_read_ai_inbox_object(text) is
  'Storage SELECT gate pre bucket ai-inbox-documents. Členstvo vo firme dokumentu + pri finančne citlivom doklade finance.view. Bez tejto kontroly by createSignedUrl() vydal URL na faktúru komukoľvek z firmy, aj keď riadok v documents už nevidí.';

revoke execute on function public.esblu_can_read_ai_inbox_object(text) from public;
revoke execute on function public.esblu_can_read_ai_inbox_object(text) from anon;
grant execute on function public.esblu_can_read_ai_inbox_object(text) to authenticated;


-- ---------------------------------------------------------------------------
-- 9. Abuse guard pre /api/scan-document
-- ---------------------------------------------------------------------------
-- Endpoint dnes overí platný token a nič viac — nekontroluje aktívne členstvo
-- ani frekvenciu. Platný token teda stačil na neobmedzené volanie drahého
-- OpenAI endpointu.
--
-- plan_limits pozná iba ai_evidence / vehicles / inventory_items / machines a
-- esblu_enforce_plan_limit() explicitne odmieta akúkoľvek inú tabuľku, takže
-- pre sken NEEXISTUJE produktový limit. Žiadny si tu nevymýšľam.
--
-- Toto je ABUSE GUARD, nie cenník: technický strop, ktorý legitímny používateľ
-- nemá ako dosiahnuť (60 skenov za hodinu je zhruba jeden každú minútu bez
-- prestávky), ale zabráni tomu, aby jeden token vyčerpal OpenAI kvótu firmy.
-- Až bude existovať komerčný limit, nahradí ho — nie naopak.
create table if not exists public.ai_scan_usage (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  endpoint text not null,
  created_at timestamptz not null default now()
);

comment on table public.ai_scan_usage is
  'Počítadlo volaní drahých AI scan endpointov, company-scoped. Slúži VÝHRADNE ako abuse guard (nie účtovanie, nie produktový limit). Zapisuje výhradne esblu_consume_ai_scan_quota(); klient sem nemá žiadny prístup.';

create index if not exists ai_scan_usage_company_created_idx
  on public.ai_scan_usage (company_id, created_at desc);

alter table public.ai_scan_usage enable row level security;

-- Žiadna politika = žiadny klientský prístup. Čítanie aj zápis ide výhradne
-- cez SECURITY DEFINER funkciu nižšie. Je to zámerné, nie opomenutie.

/**
 * Atomicky započíta jedno volanie skenu a vráti zostatok.
 *
 * Fail-closed: bez prihlásenia alebo bez aktívneho členstva vyhodí výnimku a
 * volajúci sa k OpenAI vôbec nedostane. company_id sa NIKDY nepreberá od
 * volajúceho — odvodzuje sa z auth.uid().
 *
 * pg_advisory_xact_lock serializuje súbežné volania tej istej firmy, takže
 * počítanie nie je race-able (rovnaký vzor ako esblu_enforce_plan_limit).
 */
create or replace function public.esblu_consume_ai_scan_quota(
  p_endpoint text,
  p_max_per_hour integer default 60,
  p_max_per_day integer default 240
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company_id uuid;
  v_hour_count integer;
  v_day_count integer;
begin
  if v_uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NOT_AUTHENTICATED';
  end if;

  select cm.company_id
    into v_company_id
  from public.company_members cm
  where cm.user_id = v_uid
    and cm.status = 'active'
  limit 1;

  if v_company_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_NO_ACTIVE_COMPANY',
      hint = 'Používateľ nemá aktívne členstvo v žiadnej firme.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_company_id::text || ':ai_scan_usage', 0)
  );

  select count(*) into v_hour_count
  from public.ai_scan_usage u
  where u.company_id = v_company_id
    and u.created_at > now() - interval '1 hour';

  select count(*) into v_day_count
  from public.ai_scan_usage u
  where u.company_id = v_company_id
    and u.created_at > now() - interval '24 hours';

  if v_hour_count >= p_max_per_hour or v_day_count >= p_max_per_day then
    raise exception using
      errcode = 'P0001',
      message = 'ESBLU_AI_SCAN_RATE_LIMIT',
      hint = 'Prekročený technický limit počtu skenov pre firmu. Skúste to neskôr.';
  end if;

  insert into public.ai_scan_usage (company_id, user_id, endpoint)
  values (v_company_id, v_uid, coalesce(nullif(btrim(p_endpoint), ''), 'unknown'));

  return jsonb_build_object(
    'company_id', v_company_id,
    'used_last_hour', v_hour_count + 1,
    'used_last_day', v_day_count + 1,
    'max_per_hour', p_max_per_hour,
    'max_per_day', p_max_per_day
  );
end;
$function$;

comment on function public.esblu_consume_ai_scan_quota(text, integer, integer) is
  'Abuse guard pre AI scan endpointy: vyžaduje auth.uid() a aktívne členstvo, atomicky (pg_advisory_xact_lock) započíta volanie a vyhodí ESBLU_AI_SCAN_RATE_LIMIT pri prekročení technického stropu. company_id sa odvodzuje z auth.uid(), nikdy sa nepreberá od volajúceho. NIE JE to produktový/komerčný limit — ten pre sken zatiaľ neexistuje.';

revoke execute on function public.esblu_consume_ai_scan_quota(text, integer, integer) from public;
revoke execute on function public.esblu_consume_ai_scan_quota(text, integer, integer) from anon;
grant execute on function public.esblu_consume_ai_scan_quota(text, integer, integer) to authenticated;

commit;
