# Verejná registrácia + nový verejný web (2026-11-17)

Koniec uzavretej bety: nový zákazník (e-mail mimo `beta_allowlist`) sa zaregistruje a založí si firmu.
Verejný web (landing, registrácia, cenník, právne podstránky) je vizuálne zladený s aplikáciou.

## 1. Databáza — `supabase/migrations/20261117100000_open_public_registration.sql`

Audit pred zmenou (prod `fkpgvgvsmbpieduoatrt`, read-only definície funkcií): obe kontroly vyžadovali
`beta_allowlist` (`revoked_at is null and consumed_at is null`):

- Auth hook `esblu_before_user_created_beta_gate` — pred vznikom `auth.users` (prod mal Google invite vetvu
  z `20260927120000`; staging `esblu-test` ju nemal — drift, migrácia ho zjednocuje),
- `esblu_ensure_my_owner_company` — pri založení firmy (`ESBLU_BETA_ACCESS_REQUIRED`).

Zmena:

| Objekt | Čo |
|---|---|
| `public.registration_policy` | singleton `mode = 'open' \| 'closed_beta'`; RLS bez policy, žiadne granty pre anon/authenticated, service_role iba DML |
| `public.esblu_public_registration_open()` | jediný zdroj pravdy pre obe kontroly; **fail closed** (chýbajúci riadok = zatvorené); bez EXECUTE pre klientov |
| hook | invite vetvy (token aj Google) nezmenené; nová vetva „registrácia otvorená“ pred allowlistom; v režime `closed_beta` neutrálna hláška „Registrácia nových firiem je dočasne pozastavená …“ |
| `esblu_ensure_my_owner_company` | allowlist iba v režime `closed_beta`; `ESBLU_PENDING_INVITE_EXISTS`, advisory lock, `consumed_at` evidencia — bez zmeny |

Nemení sa: pozvánky a `esblu_accept_company_invite`, roly a oprávnenia, RLS a izolácia firiem, prijímanie
VOP / zásad / DPA, trial (iba overený právny subjekt + `trial_claims` proti opakovanému čerpaniu).

## 2. Rýchly návrat k uzavretej registrácii (okamžite, bez deployu)

```sql
update public.registration_policy
   set mode = 'closed_beta', updated_at = now(), note = '<dôvod>'
 where id;
```

Účinok: nový e-mail mimo allowlistu dostane pri registrácii 403 (web/app zobrazí lokalizovanú hlášku
„Registrácia nových firiem je momentálne pozastavená …“), allowlist a pozvánky fungujú ako predtým.
Opätovné otvorenie: to isté s `mode = 'open'`. Kontrola: `select mode, updated_at, note from public.registration_policy;`

Verejné texty webu po prepnutí stále pozývajú na registráciu — ak má návrat trvať dlhšie, vrátiť aj web:
Vercel → `esblu` → Deployments → predchádzajúci produkčný deployment → Promote (alebo revert commitu).
Úplný rollback schémy: `supabase/rollback/20261117100000_open_public_registration_rollback.sql`
(vráti presné produkčné definície funkcií spred migrácie, zmaže tabuľku a helper).

## 3. Verejný web

- `app/components/public/PublicSite.tsx` — spoločná hlavička (navigácia, jazyk, Prihlásiť sa, **Vytvoriť účet**)
  a pätička (produkt, právne dokumenty, kontakt, prevádzkovateľ) pre landing, cenník, právne podstránky a web
  prihlásenie/registráciu. Mobilná appka (`IS_MOBILE_BUILD`) ostáva bez marketingovej hlavičky.
- `app/components/PublicLandingPage.tsx` — úvod s reálnymi obrazovkami Esblu (demo údaje), funkcie s rovnakými
  ilustráciami modulov ako Dashboard, „Ako začať“, AI transparentnosť (schválené texty), skúšobná verzia,
  bezpečnosť, záverečná výzva.
- Registrácia: `/login?rezim=registracia` otvorí formulár rovno v režime registrácie (`lib/public-links.ts`).
- Texty SK/EN/DE bez zmienok o uzavretej bete (landing, auth, onboarding, cenník, metadáta).
- Demo video: odstránená záverečná karta „Uzavretá beta“ (strih na 405 s + fade, titulky a `VIDEO_DURATION_SECONDS`).
- SEO: nový popis, OG/Twitter obrázok `public/images/landing/esblu-og.png` (1200×630, `summary_large_image`),
  `theme-color` = pozadie appky.
- Snímky: `scripts/landing-screenshots/` — skutočné UI (next dev) + syntetická firma „Novák Stavby s. r. o.“,
  všetky volania Supabase obslúžené lokálne (žiadna DB). Výstup WebP q86 do `public/images/landing/`.

Ponechané zámerne: `entitlements.trial.legacy_no_trial` („pôvodný beta režim“) — interný stav existujúcich firiem
v Nastaveniach, nie verejný text. Interné kľúče `auth.closedBeta.*` / `oauth=beta` ostávajú (iba nové texty).

## 4. Android — balík 3 (1.0.0, versionCode 3)

AAB `esblu-1.0.0-vc3.aab` je zostavený zo zdroja `bc31e63` a obsahuje statický export webu (Capacitor `webDir: out`).

- **Funkčne s verejnou registráciou funguje**: o registrácii aj založení firmy rozhoduje server (hook + RPC),
  appka volá rovnaké `signUp` / `esblu_ensure_my_owner_company` a produkčný Supabase.
