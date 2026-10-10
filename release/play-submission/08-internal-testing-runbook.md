# 08 — Internal Testing runbook (prvý upload) — NEVYKONANÉ

Predpoklad: Google dokončil overenie organizácie a telefónu. Názvy menu podľa aktuálnej Play Console; ak sa líšia, cieľ kroku ostáva rovnaký.

## 1. Vytvorenie appky
Play Console → **Home → Create app**: App name `Esblu` · Default language `Slovak – sk-SK` · **App** · **Free** · potvrdiť Developer Program Policies a US export laws → **Create app**.

## 2. Očakávania balíka
`com.esblu.app` (po prvom uploade nemenné navždy) · versionCode **1** · versionName **1.0.0** · minSdk 24 · targetSdk 36.

## 3. Play App Signing
Pri prvom release Console ponúkne Play App Signing → ponechať **Google-generated app signing key** (default). Tvoj `esblu-upload-key-2026.jks` je **upload key**. Neexportovať/neuploadovať vlastný app signing key.

## 4. Upload
**Test and release → Testing → Internal testing → Create new release** → nahrať `release\esblu-1.0.0-vc1.aab` (8.7 MB).

## 5. Overenie verzie
Po spracovaní v detaile bundle: `com.esblu.app`, version code 1, version name 1.0.0, API 24+, target 36. Ak niečo nesedí — **Discard release**, nič nepublikovať.

## 6. Warnings/errors
| Hlásenie | Význam | Akcia |
|---|---|---|
| „No deobfuscation file" (R8 vypnutý) | iba info | ignorovať |
| „Native debug symbols" | iba info | ignorovať |
| Advertising ID otázka | appka AD_ID nemá | App content → Advertising ID → „No" |
| Data safety / content rating / app access incomplete | pre internal testing **nie sú blockery**; pre Closed áno | vyplniť podľa 03/04/05 |
| Chyba podpisu / package name | stop | neposielať nič, kontaktovať mňa |
| Version code already used | stop | nový build s `-PesbluVersionCode=2` |

## 7. Testeri
Internal testing → **Testers** → Create email list „Esblu internal" → e-maily interných testerov (Google účty) → Save. Max 100.

## 8. Reviewer/app access
Pre internal testing nie je povinné; App access (03) vyplniť pred Closed.

## 9. Install link
Release notes (01-H) → **Save → Review release → Start rollout to Internal testing**. Testers → **Copy link** (opt-in) → poslať testerom → „Accept invite" → „Download it on Google Play".

## 10–15. Test z Play-nainštalovanej appky
Pred inštaláciou odinštalovať debug/beta build (iný podpis → update by zlyhal).
| # | Test | Očakávanie |
|---|---|---|
| 10 | Inštalácia z Play | appka sa spustí, prihlasovacia obrazovka |
| 11 | Google login | Custom Tab → návrat do appky → dashboard (nezávisí od podpisu) |
| 11b | E-mail login | dashboard, správna firma |
| 12 | Push: Nastavenia → Notifikácie → Zapnúť | povolenie, zariadenie registrované; chat správa od kolegu → notifikácia |
| 13 | Deep/App links (`https://www.esblu.com/reset-hesla` z e-mailu) | **zatiaľ otvorí prehliadač** (App Links nie sú overené, kým `assetlinks.json` nemá Play fingerprint) — očakávané |
| 14 | Zrušenie účtu | iba na testovacom účte; overiť 409 ochranu pri firme s finalizovanou faktúrou |
| 15 | Update: zvýšiť versionCode (2), nahrať, aktualizovať z Play | dáta/session ostanú |

## 16. Play App Signing SHA-256
**Test and release → App integrity → Play app signing → App signing key certificate** → SHA-256 (a SHA-1). Ak je uvedených viac certifikátov (hybrid signing), skopírovať **všetky**. Poslať mi iba tieto verejné fingerprinty.

## 17. assetlinks.json
Do candidate (`docs/android-release-aab-2026-10-10.md`) doplním Play SHA-256 vedľa upload key `51:83:9A:…:6B:11:BA`; legacy `D0:D0:81…` sa odstráni. Production deploy **iba po explicitnom súhlase**.

### Upload key ≠ Play App Signing key
- **Upload key** (`51:83:9A…`) podpisuje iba súbor, ktorý nahrávaš do Play.
- **App signing key** (Google) podpisuje APK, ktoré si používatelia inštalujú z Play. App Links overuje Android voči podpisu **nainštalovanej** appky → do `assetlinks.json` patrí **Play App Signing SHA-256** (upload key iba pre lokálne/sideload testy).
- Google login (Supabase web OAuth) ani FCM fingerprint nepotrebujú.

## 18. Čo NESMIE ísť do Closed/Production bez legal gate
Closed testing, Open testing, Production, **Promote release** z internal, zverejnenie store listingu, odoslanie Data safety/Content rating na review pre verejné tracky — až po CLIA/GDPR/VOP a explicitnom súhlase (09).
