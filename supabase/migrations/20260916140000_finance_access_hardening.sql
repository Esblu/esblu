begin;

-- =============================================================================
-- Esblu — Finance Access Hardening
-- =============================================================================
-- Nové záväzné rozhodnutie: finančné/fakturačné údaje (company_billing_
-- profile, business_partners) NESMÚ byť automaticky viditeľné adminovi ani
-- employee. Prístup má OWNER vždy, alebo iný člen firmy iba s explicitne
-- prideleným finančným oprávnením (typicky účtovník/účtovníčka).
--
-- Namespaced permission kľúče v existujúcom company_members.permissions
-- jsonb (stĺpec existuje od Fázy 1B, dnes v appke nepoužívaný — audit
-- potvrdil 0 neprázdnych riadkov v produkcii, žiadna existujúca konvencia,
-- takže sa touto migráciou zavádza prvá):
--
--   permissions = {"finance": {"view": true, "manage": true}}
--
--   finance.view   — smie SELECT company_billing_profile / business_partners
--   finance.manage — smie navyše INSERT/UPDATE/DELETE (manage implikuje view)
--
-- OWNER má view+manage VŽDY (hardcoded v helperoch nižšie, nezávisle od
-- obsahu permissions). role='admin' SAMA OSEBE finančný prístup NEDÁVA —
-- presne podľa zadania. Rolový model (owner/admin/employee) sa nemení,
-- žiadna nová globálna rola sa nezavádza.
--
-- Namespaced tvar (nie plochý finance_access:true) je zámerný — rovnaký
-- jsonb stĺpec má v budúcnosti niesť aj ďalšie namespaces (invoices,
-- payments, exports, eFaktúry, reports), takže "finance" je jeden kľúč
-- medzi viacerými, nie jediný možný.
--
-- ROZSAH tejto migrácie:
--   1. Dva nové SECURITY DEFINER helpery (esblu_my_finance_view/manage),
--      1:1 štýl s existujúcimi esblu_my_active_company_id()/...role().
--   2. RLS na company_billing_profile a business_partners prepísané z
--      "owner/admin" na "owner alebo finance view/manage" (SELECT), resp.
--      "owner alebo finance manage" (INSERT/UPDATE/DELETE).
--   3. Branding zostáva pre všetkých aktívnych členov bez ohľadu na
--      finance permission — esblu_get_company_profile() je SECURITY
--      DEFINER a vracia iba (company_name, logo_path), obchádza RLS na
--      company_billing_profile úplne, takže Dashboard branding sa touto
--      migráciou NIJAKO nemení a zostáva funkčný pre owner/admin/employee
--      rovnako ako doteraz.
--   4. Cross-company izolácia zostáva nezmenená (company_id qual sa
--      nemení, iba sa dopĺňa o finance podmienku).
-- =============================================================================


-- =============================================================================
-- 1. Finance access helpery
-- =============================================================================
-- Rovnaký vzor ako esblu_my_active_role()/esblu_my_active_company_id()
-- (STABLE SECURITY DEFINER, SET search_path TO '', jeden riadok pre
-- aktívny membership). coalesce(..., false) na oboch úrovniach — chýbajúci
-- riadok, chýbajúci "finance" kľúč, chýbajúci "view"/"manage" kľúč alebo
-- non-boolean hodnota v jsonb sa vždy vyhodnotí ako BEZ prístupu
-- (fail-closed), nikdy nevyhodí chybu.

create or replace function public.esblu_my_finance_view()
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
      limit 1
    ),
    false
  );
$function$;

comment on function public.esblu_my_finance_view() is
  'true pre AKTÍVNEHO prihláseného člena, ak smie ČÍTAŤ finančné/billing dáta (company_billing_profile, business_partners): owner vždy, inak iba permissions.finance.view alebo permissions.finance.manage = true. role=''admin'' sama osebe NEDÁVA finance prístup. Fail-closed (coalesce na false) pri chýbajúcom membershipe/kľúči/neplatnej hodnote.';

create or replace function public.esblu_my_finance_manage()
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
        or coalesce((cm.permissions -> 'finance' ->> 'manage')::boolean, false)
      from public.company_members cm
      where cm.user_id = auth.uid()
        and cm.status = 'active'
      limit 1
    ),
    false
  );
$function$;

comment on function public.esblu_my_finance_manage() is
  'true pre AKTÍVNEHO prihláseného člena, ak smie ZAPISOVAŤ finančné/billing dáta (company_billing_profile, business_partners): owner vždy, inak iba permissions.finance.manage = true. Fail-closed (coalesce na false).';

revoke execute on function public.esblu_my_finance_view() from public;
revoke execute on function public.esblu_my_finance_view() from anon;
grant execute on function public.esblu_my_finance_view() to authenticated;

revoke execute on function public.esblu_my_finance_manage() from public;
revoke execute on function public.esblu_my_finance_manage() from anon;
grant execute on function public.esblu_my_finance_manage() to authenticated;


-- =============================================================================
-- 2. company_billing_profile — RLS prepis owner/admin → owner/finance
-- =============================================================================
drop policy if exists company_billing_profile_select_company on public.company_billing_profile;
drop policy if exists company_billing_profile_insert_owner_admin on public.company_billing_profile;
drop policy if exists company_billing_profile_update_owner_admin on public.company_billing_profile;

create policy company_billing_profile_select_finance
  on public.company_billing_profile
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_view()
  );

create policy company_billing_profile_insert_finance
  on public.company_billing_profile
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and (updated_by is null or updated_by = auth.uid())
  );

create policy company_billing_profile_update_finance
  on public.company_billing_profile
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and (updated_by is null or updated_by = auth.uid())
  );

-- DELETE zostáva zámerne bez politiky (bezo zmeny od Fázy 1B) — priamy
-- klientský DELETE nie je nikdy povolený, ani ownerovi, ani finance
-- manage členovi. Profil zaniká výhradne cez ON DELETE CASCADE.


-- =============================================================================
-- 3. business_partners — RLS prepis owner/admin → owner/finance
-- =============================================================================
drop policy if exists business_partners_select_company on public.business_partners;
drop policy if exists business_partners_insert_owner_admin on public.business_partners;
drop policy if exists business_partners_update_owner_admin on public.business_partners;
drop policy if exists business_partners_delete_owner_admin on public.business_partners;

create policy business_partners_select_finance
  on public.business_partners
  for select
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_view()
  );

create policy business_partners_insert_finance
  on public.business_partners
  for insert
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and (created_by is null or created_by = auth.uid())
    and (updated_by is null or updated_by = auth.uid())
  );

create policy business_partners_update_finance
  on public.business_partners
  for update
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
  )
  with check (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
    and (updated_by is null or updated_by = auth.uid())
  );

create policy business_partners_delete_finance
  on public.business_partners
  for delete
  using (
    company_id = public.esblu_my_active_company_id()
    and public.esblu_my_finance_manage()
  );

commit;
