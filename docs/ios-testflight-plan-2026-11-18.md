# iOS — cesta k internému TestFlight (2026-11-18)

Nadväzuje na `docs/ios-release-readiness-2026-10-08.md`. Zdroj: `main` @ `12da726`.

## 1. Stav (overené dnes)

| Oblasť | Stav | Dôkaz |
|---|---|---|
| Capacitor iOS projekt | existuje (`mobile/ios`, Capacitor 8, SPM), bundle `com.esblu.app` (Debug + Release), `MARKETING_VERSION 1.0`, build 1, `CODE_SIGN_STYLE Automatic`, **bez `DEVELOPMENT_TEAM`** | `project.pbxproj` |
| Natívne pluginy | `EsbluAppleSignInPlugin.swift` (ASAuthorization, SHA-256 nonce → `signInWithIdToken`), `EsbluSecureStoragePlugin.swift` (Keychain) | posledná zmena iOS: `f0b4e12` |
| Entitlements | `aps-environment=development`, `com.apple.developer.applesignin`, `applinks:www.esblu.com` | `App.entitlements` |
| Kompilácia | **nikdy** (žiadny Mac ani Xcode v prostredí agenta) | — |
| Apple Developer / App Store Connect | **nič registrované** (podľa repa; prístup agenta nemám) | readiness 2026-10-08 |
| Supabase Apple provider | **neoverené** — MCP nevracia konfiguráciu Auth; produkcia má `NEXT_PUBLIC_ESBLU_OAUTH_PROVIDERS` (hodnota nečítaná), v appke sa Apple ponúkne iba ak obsahuje `apple` | Vercel env (iba názov) |
| AASA (`/.well-known/apple-app-site-association`) | iba šablóna s `__APPLE_TEAM_ID__` (fail-closed render) | `mobile/deep-link-templates/` |
| Mac | **nepotvrdený** — otázka pre vlastníka | — |

**Záver:** podmienky pre TestFlight (schválený Apple účet, podpisovanie, Mac/CI) nie sú splnené → TestFlight **nespúšťam**,
príprava v repozitári je hotová v rozsahu bez Apple účtu; nižšie sú presné chýbajúce kroky.

## 2. Chýbajúce kroky, cena a kto ich vykoná

| # | Krok | Cena | Kto |
|---|---|---|---|
| 1 | **D-U-N-S číslo** pre Esblu s.r.o. (Apple ho vyžaduje pre organizáciu; vyhľadanie/žiadosť cez Apple formulár) | 0 € (spracovanie dni až ~2 týždne) | vlastník (štatutár) |
| 2 | **Apple Developer Program — organizácia** (právna entita, D-U-N-S, oprávnenie podpisovať, e-mail na doméne esblu.com, verejný web) | **99 $ / rok** (účtované v EUR; presnú sumu ukáže Apple pri platbe) — **schválenie vlastníkom** | vlastník (Apple ID s 2FA) |
| 3 | App ID `com.esblu.app` + capabilities Sign in with Apple, Push Notifications, Associated Domains | 0 € | vlastník alebo agent s pozvaním do tímu (rola Admin/App Manager) |
| 4 | Sign in with Apple: Services ID (web), kľúč `.p8` (Key ID, Team ID) → Supabase Auth → Apple provider (client IDs: `com.esblu.app` + Services ID) | 0 € | vlastník zadá kľúč priamo v Supabase Dashboarde |
| 5 | APNs kľúč `.p8` → server env (Preview najprv) | 0 € | vlastník |
| 6 | App Store Connect: nová appka „Esblu“, bundle `com.esblu.app`, SKU, primárny jazyk SK | 0 € | vlastník |
| 7 | **Build:** (a) Mac s Xcode 16+ → Archive → Upload, alebo (b) bez Macu: **Codemagic** free 500 min/mes. (M2) s App Store Connect API kľúčom a automatickým podpisom, alebo Xcode Cloud (25 h/mes. v členstve, ale prvé nastavenie z Xcode na Macu) | (a) 0 € ak Mac existuje; (b) 0 € do 500 min, potom 0,095 $/min | vlastník (Mac) / agent pripraví `codemagic.yaml` po získaní API kľúča |
| 8 | AASA na `www.esblu.com` s Team ID (render šablóny + produkčný deploy) | 0 € | agent po Team ID + súhlas s deployom |
| 9 | Interný TestFlight: tester = člen tímu App Store Connect (bez Beta App Review) | 0 € | vlastník |

Odhad: **99 $ / rok** + 0 € build (Codemagic free tier alebo vlastný Mac). Platený build iba pri > 500 min/mes.
(1 build ≈ 10–20 min → ~25–50 buildov mesačne zadarmo).

## 3. Testovací plán (pripravený, spustiteľný po kroku 7)

