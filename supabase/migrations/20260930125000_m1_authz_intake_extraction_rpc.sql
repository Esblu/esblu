-- =============================================================================
-- M1 authz (2026-09-28) — podpísané pripojenie vyťažených údajov k príjmu
-- (documents: faktúra/bloček, ai_evidence: dodací list).
-- NEAPLIKOVANÉ. Aplikovať iba cez MCP apply_migration po výslovnom schválení
-- (assetpilot / fkpgvgvsmbpieduoatrt). Nikdy nie `supabase db push`.
--
-- ČISTO ADITÍVNE: nová tabuľka použitých podpisov, interný overovací helper
-- a dve úzke RPC. Žiadna existujúca politika sa nemení — bezpečné aplikovať
-- ako PRVÉ (starý kód tieto funkcie nevolá).
--
-- PREČO: po 20260930130000 / 20260930135000 smie zamestnanec (a admin bez
-- finance.manage) vložiť doklad / dodací list IBA bez vyťažených polí. Údaje
-- zo zapečateného skenu musí doplniť dôveryhodný server — bez service_role
-- (invariant príjmu: „iba pod identitou volajúceho"). RPC sa volajú pod JWT
-- volajúceho, ale údaje prijmú IBA s HMAC podpisom servera, ktorý klient
-- nepozná (kľúč: server env ESBLU_INTAKE_ATTEST_SECRET = Vault secret
-- `esblu_intake_attest_key`).
--
-- FORMÁT SPRÁVY v3 — jednoznačný, s dĺžkovým prefixom (žiadne kolízie pri
-- skladaní), zhodný s lib/intake-attest.ts:
--   pole := <octet_length(hodnota)> ':' <hodnota> ';'
--   správa := pole(version) pole(target) pole(row_id) pole(auth.uid())
--             pole(kind) pole(content_sha256) pole(expires_epoch)
--             pole(sha256_hex(payload))
--   version = 'esblu-intake-v3'
--   target  = 'documents' | 'ai_evidence'
--   row_id  = uuid::text (malé písmená)
--   kind    = z RIADKU v DB (documents.document_type / ai_evidence.evidence_kind)
--   content_sha256 = z RIADKU v DB = SHA-256 presných bajtov originálu, ktorý
--             server naskenoval A overil v Storage (/api/inbox/intake stiahne
--             objekt pod JWT volajúceho a porovná hash s pečaťou skenu)
--   expires = celé sekundy epochy, max. now() + 600 s
--   payload = presný text, ktorý server podpísal a DB parsuje (hash bajtov
--             UTF-8 — žiadna JSON kanonikalizácia nie je potrebná)
--   HMAC-SHA256, výstup hex (64 znakov), kľúč = UTF-8 bajty tajomstva.
--
-- REPLAY: podpis je viazaný na target + riadok + auth.uid() + typ + hash
-- originálu + expiráciu + dáta; každý podpis sa dá použiť raz (tabuľka esblu_intake_attestations_used,
-- PK = sha256(podpis)); riadok musí byť ešte bez údajov.
--
-- ROTÁCIA KĽÚČA: helper prijme aj `esblu_intake_attest_key_prev` (ak
-- existuje). Postup: prev := starý, current := nový (Vault) → env na serveri
-- := nový + redeploy → po ≥ 15 min zmazať prev.
--
-- STAV (M1 produktová korekcia — uploader vždy dokončí review svojho dokladu):
--   documents:   needs_review (INSERT klientom, bez údajov)
--                → extracted  (esblu_attach_intake_extraction, podpis servera)
--                → confirmed  (esblu_confirm_intake_document, uploader, audit)
--   ai_evidence: needs_review → extracted (esblu_attach_evidence_intake_extraction)
--                → confirmed (esblu_confirm_evidence_intake, uploader, audit)
--   Klient žiadny z týchto prechodov nespraví priamym INSERT/UPDATE.
--
-- ORIGINÁL SÚBORU (dôkazový podklad):
--   - documents.content_sha256 / ai_evidence.content_sha256 = hash originálu,
--   - pri pripojení AI návrhu sa do riadku zapíše atestácia (hash + cesta +
--     čas) — potvrdenie ju vyžaduje zhodnú s riadkom,
--   - trigger esblu_lock_original_file: väzbu na súbor nezmení nikto — aj pri
--     legacy riadkoch bez hashu; hash raz zapísaný sa nemení a NULL → hash
--     smie iba privilegovaný backfill batch (nikdy klient),
--   - Storage (20260930140000): originál sa nedá prepísať (žiadny UPDATE)
--     ani znova nahrať na cestu, na ktorú už odkazuje záznam.
--
-- OBNOVITEĽNÝ REVIEW: esblu_list_my_intake_reviews / esblu_get_my_intake_review
--   vrátia IBA vlastné rozpracované (needs_review/extracted) záznamy aktívnej
--   firmy v okne 24 h. Potvrdenie v rovnakom okne. Po confirmed nič.
--
-- ORÁKULUM: všetky RPC vracajú iba boolean; false pre čokoľvek (cudzí
-- riadok, zlý podpis, expirácia, replay, chýbajúci kľúč).
-- =============================================================================

begin;

-- 1) Použité podpisy (jednorazovosť) -------------------------------------------
create table if not exists public.esblu_intake_attestations_used (
  signature_sha256 text primary key check (signature_sha256 ~ '^[0-9a-f]{64}$'),
  used_at timestamptz not null default now()
);
create index if not exists esblu_intake_attestations_used_used_at_idx
  on public.esblu_intake_attestations_used (used_at);
