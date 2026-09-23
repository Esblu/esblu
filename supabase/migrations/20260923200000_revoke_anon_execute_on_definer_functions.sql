-- =============================================================================
-- SECURITY DEFINER: anon dostane EXECUTE iba tam, kde ho naozaj potrebuje
--
-- ČO SA NAŠLO
-- -----------
-- Z 65 funkcií v schéme public je 62 SECURITY DEFINER. Dvadsať z nich mohol
-- volať `anon`, teda ktokoľvek s verejným anon kľúčom, bez prihlásenia.
-- Medzi nimi aj `esblu_create_company_invite` — vytvorenie pozvánky do firmy.
--
-- PREČO SA TAM DOSTALI
-- --------------------
-- Nie omylom v jednotlivých migráciách. Žiadna z nich `grant execute ... to
-- anon` nerobila. Spôsobil to bootstrap projektu:
--
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
-- Každá funkcia, ktorú `postgres` v `public` vytvorí, teda automaticky
-- dostane `anon=X`. Overené v pg_default_acl. Preto by sa to bez zásahu do
-- default privileges opakovalo pri každej ďalšej funkcii — vrátane tej, ktorú
-- niekto napíše o rok.
--
-- ČO Z TOHO VYPLÝVALO V PRAXI
-- ---------------------------
-- Zneužiteľná diera to nebola: každá z tých dvadsiatich funkcií (okrem
-- náhľadu pozvánky a jedného triggeru) začína kontrolou `auth.uid()` a bez
-- prihlásenia skončí chybou NOT_AUTHENTICATED. Overené prečítaním všetkých
-- tiel: žiadne dynamické SQL, žiadny mutable search_path, tenant scope
-- všade.
--
-- Lenže „funkcia aj tak nič neurobí, lebo auth.uid() je NULL" nie je dôvod
-- nechať ju verejne volateľnú. SECURITY DEFINER je hranica privilégií.
-- Ak ju anon pred prihlásením nepotrebuje, nemá na ňu mať EXECUTE — a jedna
-- zabudnutá kontrola v budúcom tele potom nie je hneď verejná.
--
-- ČO ZOSTÁVA ANONYMNE VOLATEĽNÉ
-- -----------------------------
-- Presne jedna funkcia: `esblu_get_invite_preview(p_token text)`.
--
-- Pozvaný človek klikne na odkaz v e-maile a ešte účet nemá. Stránka
-- /invite/[token] mu musí ukázať, do akej firmy a v akej role ho pozvali,
-- inak by mal zadať heslo naslepo. Volá sa hneď pri načítaní stránky, pred
-- akýmkoľvek prihlásením (app/invite/InviteView.tsx → loadInvite()).
--
-- Čo cez ňu vidieť: názov firmy, rolu, maskovaný e-mail (j***@e***.sk),
-- platnosť. Nič viac — žiadne company_id, žiadny zoznam členov, žiadne
-- podnikové dáta. A iba s platným tokenom: hľadá sa podľa sha256 hashu
-- 32-bajtového náhodného tokenu, takže sa nedá vymýšľať ani enumerovať.
-- Kto token má, dostal ho e-mailom a tieto údaje mu patria.
--
-- PRIJATIE POZVÁNKY SA TÝM NELÁME
-- -------------------------------
-- `esblu_accept_company_invite` je iná funkcia a volá sa AŽ po registrácii
-- alebo prihlásení (InviteView.tsx → finalizeAcceptance() beží iba vo vetve
-- s platnou session). To isté platí pre `esblu_ensure_my_owner_company` a
-- právne súhlasy: v app/login/page.tsx aj app/onboarding/company/page.tsx sú
-- volané výhradne vnútri `if (data.session)`. Overené čítaním kódu, nie
-- odhadom.
--
-- ROLA `authenticated` SA NEMENÍ
-- ------------------------------
-- Osemnásť funkcií, ktoré appka volá z prehliadača, si EXECUTE pre
-- `authenticated` ponecháva. Nikde sa nič nepridáva — iba uberá.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Odobratie EXECUTE roli anon
--
-- REVOKE je idempotentný: opakované spustenie nič nepokazí.
-- -----------------------------------------------------------------------------

revoke execute on function public.esblu_accept_company_dpa(text) from anon;
revoke execute on function public.esblu_accept_company_invite(text) from anon;
revoke execute on function public.esblu_accept_legal_document_at_gate(text, text) from anon;
revoke execute on function public.esblu_accept_legal_document_registration(text, text) from anon;
revoke execute on function public.esblu_attach_chat_message_reference(uuid, text, uuid) from anon;
revoke execute on function public.esblu_create_company_invite(text, text) from anon;
revoke execute on function public.esblu_ensure_company_chat_channel() from anon;
revoke execute on function public.esblu_ensure_my_owner_company() from anon;
revoke execute on function public.esblu_get_my_company_dpa_status() from anon;
revoke execute on function public.esblu_get_my_pending_required_acceptances() from anon;
revoke execute on function public.esblu_get_my_unread_counts() from anon;
revoke execute on function public.esblu_get_or_create_direct_conversation(uuid) from anon;
revoke execute on function public.esblu_list_company_members_for_chat() from anon;
revoke execute on function public.esblu_list_my_company_invites() from anon;
revoke execute on function public.esblu_list_my_company_members() from anon;
revoke execute on function public.esblu_mark_conversation_read(uuid) from anon;

