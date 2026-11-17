# Android 1.0.1 (versionCode 4) — kandidát na verejné vydanie + testy pred vydaním (2026-11-17)

| Položka | Hodnota |
|---|---|
| Zdroj | `main` @ `0a44a60` (verejná registrácia + nový web) |
| Package | `com.esblu.app` |
| versionName / versionCode | **1.0.1 / 4** (vc1–vc3 použité; vc3 = 1.0.0 z `bc31e63` s textami uzavretej bety) |
| Backend | produkcia: Supabase `fkpgvgvsmbpieduoatrt`, API `https://www.esblu.com` |
| Checkout | `Claude outputs\esblu-mobile-production-vc4` (mimo Gitu; `SOURCE_COMMIT.txt`) |
| Prihlásenie v appke | e-mail/heslo; Google (`NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS=google`, návrat `com.esblu.app://auth/callback`) |

## 1. Čo je pripravené (agent, sandbox)

- čerstvý mobilný web build z `0a44a60` (`npm run build -w mobile`, produkčný `mobile/.env.local` prevzatý z vc3 checkoutu),
- `npx cap sync android` → `mobile/android/app/src/main/assets/public` (Capacitor pluginy: app 8.1.1, browser 8.0.4,
  filesystem 8.1.3, push-notifications 8.1.2, share 8.0.1), `node_modules/@capacitor/*` pre Gradle,
- lokálne súbory z vc3: `mobile/.env.local`, `app/keystore.properties`, `app/google-services.json`, `release/upload-key.sha*`,
- kontroly bundlu: `android-prebuild-check --target production` (iba produkčný Supabase/API, žiadny staging ref ani Preview host;
  kontrolu dostupnosti API sandbox nevedel spraviť cez DNS, ručne `GET /api/push/preferences` → `401 {"success":false}` JSON = OK),
  `verify-mobile-bundle` OK (9,4 MB, 34 HTML, bez videa a `.well-known`), **0 výskytov textov uzavretej bety**
  („testerov“, „approved testers“, „freigegebene Tester“); text registrácie „Po registrácii sa založí účet firmy…“ je v bundli,
- `release/build-release-aab.ps1`: parametre `-VersionCode` (default 4, kódy < 4 odmietne) a `-VersionName` (default 1.0.1),
  voliteľný `-PrepareWeb` (npm ci → mobile build → cap sync → prebuild check). Bez neho skript iba **overí** synchronizované
  assety (verify-mobile-bundle + zákaz textov uzavretej bety) — starý web sa nezabalí potichu.

Pozn.: sandbox nemá prístup ku Google Fonts; mobilný build použil písmo Geist z npm balíka `geist` (rovnaká rodina)
cez `NEXT_FONT_GOOGLE_MOCKED_RESPONSES`. Pri builde s `-PrepareWeb` na Windows sa použije Google Fonts ako doteraz.

## 2. Podpis a bundle (vlastník, Windows PowerShell) — heslo upload kľúča zadáva iba vlastník

```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-production-vc4\release"
powershell -ExecutionPolicy Bypass -File .\build-release-aab.ps1 -VersionCode 4 -VersionName 1.0.1
```

Výstup: `esblu-1.0.1-vc4.aab` + `esblu-1.0.1-vc4.signing.txt`. Overenie (agent):
`python3 scripts/verify-release-aab.py <aab> --expected-sha256 51:83:9A:35:D8:3F:29:96:2F:CB:B5:5C:9F:4F:B0:8A:F6:34:97:E7:48:A6:EB:02:30:DC:41:95:AC:6B:11:BA`

## 3. Interný kanál a telefón (vlastník)

1. Play Console → Test and release → Internal testing → Create new release → nahrať `esblu-1.0.1-vc4.aab`,
   release notes H2 z `release/play-submission/01-store-listing.md` → Review → **Start rollout to Internal testing**.
2. Telefón (tester v internom zozname) → odkaz na interné testovanie → aktualizovať Esblu → Nastavenia Androidu → Aplikácie →
   Esblu: verzia **1.0.1**.
3. V appke: Registrovať firmu → obrazovka registrácie **nesmie** spomínať uzavretú betu (má byť modrý text
   „Po registrácii sa založí účet firmy…“) → nový e-mail + heslo → potvrdzovací e-mail → odkaz otvoriť na telefóne →
   návrat do appky (alebo prihlásenie) → založenie firmy, VOP, DPA → odhlásiť → prihlásiť e-mailom → prihlásiť cez Google.
4. **Produkčné vydanie** (Production track) vytvoriť iba ako koncept — neodosielať na kontrolu, kým nie je bod 3 PASS.

## 4. Pripravenosť na kontrolu Google Play

- Popis SK/EN (`01-store-listing.md` C): posledný odsek už bez uzavretej bety, zodpovedá vc4 (registrácia v appke aj na webe,
  14 dní po overení IČO). Moduly v popise = moduly v appke.
- Release notes 1.0.1 (H2) zodpovedajú vc4. Google login v appke je zapnutý cez `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS=google`
  — v release notes sa preto neuvádza ako záruka; overiť na telefóne (bod 3).
- Kontrolórsky účet (produkcia, metadáta bez osobných údajov, 2026-11-17): existuje ako `info+playre…@esblu.com`
  (nie `play-review@esblu.com` z pôvodného návrhu `03-app-access-reviewer.md`), e-mail potvrdený, heslo nastavené, nie je
  zablokovaný, posledné prihlásenie 2026-11-17; owner firmy **Esblu Demo s.r.o.**; VOP 1.2 + DPA 1.3 prijaté, žiadne čakajúce
  dokumenty (žiadny blokujúci dialóg); 9 aktívnych ručných nárokov (invoicing, vehicles, machines, inventory, team_members 3,
  ai_documents 20, voice, voice_minutes 15, storage 1 GB); dáta: 2 vozidlá, 1 faktúra; **druhý člen (chat) chýba**.
  Platnosť hesla v Play Console overí iba prihlásenie — vlastník (heslo nesmie zadávať agent).