alter table public.esblu_intake_attestations_used enable row level security;
-- Žiadne politiky: klient tabuľku nevidí ani nemení; číta/zapisuje iba helper.
revoke all on table public.esblu_intake_attestations_used from public, anon, authenticated;

-- 1b) Hash originálu a atestácia pre ai_evidence (documents už content_sha256 má)
alter table public.ai_evidence add column if not exists content_sha256 text;
alter table public.ai_evidence add column if not exists intake_attestation jsonb;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ai_evidence_content_sha256_format'
                 and conrelid = 'public.ai_evidence'::regclass) then
    alter table public.ai_evidence add constraint ai_evidence_content_sha256_format
      check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- 1c) Originál je nemenný — AJ PRE LEGACY riadky (spred hash modelu).
--     - väzba na súbor (documents.storage_bucket/storage_path,
--       ai_evidence.photo_url, document_attachments.storage_bucket/storage_path)
--       sa po vložení NIKDY nemení — žiadna rola, ani postgres (prelinkovanie
--       záznamu z originálu A na súbor B = chyba ESBLU_ORIGINAL_FILE_IMMUTABLE),
--     - content_sha256: raz zapísaný sa nemení; NULL → hash smie iba
--       privilegovaný backfill batch (postgres / service_role) s výslovným
--       príznakom `SET LOCAL esblu.original_hash_backfill = 'on'`, NIKDY
--       klient (owner/admin/účtovník by inak „vyrobil" historický hash),
--     - ai_evidence.intake_attestation: zapisuje iba podpísané RPC
--       (SECURITY DEFINER, vlastník postgres, príznak
--       esblu.intake_attestation_write), klient nikdy; raz zapísaná sa nemení.
--     Legacy riadky tým NEZÍSKAJÚ kryptografické overenie — iba nemennú väzbu.
create or replace function public.esblu_lock_original_file()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  -- DVE nezávislé podmienky pre privilegovaný zápis (obrana do hĺbky):
  --  a) current_user nie je klientská rola. PostgREST vykoná každú požiadavku
  --     ako `SET LOCAL ROLE <rola z JWT>` (authenticated / anon /
  --     service_role); SECURITY DEFINER funkcia beží ako jej vlastník.
  --  b) výslovný transakčný príznak, ktorý nastaví IBA príslušný kód:
  --       esblu.original_hash_backfill = 'on'  → auditovaný backfill batch
  --       esblu.intake_attestation_write = 'on' → podpísané attach RPC
  --     Klient ho nastaviť nevie (set_config nie je vystavené cez PostgREST
  --     RPC) a aj keby, podmienka a) platí ďalej. Budúca SECURITY DEFINER
  --     funkcia bez príznaku hash ani atestáciu omylom nezapíše.
  v_client boolean := current_user in ('authenticated', 'anon');
  v_backfill boolean := coalesce(current_setting('esblu.original_hash_backfill', true), '') = 'on';
  v_attest boolean := coalesce(current_setting('esblu.intake_attestation_write', true), '') = 'on';
begin
  if tg_table_name = 'documents' then
    if new.storage_bucket is distinct from old.storage_bucket
       or new.storage_path is distinct from old.storage_path then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_IMMUTABLE';
    end if;
    if old.content_sha256 is not null and new.content_sha256 is distinct from old.content_sha256 then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_IMMUTABLE';
    end if;
    if old.content_sha256 is null and new.content_sha256 is not null and (v_client or not v_backfill) then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY';
    end if;
  elsif tg_table_name = 'ai_evidence' then
    if new.photo_url is distinct from old.photo_url then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_IMMUTABLE';
    end if;
    if old.content_sha256 is not null and new.content_sha256 is distinct from old.content_sha256 then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_IMMUTABLE';
    end if;
    if old.content_sha256 is null and new.content_sha256 is not null and (v_client or not v_backfill) then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_HASH_BACKFILL_ONLY';
    end if;
    if new.intake_attestation is distinct from old.intake_attestation
       and (old.intake_attestation is not null or v_client or not v_attest) then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_IMMUTABLE';
    end if;
  elsif tg_table_name = 'document_attachments' then
    if new.storage_bucket is distinct from old.storage_bucket
       or new.storage_path is distinct from old.storage_path then
      raise exception using errcode = '42501', message = 'ESBLU_ORIGINAL_FILE_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function public.esblu_lock_original_file() from public, anon, authenticated;

