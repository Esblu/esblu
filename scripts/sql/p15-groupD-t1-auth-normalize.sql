-- =============================================================================
-- P1-5 D-T1 — NÁVRH opravy (NESPÚŠŤAŤ bez samostatného schválenia). Iba staging esblu-test, iba syntetický vlastník T1.
--
-- Príčina HTTP 500 (auth log 2026-11-25 19:41:47 UTC, /admin/generate_link):
--   "error finding user: sql: Scan error on column index 3, name "confirmation_token": converting NULL to string is unsupported"
-- GoTrue načítava tokenové stĺpce auth.users ako string (nie NULL). Seed skupiny C (seed-group-c.sql) vložil
-- používateľov bez týchto stĺpcov → confirmation_token, recovery_token, email_change_token_new, email_change = NULL
-- (stĺpce nemajú DEFAULT ''). Používatelia vytvorení cez Auth API majú ''. Nie je to chyba identít ani poskytovateľa.
--
-- Oprava = normalizácia NULL → '' v 4 tokenových stĺpcoch IBA pre f1500000-…-0101. Nemení prihlásenie,
-- last_sign_in_at, updated_at, e-mail, metadáta, identity ani relácie; nevytvára session ani token.
-- Transakcia sa vráti, ak by zasiahla iný riadok alebo iný stĺpec.
-- =============================================================================
begin;
do $$
declare
  v_before jsonb;
  v_after jsonb;
  v_n int;
begin
  select to_jsonb(u) - array['confirmation_token','recovery_token','email_change_token_new','email_change'] into v_before
    from auth.users u where u.id = 'f1500000-0000-4000-8000-000000000101' and u.email = 'qa-p15-t1@esblu-qa.invalid';
  if v_before is null then raise exception 'T1 vlastník nenájdený — nič sa nemení'; end if;

  update auth.users
     set confirmation_token     = coalesce(confirmation_token, ''),
         recovery_token         = coalesce(recovery_token, ''),
         email_change_token_new = coalesce(email_change_token_new, ''),
         email_change           = coalesce(email_change, '')
   where id = 'f1500000-0000-4000-8000-000000000101'
     and email = 'qa-p15-t1@esblu-qa.invalid'
     and (confirmation_token is null or recovery_token is null or email_change_token_new is null or email_change is null);
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'očakávaný presne 1 riadok, zasiahnutých %', v_n; end if;

  select to_jsonb(u) - array['confirmation_token','recovery_token','email_change_token_new','email_change'] into v_after
    from auth.users u where u.id = 'f1500000-0000-4000-8000-000000000101';
  if v_after is distinct from v_before then raise exception 'zmenili sa aj iné stĺpce — rollback'; end if;
  if exists (select 1 from auth.users where id = 'f1500000-0000-4000-8000-000000000101'
             and (confirmation_token <> '' or recovery_token <> '' or email_change_token_new <> '' or email_change <> '')) then
    raise exception 'neočakávaná hodnota tokenu — rollback';
  end if;
end $$;
-- kontrola pred commitom: T1 = 0 NULL v 4 stĺpcoch; ostatní používatelia bez zmeny
select right(id::text, 3) u, confirmation_token is null c_null, recovery_token is null r_null,
       email_change_token_new is null e1_null, email_change is null e2_null, updated_at, last_sign_in_at
  from auth.users where id::text like 'f150%' order by 1;
commit;
