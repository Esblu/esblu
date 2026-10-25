-- =============================================================================
-- AI usage metering (cost telemetry) — 2026-10-25
--
-- Cieľ: merať skutočnú spotrebu OpenAI (tokeny / audio / obrázky / retry) na
-- FIRMU a MESIAC, aby sa náklad nemusel iba odhadovať
-- (docs/esblu-unit-economics-2026-10-22.md). Žiadna nová funkcia produktu,
-- žiadny limit — iba meranie.
--
-- GDPR: ACCESS / COST TELEMETRY ONLY — NO CONTENT LOGGING.
--   Ukladá sa IBA: firma, mesiac, typ flowu, model, výsledok a súčty čísel.
--   NIKDY: prompt, odpoveď modelu, transcript, obsah/obrázok dokumentu,
--   fakturačné údaje, text chatu, user_id ani iný osobný údaj.
--   (p_user_id slúži iba na overenie členstva, NEUKLADÁ sa.)
--
-- Tvar: agregované mesačné počítadlá (1 riadok na firmu × mesiac × flow ×
-- model × výsledok) — tabuľka rastie iba s počtom firiem a mesiacov, nie s
-- počtom volaní. Retencia: esblu_purge_ai_usage_monthly (technický default
-- 25 mesiacov, minimum 13) — OWNER/CLIA INFORMATIVE NOTE, nie právna politika.
--
-- Prístup: service-only (trieda D). Zápis iba cez SECURITY DEFINER RPC s
-- EXECUTE pre service_role; klient (anon/authenticated) nemá žiadny grant ani
-- politiku → nevie čítať, meniť ani podvrhnúť usage. Customer-facing UI nie je.
-- =============================================================================

create table if not exists public.ai_usage_monthly (
  company_id uuid not null references public.companies(id) on delete cascade,
  period_month date not null,
  flow_type text not null,
  model text not null,
  outcome text not null,
  requests bigint not null default 0,
  input_tokens bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  audio_input_tokens bigint not null default 0,
  audio_seconds numeric(14, 3) not null default 0,
  image_count bigint not null default 0,
  retry_count bigint not null default 0,
  first_recorded_at timestamptz not null default now(),
  last_recorded_at timestamptz not null default now(),
  constraint ai_usage_monthly_pk primary key (company_id, period_month, flow_type, model, outcome),
  constraint ai_usage_monthly_month_check check (period_month = (date_trunc('month', period_month))::date),
  constraint ai_usage_monthly_flow_check check (flow_type in (
    'document_scan',
    'document_scan_plate_fallback',
    'vehicle_document_scan',
    'vehicle_document_plate_fallback',
    'vehicle_registration_scan',
    'voice_transcription',
    'intent_classification_fallback'
  )),
  constraint ai_usage_monthly_model_check check (model ~ '^[a-z0-9][a-z0-9.-]{1,62}$'),
  constraint ai_usage_monthly_outcome_check check (outcome in ('success', 'failure')),
  constraint ai_usage_monthly_nonnegative check (
    requests >= 0 and input_tokens >= 0 and cached_input_tokens >= 0 and output_tokens >= 0
    and audio_input_tokens >= 0 and audio_seconds >= 0 and image_count >= 0 and retry_count >= 0
  )
);

create index if not exists ai_usage_monthly_period_idx on public.ai_usage_monthly (period_month);

alter table public.ai_usage_monthly enable row level security;
alter table public.ai_usage_monthly force row level security;
revoke all on table public.ai_usage_monthly from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.ai_usage_monthly to service_role;