drop trigger if exists esblu_lock_original_file_before_update on public.documents;
create trigger esblu_lock_original_file_before_update before update on public.documents
  for each row execute function public.esblu_lock_original_file();
drop trigger if exists esblu_lock_original_file_before_update on public.ai_evidence;
create trigger esblu_lock_original_file_before_update before update on public.ai_evidence
  for each row execute function public.esblu_lock_original_file();
drop trigger if exists esblu_lock_original_file_before_update on public.document_attachments;
create trigger esblu_lock_original_file_before_update before update on public.document_attachments
  for each row execute function public.esblu_lock_original_file();

-- 2) Interný helper — overenie podpisu + spotrebovanie ---------------------------
create or replace function public.esblu_intake_attestation_consume(
  p_target text,
  p_row_id uuid,
  p_kind text,
  p_content_sha256 text,
  p_payload text,
  p_expires_at bigint,
  p_signature text
)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_now bigint := extract(epoch from now())::bigint;
  v_message text;
  v_sig text;
  v_key text;
  v_ok boolean := false;
  v_inserted int;
begin
  if v_uid is null or p_target is null or p_row_id is null or p_kind is null or p_content_sha256 is null
     or p_payload is null or p_expires_at is null or p_signature is null then
    return false;
  end if;
  if p_content_sha256 !~ '^[0-9a-f]{64}$' then
    return false;
  end if;
  if p_target not in ('documents', 'ai_evidence') then
    return false;
  end if;
  if p_expires_at < v_now or p_expires_at > v_now + 600 then
    return false;
  end if;
  v_sig := lower(p_signature);
  if v_sig !~ '^[0-9a-f]{64}$' or octet_length(p_payload) > 200000 then
    return false;
  end if;

  v_message :=
       octet_length('esblu-intake-v3')::text || ':' || 'esblu-intake-v3' || ';'
    || octet_length(p_target)::text || ':' || p_target || ';'
    || octet_length(p_row_id::text)::text || ':' || p_row_id::text || ';'
    || octet_length(v_uid::text)::text || ':' || v_uid::text || ';'
    || octet_length(p_kind)::text || ':' || p_kind || ';'
    || octet_length(p_content_sha256)::text || ':' || p_content_sha256 || ';'
    || octet_length(p_expires_at::text)::text || ':' || p_expires_at::text || ';'
    || '64:' || encode(extensions.digest(convert_to(p_payload, 'UTF8'), 'sha256'), 'hex') || ';';

  for v_key in
    select ds.decrypted_secret
    from vault.decrypted_secrets ds
    where ds.name in ('esblu_intake_attest_key', 'esblu_intake_attest_key_prev')
      and ds.decrypted_secret is not null
      and length(ds.decrypted_secret) >= 32
  loop
    if encode(extensions.hmac(convert_to(v_message, 'UTF8'), convert_to(v_key, 'UTF8'), 'sha256'), 'hex') = v_sig then
      v_ok := true;
      exit;
    end if;
  end loop;

  if not v_ok then
    return false;
  end if;

  -- Jednorazovosť + upratanie starých (dávno expirovaných) záznamov.
  delete from public.esblu_intake_attestations_used u where u.used_at < now() - interval '1 day';
  insert into public.esblu_intake_attestations_used (signature_sha256)
  values (encode(extensions.digest(convert_to(v_sig, 'UTF8'), 'sha256'), 'hex'))
  on conflict (signature_sha256) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$function$;

-- Interný: volajú ho iba RPC nižšie (vlastník postgres). Nikto iný.
revoke all on function public.esblu_intake_attestation_consume(text, uuid, text, text, text, bigint, text) from public, anon, authenticated;

-- 3) documents: faktúra / bloček v príjme ---------------------------------------
drop function if exists public.esblu_attach_intake_extraction(uuid, text, bigint, text);
create or replace function public.esblu_attach_intake_extraction(
  p_document_id uuid,
  p_payload text,
  p_expires_at bigint,
  p_signature text
)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_type text;
  v_hash text;
  v_path text;
  v_payload jsonb;
