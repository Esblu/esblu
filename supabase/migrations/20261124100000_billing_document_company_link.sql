-- =============================================================================
-- S17-4 (2026-11-20): väzba účtovnej kópie Stripe dokladu na zákaznícku firmu nezávisle od poradia udalostí.
-- Iba aditívne. Rollback: supabase/rollback/20261124100000_billing_document_company_link_rollback.sql
-- (doplnené company_id/snapshoty sú účtovné údaje a rollback ich NEMAŽE).
--
-- Príčina: doklad (invoice.finalized / invoice.paid) sa zapisuje PRED zápisom stavu, ktorý až zakladá
-- väzbu predplatné/zákazník → firma (billing_provider_links, esblu_billing_apply_event). Prvá faktúra
-- nového predplatného (aj nezaplatená) tak ostala bez company_id a bez snapshotu odberateľa.
--
--   1) esblu_billing_documents_link_company  — AFTER INSERT na billing_provider_links (Stripe subscription /
--      customer): doplní company_id dokladom toho istého predplatného / zákazníka, ktoré firmu ešte nemajú.
--      Snapshot odberateľa doplní existujúci guard (esblu_billing_documents_guard). Nikdy neprepíše
--      priradenú firmu ani snapshot inej firmy; pri konflikte väzieb (predplatné → A, zákazník → B)
--      nedoplní nič (doklad ostane bez firmy → alert DOCUMENT_WITHOUT_COMPANY).
--   2) esblu_billing_documents_company_consistency — BEFORE INSERT/UPDATE dokladu: firma dokladu musí
--      súhlasiť so všetkými väzbami jeho predplatného a zákazníka, inak ESBLU_BILLING_DOCUMENT_COMPANY_CONFLICT
--      (zápis dokladu zlyhá → udalosť `failed` DOCUMENT_FAILED → retry s backoffom + ops alert).
--   3) jednorazové doplnenie existujúcich dokladov bez firmy (iba jednoznačná firma; snapshot = identita
--      firmy v čase doplnenia, zdroj `company`).
--   4) esblu_billing_ops_collect_documents — ops alert DOCUMENT_WITHOUT_COMPANY: doklad > 60 min bez firmy
--      aj bez snapshotu odberateľa (doklady ukončených firiem majú snapshot → nepočítajú sa). Auto-resolve.
-- Žiadna zmena RLS ani grantov existujúcich objektov; nové funkcie iba pre service_role (alert) /
-- nikoho (triggery).
-- =============================================================================

-- ----------------------------------------------------------------------------- 1) doplnenie pri vzniku väzby
create or replace function public.esblu_billing_documents_link_company()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.provider <> 'stripe' or new.link_kind not in ('subscription', 'customer')
     or to_regclass('public.billing_invoice_documents') is null then
    return null;
  end if;
  update public.billing_invoice_documents d
     set company_id = new.company_id
   where d.provider = 'stripe'
     and d.environment = new.environment
     and d.company_id is null
     -- snapshot inej (ukončenej) firmy sa nikdy nepreberá ani neprepisuje
     and (d.customer_company_id is null or d.customer_company_id = new.company_id)
     and ((new.link_kind = 'subscription' and d.provider_subscription_id = new.external_id)
       or (new.link_kind = 'customer' and d.provider_customer_id = new.external_id))
     -- nejednoznačná firma (iná väzba predplatného / zákazníka dokladu) → nič
     and not exists (
       select 1 from public.billing_provider_links l
        where l.provider = 'stripe' and l.environment = new.environment and l.company_id <> new.company_id
          and ((l.link_kind = 'subscription' and l.external_id = d.provider_subscription_id)
            or (l.link_kind = 'customer' and l.external_id = d.provider_customer_id)));
  return null;
end
$function$;

drop trigger if exists esblu_billing_documents_link_company on public.billing_provider_links;
create trigger esblu_billing_documents_link_company
  after insert on public.billing_provider_links
  for each row execute function public.esblu_billing_documents_link_company();

-- ----------------------------------------------------------------------------- 2) konzistencia firmy dokladu
create or replace function public.esblu_billing_documents_company_consistency()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- už priradenú firmu chráni esblu_billing_documents_guard (ESBLU_BILLING_DOCUMENT_COMPANY_IMMUTABLE)
  if new.company_id is null or (tg_op = 'UPDATE' and old.company_id is not null) then
    return new;
  end if;
  if exists (
    select 1 from public.billing_provider_links l
     where l.provider = new.provider and l.environment = new.environment and l.company_id <> new.company_id
       and ((l.link_kind = 'subscription' and l.external_id = new.provider_subscription_id)
         or (l.link_kind = 'customer' and l.external_id = new.provider_customer_id))) then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_DOCUMENT_COMPANY_CONFLICT';
  end if;
  return new;
end
$function$;

drop trigger if exists esblu_billing_documents_company_consistency on public.billing_invoice_documents;
create trigger esblu_billing_documents_company_consistency
  before insert or update on public.billing_invoice_documents
  for each row execute function public.esblu_billing_documents_company_consistency();

-- ----------------------------------------------------------------------------- 3) existujúce doklady bez firmy
with c as (
  select d.id, min(l.company_id::text)::uuid as company_id, count(distinct l.company_id) as n
    from public.billing_invoice_documents d
    join public.billing_provider_links l
      on l.provider = 'stripe' and l.environment = d.environment
     and ((l.link_kind = 'subscription' and l.external_id = d.provider_subscription_id)
       or (l.link_kind = 'customer' and l.external_id = d.provider_customer_id))
   where d.provider = 'stripe' and d.company_id is null
   group by d.id
)
update public.billing_invoice_documents d
   set company_id = c.company_id
  from c
 where d.id = c.id and c.n = 1
   and (d.customer_company_id is null or d.customer_company_id = c.company_id);

-- ----------------------------------------------------------------------------- 4) ops alert
create or replace function public.esblu_billing_ops_collect_documents(p_environment text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_n bigint;
  v_resolved integer := 0;
begin
  if p_environment is null or p_environment not in ('test', 'live') then
    raise exception using errcode = 'P0001', message = 'ESBLU_BILLING_OPS_ALERT_INVALID';
  end if;
  select count(*) into v_n from public.billing_invoice_documents d
   where d.environment = p_environment and d.company_id is null and d.customer_company_id is null
     and d.created_at < now() - interval '60 minutes';
  if v_n > 0 then
    perform public.esblu_billing_ops_raise(p_environment, 'DOCUMENT_WITHOUT_COMPANY', 'critical', 1440, 1, jsonb_build_object('count', v_n));
    return jsonb_build_object('raised', jsonb_build_array('DOCUMENT_WITHOUT_COMPANY'), 'resolved', 0);
  end if;
  update public.billing_ops_alerts a set state = 'resolved', resolved_at = now()
   where a.environment = p_environment and a.state in ('open', 'counting') and a.code = 'DOCUMENT_WITHOUT_COMPANY';
  get diagnostics v_resolved = row_count;
  return jsonb_build_object('raised', '[]'::jsonb, 'resolved', v_resolved);
end
$function$;

revoke all on function public.esblu_billing_documents_link_company() from public, anon, authenticated, service_role;
revoke all on function public.esblu_billing_documents_company_consistency() from public, anon, authenticated, service_role;
revoke all on function public.esblu_billing_ops_collect_documents(text) from public, anon, authenticated;
grant execute on function public.esblu_billing_ops_collect_documents(text) to service_role;