## 5. Výsledky testov (2026-11-17)

| # | Test | Prostredie | Výsledok | Dôkaz |
|---|---|---|---|---|
| S1 | Registrácia cez Auth API (signup + hook) | staging `esblu-test`, Preview `dpl_2Zthw…` | BLOKOVANÝ | GoTrue `429 email rate limit exceeded` (vstavaný mailer stagingu); `.invalid`/`example.com` adresy GoTrue odmieta |
| S2 | Potvrdzovací odkaz → vstup do Esblu | staging | PREŠIEL | syntetický účet (SQL), `/auth/callback?token_hash…&type=email` → `/onboarding/company` → „Moja firma“, `email_confirmed_at` nastavené, súhlasy VOP 1.1 + zásady 1.4 zapísané (`registration`) |
| S3 | VOP firmy 1.2 (gate) | staging | PREŠIEL | dialóg → „Zmluva uzatvorená“, záznam `legal_gate` 1.2 |
| S4 | DPA 1.3 (gate) | staging | PREŠIEL | 2 riadky `company_dpa_acceptances`, záznam v Nastaveniach |
| S5 | Pred IČO: moduly zamknuté | staging | PREŠIEL | Dashboard „Nie je súčasťou vášho balíka“ |
| S6 | Overenie IČO v registri + 14-dňový trial | staging | PREŠIEL | „Firemné údaje sú overené. Skúšobné obdobie je aktívne“, trial 17. 11. → 1. 12. 2026 |
| S7 | Syntetický partner + koncept faktúry | staging | PREŠIEL | „QA Odberateľ Demo s.r.o.“, faktúra `regular_invoice/draft/issued` |
| P1 | Registrácia e-mailom + heslom, adresa mimo tímu projektu (v appke vc4) | produkcia | PREŠIEL | 22:55:16 hook `esblu_before_user_created_beta_gate` OK → `/signup` 200 `user_confirmation_requested`; doména mimo `esblu.com`; owner novej firmy, súhlasy VOP 1.2 + zásady 1.4 (`registration`) |
| P2 | Doručenie a otvorenie potvrdzovacieho e-mailu | produkcia (custom SMTP zapnuté — potvrdil vlastník v Dashboarde) | PREŠIEL | `/verify` 200 o 13 s po odoslaní (22:55:29), `email_confirmed_at` nastavené, vlastník: „odkaz ma dostal do Esblu“ |
| P3 | Návrat z Google prihlásenia — appka aj web | produkcia | PREŠIEL | appka: `/authorize` z `com.esblu.app://auth/callback` → `/callback` 302 → `/token` pkce 200 (22:52, 22:58, 23:01, 23:04); web: `/authorize` z `www.esblu.com/auth/callback?oauth=google` → `/token` pkce 200 (23:06:24) |
| P4 | Prihlásenie heslom (existujúci používateľ / kontrolór) | produkcia | PREŠIEL | appka vc4: `/token` password 200 (23:03:39); kontrolórsky účet: password 200 dnes 11:33 a 12:03 UTC (Android) |
| A1 | Mobilný build + cap sync + kontroly bundlu | sandbox (produkčná konfigurácia) | PREŠIEL | § 1 |
| A2 | Podpísaný AAB vc4 | Windows (vlastník zadal heslo) + overenie sandbox | PREŠIEL | `esblu-1.0.1-vc4.aab` (9 237 343 B, SHA-256 `9c120a0b7c55bbba…`), verify-release-aab: com.esblu.app, vc 4, 1.0.1, min 24 / target 36, nie debug, signer = upload key `51:83:9A:…:11:BA`, 64-bit ABI, iba produkčný backend; 0 textov uzavretej bety |
| A3 | Interný kanál + telefón | Play Internal testing, telefón | PREŠIEL | rollout spustený (vlastník); po aktualizácii registrácia ukazuje „Po registrácii sa založí účet firmy…“; P1–P4 vykonané z appky |
| G1 | Popisy SK/EN a release notes vs. balík | repo | PREŠIEL | § 4, `01-store-listing.md` C + H2 |
| G2 | Kontrolórsky účet | produkcia | PREŠIEL | metadáta (§ 4) + úspešné prihlásenie heslom dnes; Play Console App access musí obsahovať `info+playreview@esblu.com` |

Doplnok (2026-11-17, druhé kolo): SMTP — vlastný SMTP v produkčnom Supabase je zapnutý (Dashboard, potvrdil vlastník;
host/odosielateľa agent nevidí — MCP nevracia konfiguráciu Auth). Pri GDPR evidencii treba poskytovateľa SMTP uviesť
medzi sprostredkovateľmi, ak tam ešte nie je (otvorená otázka Q11 z `clia-gdpr-reconciliation-2026-11-10.md`).
Vedľajšie nálezy z testu: zrušenie účtu v appke prebehlo (job 23:01:40); po teste zostal v produkcii testovací účet
vytvorený cez Google (23:04, owner novej firmy „Moja firma“) — zmazať v appke Nastavenia → Zrušiť účet, ak nie je potrebný.
Produkčné vydanie v Play Console: iba koncept (neodoslané).