begin
  if v_uid is null or p_document_id is null or p_payload is null then
    return false;
  end if;

  select d.document_type, d.content_sha256, d.storage_path into v_type, v_hash, v_path
  from public.documents d
  where d.id = p_document_id
    and d.user_id = v_uid
    and d.company_id = public.esblu_my_active_company_id()
    and d.document_type in ('invoice', 'receipt')
    and d.status = 'needs_review'
    and d.deleted_at is null
    and d.extracted_fields is null
    and d.ai_raw_output is null
    and d.content_sha256 is not null
    and d.storage_bucket = 'ai-inbox-documents'
    and d.created_at >= now() - interval '15 minutes'
  for update;

  if v_type is null then
    return false;
  end if;

  begin
    v_payload := p_payload::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(v_payload) is distinct from 'object'
     or jsonb_typeof(v_payload -> 'extracted_fields') is distinct from 'object'
     or jsonb_typeof(v_payload -> 'ai_raw_output') is distinct from 'object' then
    return false;
  end if;

  if not public.esblu_intake_attestation_consume('documents', p_document_id, v_type, v_hash, p_payload, p_expires_at, p_signature) then
    return false;
  end if;

  -- needs_review → extracted: AI návrh je pripojený a ATESTOVANÝ serverom.
  -- Potvrdiť ho smie iba uploader cez esblu_confirm_intake_document.
  update public.documents
     set extracted_fields = v_payload -> 'extracted_fields',
         -- Atestácia originálu zapisuje DB (nie payload): hash + cesta + čas.
         ai_raw_output = (v_payload -> 'ai_raw_output') || jsonb_build_object(
           'intake', 'sealed',
           'attested_content_sha256', v_hash,
           'attested_storage_path', v_path,
           'attested_at', now()
         ),
         field_confidence = case when jsonb_typeof(v_payload -> 'field_confidence') in ('object', 'array')
                                 then v_payload -> 'field_confidence' end,
         status = 'extracted'
   where id = p_document_id;

  return true;
end;
$function$;

revoke all on function public.esblu_attach_intake_extraction(uuid, text, bigint, text) from public, anon;
grant execute on function public.esblu_attach_intake_extraction(uuid, text, bigint, text) to authenticated;

-- 4) ai_evidence: dodací list / vážny lístok v príjme --------------------------
create or replace function public.esblu_attach_evidence_intake_extraction(
  p_evidence_id uuid,
  p_payload text,
  p_expires_at bigint,
  p_signature text
)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_kind text;
  v_hash text;
  v_photo text;
  v_p jsonb;
  v_allowed text[] := array[
    'spz', 'supplier', 'customer', 'construction_site', 'document_number', 'material',
    'quantity', 'unit', 'brutto', 'tara', 'netto', 'document_date', 'document_time',
    'source_location', 'destination_location', 'document_language', 'confidence_score', 'raw_text'
  ];
begin
  if v_uid is null or p_evidence_id is null or p_payload is null then
    return false;
  end if;

  select e.evidence_kind, e.content_sha256, e.photo_url into v_kind, v_hash, v_photo
  from public.ai_evidence e
  where e.id = p_evidence_id
    and e.user_id = v_uid
    and e.company_id = public.esblu_my_active_company_id()
    and e.evidence_kind in ('delivery_note', 'weigh_ticket')
    and e.review_status = 'needs_review'
    and e.deleted_at is null
    and e.content_sha256 is not null
    and e.photo_url is not null
    and e.intake_attestation is null
    and e.created_at >= now() - interval '15 minutes'
    and e.spz is null and e.supplier is null and e.customer is null
    and e.construction_site is null and e.document_number is null and e.material is null
    and e.quantity is null and e.unit is null and e.brutto is null and e.tara is null and e.netto is null
    and e.document_date is null and e.document_time is null
    and e.source_location is null and e.destination_location is null
    and e.document_language is null and e.confidence_score is null and e.raw_text is null
  for update;

  if v_kind is null then
    return false;
  end if;

  begin
    v_p := p_payload::jsonb;
  exception when others then
    return false;
  end;

  if jsonb_typeof(v_p) is distinct from 'object' then
    return false;
  end if;
  -- Iba povolené kľúče (žiadne vehicle_id, review_status, user_id, …).
  if exists (select 1 from jsonb_object_keys(v_p) k where k <> all (v_allowed)) then
    return false;
  end if;

  if not public.esblu_intake_attestation_consume('ai_evidence', p_evidence_id, v_kind, v_hash, p_payload, p_expires_at, p_signature) then
    return false;
  end if;

  -- Príznak pre esblu_lock_original_file: atestáciu smie zapísať iba toto RPC.
  perform set_config('esblu.intake_attestation_write', 'on', true);
  update public.ai_evidence
     set spz = left(v_p ->> 'spz', 20),
         supplier = left(v_p ->> 'supplier', 500),
         customer = left(v_p ->> 'customer', 500),
         construction_site = left(v_p ->> 'construction_site', 500),
         document_number = left(v_p ->> 'document_number', 100),
         material = left(v_p ->> 'material', 500),
         quantity = case when jsonb_typeof(v_p -> 'quantity') = 'number' then (v_p ->> 'quantity')::numeric end,
         unit = left(v_p ->> 'unit', 20),
         brutto = case when jsonb_typeof(v_p -> 'brutto') = 'number' then (v_p ->> 'brutto')::numeric end,
         tara = case when jsonb_typeof(v_p -> 'tara') = 'number' then (v_p ->> 'tara')::numeric end,
         netto = case when jsonb_typeof(v_p -> 'netto') = 'number' then (v_p ->> 'netto')::numeric end,
         document_date = case when (v_p ->> 'document_date') ~ '^\d{4}-\d{2}-\d{2}$'
                              then public.esblu_try_date(v_p ->> 'document_date') end,
         document_time = left(v_p ->> 'document_time', 20),
         source_location = left(v_p ->> 'source_location', 500),
         destination_location = left(v_p ->> 'destination_location', 500),
         document_language = left(v_p ->> 'document_language', 10),
         confidence_score = case when jsonb_typeof(v_p -> 'confidence_score') = 'number' then (v_p ->> 'confidence_score')::numeric end,
         raw_text = left(v_p ->> 'raw_text', 20000),
         -- Pôvodný AI návrh + atestácia originálu (zapisuje DB, nie payload).
         intake_attestation = jsonb_build_object(
           'content_sha256', v_hash,
           'photo_url', v_photo,
           'attested_at', now(),
           'ai_values', v_p
         ),
         review_status = 'extracted'
   where id = p_evidence_id;
  perform set_config('esblu.intake_attestation_write', 'off', true);

  return true;
