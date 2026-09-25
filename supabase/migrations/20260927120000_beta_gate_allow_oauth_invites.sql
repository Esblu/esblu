-- =============================================================================
-- Uzavretá beta: pozvaní používatelia aj cez Google / Apple (OAuth).
--
-- STAV: NAVRHNUTÉ, NEAPLIKOVANÉ. Aplikovať iba po výslovnom schválení cez
-- Supabase MCP apply_migration (supabase/MIGRATIONS.md). NIKDY db push.
--
-- PREČO: Auth hook „Before User Created" púšťa pozvaných iba podľa invite
-- tokenu v user_metadata. Pri prihlásení cez Google/Apple Supabase metadáta
-- z appky neprenáša, takže pozvaný zamestnanec, ktorý nie je na beta
-- allowliste, by sa cez OAuth nezaregistroval. Táto zmena pridá JEDINÚ
-- vetvu: platná (pending, nevypršaná) pozvánka pre presne tento e-mail.
--
-- POSKYTOVATEĽ: vetva platí IBA pre app_metadata.provider ∈ {google, apple}
-- (nastavuje Supabase Auth server, nie klient). Chýbajúci/iný poskytovateľ =
-- žiadny obchvat (fail closed). OVERENIE PO APLIKOVANÍ: skúšobný pozvaný
-- účet cez Google — ak by Supabase v udalosti hooku provider neposlal,
-- pozvaný sa cez OAuth nezaregistruje (bezpečné zlyhanie) a treba to riešiť
-- samostatnou revíziou, NIE rozšírením podmienky.
--
-- ČO SA NEMENÍ: owner-registrácia stále vyžaduje beta_allowlist; náhodný
-- Google/Apple účet bez pozvánky a bez allowlistu sa nevytvorí (403).
-- Členstvo vzniká až prijatím pozvánky s tokenom (esblu_accept_company_invite
-- — tá istá kontrola e-mailu). Apple „Hide My Email" relay adresa sa s
-- e-mailom pozvánky nezhoduje → taký používateľ musí použiť e-mail/heslo
-- alebo pozvánku na relay adresu.
-- =============================================================================

create or replace function public.esblu_before_user_created_beta_gate(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_email text;
  v_invite_token text;
  v_token_hash text;
  v_invite_valid boolean;
  v_beta_allowed boolean;
  v_provider text;
begin
  v_email := lower(btrim(coalesce(event->'user'->>'email', '')));

  if v_email = '' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 400,
        'message', 'Chýba e-mailová adresa.'
      )
    );
  end if;

  -- Bypass pre pozvaných admin/employee — NEZMENENÉ. Vracia sa skôr, než sa
  -- vôbec dostane k beta_allowlist/consumed_at kontrole nižšie.
  v_invite_token := btrim(coalesce(
    event #>> '{user,user_metadata,esblu_invite_token}', ''
  ));

  if v_invite_token <> '' then
    v_token_hash := encode(extensions.digest(v_invite_token, 'sha256'), 'hex');

    select exists (
      select 1
      from public.company_invites ci
      where ci.token_hash = v_token_hash
        and ci.status = 'pending'
        and ci.expires_at > now()
        and ci.email = v_email
    ) into v_invite_valid;

    if v_invite_valid then
      return '{}'::jsonb;
    end if;
  end if;

  -- OAuth (Google/Apple) nevie poslať user_metadata s invite tokenom.
  -- Pozvaný používateľ sa preto smie vytvoriť aj vtedy, keď pre PRESNE jeho
  -- e-mail (overený poskytovateľom) existuje platná, nevypršaná pozvánka.
  -- Členstvo aj tak vznikne až prijatím pozvánky (esblu_accept_company_invite
  -- s tokenom z odkazu a rovnakou kontrolou e-mailu) — samotné vytvorenie
  -- účtu nedáva prístup k žiadnej firme.
  -- FAIL CLOSED na poskytovateľa: vetva platí IBA pre výslovne schválených
  -- poskytovateľov (google, apple). Poskytovateľa nastavuje Supabase Auth
  -- server v app_metadata (klient ho nemôže podvrhnúť — user_metadata sa tu
  -- zámerne NEČÍTA). E-mail/heslo túto vetvu nepoužíva (má vlastnú vetvu s
  -- tokenom vyššie — nezmenenú). Chýbajúci alebo iný poskytovateľ (napr.
  -- neskôr omylom zapnutý GitHub/Azure, ktorý neoveruje e-mail rovnako) =
  -- žiadny obchvat; platí iba beta allowlist nižšie. Nový poskytovateľ
  -- vyžaduje vedomú úpravu tohto zoznamu a bezpečnostnú revíziu.
  v_provider := lower(btrim(coalesce(event #>> '{user,app_metadata,provider}', '')));

  if v_provider in ('google', 'apple') then
    select exists (
      select 1
      from public.company_invites ci
      where ci.status = 'pending'
        and ci.expires_at > now()
        and ci.email = v_email
    ) into v_invite_valid;

    if v_invite_valid then
      return '{}'::jsonb;
    end if;
  end if;

  -- Owner-registration prípad (alebo neplatný/spoofnutý invite token) —
  -- OPRAVA: vyžaduje aj ba.consumed_at is null, nielen revoked_at is null,
  -- inak by sa raz spotrebovaný slot dal po zmazaní účtu použiť znova.
  select exists (
    select 1
    from public.beta_allowlist ba
    where ba.email = v_email
      and ba.revoked_at is null
      and ba.consumed_at is null
  ) into v_beta_allowed;

  if v_beta_allowed then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Esblu je momentálne v uzavretej beta verzii. Ak máte schválený beta prístup, kontaktujte nás na info@esblu.com.'
    )
  );
end;
$function$;

revoke execute on function public.esblu_before_user_created_beta_gate(jsonb)
  from public, anon, authenticated;

grant execute on function public.esblu_before_user_created_beta_gate(jsonb)
  to supabase_auth_admin;

comment on function public.esblu_before_user_created_beta_gate(jsonb) is
  'Supabase Auth "Before User Created" hook. Owner-signup vetva vyžaduje beta_allowlist zhodu s revoked_at IS NULL AJ consumed_at IS NULL (20260818140000 — zabraňuje opakovanému použitiu raz spotrebovaného slotu po zmazaní účtu). Invite bypass: platný invite token v metadátach ALEBO (20260927120000) pri poskytovateľovi google/apple (app_metadata, nie klient) platná pozvánka pre presne tento e-mail. MANUÁLNY KROK MIMO TEJTO MIGRÁCIE: musí byť zapnutý v Supabase Dashboard → Authentication → Hooks → Before User Created, namierený na túto funkciu.';