- **Texty sú zastarané**: v balíku je `auth.closedBeta.registerNotice` („Esblu je momentálne v uzavretej beta
  verzii …“), ktorý sa zobrazuje na obrazovke registrácie, a beta texty landing/auth (overené v `assets/public`).
- **Na zobrazenie aktuálnych textov treba nový AAB** (versionCode 4) z commitu tohto vydania.

## 5. Google Play — náhradný text (Store listing → Full description, posledný odsek)

SK (nahradiť vetu „Esblu je momentálne v uzavretej beta verzii. Nové účty sú dostupné len pre schválených testerov.“):

```
Účet pre firmu si vytvoríte priamo v aplikácii alebo na www.esblu.com. Po overení IČO firmy získate 14 dní všetkých hlavných modulov zadarmo — bez platobnej karty, nič sa automaticky neúčtuje.
```

EN (nahradiť „Esblu is currently in closed beta. New accounts are available only to approved testers.“):

```
Create an account for your company directly in the app or at www.esblu.com. Once your company ID is verified, you get all main modules free for 14 days — no payment card, nothing is charged automatically.
```

Short description a ostatné polia bez zmeny (`release/play-submission/01-store-listing.md`).

## 6. Validácia (2026-11-17)

Kód: `tsc --noEmit` OK; ESLint zmenených súborov 0 chýb (celý `npm run lint` hlási 33 chýb / 31 varovaní iba
v nezmenených súboroch — existujúci stav `origin/main`); `next build` overený Vercel Preview buildom
`dpl_2ZthwANJhEeLJRpf2aPriKojwEZn` (READY; sandbox nemá prístup k Google Fonts). Testy: `test:google-oauth` 17/0,
`test:google-oauth-db` 26/0 (nová matica open/closed/fail-closed), `test:dashboard-today` 18/0, `test:i18n` 114/0,
`test:auth-recovery` 18/0, `test:clia-gdpr` 17/0.

Staging `esblu-test` (migrácia aplikovaná; syntetické účty `@esblu-qa.invalid`, transakcie s rollbackom):

| Krok | Výsledok |
|---|---|
| hook pre nový e-mail mimo allowlistu (e-mail aj Google) | povolené |
| súhlasy pri registrácii (VOP 1.1 / zásady 1.4) | zapísané, 0 čakajúcich |
| založenie firmy | `created = true`, rola owner, druhé volanie bez novej firmy |
| firemné VOP 1.2 + DPA 1.3 (owner) | prijaté |
| pred overením IČO | trial neaktívny, faktúra `ENTITLEMENT_DENIED:invoicing` |
| po overení IČO (server, service_role) | trial aktívny, 14 dní |
| prvý syntetický doklad (koncept faktúry pod RLS) | uložený |
| pozvánka (token) → registrácia pozvaného | hook povolí; vlastnú firmu nezaloží (`ESBLU_PENDING_INVITE_EXISTS`); prijatie = presne zadaná rola; opakované prijatie `ESBLU_INVITE_ALREADY_ACCEPTED` |
| oprávnenia employee | pozvať `ESBLU_NOT_ACTIVE_OWNER_OR_ADMIN`, prijať VOP za firmu `ESBLU_NOT_ACTIVE_OWNER` |
| opakované čerpanie trialu (iná firma, to isté IČO s medzerami) | trial **nie** |
| iný tenant | 0 viditeľných faktúr cudzej firmy |
| režim `closed_beta` | cudzí e-mail 403 (nová hláška), allowlist/pozvánky/Google pozvánka OK, Apple bez obchvatu, chýbajúci riadok = zatvorené |

Produkcia `assetpilot` (po migrácii; read-only počty + jedna transakcia s rollbackom, žiadne trvalé zápisy dát):
politika `open`; všetkých 7 existujúcich používateľov s firmou → `ensure` nezaloží novú firmu (0 chýb);
nový syntetický zákazník: hook OK (e-mail aj Google), súhlasy, firma, VOP+DPA, trial až po IČO, prvý doklad,
0 viditeľných cudzích firiem/faktúr/dokladov; pozvánka admin → prijatá ako admin; opakované čerpanie trialu odmietnuté.
Security advisors: nové iba očakávané `rls_enabled_no_policy` (INFO) pre `registration_policy` (zámerne ako `beta_allowlist`).

Web (Preview, Playwright 1440×900 a 390×844, SK/EN/DE): bez horizontálneho posunu, „Vytvoriť účet“ viditeľné na
úvodnej obrazovke, snímka aplikácie na mobile v prvom zobrazení, skip-link → `#obsah`, mobilné menu sa zatvára Esc,
`/login?rezim=registracia` otvorí registráciu, 0 výskytov „beta/tester“ na `/`, registrácii a cenníku, právne
stránky 200 so spoločnou hlavičkou, OG obrázok + `summary_large_image`, `theme-color #05080f`.

Neoverené automatom (vyžaduje zadanie hesla / Google účtu v prehliadači — vykoná vlastník): interaktívna registrácia
e-mailom s potvrdením e-mailu na stagingu, prihlásenie cez Google, prihlásenie existujúceho používateľa heslom.
Postup: `/login?rezim=registracia` → nový e-mail → potvrdiť e-mail → Nastavenia → Identita firmy (IČO) →
Faktúry → nový koncept; Google: `/login` → „Pokračovať cez Google“ (ak je na danom prostredí zapnutý).