end;
$function$;

-- Bezpečný prevod dátumu (neplatný kalendárny dátum → NULL, nie výnimka).
create or replace function public.esblu_try_date(p_value text)
returns date
language plpgsql
immutable
set search_path to ''
as $function$
begin
  return p_value::date;
exception when others then
  return null;
end;
$function$;

revoke all on function public.esblu_try_date(text) from public, anon, authenticated;
revoke all on function public.esblu_attach_evidence_intake_extraction(uuid, text, bigint, text) from public, anon;
grant execute on function public.esblu_attach_evidence_intake_extraction(uuid, text, bigint, text) to authenticated;

-- 5) Audit opráv a potvrdení pre ai_evidence -----------------------------------
--    (documents používa existujúci document_review_log.)
create table if not exists public.ai_evidence_review_log (
  id uuid primary key default gen_random_uuid(),
  evidence_id uuid references public.ai_evidence(id) on delete set null,
  evidence_ref uuid not null,
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null,
  action text not null check (action in ('field_edited', 'confirmed')),
  field_name text,
  old_value jsonb,
  new_value jsonb,
  snapshot jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ai_evidence_review_log_ref_idx on public.ai_evidence_review_log (evidence_ref, created_at);
create index if not exists ai_evidence_review_log_company_idx on public.ai_evidence_review_log (company_id);
alter table public.ai_evidence_review_log enable row level security;

-- Čítanie = presne ten, kto smie čítať samotný záznam (ai_evidence RLS:
-- vážne lístky prevádzka, dodacie listy iba finance_view). Záznam bez
-- riadku (zmazaný) iba finance_view.
drop policy if exists ai_evidence_review_log_select_readable on public.ai_evidence_review_log;
create policy ai_evidence_review_log_select_readable
  on public.ai_evidence_review_log
  for select
  to authenticated
  using (
    company_id = public.esblu_my_active_company_id()
    and (
      (evidence_id is not null and exists (select 1 from public.ai_evidence e where e.id = ai_evidence_review_log.evidence_id))
      or (evidence_id is null and public.esblu_my_finance_view())
    )
  );
-- Zápis IBA cez potvrdzovacie RPC (SECURITY DEFINER). Klient nič.
revoke all on table public.ai_evidence_review_log from public, anon, authenticated;
grant select on table public.ai_evidence_review_log to authenticated;

-- 6) POTVRDENIE uploaderom — documents (faktúra / bloček) ------------------------
--    Stav extracted → confirmed. Iba vlastný doklad (auth.uid()), aktívna
--    firma, typ faktúra/bloček, atestovaný AI návrh (ai_raw_output.intake =
--    'sealed' — zapisuje ho výhradne podpísané RPC vyššie), okno 30 min.
--    Opravy sa auditujú po poliach (AI hodnota → hodnota používateľa), potom
--    záznam 'confirmed' so snímkou. Aktér = auth.uid(). Po potvrdení uploader
--    doklad NEVIDÍ (documents SELECT: finančný typ + stav confirmed → iba
--    finance_view) — potvrdenie nerozširuje žiadne čítacie právo.
create or replace function public.esblu_confirm_intake_document(
  p_document_id uuid,
  p_fields jsonb,
  p_note text
)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_type text;
  v_old jsonb;
  v_old_note text;
  v_key text;
  v_hash text;
  v_path text;
  v_created timestamptz;
  v_attested_at text;