-- ----------------------------------------------------------------------------- zápis (server only)
-- Vráti true = započítané, false = odmietnuté (fail closed: neznámy flow,
-- neplatné čísla, používateľ nie je aktívny člen danej firmy → nič sa
-- nezapíše, aby sa usage nikdy nepripísal inej firme).
create or replace function public.esblu_record_ai_usage(
  p_company_id uuid,
  p_user_id uuid,
  p_flow_type text,
  p_model text,
  p_outcome text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_output_tokens bigint,
  p_audio_input_tokens bigint,
  p_audio_seconds numeric,
  p_image_count integer,
  p_retry_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_month date := (date_trunc('month', now()))::date;
begin
  if p_company_id is null or p_user_id is null then
    return false;
  end if;
  if p_flow_type is null or p_flow_type not in (
    'document_scan', 'document_scan_plate_fallback', 'vehicle_document_scan',
    'vehicle_document_plate_fallback', 'vehicle_registration_scan',
    'voice_transcription', 'intent_classification_fallback'
  ) then
    return false;
  end if;
  if p_model is null or p_model !~ '^[a-z0-9][a-z0-9.-]{1,62}$' then
    return false;
  end if;
  if p_outcome is null or p_outcome not in ('success', 'failure') then
    return false;
  end if;
  if coalesce(p_input_tokens, 0) < 0 or coalesce(p_cached_input_tokens, 0) < 0
    or coalesce(p_output_tokens, 0) < 0 or coalesce(p_audio_input_tokens, 0) < 0
    or coalesce(p_audio_seconds, 0) < 0 or coalesce(p_image_count, 0) < 0
    or coalesce(p_retry_count, 0) < 0
    or coalesce(p_input_tokens, 0) > 10000000 or coalesce(p_output_tokens, 0) > 10000000
    or coalesce(p_audio_seconds, 0) > 86400 or coalesce(p_image_count, 0) > 100
    or coalesce(p_retry_count, 0) > 10 then
    return false;
  end if;

  -- Company scoping: iba aktívny člen TEJTO firmy (multi-company: usage firmy A
  -- sa nikdy nezapíše firme B). Inak fail closed.
  if not exists (
    select 1 from public.company_members cm
    where cm.company_id = p_company_id and cm.user_id = p_user_id and cm.status = 'active'
  ) then
    return false;
  end if;

  insert into public.ai_usage_monthly as u (
    company_id, period_month, flow_type, model, outcome, requests,
    input_tokens, cached_input_tokens, output_tokens, audio_input_tokens,
    audio_seconds, image_count, retry_count
  ) values (
    p_company_id, v_month, p_flow_type, p_model, p_outcome, 1,
    coalesce(p_input_tokens, 0), coalesce(p_cached_input_tokens, 0), coalesce(p_output_tokens, 0),
    coalesce(p_audio_input_tokens, 0), coalesce(p_audio_seconds, 0), coalesce(p_image_count, 0),
    coalesce(p_retry_count, 0)
  )
  on conflict on constraint ai_usage_monthly_pk do update set
    requests = u.requests + 1,
    input_tokens = u.input_tokens + excluded.input_tokens,
    cached_input_tokens = u.cached_input_tokens + excluded.cached_input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    audio_input_tokens = u.audio_input_tokens + excluded.audio_input_tokens,
    audio_seconds = u.audio_seconds + excluded.audio_seconds,
    image_count = u.image_count + excluded.image_count,
    retry_count = u.retry_count + excluded.retry_count,
    last_recorded_at = now();

  return true;
end
$function$;
revoke all on function public.esblu_record_ai_usage(uuid, uuid, text, text, text, bigint, bigint, bigint, bigint, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_record_ai_usage(uuid, uuid, text, text, text, bigint, bigint, bigint, bigint, numeric, integer, integer) to service_role;

-- Skeny dokumentov: firma + používateľ sa odvodia z AI rezervácie
-- (ai_processing_usage, ktorú vytvorila DB podľa aktívnej firmy session) —
-- usage patrí presne tej firme, ktorej sa započítala AI kvóta. Server
-- neposiela company_id vôbec. Neznáma rezervácia → false (fail closed).
create or replace function public.esblu_record_ai_usage_for_reservation(
  p_ai_usage_id uuid,
  p_flow_type text,
  p_model text,
  p_outcome text,
  p_input_tokens bigint,
  p_cached_input_tokens bigint,
  p_output_tokens bigint,
  p_image_count integer,
  p_retry_count integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_company_id uuid;
  v_user_id uuid;
begin
  if p_ai_usage_id is null or p_flow_type is null or p_flow_type not in (
    'document_scan', 'document_scan_plate_fallback', 'vehicle_document_scan',
    'vehicle_document_plate_fallback', 'vehicle_registration_scan'
  ) then
    return false;
  end if;
  select u.company_id, u.user_id into v_company_id, v_user_id
  from public.ai_processing_usage u
  where u.id = p_ai_usage_id;
  if v_company_id is null or v_user_id is null then
    return false;
  end if;
  return public.esblu_record_ai_usage(
    v_company_id, v_user_id, p_flow_type, p_model, p_outcome,
    p_input_tokens, p_cached_input_tokens, p_output_tokens, 0, 0, p_image_count, p_retry_count
  );
end
$function$;
revoke all on function public.esblu_record_ai_usage_for_reservation(uuid, text, text, text, bigint, bigint, bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.esblu_record_ai_usage_for_reservation(uuid, text, text, text, bigint, bigint, bigint, integer, integer) to service_role;

-- ----------------------------------------------------------------------------- retencia (server only)
-- Zmaže mesiace staršie ako p_keep_months (minimum 13 — rok porovnania
-- ostane vždy zachovaný; chybný parameter nevymaže čerstvé dáta).
create or replace function public.esblu_purge_ai_usage_monthly(p_keep_months integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_keep integer := greatest(coalesce(p_keep_months, 25), 13);
  v_deleted integer;
begin
  delete from public.ai_usage_monthly
  where period_month < ((date_trunc('month', now()) - make_interval(months => v_keep)))::date;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;
revoke all on function public.esblu_purge_ai_usage_monthly(integer) from public, anon, authenticated;
grant execute on function public.esblu_purge_ai_usage_monthly(integer) to service_role;