| # | Test | Očakávanie | Dôkaz |
|---|---|---|---|
| A1 | Registrácia cez Apple (nový e-mail) | natívny hárok → `signInWithIdToken` → nový používateľ → onboarding firmy (VOP 1.2, DPA 1.3) | Supabase auth log `/token?grant_type=id_token` 200, `provider=apple` |
| A2 | **Skryť môj e-mail** | účet s `@privaterelay.appleid.com`; potvrdzovacie e-maily (Resend z `mail.esblu.com`) musia byť doručené cez Apple relay → v Apple Developer → Services → **Sign in with Apple for Email Communication** zaregistrovať doménu `mail.esblu.com` a odosielateľa | e-mail doručený na relay |
| A3 | Návrat z Apple prihlásenia (zrušenie hárku, zlyhanie) | `CANCELED` → ostane na login bez chyby; `APPLE_SIGN_IN_FAILED` → hlásenie, nič sa neprihlási | UI |
| A4 | **Prepojenie s existujúcim účtom** (rovnaký overený e-mail ako heslo/Google) | Supabase automatic linking iba pri overenom zhodnom e-maile → ten istý `user_id`, firma a roly zachované; pri relay e-maile **nevznikne** prepojenie → nový prázdny účet → treba manuálne prepojenie (Supabase `linkIdentity`, dnes v kóde **nie je**) | `auth.identities` 2 riadky pre 1 používateľa; `company_members` nezmenené |
| A5 | Prijatie pozvánky cez Apple | pozvánka je na e-mail; pri relay e-maile sa nezhoduje → pozvánku treba prijať e-mailom/heslom alebo po prepojení | pozvánka `accepted` |
| A6 | **Zrušenie účtu → odvolanie Apple tokenu** | Apple vyžaduje pri zrušení účtu odvolať tokeny cez `POST https://appleid.apple.com/auth/revoke`. **Dnes nie je implementované** (plugin vracia iba `identityToken`, nie `authorizationCode`; server nemá Apple client secret) | — |
| A7 | Push (APNs) foreground/background/tap | ako Android (`PushBridge` allowlist) | zariadenie |
| A8 | App Privacy | zhodné s Google Data safety (`release/play-submission/04-data-safety.md`) + Apple: Name/Email z Apple, Identifiers (push token) | App Store Connect |
| A9 | Demo prístup pre App Review | rovnaký kontrolórsky účet ako Play (heslo iba v App Store Connect → App Review Information); demo dáta podľa `03-app-access-reviewer.md` | — |

### Potrebná implementácia pred verejným iOS vydaním (nie pred interným TestFlightom)

1. **Odvolanie Apple tokenu (A6):** plugin vráti aj `authorizationCode`; server ho pri prihlásení vymení
   (`/auth/token`, client secret = JWT ES256 z `.p8`) za `refresh_token`, uloží ho šifrovane (service-only tabuľka),
   pri zrušení účtu zavolá `/auth/revoke`. Vyžaduje migráciu a secret → samostatné schválenie.
   ([Apple — offering account deletion](https://developer.apple.com/support/offering-account-deletion-in-your-app/))
2. **Manuálne prepojenie identít (A4/A5):** Nastavenia → „Prepojiť Apple“ (`supabase.auth.linkIdentity`) pre prihláseného
   používateľa, aby relay e-mail nevytvoril druhý účet bez firmy.

## 4. Predaj v iOS — StoreKit vs. ostatné varianty (rozhodnutie pred predajom)

| Variant | Pravidlo (App Review Guidelines, 16. 10. 2026) | Ekonomika (15,90 € s DPH) | Riziko |
|---|---|---|---|
| Bez nákupu v appke, prihlásenie k webovému predplatnému | 3.1.3(b) multiplatform: prístup k obsahu kúpenému na webe je povolený, **ak sú položky dostupné aj ako IAP**; 3.1.3(c) enterprise: ak sa predáva **iba organizáciám pre zamestnancov**, možno iné platby | výplata webu (~15,20 €) | Esblu predáva aj SZČO/jednotlivcom → 3.1.3(c) nemusí stačiť; App Review môže žiadať IAP |
| StoreKit IAP (Small Business Program) | 3.1.1 | ~10,99 € (15 %) | najnižšie riziko schválenia; server Apple adaptér hotový (fake), StoreKit nekompilovaný |
| EÚ: vlastný procesor v appke / odkaz von (Attachment 14 od 1. 10. 2026) | nové EÚ podmienky | provízia 10–20 % + vlastné poplatky | reporting do 15 dní, záväzok 12 mesiacov, CLIA |

Odporúčanie: interný TestFlight **bez nákupu**; o predaji v iOS rozhodnúť až po CLIA a podľa výsledku App Review prvej verzie
(predložiť ako „companion“ s prihlásením a vysvetlením B2B modelu v poznámke pre review).
[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