begin
  if v_uid is null or p_document_id is null or p_fields is null then
    return false;
  end if;
  if jsonb_typeof(p_fields) is distinct from 'object'
     or octet_length(p_fields::text) > 100000
     or (select count(*) from jsonb_object_keys(p_fields)) > 200
     or (p_note is not null and char_length(p_note) > 1000) then
    return false;
  end if;

  select d.document_type, coalesce(d.extracted_fields, '{}'::jsonb), d.note,
         d.content_sha256, d.storage_path, d.created_at, d.ai_raw_output ->> 'attested_at'
    into v_type, v_old, v_old_note, v_hash, v_path, v_created, v_attested_at
  from public.documents d
  where d.id = p_document_id
    and d.user_id = v_uid
    and d.company_id = public.esblu_my_active_company_id()
    and d.document_type in ('invoice', 'receipt')
    and d.status = 'extracted'
    and d.deleted_at is null
    and d.ai_raw_output ->> 'intake' = 'sealed'
    -- Potvrdzuje sa presne ten originál, ku ktorému server atestoval AI návrh.
    and d.content_sha256 is not null
    and d.ai_raw_output ->> 'attested_content_sha256' = d.content_sha256
    and d.ai_raw_output ->> 'attested_storage_path' = d.storage_path
    and d.created_at >= now() - interval '24 hours'
  for update;

  if v_type is null then
    return false;
  end if;

  for v_key in
    select k from jsonb_object_keys(v_old) k
    union
    select k from jsonb_object_keys(p_fields) k
  loop
    if (v_old -> v_key) is distinct from (p_fields -> v_key) then
      insert into public.document_review_log (document_id, document_ref, user_id, action, field_name, old_value, new_value, document_snapshot)
      values (p_document_id, p_document_id, v_uid, 'field_edited', v_key, v_old -> v_key, p_fields -> v_key,
              jsonb_build_object('content_sha256', v_hash));
    end if;
  end loop;

  if p_note is distinct from v_old_note then
    insert into public.document_review_log (document_id, document_ref, user_id, action, field_name, old_value, new_value)
    values (p_document_id, p_document_id, v_uid, 'field_edited', 'note', to_jsonb(v_old_note), to_jsonb(p_note));
  end if;

  update public.documents
     set extracted_fields = p_fields,
         note = p_note,
         status = 'confirmed',
         updated_at = now()
   where id = p_document_id;

  insert into public.document_review_log (document_id, document_ref, user_id, action, document_snapshot)
  values (
    p_document_id, p_document_id, v_uid, 'confirmed',
    jsonb_build_object('document_type', v_type, 'ai_fields', v_old, 'confirmed_fields', p_fields,
                       'uploaded_by', v_uid, 'confirmed_by', v_uid, 'flow', 'intake_review',
                       'content_sha256', v_hash, 'storage_bucket', 'ai-inbox-documents', 'storage_path', v_path,
                       'created_at', v_created, 'extracted_at', v_attested_at, 'confirmed_at', now())
  );

  return true;
end;
$function$;

revoke all on function public.esblu_confirm_intake_document(uuid, jsonb, text) from public, anon;
grant execute on function public.esblu_confirm_intake_document(uuid, jsonb, text) to authenticated;

