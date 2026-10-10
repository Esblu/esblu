# Google Play — Internal / Closed testing readiness (Android, 2026-10-10)

Branch `mobile-platform`. Nič nie je publikované, Production track sa nepoužíva. Zdroje: iba oficiálne Google stránky (overené 2026-10-10), odkazy pri každom bode.

## 1. Policy audit (oficiálne zdroje)

| Téma | Požiadavka | Esblu stav |
|---|---|---|
| Target API | Od **31. 8. 2026** nové appky aj updaty musia cieliť **API 36**; predĺženie možné do 1. 11. 2026 ([answer/11926878](https://support.google.com/googleplay/android-developer/answer/11926878)) | `targetSdk 36`, `compileSdk 36`, `minSdk 24` ✅ |
| Formát | Nové appky iba **AAB** ([answer/9859152](https://support.google.com/googleplay/android-developer/answer/9859152)) | `gradlew bundleRelease` ✅ |
| Play App Signing | Upload key (u teba) + app signing key (Google). Nové appky môžu dostať „quantum-ready hybrid signing" (až 3 kľúče) — do služieb treba registrovať **všetky** fingerprinty z Play Console ([answer/9842756](https://support.google.com/googleplay/android-developer/answer/9842756)) | pozri §3 |
| Internal testing | max **100** testerov (e-mail zoznam), build do minút, môže začať pred dokončením setupu, **bez Data safety** ([answer/9845334](https://support.google.com/googleplay/android-developer/answer/9845334)) | Phase 1 |
| Closed testing | e-mail zoznamy / Google Groups, vyžaduje dokončený App content | Phase 2 |
| Produkčný prístup | **Osobný** developer účet (po 13. 11. 2023): closed test s **≥ 12 testermi opt-in 14 dní nepretržite**, potom „Apply for production" ([answer/14151465](https://support.google.com/googleplay/android-developer/answer/14151465)). Organizačný účet: D-U-N-S ([answer/13628312](https://support.google.com/googleplay/android-developer/answer/13628312)) | závisí od typu účtu (user) |
| Data safety | povinné pre closed/open/production; „collected" = opustí zariadenie; „shared" = tretej strane okrem service providerov, právnych dôvodov a akcie iniciovanej používateľom ([answer/10787469](https://support.google.com/googleplay/android-developer/answer/10787469)) | §6 |
| Zrušenie účtu | in-app cesta **aj webový odkaz**, ktorý funguje bez appky; čiastočné ponechanie dát z právnych dôvodov s vysvetlením ([answer/13327111](https://support.google.com/googleplay/android-developer/answer/13327111)) | §8 |
| Privacy policy | verejná aktívna URL (nie PDF) + odkaz v appke; kontakt, typy dát, zdieľanie, retencia ([answer/10144311](https://support.google.com/googleplay/android-developer/answer/10144311)) | §9 |
| Notifikácie | Android 13+ vypnuté predvolene, žiadať v kontexte ([developer.android.com](https://developer.android.com/develop/ui/compose/notifications/notification-permission)) | žiada sa iba po kliknutí v Nastaveniach ✅ |
| Foto/video | `READ_MEDIA_IMAGES/VIDEO` iba ak nestačí systémový picker + deklarácia ([answer/16935362](https://support.google.com/googleplay/android-developer/answer/16935362)) | appka ich **nemá** (systémový výber súborov) ✅ |
| Foreground service / exact alarm | deklarácie ([answer/13392821](https://support.google.com/googleplay/android-developer/answer/13392821), [answer/9888170](https://support.google.com/googleplay/android-developer/answer/9888170)) | appka nemá FGS ani alarmy ✅ |
| Advertising ID | API 33+: `AD_ID` povolenie; SDK ho môžu zlúčiť ([answer/6048248](https://support.google.com/googleplay/android-developer/answer/6048248)) | merged manifest **bez AD_ID**, žiadne ads/analytics SDK → v Console odpoveď „nepoužíva" |
| Content rating | IARC dotazník v App content ([answer/9859655](https://support.google.com/googleplay/android-developer/answer/9859655)) | §10 |
| App access | prihlasovacie údaje pre review: opakovateľné, platné, bez 2FA, po anglicky ([answer/15748846](https://support.google.com/googleplay/android-developer/answer/15748846)) | §10 |
| Financial features | deklarácia **povinná pre všetky** appky na closed/open/prod ([answer/13849271](https://support.google.com/googleplay/android-developer/answer/13849271)); fakturácia/účtovníctvo nie je v zozname typov | návrh: „My app doesn't provide any financial features" — **potvrď ty** (fakturácia ≠ platby/pôžičky/peňaženka) |
| AI-generated content | appky generujúce obsah AI musia mať **in-app nahlásenie** urážlivého výstupu; výnimka pre produktivitu, kde AI iba zlepšuje existujúcu funkciu ([answer/13985936](https://support.google.com/googleplay/android-developer/answer/13985936)) | AI číta doklady (vždy potvrdzuje používateľ) + asistent na príkazy → pravdepodobne výnimka; bezpečnejšie je doplniť „Nahlásiť odpoveď" v asistentovi — **produktové rozhodnutie** |
| Pre-launch report | crawler na lab zariadeniach, credentials **nevie vyplniť vo WebView login** ([answer/9842757](https://support.google.com/googleplay/android-developer/answer/9842757)) | §13 |
| Device catalog | vylúčenia zariadení, neplatí pre internal ([answer/7353455](https://support.google.com/googleplay/android-developer/answer/7353455)) | netreba meniť |
| Developer verification | Play appky registruje Google automaticky ([developer.android.com/developer-verification](https://developer.android.com/developer-verification)) | n/a |

## 2. Release build / AAB

| | Stav |
|---|---|
| applicationId / namespace | `com.esblu.app` |
| versionCode / versionName | `1` / `1.0`; prepis bez úpravy súboru: `-PesbluVersionCode=N -PesbluVersionName=x.y.z` (každý upload = vyšší versionCode) |
| SDK | target/compile 36, min 24 (Android 7.0+) |
| 64-bit | žiadne vlastné natívne `.so` (Capacitor = Java/Kotlin + WebView) → bez 64-bit rizika |
| R8/ProGuard | `minifyEnabled false` (zámerne — Capacitor pluginy sa volajú reflexiou z JS; zapnutie R8 = samostatný test). Play to nevyžaduje |
| Signing | `app/keystore.properties` (mimo Gitu) → podpísaný AAB; bez neho **nepodpísaný** AAB len na lokálnu validáciu, nikdy debug kľúč |
| Firebase | `google-services.json` (projekt `esblu-c0652`) lokálne, gitignored |
| Secure storage, OAuth, push, deep links, ikony | rovnaké ako overený production beta build |

Build (Windows, Android Studio JBR):
```powershell
cd "C:\Users\roiaj\assetpilot\Claude outputs\esblu-mobile-production-beta\mobile\android"
.\gradlew.bat bundleRelease -PesbluVersionCode=1 -PesbluVersionName=1.0.0
# výsledok: app\build\outputs\bundle\release\app-release.aab
```
Pred buildom: `node scripts\android-prebuild-check.mjs --target production` musí prejsť.

## 3. Play App Signing / SHA-256

- **Upload key** = tvoj keystore (RSA 2048+, mimo Gitu, záloha!). Jeho SHA-256 je dnes v `public/.well-known/assetlinks.json` (`D0:D0:81:…:A2:FC`). Over, že máš `.jks`, z ktorého tento fingerprint pochádza: `keytool -list -v -keystore <tvoj.jks> -alias <alias>`.
- **App signing key** = Google. Po vytvorení appky a prvom uploade: Play Console → Test and release → **App integrity / Play app signing** → „App signing key certificate" (SHA-1, SHA-256; pri hybrid signing viac certifikátov).
- Store build inštalovaný z Play je podpísaný **app signing key**, nie upload key ani debug → App Links a služby viazané na podpis musia mať **Play** fingerprint(y).
- Debug build (Android Studio Run) = `%USERPROFILE%\.android\debug.keystore`: `keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android`.

## 4. Google login (release)

- Prihlásenie ide cez **Supabase-hosted OAuth** (web OAuth client v Supabase + Custom Tab + `com.esblu.app://auth/callback`). Overené na zariadení.
- **Nepotrebuje Android OAuth client ani SHA fingerprint** — Google vidí iba web klienta a redirect na `fkpgvgvsmbpieduoatrt.supabase.co`. Zmena podpisu (debug → Play) Google login **neovplyvní**.
- Checklist: (1) redirect `com.esblu.app://auth/callback` v produkčnom Supabase ✅, (2) Google provider zapnutý ✅, (3) Google OAuth consent screen v stave „In production" (inak len test users) — **over v Google Cloud Console**, (4) web login nemenený ✅.
- Samostatný Android OAuth client by bol potrebný až pri natívnom Google Sign-In SDK / Credential Manager — nepoužíva sa.

## 5. App Links (candidate, nenasadené)

Candidate `public/.well-known/assetlinks.json` po získaní Play fingerprintu (pole, poradie nehrá rolu):
```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.esblu.app",
      "sha256_cert_fingerprints": [
        "D0:D0:81:55:01:54:6E:CF:F7:91:74:57:53:DB:F6:43:92:B7:D8:DA:F6:3A:DA:A5:77:0B:E0:0A:90:F6:A2:FC",
        "<PLAY_APP_SIGNING_SHA256>"
      ]
    }
  }
]
```
- Debug fingerprint pridávaj iba dočasne pre lokálny test (nie do store verzie).
- Dnes: produkčný súbor existuje (200, `application/json`) iba s upload fingerprintom → App Links v store builde budú fungovať až po doplnení Play SHA-256 a nasadení webu (vyžaduje tvoj súhlas s deployom).

## 6. Data safety — návrh (podľa kódu)

Všetky dáta: **šifrované pri prenose** (HTTPS: `www.esblu.com`, `*.supabase.co`, Google FCM). **Používateľ môže požiadať o vymazanie: Áno** (in-app + web). Žiadne dáta sa nepredávajú, žiadna reklama/analytika.

| Play kategória → typ | Collected | Shared | Povinné? | Účel | Opora v kóde |
|---|---|---|---|---|---|
| Personal info → **Email address** | Áno | Nie | Povinné | Account management, App functionality | Supabase Auth (`app/login/page.tsx`), pozvánky |
| Personal info → **User IDs** | Áno | Nie | Povinné | Account management | `auth.users.id` |
| Personal info → **Name** | Áno (iba ak Google login: profil od Google; inak nie) | Nie | Voliteľné | Account management | Supabase identity (Google provider) |
| Personal info → **Other info** (firma: názov, IČO/DIČ/IČ DPH, adresa; kontakty obchodných partnerov: e-mail, telefón) | Áno | Nie (registrový lookup posiela iba IČO/názov **firmy** do verejných registrov RPO/RÚZ — nie osobné údaje používateľa) | Firma povinná, partneri voliteľné | App functionality | `company_billing_profile`, `business_partners`, `lib/company-lookup/*` |
| Financial info → **Other financial info** (faktúry, úhrady, IBAN/BIC firmy a partnerov) | Áno | Áno — **iba ak používateľ naskenuje doklad**: obrázok ide do OpenAI na vyťaženie údajov | Voliteľné | App functionality | `invoices*`, `app/api/scan-document` |
| Financial info → Payment info / credit card | **Nie** | — | — | — | žiadny platobný SDK |
| Photos and videos → **Photos** | Áno | Áno (OpenAI — iba fotky odoslané na AI vyťaženie) | Voliteľné | App functionality | Storage buckets, `scan-*` routes (`store:false`) |
| Files and docs → **Files and docs** | Áno | Áno (OpenAI — iba doklady na AI vyťaženie) | Voliteľné | App functionality | `documents`, `ai-*-documents`, `chat-attachments` |
| Messages → **Other in-app messages** (tímový chat) | Áno | Nie (push nesie iba generický text, náhľad je predvolene vypnutý) | Voliteľné | App functionality | `chat_messages`, `lib/push/routing.ts` |
| Audio → **Voice or sound recordings** | Áno (hlasový príkaz asistenta) | Áno (OpenAI prepis `gpt-4o-transcribe`; Esblu audio neukladá → označ **„processed ephemerally"**) | Voliteľné | App functionality | `app/api/assistant/transcribe/route.ts` |
| App activity → **Other user-generated content** (príkazy asistenta – text) | Áno | Áno (OpenAI, `store:false`, iba ak lokálny parser nestačí) | Voliteľné | App functionality | `lib/intents/ai-fallback.ts` |
| Device or other IDs → **Device or other IDs** (FCM token, installation UUID) | Áno | Áno → Google FCM je **service provider** doručenia (nepočíta sa ako „shared" — over si výklad) | Voliteľné (len po zapnutí notifikácií) | App functionality | `push_devices`, `lib/push/providers/fcm.ts` |
| Location / Contacts / Calendar / SMS / Health / Web history | **Nie** | — | — | — | grep: nenájdené |
| App info and performance (crash logs, diagnostics) | **Nie** (len serverové logy Vercel) | — | — | — | žiadne SDK |
| Advertising ID | **Nie** | — | — | — | merged manifest bez AD_ID |

Pozn.: OpenAI = spracovateľ v mene Esblu (je uvedený v `/subprocessors`) → podľa Google definície môže ísť o „service provider" (nie „shared"). Konzervatívne odporúčanie: uviesť ako **Shared** pre Photos, Files, Voice, Financial info. **Rozhodnutie je tvoje.**

**Nesúlad s verejnými textami (neopravené, len hlásim):** `/subprocessors` a privacy policy 1.3 nespomínajú Google Firebase (push), odosielanie hlasu a textu asistenta do OpenAI, ani registre RPO/RÚZ. Pred closed testom odporúčam právnu aktualizáciu (nevytváral som nové právne tvrdenia).

## 7. Permissions (manifest + merged)

| Povolenie | Zdroj | Potrebné? | Rozhodnutie |
|---|---|---|---|
| `INTERNET` | app | áno | ponechať |
| `POST_NOTIFICATIONS` | app | áno (push, žiadané v kontexte) | ponechať |
| `RECORD_AUDIO` | app | áno — hlasový asistent (WebView `getUserMedia`) | ponechať (runtime prompt pri prvom použití) |
| `MODIFY_AUDIO_SETTINGS` | app | áno — WebView audio capture to vyžaduje | ponechať |
| `ACCESS_NETWORK_STATE`, `WAKE_LOCK`, `c2dm.RECEIVE`, `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | Firebase Messaging (merge) | áno pre FCM | ponechať (normal, nie runtime) |
| CAMERA | — | nie (fotoaparát cez systémový `IMAGE_CAPTURE` intent) | nepridávať |
| READ_MEDIA_* / storage | — | nie (systémový výber súborov) | — |
| Location, Bluetooth, Contacts, Phone/SMS, exact alarm, FGS | — | nie | — |

Žiadne zbytočné povolenie na odstránenie. `allowBackup=false`.

## 8. Zrušenie účtu

- **In-app:** Nastavenia → „Zrušiť účet" (owner: celá firma, potvrdenie frázou; člen: iba identita a členstvo). Server: overenie roly z tokenu → zmazanie súborov → DB transakcia → zmazanie auth používateľa ako posledné.
- **Blokované zrušenie:** firma s finalizovanými faktúrami → 409, nič sa nezmaže, vysvetlenie + kontakt (zákonná archivácia). Žiadne čiastočné mazanie.
- **Web link (požiadavka Play):** pridaná verejná stránka **`https://www.esblu.com/zrusenie-uctu`** (SK/EN/DE, bez prihlásenia): in-app postup, rozsah mazania a archivácia (rovnaké texty ako v appke), žiadosť e-mailom na `privacy@esblu.com`. **Je iba na vetve — na produkcii zatiaľ 404**, kým neschváliš merge + deploy.
- Play Console odpoveď: Delete account URL = `https://www.esblu.com/zrusenie-uctu`; „Do you provide a way for users to request that some or all of their data is deleted, without requiring them to delete their account?" → **Nie** (iba ak sa rozhodneš inak).

## 9. Privacy / store odkazy (HTTPS, overené 2026-10-10)

| Odkaz | Stav |
|---|---|
| Privacy policy `https://www.esblu.com/ochrana-osobnych-udajov` | 200 ✅ (v appke: Nastavenia → GDPR) |
| Terms `https://www.esblu.com/podmienky-pouzivania` | 200 ✅ |
| Kontakt `https://www.esblu.com/kontakt` (info@ / privacy@esblu.com) | 200 ✅ |
| Sprostredkovatelia `https://www.esblu.com/subprocessors` | 200 ✅ |
| Zrušenie účtu `https://www.esblu.com/zrusenie-uctu` | **404 — čaká na deploy** |

## 10. Content rating / App access / reviewer

- **IARC návrh:** kategória „Utility, Productivity, Communication, or Other"; násilie/sex/vulgarizmy/drogy/hazard: **Nie**; **používatelia môžu komunikovať** (interný firemný chat) → **Áno** (iba členovia tej istej firmy, nie verejné); zdieľanie polohy: Nie; digitálne nákupy: Nie.
- **Reviewer / demo účet (nie tvoj owner účet):**
  1. Pridaj `play-review@esblu.com` (alebo iný tvoj mailbox) do `beta_allowlist` a zaregistruj ho (potvrdenie e-mailom), vytvorí sa firma, napr. „Esblu Demo s.r.o.".
  2. Naplň iba fiktívne demo dáta (2 vozidlá, 1 stroj, pár skladových položiek, 1 partner, 1 koncept faktúry). Žiadne reálne údaje.
  3. Účet bez 2FA, heslo trvalé; neodstraňovať počas review.
- **App access text (EN):** „All functionality requires sign-in. Use the e-mail/password below on the login screen (do not use Google sign-in). The account belongs to a demo company with sample data. Main areas: Overview, Inbox (document upload with AI extraction — results are always confirmed by the user), Vehicles, Machines, Inventory, Business partners, Invoices, Team chat, Settings (includes Delete account). Push notifications are optional (Settings → Notifications)."
- **Beta allowlist:** nové registrácie mimo allowlistu sú odmietnuté → reviewer musí dostať už existujúci účet.

## 11. Store listing (draft — NEPUBLIKOVANÉ)

| Pole | Limit | Návrh |
|---|---|---|
| Názov | 30 | `Esblu` |
| Kategória | — | Business (návrh) |
| Kontakt | povinné | `info@esblu.com`, web `https://www.esblu.com` |
| Privacy policy | povinné | `https://www.esblu.com/ochrana-osobnych-udajov` |

Krátky popis (≤ 80 zn.):
- SK: `Firemná evidencia a fakturácia na jednom mieste.`
- EN: `Company records and invoicing in one place.`
- DE: `Firmenverwaltung und Rechnungsstellung an einem Ort.`

Dlhý popis — iba existujúce texty z webu Esblu (landing), bez nových tvrdení. SK:
> Esblu pomáha menším stavebným, servisným, dopravným a technickým firmám spravovať dokumenty, vozidlá, stroje, sklad, obchodných partnerov a faktúry v jednej aplikácii.
> • Inbox — Odfotíte alebo nahráte dokument. Esblu pomocou AI načíta dostupné údaje. Pred uložením ich vždy skontrolujete a potvrdíte.
> • Vozidlá — Evidencia vozidiel, technických údajov, dokumentov, fotografií a servisných záznamov.
> • Stroje — Prehľad firemných strojov a techniky vrátane základných údajov, fotografií a servisných záznamov.
> • Sklad — Jednoduchá evidencia skladových položiek, množstva, minimálnych zásob, umiestnenia a fotografií.
> • Obchodní partneri — Zákazníci a dodávatelia na jednom mieste.
> • Faktúry — Vystavovanie faktúr, evidencia úhrad a opravné doklady priamo v Esblu.
> • Firemný chat — Interná komunikácia medzi členmi vašej firmy priamo v Esblu.
> Esblu je momentálne v uzavretej beta verzii. Nové účty sú dostupné len pre schválených testerov.

EN/DE: rovnaká štruktúra z `lib/i18n/dictionaries/{en,de}.ts` (`landing.hero.subtitle`, `features.*Desc`, `hero.betaNotice`).

**Chýbajúce assety (nevytvorené — chýba schválený vizuálny brief):**
- Ikona 512×512 PNG (32-bit, ≤ 1 MB) — dá sa exportovať z finálneho master icon (`mobile/icon-source/esblu-master-icon.png`, 1254 px) po tvojom súhlase.
- Feature graphic 1024×500 JPG/24-bit PNG bez alfa.
- Telefón: min. 2, odporúčané 4–8 screenshotov 1080×1920 (9:16) z demo účtu. Shot list: 1 Prehľad, 2 Inbox (nahratie dokladu → kontrola AI údajov), 3 Vozidlo detail, 4 Sklad, 5 Faktúra (koncept / PDF), 6 Firemný chat, 7 Nastavenia/notifikácie.
- Tablet: voliteľné (min. 4, 1080–7680 px) — odporúčam vynechať.

## 12. Rollout

| Fáza | Kto | Pridanie testera | Update | Rollback |
|---|---|---|---|---|
| 1 Internal | ty + interný tím (≤ 100) | Testing → Internal testing → Testers → e-mail zoznam → opt-in link | nahrať AAB s vyšším versionCode → release | „Halt"/nahrať predchádzajúci kód s **vyšším** versionCode (nedá sa vrátiť nižší) |
| 2 Closed | vybraní beta zákazníci (na beta allowliste) | e-mail zoznam / Google Group + opt-in link; pri osobnom účte ≥ 12 testerov 14 dní | promote z Internal alebo nový release | halt release, nový fix build |
| 3 Production | až po tvojom výslovnom súhlase | — | — | — |

versionCode: monotónne +1 pri každom uploade (`-PesbluVersionCode`), versionName semver; release notes SK/EN krátko („Opravy a zlepšenia: …").

## 13. Pre-launch report

- Automaticky po uploade: crawler (Robo) niekoľko minút na lab zariadeniach Android 9+: pády, ANR, výkon, prístupnosť, bezpečnostné varovania.
- **Login:** Esblu login je vo WebView → crawler podľa dokumentácie **nevie** vyplniť credentials; uvidí iba login obrazovku, verejné právne stránky a stav offline. Očakávaj „limited coverage", nie chybu.
- Neoverí: push (bez povolenia), Google login (Custom Tab), App Links/deep links (max. 3 vlastné), nákupy (žiadne nie sú), skenovanie dokladov.

## 14. Validácia (lokálne)

- tsc, lint delta, mobile testy, prebuild `--target production`, secrets scan, manifest audit — pozri report.
- **AAB build:** sandbox nemá Android SDK ani sieťový prístup ku Gradle/Google Maven → `bundleRelease` + `bundletool validate` sa musia spustiť na tvojom PC (postup §2).