-- `esblu_my_active_company_id` a `esblu_my_active_role` sú pomocné funkcie RLS
-- politík. Politiky sú písané `TO public`, čo formálne zahŕňa aj anon — lenže
-- anon nemá na žiadnu z tých tabuliek tabuľkový grant, takže sa ich politiky
-- nikdy nevyhodnocujú. Jediné, čo anon smie čítať, je `legal_documents`, a tá
-- má politiku `USING (true)` bez volania akejkoľvek funkcie. Overené.
--
-- Volania zvnútra iných SECURITY DEFINER funkcií sa kontrolujú voči vlastníkovi
-- (postgres), nie voči volajúcemu, takže tie sa týmto nedotkne.
revoke execute on function public.esblu_my_active_company_id() from anon;
revoke execute on function public.esblu_my_active_role() from anon;

-- -----------------------------------------------------------------------------
-- 2. Triggerová funkcia nepatrí žiadnemu klientovi
--
-- `esblu_log_invoice_accounting_state()` vracia `trigger`. Cez PostgREST sa
-- volať nedá a trigger ju spúšťa bez ohľadu na EXECUTE volajúceho — presne
-- ako ostatných desať triggerových funkcií v tejto schéme, ktoré nemajú
-- žiadny klientský grant a fungujú.
--
-- Táto jediná ho mala, a navyše aj pre PUBLIC. Nebola to voľba, iba zvyšok
-- po tom, ako vznikla.
-- -----------------------------------------------------------------------------

revoke execute on function public.esblu_log_invoice_accounting_state() from public;
revoke execute on function public.esblu_log_invoice_accounting_state() from anon;
revoke execute on function public.esblu_log_invoice_accounting_state() from authenticated;

-- -----------------------------------------------------------------------------
-- 3. Pevný search_path pre triggerovú funkciu na auth.users
--
-- `esblu_create_settings_for_new_user()` beží ako SECURITY DEFINER pri každej
-- registrácii a mala `search_path = pg_catalog, public`. Telo je už teraz
-- plne kvalifikované (`public.settings`), takže prázdny search_path nič
-- nemení na správaní a odoberá poslednú vec, ktorú by bolo treba strážiť.
--
-- Zneužiteľné to nebolo — ani anon, ani authenticated nemajú CREATE na schéme
-- public, takže si tam nikto nemohol podstrčiť vlastnú tabuľku. Ale pravidlo
-- „SECURITY DEFINER má prázdny search_path" má platiť bez výnimky, nie
-- „okrem jednej funkcie, kde to vyšlo".
-- -----------------------------------------------------------------------------

create or replace function public.esblu_create_settings_for_new_user()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.settings (user_id, plan)
  values (new.id, 'free')
  on conflict (user_id) do nothing;

  return new;
end
$function$;

-- -----------------------------------------------------------------------------
-- 4. Aby sa to samo nevrátilo
--
-- Toto je vlastná oprava. Bez nej by ďalšia funkcia, ktorú niekto v migrácii
-- napíše, opäť automaticky dostala `anon=X` — a nikto by si to nevšimol,
-- lebo v migrácii by žiadny GRANT nebol.
--
-- Po tejto zmene nová funkcia vytvorená rolou `postgres` v schéme `public`
-- nedostane EXECUTE ani pre anon, ani pre authenticated. Kto ju chce sprístupniť
-- klientovi, musí to v migrácii napísať:
--
--     grant execute on function public.moja_funkcia(...) to authenticated;
--
-- Je to o jeden riadok práce navyše a o jedno rozhodnutie, ktoré je vidieť
-- v diffe. Keď sa naň zabudne, appka zlyhá hlasno na „permission denied" —
-- to je lepšie než ticho otvorená funkcia.
--
-- POZOR: service_role si default ponecháva. Serverové cesty (webhooky, edge
-- funkcie) inak prestanú fungovať a tam anonymný prístup nehrozí.
--
-- Rola `supabase_admin` má vlastné default privileges pre public FUNCTIONS,
-- ktoré anon tiež udeľujú. Spravuje ich Supabase a nemeníme ich; žiadna
-- funkcia Esblu ju ako vlastníka nemá (všetkých 65 vlastní `postgres`).
-- -----------------------------------------------------------------------------

alter default privileges for role postgres in schema public
  revoke execute on functions from anon;

alter default privileges for role postgres in schema public
  revoke execute on functions from authenticated;