-- 7) POTVRDENIE uploaderom — ai_evidence (dodací list / vážny lístok) ------------
--    Stav extracted → confirmed. Iba vlastný záznam, aktívna firma, povolený
--    druh, atestovaný AI návrh (review_status = 'extracted' nastavuje iba
--    podpísané RPC), okno 30 min. Povolené iba kontrolovateľné polia; väzba
--    na vozidlo iba na vozidlo VLASTNEJ firmy. Nepovolený kľúč, neplatné
--    číslo či dátum = false (nič sa nezmení). Audit po poliach + 'confirmed'.
create or replace function public.esblu_confirm_evidence_intake(
  p_evidence_id uuid,
  p_values jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.esblu_my_active_company_id();
  v_row public.ai_evidence;
  v_old jsonb;
  v_new jsonb;
  v_key text;
  v_text_keys text[] := array[
    'spz', 'supplier', 'customer', 'construction_site', 'document_number', 'material',
    'material_original', 'material_category', 'unit', 'document_time',
    'source_location', 'destination_location', 'movement_type'
  ];
  v_number_keys text[] := array['quantity', 'brutto', 'tara', 'netto'];
  v_allowed text[];
  v_vehicle uuid;
  v_date date;
begin
  v_allowed := v_text_keys || v_number_keys || array['document_date', 'vehicle_id'];
  if v_uid is null or v_company is null or p_evidence_id is null or p_values is null then
    return false;
  end if;
  if jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text) > 50000 then
    return false;
  end if;
  if exists (select 1 from jsonb_object_keys(p_values) k where k <> all (v_allowed)) then
    return false;
  end if;
  -- Typy hodnôt: texty = string|null, čísla = number|null.
  if exists (select 1 from jsonb_each(p_values) kv
             where kv.key = any (v_text_keys) and jsonb_typeof(kv.value) not in ('string', 'null'))
     or exists (select 1 from jsonb_each(p_values) kv
             where kv.key = any (v_number_keys) and jsonb_typeof(kv.value) not in ('number', 'null')) then
    return false;
  end if;

  select * into v_row
  from public.ai_evidence e
  where e.id = p_evidence_id
    and e.user_id = v_uid
    and e.company_id = v_company
    and e.evidence_kind in ('delivery_note', 'weigh_ticket')
    and e.review_status = 'extracted'
    and e.deleted_at is null
    -- Potvrdzuje sa presne ten originál, ku ktorému server atestoval AI návrh.
    and e.content_sha256 is not null
    and e.intake_attestation ->> 'content_sha256' = e.content_sha256
    and e.intake_attestation ->> 'photo_url' = e.photo_url
    and e.created_at >= now() - interval '24 hours'
  for update;

  if v_row.id is null then
    return false;
  end if;

  if p_values ? 'vehicle_id' and jsonb_typeof(p_values -> 'vehicle_id') <> 'null' then
    begin
      v_vehicle := (p_values ->> 'vehicle_id')::uuid;
    exception when others then
      return false;
    end;
    if not exists (select 1 from public.vehicles v where v.id = v_vehicle and v.company_id = v_company) then
      return false;
    end if;
  end if;

  if p_values ? 'document_date' and jsonb_typeof(p_values -> 'document_date') <> 'null' then
    if (p_values ->> 'document_date') !~ '^\d{4}-\d{2}-\d{2}$' then
      return false;
    end if;
    v_date := public.esblu_try_date(p_values ->> 'document_date');
    if v_date is null then
      return false;
    end if;
  end if;

  v_old := jsonb_build_object(
    'spz', v_row.spz, 'supplier', v_row.supplier, 'customer', v_row.customer,
    'construction_site', v_row.construction_site, 'document_number', v_row.document_number,
    'material', v_row.material, 'material_original', v_row.material_original,
    'material_category', v_row.material_category, 'unit', v_row.unit,
    'document_time', v_row.document_time, 'source_location', v_row.source_location,
    'destination_location', v_row.destination_location, 'movement_type', v_row.movement_type,
    'quantity', v_row.quantity, 'brutto', v_row.brutto, 'tara', v_row.tara, 'netto', v_row.netto,
    'document_date', v_row.document_date, 'vehicle_id', v_row.vehicle_id
  );
  -- Chýbajúci kľúč = bez zmeny; prítomný null = vymazanie.
  v_new := v_old || p_values;

  foreach v_key in array v_allowed loop
    if (v_old -> v_key) is distinct from (v_new -> v_key) then
      insert into public.ai_evidence_review_log (evidence_id, evidence_ref, company_id, user_id, action, field_name, old_value, new_value, snapshot)
      values (p_evidence_id, p_evidence_id, v_company, v_uid, 'field_edited', v_key, v_old -> v_key, v_new -> v_key,
              jsonb_build_object('content_sha256', v_row.content_sha256));
    end if;
  end loop;

  update public.ai_evidence
     set spz = left(v_new ->> 'spz', 20),
         supplier = left(v_new ->> 'supplier', 500),
         customer = left(v_new ->> 'customer', 500),
         construction_site = left(v_new ->> 'construction_site', 500),
         document_number = left(v_new ->> 'document_number', 100),
         material = left(v_new ->> 'material', 500),
         material_original = left(v_new ->> 'material_original', 500),
         material_category = left(v_new ->> 'material_category', 100),
         unit = left(v_new ->> 'unit', 20),
         document_time = left(v_new ->> 'document_time', 20),
         source_location = left(v_new ->> 'source_location', 500),
         destination_location = left(v_new ->> 'destination_location', 500),
         movement_type = left(v_new ->> 'movement_type', 50),
         quantity = (v_new ->> 'quantity')::numeric,
         brutto = (v_new ->> 'brutto')::numeric,
         tara = (v_new ->> 'tara')::numeric,
         netto = (v_new ->> 'netto')::numeric,
         document_date = (v_new ->> 'document_date')::date,
         vehicle_id = (v_new ->> 'vehicle_id')::uuid,
         review_status = 'confirmed'
   where id = p_evidence_id;

  insert into public.ai_evidence_review_log (evidence_id, evidence_ref, company_id, user_id, action, snapshot)
  values (p_evidence_id, p_evidence_id, v_company, v_uid, 'confirmed',
          jsonb_build_object('evidence_kind', v_row.evidence_kind,
                             'ai_values', v_row.intake_attestation -> 'ai_values', 'values_before_review', v_old,
                             'confirmed_values', v_new,
                             'uploaded_by', v_row.user_id, 'confirmed_by', v_uid, 'flow', 'intake_review',
                             'content_sha256', v_row.content_sha256, 'storage_bucket', 'ai-evidence-documents',
                             'photo_url', v_row.photo_url, 'created_at', v_row.created_at,
                             'extracted_at', v_row.intake_attestation ->> 'attested_at', 'confirmed_at', now()));

  return true;
end;
$function$;

revoke all on function public.esblu_confirm_evidence_intake(uuid, jsonb) from public, anon;
grant execute on function public.esblu_confirm_evidence_intake(uuid, jsonb) to authenticated;


-- 8) OBNOVITEĽNÝ REVIEW — iba vlastné rozpracované záznamy ---------------------
--    Aplikácia spadla / zatvorila sa / stratila sieť → uploader pokračuje.
--    Žiadne rozšírenie documents/ai_evidence SELECT: tieto funkcie vracajú
--    IBA riadky, kde user_id = auth.uid(), aktívna firma, stav
--    needs_review / extracted, povolený typ, vytvorené pred ≤ 24 h. Po
--    confirmed nič. Cudzie / neexistujúce / expirované = prázdne (bez rozdielu).
create or replace function public.esblu_list_my_intake_reviews()
returns table (
  target text,
  id uuid,
  kind text,
  status text,
  created_at timestamptz,
  review_expires_at timestamptz
)
language sql
stable
security definer
set search_path to ''
as $function$
  select * from (
    select 'documents'::text, d.id, d.document_type, d.status, d.created_at, d.created_at + interval '24 hours'
    from public.documents d
    where d.user_id = auth.uid()
      and d.company_id = public.esblu_my_active_company_id()
      and d.document_type in ('invoice', 'receipt')
      and d.status in ('needs_review', 'extracted')
      and d.deleted_at is null
      and d.created_at >= now() - interval '24 hours'
    union all
    select 'ai_evidence'::text, e.id, e.evidence_kind, e.review_status, e.created_at, e.created_at + interval '24 hours'
    from public.ai_evidence e
    where e.user_id = auth.uid()
      and e.company_id = public.esblu_my_active_company_id()
      and e.evidence_kind in ('delivery_note', 'weigh_ticket')
      and e.review_status in ('needs_review', 'extracted')
      and e.deleted_at is null
      and e.created_at >= now() - interval '24 hours'
  ) t
  order by 5 desc
  limit 20;
$function$;

create or replace function public.esblu_get_my_intake_review(p_target text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_company uuid := public.esblu_my_active_company_id();
  v_result jsonb;
begin
  if v_uid is null or v_company is null or p_id is null then
    return null;
  end if;

  if p_target = 'documents' then
    select jsonb_build_object(
      'target', 'documents', 'id', d.id, 'kind', d.document_type, 'status', d.status,
      'storage_bucket', d.storage_bucket, 'storage_path', d.storage_path, 'content_sha256', d.content_sha256,
      'ai_fields', d.ai_raw_output -> 'fields', 'confidence_score', d.ai_raw_output -> 'confidenceScore',
      'field_confidence', d.field_confidence, 'review_values', d.extracted_fields, 'note', d.note,
      'created_at', d.created_at, 'review_expires_at', d.created_at + interval '24 hours',
      'can_confirm', (d.status = 'extracted' and d.ai_raw_output ->> 'attested_content_sha256' = d.content_sha256)
    ) into v_result
    from public.documents d
    where d.id = p_id
      and d.user_id = v_uid
      and d.company_id = v_company
      and d.document_type in ('invoice', 'receipt')
      and d.status in ('needs_review', 'extracted')
      and d.deleted_at is null
      and d.created_at >= now() - interval '24 hours';
  elsif p_target = 'ai_evidence' then
    select jsonb_build_object(
      'target', 'ai_evidence', 'id', e.id, 'kind', e.evidence_kind, 'status', e.review_status,
      'storage_bucket', 'ai-evidence-documents', 'storage_path', e.photo_url, 'content_sha256', e.content_sha256,
      'ai_fields', e.intake_attestation -> 'ai_values', 'confidence_score', e.confidence_score,
      'document_type', e.document_type,
      'review_values', jsonb_build_object(
        'spz', e.spz, 'supplier', e.supplier, 'customer', e.customer, 'construction_site', e.construction_site,
        'document_number', e.document_number, 'material', e.material, 'material_original', e.material_original,
        'material_category', e.material_category, 'unit', e.unit, 'document_time', e.document_time,
        'source_location', e.source_location, 'destination_location', e.destination_location,
        'movement_type', e.movement_type, 'quantity', e.quantity, 'brutto', e.brutto, 'tara', e.tara,
        'netto', e.netto, 'document_date', e.document_date, 'vehicle_id', e.vehicle_id,
        'document_language', e.document_language, 'raw_text', e.raw_text
      ),
      'created_at', e.created_at, 'review_expires_at', e.created_at + interval '24 hours',
      'can_confirm', (e.review_status = 'extracted' and e.intake_attestation ->> 'content_sha256' = e.content_sha256)
    ) into v_result
    from public.ai_evidence e
    where e.id = p_id
      and e.user_id = v_uid
      and e.company_id = v_company
      and e.evidence_kind in ('delivery_note', 'weigh_ticket')
      and e.review_status in ('needs_review', 'extracted')
      and e.deleted_at is null
      and e.created_at >= now() - interval '24 hours';
  end if;

  return v_result;
end;
$function$;

revoke all on function public.esblu_list_my_intake_reviews() from public, anon;
grant execute on function public.esblu_list_my_intake_reviews() to authenticated;
revoke all on function public.esblu_get_my_intake_review(text, uuid) from public, anon;
grant execute on function public.esblu_get_my_intake_review(text, uuid) to authenticated;

commit;
