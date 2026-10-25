# Esblu — MASTER PRE-LAUNCH CHECKLIST

Kanonický zoznam všetkého, čo musí byť hotové pred verejným spustením. Aktualizovať pri každom bloku.
Posledná aktualizácia: **2026-10-26** (branch `preprod-release-candidate` — **J7 BUSINESS RULE CORRECTIONS** + PRICING + ENTITLEMENTS ARCHITECTURE, sekcia **J7**; predtým COST CONTROL HARDENING, sekcia **J6**; predtým CHECKLIST RECONCILIATION na RC `c3a8650`, sekcie **M–P**;
predtým PRE-LAUNCH TECHNICAL BLOCKERS: PASS, sekcia **J5**; GRANULAR TEAM PERMISSIONS: PASS, sekcia **J4**).

Statusy: **PASS** · **READY** (pripravené, čaká na vykonanie/súhlas) · **BLOCKED LEGAL** (CLIA) · **BLOCKED EXTERNAL** ·
**TODO** · **NOT YET RUN** · **PENDING APPROVAL** · **PENDING DECISION** · **ALREADY DONE** (predtým vedené ako otvorené).

Blocker štítky (kto blokuje ďalší krok): `OWNER DECISION` · `CLIA` · `ACCOUNTANT` · `GOOGLE PLAY` · `APPLE` ·
`PRODUCTION APPROVAL` · `EXTERNAL PROVIDER` · `FINAL QA`.

> **Reconciliation 2026-10-22:** statusy boli porovnané s históriou RC (`c3a8650`), dokumentáciou v `docs/` a
> `release/play-submission/` a s potvrdeniami vlastníka. Stav Google Play Console nie je v Gite — položky F označené
> „potvrdené vlastníkom“ vychádzajú z jeho potvrdenia z 2026-10-22 (Claude do Play Console nezasahoval ani ho nemenil).
> Súhrn zmien a TOP blockery: sekcie **M–P** na konci.

## ⛔ PRODUCTION HARD STOPS — vyžadujú VÝSLOVNÝ súhlas majiteľa

| akcia | status |
|---|---|
| produkčná DB migrácia / zápis | ⛔ čaká na súhlas |
| produkčný deploy | ⛔ čaká na súhlas |
| produkčné secrets (Vercel env) | ⛔ čaká na súhlas |
| merge do `main` (ovplyvňuje produkciu) | ⛔ čaká na súhlas |
| live e-Faktúra (provider live kľúč, webhook, `ESBLU_EINVOICE_LIVE_ENABLED`) | ⛔ čaká na súhlas |
| Stripe live | ⛔ čaká na súhlas |
| Google Play / Apple live billing, produkty v obchodoch | ⛔ čaká na súhlas |
| reviewer / demo účet v produkcii | ⛔ čaká na súhlas |
| produkčné `assetlinks.json` | ⛔ čaká na súhlas |
| platené aktivácie / zmluvy | ⛔ čaká na súhlas |

## A. CODE / RC

| položka | status | poznámka |
|---|---|---|
| multi-company (N firiem, 1 owner, odchod ≠ zrušenie) | PASS | PGlite + staging QA |
| owner-only billing | PASS | 5 rolí + cross-company na stagingu |
| per-device / per-session aktívna firma | PASS | staging: súbežné sessions izolované |
| trial per overený právny subjekt (IČO) | PASS | vrátane skutočného paralelného race na stagingu |
| account deletion (DB najprv, Storage po commite, guard predplatného) | PASS | staging: guard + cleanup job |
| eInvoice integrácia do RC | PASS | merge `einvoice-port` → RC (audit §12); 94/94 test sád, tsc, lint baseline, buildy |
| eInvoice ↔ zrušenie firmy (reconciliation guard) | PASS (kód + PGlite + staging) | `20261013100000` na stagingu; A–E overené (audit §13); retencia / deaktivácia u providera BLOCKED LEGAL |
| eInvoice E2E harness (owner C/D) | PASS (invariant) | staging: všetky firmy presne 1 owner = owner_id; seed sa znova nespúšťal (dáta už spĺňajú) |
| voice | PASS | RC sady; staging: návrh viazaný na firmu |
| push | PASS (kód) | real-device NOT YET RUN |
| chat | PASS | staging izolácia per session |
| files / signed URL | PASS (DB politiky + reálne HTTP) | media baseline = produkcia; role/odchod/cross-tenant/anon; staging HTTP smoke `scripts/storage-signed-url-http-smoke.ts` **25 ok / 0 fail** (vlastník, Windows, 2026-10-22) — sekcia J5 |
| dashboard (nový) | READY | v RC; produkčný merge TODO |
| auth (email, Google, session restore) | PASS (RC) | real-device NOT YET RUN |
| web build / mobile static export | PASS (po integrácii) | offline font mock v sandboxe; `verify-mobile-bundle` PASS |

## B. STAGING (`esblu-test` `cjbdijbbcujvmrzezusd`)

| položka | status |
|---|---|
| multi-company migrácie 120000–160000 | PASS |
| push session migrácia `20261001130000` | PASS (aplikovaná idempotentne, fingerprint bez zmeny = prod) |
| media migrácie `20261005090000`, `20261005091000` | PASS (aplikované po jednej; funkcie/triggre/storage politiky/buckety = produkcia) |
| eInvoice ↔ multi-company DB scoping | PASS (DB, rollback) |
| eInvoice migrácie + `20261013100000` na stagingu | PASS (eInvoice cez 100011 už v histórii — nespúšťané znova; 20261013100000 aplikovaná) |
| eInvoice multi-company / roly / RLS na stagingu (reálny Postgres) | PASS (SZČO 2 sessions, 5 rolí, cudzí owner; audit §13) |
| eInvoice finálny staging QA (sandbox provider HTTP E2E) | PASS (2026-10-14, RC `48456f1`, eFaktura.sk sandbox × `esblu-test`; audit §14) |
| subscriptions staging QA (fake/test provider) | ALREADY DONE — `docs/subscriptions-production-readiness-2026-10-11.md` §15 (migrácie, RBAC, 10-backend concurrency, reconciliation, entitlement E2E); po integrácii owner-only billing PASS (A). E2E so skutočnými store produktmi patrí do **K** (`FINAL QA`) |
| finálny staging schema fingerprint | PASS (pred/po v audite §13; dáta bez zmeny) |

## C. LEGAL / CLIA

CLIA očakáva prvé drafty v **prvej polovici novembra 2026** (ak nepríde ďalšia zásadná zmena scope). Claude nerobí právne
rozhodnutia — všetko nižšie ostáva `CLIA`, kým nepríde schválený text / stanovisko.

| položka | status | blocker |
|---|---|---|
| privacy policy (finálna) | BLOCKED LEGAL | `CLIA` |
| zoznam subprocesorov | BLOCKED LEGAL | `CLIA` |
| OpenAI (DPA, prenos) | BLOCKED LEGAL | `CLIA` |
| Firebase / FCM | BLOCKED LEGAL | `CLIA` |
| Stripe | BLOCKED LEGAL | `CLIA` |
| Google Play (zmluvná rola, billing) | BLOCKED LEGAL | `CLIA` |
| Apple (zmluvná rola, billing) | BLOCKED LEGAL | `CLIA` |
| e-Faktúra provider — zmluva, DPA, **rola providera** (sprostredkovateľ vs. samostatný prevádzkovateľ) | BLOCKED LEGAL | `CLIA` · `EXTERNAL PROVIDER` |
| retencia (účtovné záznamy, e-faktúry, XML, archív) | BLOCKED LEGAL | `CLIA` · `ACCOUNTANT` |
| texty zrušenia účtu / odchodu z firmy (account deletion wording) | BLOCKED LEGAL | `CLIA` |
| nevyčerpané predplatné / refund wording pri zrušení | BLOCKED LEGAL | `CLIA` |
| retencia hashovaných trial claimov | BLOCKED LEGAL | `CLIA` |
| obchodné podmienky predplatného | BLOCKED LEGAL | `CLIA` |
| refund policy | BLOCKED LEGAL | `CLIA` |
| merchant-of-record rozhodnutia | BLOCKED LEGAL | `CLIA` |
| B2B/B2C DPH / OSS | BLOCKED LEGAL | `CLIA` · `ACCOUNTANT` |
| finančné roly (účtovník / finance view — rozsah prístupu) | BLOCKED LEGAL | `CLIA` |
| autor účtovných záznamov pri zrušení loginu (former-user attribution / história, pseudonymizácia) | BLOCKED LEGAL | `CLIA` |
| Data Safety odpovede (Play) | BLOCKED LEGAL | `CLIA` → `GOOGLE PLAY` |
| App Privacy (Apple) | BLOCKED LEGAL | `CLIA` → `APPLE` |
| CLIA delta: granular internal role permissions (J4) — iba informatívne | READY (na odovzdanie) | `CLIA` |

## D. ACCOUNTING — ACCOUNTING DECISION REQUIRED

Technicky sa nerozhoduje — kód ostáva pri aktuálnom správaní, kým účtovník/CLIA nerozhodne.

| položka | status | blocker |
|---|---|---|
| ne-ECB kurzy (FX) | BLOCKED EXTERNAL / ACCOUNTANT-CLIA DECISION | `ACCOUNTANT` |
| dátum prijatej zahraničnej faktúry | BLOCKED EXTERNAL / ACCOUNTANT-CLIA DECISION | `ACCOUNTANT` |
| oprava DPH pri vrátenej zdanenej zálohe / bonuse | BLOCKED EXTERNAL / ACCOUNTANT-CLIA DECISION | `ACCOUNTANT` |
| úloha e-Faktúry v archivácii / retencii (archív vs. kópia) | BLOCKED EXTERNAL / ACCOUNTANT-CLIA DECISION | `ACCOUNTANT` · `CLIA` |

## E. BILLING / SUBSCRIPTIONS

Technická pripravenosť ≠ business rozhodnutie. Architektúra je READY; ceny, balíky a store produkty ostávajú otvorené.

| položka | status | blocker |
|---|---|---|
| owner-only billing model | PASS | — (A; staging 5 rolí + cross-company) |
| billing architektúra (platforma, entitlementy, lifecycle, reconciliation) | READY | — (`docs/subscriptions-production-readiness-2026-10-11.md`; staging §15) |
| rozhodnutie o cenách | DECIDED — Komplet 15,90 € (J7) | — |
| cena per firma | DECIDED — 15,90 € / firma / mesiac, bez textu „+ DPH“ (J7) | — |
| multi-company zľava / balík | DECIDED — ďalšia firma 12,90 € s vlastnými limitmi (J7) | — |
| e-Faktúra free / platený addon / v pláne | DECIDED (architektúra) — 20 tx v Komplete, +40 / 4,90 €, +100 / 9,90 €, modul 3,90 € placeholder; live ⛔ BLOCKED (J7) | `EXTERNAL PROVIDER` · `CLIA` · `OWNER DECISION` |
| Stripe test integrácia | READY (fake/test v kóde) | — |
| Google Play subscription produkty / base plany | TODO (Play app už existuje — čaká na ceny) | `OWNER DECISION` → `GOOGLE PLAY` |
| license testers | TODO (už nie je blokované účtom) | `GOOGLE PLAY` |
| Play service account (minimálne práva) | TODO (už nie je blokované účtom) | `GOOGLE PLAY` · `PRODUCTION APPROVAL` (secret) |
| RTDN (Pub/Sub) | TODO (už nie je blokované účtom) | `GOOGLE PLAY` · `PRODUCTION APPROVAL` |
| Apple IAP produkty | BLOCKED EXTERNAL (App Store Connect nie je nastavený) | `APPLE` · `OWNER DECISION` |
| Mac StoreKit compile | NOT YET RUN | `APPLE` |
| live Stripe aktivácia | ⛔ PENDING APPROVAL | `OWNER DECISION` · `PRODUCTION APPROVAL` |
| store billing aktivácia (Play / Apple) | ⛔ PENDING APPROVAL | `OWNER DECISION` · `PRODUCTION APPROVAL` |
| COST / UNIT ECONOMICS AUDIT | PARTIAL — `docs/esblu-unit-economics-2026-10-22.md` (model + `scripts/unit-economics-model.py`); čaká na potvrdenie AI tokenov, eFaktúra cenníka a dev overheadu | `OWNER DECISION` · `EXTERNAL PROVIDER` |
| Pricing (cena, limity, add-ony, ďalšia firma) | DECIDED (OWNER DECISION 2026-10-25) — Esblu Komplet 15,90 €, modul 3,90 €, ďalšia firma 12,90 € — sekcia J7; live billing ⛔ PENDING | `OWNER DECISION` (zverejnenie) · `PRODUCTION APPROVAL` |

## F. GOOGLE PLAY

Stav podľa potvrdenia vlastníka (2026-10-22). Žiadne nové store zmeny neboli v rámci reconciliation vykonané.

| položka | status | blocker / poznámka |
|---|---|---|
| organizačný developer účet overený | ALREADY DONE (PASS) | potvrdené vlastníkom 2026-10-22 (pôvodne „BLOCKED EXTERNAL“) |
| app vytvorená (`com.esblu.app`) | ALREADY DONE (PASS) | potvrdené vlastníkom 2026-10-22 (pôvodne „BLOCKED EXTERNAL“) |
| ads declaration | ALREADY DONE (PASS) — **No** | merged manifest bez `AD_ID`, žiadne ads SDK |
| content rating (IARC) | ALREADY DONE (PASS) — **PEGI 3** | |
| kategória | ALREADY DONE (PASS) — **Business** | |
| základný app setup (názov, jazyk, free app) | ALREADY DONE (PASS) | |
| target audience 18+ | PENDING DECISION (finálne potvrdenie 18+) | `OWNER DECISION` |
| financial features | TODO (návrh „no financial features“, `release/play-submission/05`) | `OWNER DECISION` |
| health / government deklarácie | TODO (očakávané „nie“) | `OWNER DECISION` |
| privacy policy URL | READY (URL existuje, 200) / finálny text BLOCKED LEGAL | `CLIA` |
| Data Safety | BLOCKED LEGAL (draft `release/play-submission/04`) | `CLIA` → `GOOGLE PLAY` |
| reviewer / demo účet | TODO — nevytvorený; zápis do produkcie ⛔ PENDING APPROVAL | `PRODUCTION APPROVAL` |
| store listing SK/EN, ikona 512, feature graphic | READY (draft v `release/play-submission/`) | `OWNER DECISION` (schválenie textov / variantu grafiky) |
| screenshoty | TODO (capture z demo účtu po finálnom AAB) | `FINAL QA` |
| Internal Testing / finálny store release flow | NOT YET RUN / neuzavretý | `GOOGLE PLAY` · `FINAL QA` |
| Play App Signing + App Signing SHA-256 | TODO (aktivuje sa / potvrdí pri prvom uploade AAB) | `GOOGLE PLAY` |
| assetlinks produkčná aktualizácia (Play SHA-256) | ⛔ PENDING APPROVAL (po Play App Signing) | `GOOGLE PLAY` · `PRODUCTION APPROVAL` |
| closed / production rollout | NOT YET RUN | `PRODUCTION APPROVAL` |

## G. APPLE

Nič z Apple nie je hotové — nič sa neoznačuje PASS.

| položka | status | blocker |
|---|---|---|
| App Store Connect setup | BLOCKED EXTERNAL | `APPLE` |
| privacy disclosures (App Privacy) | BLOCKED LEGAL | `CLIA` → `APPLE` |
| IAP produkty | BLOCKED EXTERNAL | `APPLE` · `OWNER DECISION` (ceny) |
| StoreKit compile / test | NOT YET RUN | `APPLE` |
| screenshoty / listing | TODO | `APPLE` |
| review účet | TODO; ⛔ PENDING APPROVAL (zápis do produkcie) | `PRODUCTION APPROVAL` |
| TestFlight | NOT YET RUN | `APPLE` |
| production rollout | NOT YET RUN | `PRODUCTION APPROVAL` |

## H. WEB

| položka | status | blocker |
|---|---|---|
| nový dashboard — produkčný merge / deploy | ⛔ PENDING APPROVAL (READY v RC) | `PRODUCTION APPROVAL` |
| `/zrusenie-uctu` v produkcii | READY (RC) — live až po deploy | `PRODUCTION APPROVAL` |
| privacy / legal stránky (finálne texty) | BLOCKED LEGAL | `CLIA` |
| billing web (Stripe) | READY (test) / ⛔ live | `OWNER DECISION` · `PRODUCTION APPROVAL` |
| Vercel plán podporuje minútové crony (e-Faktúra) | ALREADY DONE (PASS) — **VERCEL 1-MINUTE CRON: SUPPORTED** (J5; Pro plán) | — |
| produkčný monitoring | TODO (nie launch blocker — vedomé rozhodnutie v `docs/data-breach-procedure.md`; v rollout kroku L13) | `OWNER DECISION` |

## I. ANDROID

| položka | status | blocker |
|---|---|---|
| finálny release AAB (z finálneho RC) | NOT YET RUN (`vc1` z 2026-10-10 je zastaraný — nie je finálny release build) | `FINAL QA` (po C/E/F) |
| upload key signing | READY (upload key mimo repa, `scripts/verify-release-aab.py` PASS; `docs/android-release-aab-2026-10-10.md`) | — |
| Play App Signing | TODO (pri prvom uploade) | `GOOGLE PLAY` |
| billing ON/OFF matica | PASS (debug, RC kit) | — |
| manifest / permissions / targetSdk | PASS (RC audit) | — |
| secret scan produkčného bundlu | NOT YET RUN (finálny) | `FINAL QA` |
| reálny test inštalácie z Play | NOT YET RUN | `FINAL QA` |

## J. SECURITY

| položka | status |
|---|---|
| RLS / tenant izolácia (multi-company) | PASS (PGlite + staging) |
| eInvoice RLS (SELECT iba aktívna firma + finance) | PASS (staging DB) |
| secrets (žiadne v repe, server-only) | PASS (scan) |
| signed URL / media model | PASS (staging DB politiky = produkcia; reálny HTTP smoke 25/0 — J5) |
| poradie zrušenia účtu (DB → Storage → auth) | PASS |
| logovanie / PII (webhook payloady) | TODO (audit pri integrácii live providerov; billing token redakcia už PASS — subscriptions §15.6) |
| zálohy | PASS — scheduled physical daily backups ACTIVE (overené vlastníkom v Dashboarde, najnovší 22 Oct 2026 02:38:07 UTC); PITR DISABLED / OPTIONAL ADD-ON (nie blocker); pred oknom znova potvrdiť čerstvý úspešný backup (J5) |
| rollback plány | READY — per skupina v `docs/production-migration-runbook-2026-10-22.md` §G (vrátane „podmienečne“ / „STAGING ONLY“ výhrad) |
| observability | TODO (spolu s produkčným monitoringom, H; nie launch blocker) |
| Preview `OPENAI_API_KEY` Vercel warning „Needs Attention“ (`readable-secret`) | EXPECTED — Preview hodnota = nefunkčný sentinel `preview-disabled` (overené 2026-10-22 bez výpisu hodnoty), OpenAI v Preview zámerne vypnuté; Production `OPENAI_API_KEY` = samostatný Sensitive secret, len production target, nedotknutý; no action required before launch |
| Preview AI fail-closed (voice, assistant, AI dokumenty) | PASS — všetky OpenAI routes vracajú 503 `AI_UNAVAILABLE` pred kvótou / nahratím / volaním OpenAI (`test:ai-preview-disabled`); scan routes doplnené 2026-10-22 |

## J2. SUPABASE 2026-10-30 DATA API GRANTS CHANGE

Od 30. 10. 2026 Supabase neudeľuje novým objektom v `public` Data API grants automaticky. Detail, inventár
92 tabuliek, matica a rollout plán: `docs/supabase-explicit-grants-audit-2026-10-21.md`; pravidlo: `supabase/GRANTS.md`.

| položka | status | poznámka |
|---|---|---|
| repo audit (92 tabuliek, A–E, staging + produkcia read-only) | PASS | 24 tabuliek appky a 57 service_role tabuliek záviselo od auto-grantov |
| explicit grants repo (`20261021100000` + manifest) | PASS | least privilege; odobraté iba práva, ktoré RLS zamietala / appka nepoužíva |
| fresh replay od nuly bez auto-grantov | PASS | `test:grants-replay-db` 42/42 (baseline + reconciliation + cleanup); 2 zdokumentované presuny poradia |
| statický guard pre budúce migrácie | PASS | `test:grants-guard` 10/10 (vrátane: politika bez `TO` / `TO public`) |
| staging validation (`cjbdijbbcujvmrzezusd`) | PASS | ACL a politiky == replay (md5); rolová matica, tenant, billing owner-only, eInvoice, trial, deletion, media, push, locale; PostgREST anon HTTP; advisors bez zmeny |
| settings.locale bug (tichý `42501`) | PASS | `20261022100000`: `grant update (locale)` iba tento stĺpec; LocaleProvider loguje `error`; regresné testy |
| policy hygiene (27 politík `TO public` → `TO authenticated`) | PASS | podmienky bez zmeny (qual md5 =); v public schéme 0 `TO public`; legal_documents `{anon,authenticated}` nedotknuté |
| **production migration** | ⛔ PENDING APPROVAL | poradie: audit grants §7; **produkcia nie je PASS, kým nie sú obe migrácie produkčne aplikované a overené** |

## J3. PRODUCT / POSITIONING / ONBOARDING (2026-10-22)

**PRODUCT RC FINALIZATION: PASS** (2026-10-22). Neoznačuje final real-device smoke, final AAB, Google review, CLIA ani production rollout — tie ostávajú v sekciách C, F, K, L.

Detail: `docs/product-positioning-audit-2026-10-22.md`. Bez nového providera, dátového modelu, trackingu ani zmeny oprávnení — **GDPR IMPACT: NONE** pre všetky zmeny.

| položka | status | poznámka |
|---|---|---|
| positioning clarity | PASS | landing: „Firma pod kontrolou.“ + „Faktúry, autá, stroje, sklad, dokumenty a termíny na jednom mieste.“; persona 2–15 ľudí; „namiesto Excelu, WhatsAppu a fakturačky“; eFaktúra ostáva „pripravujeme“ |
| dashboard „Dnes“ | PASS | `lib/dashboard/today.ts` + `TodayPanel`: Urgentné / Dnes / Čoskoro / Info, každá položka s akciou; faktúry, prijaté/eFaktúry na kontrolu, STK/EK/známky/servis, sklad, Inbox, chat, koniec trialu (iba vlastník); `test:dashboard-today` 16/16 |
| onboarding | PASS | „Prvé kroky“ (firma → firemné údaje → prvý záznam → pozvať kolegu/účtovníka, voliteľné) odvodené z existujúcich dát; skrytie iba lokálne na zariadení; žiadne falošné dáta; krok „pozvať“ sa skryje, keď nárok `team_members` nedovolí ďalšieho používateľa (`55a5fe4`) |
| empty states | PASS | vozidlá, stroje, sklad, faktúry, partneri, priečinky: čo modul robí + prvý krok; filter ≠ prvé spustenie |
| role-aware UX | PASS | finančné položky iba s finance view, prevádzka iba owner/admin/employee, billing/aktivácia iba vlastník; asistent-tipy iba overené intenty povolené role (zamestnanec žiadne) |
| multi-company clarity | PASS | prepínač firmy v desktop sidebari aj mobilnom webovom menu (natívna appka: „Viac“); „Dnes“ = iba aktívna firma (`company_id` z membershipu + RLS); po prepnutí hard reload |
| mobile/web consistency | PASS | rovnaký obsah „Dnes“: mobil kompaktne nad valcom (2 položky + „Zobraziť všetko“), desktop bočný panel; navigácia „Dnes“ v oboch |
| pricing UX (per firma, billing iba vlastník) | PASS | cenník: „Predplatné je za firmu, nie za prihlásenie… spravuje iba vlastník“; ne-vlastník nevidí výzvu na aktiváciu; cena / multi-company bundle / eFaktúra free-paid = **TBD** |
| reálny device smoke | NOT YET RUN | patrí do **K** (až po CLIA/legal, billing/store, finálnom AAB) |
| Turbopack web build (štandardný `next build`) | PASS | Vercel Preview pre presné SHA `a1d979d`, `fa4c800`, `55a5fe4`: `▲ Next.js 16.3.8 (Turbopack)`, TypeScript OK, 59/59 stránok, READY; v sandboxe blokuje proxy `fonts.googleapis.com` (403) |
| mobile Turbopack build + `verify:mobile-bundle` | PASS | overené vlastníkom na Windows hoste (štandardný `npm run build -w mobile` → `npm run verify:mobile-bundle`), 2026-10-22 |
| `test:invoicing-flow` / PGlite testy po čistom `npm ci` | PASS | `@electric-sql/pglite@0.5.8` ako exact devDependency (`fa4c800`); predtým iba `npm i --no-save` |
| staging UX click-through — bez prihlásenia (landing desktop + 375 px, cenník, metadata) | PASS | Preview → staging Supabase `cjbdijbbcujvmrzezusd`; bez horizontálneho pretečenia; eFaktúra „pripravujeme“; cenník „za firmu, spravuje iba vlastník“ |
| staging UX click-through — prihlásené roly (owner prázdny / s dátami / 2 firmy, employee, accountant) | PASS | manuálne overené vlastníkom na Preview × staging `cjbdijbbcujvmrzezusd` (2026-10-22): owner takmer prázdna firma + onboarding CTA, owner s dátami (QA UX Firma A) — Urgentné/Dnes/Čoskoro/Info + CTA z urgentnej položky, owner QA UX Firma B, multi-company prepnutie a izolácia dát, employee, accountant, mobile-width, /faktury desktop po oprave (`340a7c2`). QA fixtures (QA UX Firma A/B, `qa-ux-*@esblu-qa.invalid`) **ostávajú na stagingu**; cleanup skript pripravený, spustí sa iba po výslovnom pokyne (vyžaduje súhlas s dočasným vypnutím triggerov pre syntetické finalizované faktúry). |

## J4. TEAM GRANULAR PERMISSIONS (2026-10-23)

**GRANULAR TEAM PERMISSIONS: PASS** (2026-10-23, RC `66c4db2`). Production rollout ostáva **NOT YET RUN / PENDING APPROVAL**. QA UX fixtures ostávajú na stagingu (cleanup iba po výslovnom pokyne).

Detail: `docs/team-granular-permissions-2026-10-23.md`. Migrácia `20261023100000_team_granular_permissions` (+ rollback).
**GDPR IMPACT: NONE / ACCESS-CONTROL HARDENING** (rovnaké firemné dáta, rovnakí interní členovia, žiadny provider, typ údajov, účel ani retencia; informatívne do CLIA delta: „granular internal role permissions added“).

| položka | status | poznámka |
|---|---|---|
| permission model | PASS | register `esblu_permission_registry()` + TS zrkadlo (parita testovaná); tabuľka viazaná na `company_members.id`; neznáme = deny |
| DB/RLS enforcement | PASS | insert/update vozidiel, známok, strojov, servisu strojov, fotiek strojov/skladu, skladu cez `esblu_my_has_permission`; trigger „iba množstvo“; storage upload fotiek |
| owner management | PASS | `esblu_set_member_permissions` — iba aktívny zamestnanec tej istej firmy, nikdy sám sebe; audit `company_member_permission_events` |
| admin management | PASS | iba delegovateľné prevádzkové (`admin_may_grant`); nie owner/admin/účtovník; billing/vlastníctvo/zrušenie firmy nie sú v registri |
| employee UI | PASS | Nastavenia → člen → Oprávnenia (skupiny, vety, predvoľby); CTA v Strojoch/Sklade/Vozidlách podľa oprávnení; mazanie owner/admin |
| multi-company isolation | PASS | oprávnenie v A neplatí v B (PGlite F + staging) |
| self-escalation guard | PASS | RPC, priamy zápis (42501 privilege), zmena roly, admin sám sebe, účtovník — DENY |
| grants / fresh replay | PASS | trieda C, `anon` 0; manifest; `test:grants-guard` 10/10; `test:grants-replay-db` 43/43 vrátane idempotencie a rollback → re-apply |
| staging validation | PASS | `cjbdijbbcujvmrzezusd`: aplikované; funkcie/politiky/ACL md5 == replay; matica s QA UX fixtures v rollbacknutej transakcii; advisors bez nového nálezu mimo očakávaných (RPC-only tabuľky, authenticated RPC) |
| manual UX validation (owner/admin → zamestnanec) | PASS | overené vlastníkom na Preview `66c4db2` (READY) × staging: owner otvoril oprávnenia QA zamestnanca, grant „Môže pridávať stroje“ → po refreshi „Pridať stroj“ + vytvorenie stroja, revoke → tlačidlo zmizlo; skladové oprávnenie podľa očakávania; owner/admin editor funkčný |
| mobile Turbopack build | PASS | Windows host, presné RC `66c4db2`: `npm run build -w mobile` — Next.js 16.3.8 (Turbopack), TypeScript PASS, 34/34 statických stránok |
| verify:mobile-bundle | PASS | Windows host, `66c4db2`: všetky kontroly bundlu PASS (73 chunkov, 7,2 MB) |
| finance/doklady/partneri pre zamestnanca | NOT IN V1 | finančný model (`permissions.finance`, účtovník) bez zmeny |
| **production rollout** | ⛔ NOT YET RUN / PENDING APPROVAL | poradie: hneď za `20261022100000` (sekcia L) |

## J5. PRE-LAUNCH TECHNICAL BLOCKERS (2026-10-22)

**PRE-LAUNCH TECHNICAL BLOCKERS: PASS** (2026-10-22; audit na RC `f06abe9`, finálne doplnky `9da058c`+). Detail: `docs/production-migration-runbook-2026-10-22.md`.
Produkcia iba čítaná (read-only SELECT, Vercel GET) — žiadny zápis, migrácia, deploy ani zmena env/plánu.

| položka | status | poznámka |
|---|---|---|
| Vercel plan / cron capability | PASS | **VERCEL 1-MINUTE CRON: SUPPORTED** — Vercel API: produkčný aj RC Preview deployment `plan: "pro"`; billing ledger (Committed, Additional Team Seats, fakturované využitie); RC Preview s `* * * * *` READY; docs: Pro min. interval 1 min, 100 cronov |
| cron inventory | PASS | 8 cronov (prod dnes 1); všetky `CRON_SECRET` + timingSafeEqual + 401; idempotentné / SKIP LOCKED + lease; eInvoice bez prod env = no-op; `CRON_SECRET` samostatné záznamy pre Production / Preview; crony bežia iba na produkcii; `test:prelaunch-blockers` |
| signed URL HTTP test | PASS | `scripts/storage-signed-url-http-smoke.ts` na Windows × staging: **25 ok / 0 fail** (vlastník, 2026-10-22; QA identity `qa-ux-a-signedurl@…` iba Firma A, `qa-ux-b-foreign@…` iba Firma B) — autorizovaná URL, GET/HEAD 200 `image/png`, TTL 3600, expirácia, token claims ⊆ Storage allowlist (`scope=download`), anon DENY, private bucket, traversal DENY, uploader-only draft, cleanup; po zmazaní objektu stará URL obsah neservuje. Predtým Claude: anon/public/forged/traversal HTTP 400 |
| signed URL cross-company isolation | PASS | používateľ cudzej firmy: sign / batch sign / list / download DENY (reálne HTTP, smoke 25/0); guard v skripte vynúti A iba Firma A, B iba Firma B, bez spoločného členstva |
| production migration diff | PASS | presne **38** migrácií absent v produkcii (baseline + `20261002100000` … `20261023100000` okrem `20261005090000/091000`); repo × prod história (56) × staging história |
| production migration runbook | PASS (READY) | precheck, backup, poradie, expected state, grants, smoke, rollback, STOP, okno, súhlasy; `scripts/sql/prod-migration-precheck.sql` — dry-run na produkcii 0 STOP / 0 WARN |
| legacy baseline `20260720000000` | CONDITIONAL | no-op (9/9 tabuliek v produkcii); APPLY pre paritu histórie so stagingom, STOP ak ≠ 9 |
| backup / recovery confirmation | PASS | vlastník, Dashboard `fkpgvgvsmbpieduoatrt` → Database → Backups: scheduled physical daily backups ACTIVE, najnovší **22 Oct 2026 02:38:07 UTC**, predchádzajúce denné dostupné; Storage objekty NIE sú v DB zálohe. Pred migračným oknom znova potvrdiť čerstvý úspešný scheduled backup (runbook §B) |
| PITR | DISABLED / OPTIONAL ADD-ON | nie blocker pre aktuálny RC; add-on neaktivovaný (rozhodnutie vlastníka, platený) |
| **production rollout** | ⛔ NOT YET RUN / PENDING APPROVAL | runbook §I |

## J6. COST CONTROL HARDENING (2026-10-25)

**COST CONTROL HARDENING: PASS (repo + staging)**. Production rollout **NOT YET RUN / PENDING APPROVAL**. Bez nového providera,
bez nového AI modulu, bez zmeny pricing UI / billingu / limitov zákazníkov. Detail: `docs/esblu-unit-economics-2026-10-22.md`
§5.3–5.4, §6, §21. **GDPR IMPACT: ACCESS / COST TELEMETRY ONLY — NO CONTENT LOGGING** (informatívne do CLIA delta: nová
technická tabuľka `ai_usage_monthly` bez osobných údajov a obsahu; skrátenie retencie chat dedupe riadkov).

| položka | status | poznámka |
|---|---|---|
| OpenAI flow inventory | PASS | 5 flowov: document scan (+ plate fallback), vehicle document scan (+ plate fallback), vehicle registration scan, voice transcription, intent classification fallback; **žiadny samostatný AI chatbot/asistent**; interný chat AI nevolá (`test:cost-control`) |
| usage metering | PASS (repo + staging) | `ai_usage_monthly` mesačné počítadlá (tokeny, cache, audio, obrázky, retry); iba čísla z `usage`; zápis iba service_role RPC; migrácia `20261025100000` (+ rollback) |
| company scoping | PASS | skeny z AI rezervácie, hlas z aktívnej firmy session, intent fallback z overeného členstva; DB overí aktívne členstvo, inak nič (fail closed); multi-company A ≠ B (PGlite + staging) |
| retry guard | PASS | SDK `maxRetries: 0` + explicitné timeouty; retry iba 429/500/502/503 (max. 1 pri skenoch a prepise, 0 pri fallbackoch); timeout / 4xx sa nikdy neopakujú |
| chat realtime scoping | PASS | všetkých 7 chat `postgres_changes` odberov s filtrom firma/konverzácia; RLS bez zmeny; funkčné správanie chatu bez zmeny (unread je aj tak iba aktívna firma) |
| notification retention | PASS (chat) / OWNER/CLIA NOTE (deadline) | `esblu_purge_chat_notification_deliveries` — iba `chat` riadky > 7 dní, po dávkach; `deadline` sa nemažú (kľúč `overdue`); migrácia `20261025110000` |
| push optimization | PASS | paralelné dávky po 5 príjemcov, jeden zdieľaný FCM OAuth token; deduplikácia bez zmeny; FCM HTTP v1 nemá multicast (zdokumentované) |
| telemetry-maintenance cron | PASS (repo) | `/api/cron/telemetry-maintenance` denne 03:40, CRON_SECRET; v produkcii až po deploy (9 cronov) |
| grants / RLS / replay | PASS | manifest + `test:grants-guard` 10/10, `test:grants-replay-db` 43/43 (idempotencia + rollback → re-apply), `test:cost-control-db` 13/13 |
| staging (`cjbdijbbcujvmrzezusd`) | PASS | obe migrácie aplikované; md5 4 funkcií == PGlite replay; matica `scripts/sql/cost-control-staging-matrix.sql` (owner/employee/iná firma/anon = privilege, service zápis + scoping + fail closed, purge iba starých chat riadkov); fixtures zahodené; advisors: iba očakávané INFO `rls_enabled_no_policy` |
| synthetic OpenAI usage na stagingu | N/A — OpenAI na Preview/stagingu zámerne vypnutá (sentinel); overené mock `usage` testami (`test:cost-control`) a DB zápisom na stagingu |
| unit economics refresh | PASS | terminológia (písané/hlasové príkazy namiesto „AI asistent“), chat po fixoch (20 ľudí HEAVY ≈ 1,6 €/mes.), retry riziko, telemetria; pricing **OWNER DECISION PENDING** |
| mobile Turbopack build + `verify:mobile-bundle` | PENDING OWNER (Windows) | zmenený zdieľaný `MobileChatFab`; v sandboxe mobile webpack build 34/34 PASS, Turbopack blokuje Google Fonts proxy |
| **production rollout** | ⛔ NOT YET RUN / PENDING APPROVAL | migrácie #39–#40 v runbooku (sekcia L), potom deploy |

## J7. PRICING + ENTITLEMENTS ARCHITECTURE (2026-10-26)

**PRICING + ENTITLEMENTS: PASS (repo + staging)**. Nič nie je live: billing ⛔ PENDING, eFaktúra ⛔ BLOCKED, production rollout
**NOT YET RUN / PENDING APPROVAL**. Kanonický engine `lib/pricing.ts`; DB `20261026100000_pricing_entitlements` (+ rollback).
Zverejnenie cenníka v produkcii = až schválený produkčný deploy (`/cennik` v RC už ukazuje novú cenu).

| položka | status | poznámka |
|---|---|---|
| Esblu Komplet 15,90 € / firma / mesiac | PASS (engine + DB) | 25 používateľov, všetky moduly, firemný chat, 40 AI / mes., 60 min hlasu / mes., 5 GB, 20 eFaktúra tx / mes. až po live eFaktúre; bez textu „+ DPH“ (Esblu s.r.o. nie je platiteľ DPH) |
| samostatný modul 3,90 € | PASS | moduly: Vozidlá, Stroje, Sklad, Faktúry, Dokumenty a AI evidencia (+ eFaktúra placeholder, nepredajná) |
| **OWNER-CONFIRMED (2026-10-26): Dokumenty = 10 AI** | PASS (korekcia) | samostatný modul Dokumenty / AI evidencia 3,90 € = **10 AI / obdobie**; Dokumenty + 1 AI balík = 50; Komplet = **40 AI**; Komplet + balík = 80; trial 10; modul bez Dokumentov = 0 AI. Migrácia `20261026110000` (predtým chybne 40) |
| **OWNER-CONFIRMED: hlas v modulárnom pláne iba cez add-on** | PASS | modulárny plán 0 min; +60 min / 3,90 €; Komplet 60 min; trial 15 min; role/security hlasu bez zmeny |
| **OWNER-CONFIRMED: platená firma = 25 používateľov + 5 GB** | PASS | každý aktívny platený plán (1 modul, 4 moduly, Komplet, ďalšia firma 12,90); +25 používateľov / 4,90 €; storage add-on zatiaľ neexistuje |
| **OWNER-CONFIRMED: trial skončil bez plánu = žiadne nové uploady** | PASS (korekcia) | trial 1 GB; bez aktívneho plateného plánu limit **0** (predtým chybne podlaha 1 GB) — žiadny nový dokument, príloha ani fotka; RESTRICTIVE brána kryje INSERT aj UPDATE (prepis/upsert); existujúce súbory ostávajú a nemažú sa; po aktivácii plánu 5 GB |
| **OWNER-CONFIRMED: čakajúce pozvánky rezervujú miesto** | PASS | aktívne členstvá + platné čakajúce pozvánky ≤ limit (owner sa počíta); zrušená / expirovaná pozvánka miesto uvoľní; samostatné „odmietnutie“ pozvánky produkt nemá (pozvánka expiruje po 7 dňoch alebo ju zruší owner/admin); pozvánky inej firmy sa nepočítajú; prijatie kontroluje aktívnych voči limitu |
| **OWNER-CONFIRMED: eFaktúra odoslaná = 1 tx, prijatá = 0,5 tx** | PASS (readiness) | integer half-units (odoslaná 2, prijatá 1; 20 tx = 40); 10 odoslaných + 20 prijatých = 20 tx; nad limit fail closed; add-ony +40 / +100; nič live |
| cenový strop modulov | PASS | 1/2/3/4 moduly = 3,90/7,80/11,70/15,60; 5 → Komplet 15,90; zákazník nikdy neplatí viac (test všetkých kombinácií); odporúčanie Kompletu pred potvrdením, nič sa neprepína samo |
| ďalšia firma 12,90 € | PASS | tier `secondary` (owner už má inú firmu s plánom); strop modulov 12,90; vlastné limity, nič sa nezdieľa |
| 14-dňový trial | PASS | všetky hlavné moduly, 25 používateľov, 10 AI, 15 min hlasu, 1 GB, chat; eFaktúra bez živých transakcií; trial z overeného právneho subjektu (nereštartuje sa novým účtom); dáta sa nikdy nemažú |
| usage limity + add-ony | PASS | AI 40 (+40 / 3,90 €), hlas 60 min (+60 / 3,90 €), používatelia 25 (+25 / 4,90 €), úložisko 5 GB, eFaktúra 20 tx (+40 / 4,90 €, +100 / 9,90 €); add-ony mimo stropu; aktivácia iba potvrdeným billing eventom (staging: mock) |
| hard stop + LIMIT_REACHED | PASS | AI (rezervácia), hlas (pred prepisom, minúty), používatelia (pozvánka/prijatie), úložisko (RESTRICTIVE INSERT + UPDATE politika + predkontrola pri všetkých 14 klientskych uploadoch; audit: žiadna iná cesta zápisu do Storage, 2 serverové eFaktúra uploady = service role, nie live); UI dostane čerpanie / zahrnuté / ponuku add-onu; existujúce dáta ostávajú |
| downgrade / koniec predplatného | PASS | nároky odvolané, dáta ostávajú čitateľné, opätovná aktivácia vráti zápis (PGlite + staging) |
| multi-company izolácia | PASS | nároky, počítadlá, úložisko a plán vždy pre AKTÍVNU firmu; firma A ≠ A2 ≠ B |
| billing authority | PASS | iba owner (`esblu_billing_my_access`); admin (aj s billing.manage), účtovník, zamestnanec nie; plán a tier vidí iba owner |
| provider abstraction | PASS (architektúra) | provider = zdroj stavu (`subscription_accounts`), `company_plan_selection` = kompozícia, jedno pravidlo `esblu_plan_entitlement_targets` pre Stripe / Google Play / Apple |
| RLS / grants | PASS | 2 nové service-only tabuľky (FORCE RLS), manifest, `test:grants-guard` 10/10, `test:grants-replay-db` 43/43 (idempotencia + rollback) |
| testy | PASS | `test:pricing-engine` 19/19, `test:pricing-entitlements-db` 35/35 (TS↔SQL parita 196 kombinácií, AI / hlas / users+pozvánky / storage / eFaktúra matice), `test:plan-entitlements` 47/47; celá sada 87/87 |
| staging (`cjbdijbbcujvmrzezusd`) | PASS | migrácie `20261026100000` + `20261026110000` aplikované; md5 funkcií == replay; matica `scripts/sql/pricing-entitlements-staging-matrix.sql` (rolled back); `allow_mock_plans` ostáva **false**; advisors iba očakávané |
| eFaktúra live | ⛔ BLOCKED / PENDING EXTERNAL + OWNER APPROVAL | provider pricing, live API, právny režim, CLIA, účtovné flowy, produkčná aktivácia |
| live billing (Stripe / Google Play / Apple) | ⛔ PENDING APPROVAL | žiadne produkčné produkty ani checkout |
| mobile Turbopack build + `verify:mobile-bundle` | PENDING OWNER (Windows) | zmenené zdieľané upload obrazovky |
| **production rollout** | ⛔ NOT YET RUN / PENDING APPROVAL | migrácie #41–#42 v runbooku (sekcia L) |

## K. FINAL FULL SMOKE — spustiť IBA keď finálny RC obsahuje multi-company + eInvoice + voice + billing + finálnu legal/store konfiguráciu

Status: **NOT YET RUN** (`FINAL QA`) — zámerne sa nespúšťa teraz. Predpoklady: CLIA/legal texty, finálna billing/store
konfigurácia, finálny AAB, release settings, production deployment candidate. Rozsah: mobil + desktop; auth, Google login, multi-company, roly, faktúry, e-Faktúra
odoslanie/príjem, partneri, vozidlá, stroje, sklad, súbory, chat, hlas, push, billing, zrušenie účtu, offline,
reconnect, oprávnenia, notifikácie, aplikácia nainštalovaná z obchodu.

## L. PRODUCTION ROLLOUT (všetko ⛔ až po súhlase)

Autoritatívny postup: `docs/production-migration-runbook-2026-10-22.md` (42 migrácií, STOP podmienky, rollback per skupina).

1. read-only produkčný precheck (`scripts/sql/prod-migration-precheck.sql` + `scripts/sql/einvoice-prod-precheck.sql`)
2. skutočná história migrácií
3. záloha / logický dump
4. schema fingerprint
5. **výslovný súhlas**
6. migrácie po jednej (poradie: `docs/einvoice-rc-integration-audit-2026-10-13.md` §3)
   → hneď za poslednou RC migráciou `20261021100000_explicit_data_api_grants` a `20261022100000_grants_locale_and_policy_hygiene` (audit grants §7; ACL + policy md5 kontrola po)
   → potom `20261023100000_team_granular_permissions` (J4; po aplikovaní md5 funkcií/politík/ACL == replay)
   → potom `20261025100000_ai_usage_metering` a `20261025110000_notification_deliveries_chat_retention` (J6; md5 4 funkcií == replay/staging)
   → potom `20261026100000_pricing_entitlements` a `20261026110000_pricing_entitlement_corrections` (J7; `allow_mock_plans` musí ostať false)
7. merge / deploy
8. ECB import (fx-rates)
9. crony
10. live e-Faktúra env + webhook
11. billing provideri
12. interná firma — smoke
13. monitoring
14. pilot
15. širší rollout

## M. QA FIXTURES (staging `cjbdijbbcujvmrzezusd`)

| položka | status | poznámka |
|---|---|---|
| QA UX Firma A / B, účty `qa-ux-*@esblu-qa.invalid` (vrátane `qa-ux-a-signedurl@…`, `qa-ux-b-foreign@…`) | RETAINED FOR REGRESSION QA | iba staging; produkcia ich neobsahuje |
| cleanup QA fixtures | TODO AFTER RELEASE VALIDATION | skript pripravený; spustí sa iba po výslovnom pokyne (vyžaduje súhlas s dočasným vypnutím triggerov pre syntetické finalizované faktúry) |

## N. PRODUKTOVÝ SCOPE — NO FEATURE CREEP BEFORE LAUNCH

Zásada: **do uzavretia legal / store / release bodov (C, D, E, F, G, K, L) sa nepridáva nový scope.** Nepridávať najmä:

- bankovú integráciu,
- CRM,
- GPS / fleet tracking,
- mzdy (payroll),
- dochádzku (attendance),
- nových externých providerov / subprocesorov,
- nový väčší GDPR scope (nové kategórie údajov, účely, prenosy).

Povolené pred launchom: opravy bugov, bezpečnostné opravy, zmeny vyžiadané CLIA / účtovníkom / store review a release
konfigurácia. Každá výnimka = výslovné rozhodnutie vlastníka + CLIA delta.

## O. RECONCILIATION LOG (2026-10-22, RC `c3a8650`)

Docs-only audit; žiadny kód, DB, produkcia, secrets, legal texty ani billing konfigurácia sa nemenili.

| sekcia | položka | pôvodne | teraz | dôvod |
|---|---|---|---|---|
| B | subscriptions staging QA | NOT YET RUN | ALREADY DONE | subscriptions readiness §15 (2026-10-11) + owner-only billing PASS v A |
| E | Google Play test produkt | BLOCKED EXTERNAL | TODO (`OWNER DECISION` → `GOOGLE PLAY`) | Play app existuje; čaká na ceny |
| E | license testers / service account / RTDN | BLOCKED EXTERNAL | TODO (`GOOGLE PLAY`) | developer účet + app už existujú |
| E | ceny / per firma / bundle / e-Faktúra | TODO (biznis) | PENDING DECISION (`OWNER DECISION`) | oddelené od technickej pripravenosti |
| F | organizačný developer účet | BLOCKED EXTERNAL | ALREADY DONE | potvrdené vlastníkom |
| F | app vytvorená | BLOCKED EXTERNAL | ALREADY DONE | potvrdené vlastníkom |
| F | ads declaration | TODO | ALREADY DONE (No) | potvrdené vlastníkom |
| F | content rating | TODO | ALREADY DONE (PEGI 3) | potvrdené vlastníkom |
| F | kategória | TODO | ALREADY DONE (Business) | potvrdené vlastníkom |
| F | target audience 18+ | TODO | PENDING DECISION (`OWNER DECISION`) | čaká na finálne potvrdenie 18+ |
| F | privacy policy URL | BLOCKED LEGAL | READY (URL) / text BLOCKED LEGAL | URL existuje, finálny text čaká na CLIA |
| F | reviewer účet | ⛔ hard stop | TODO + ⛔ PENDING APPROVAL | nevytvorený; zápis do produkcie vyžaduje súhlas |
| F | store listing / feature graphic | TODO | READY (draft) | `release/play-submission/` (01, 02) |
| F | Play App Signing | BLOCKED EXTERNAL | TODO (`GOOGLE PLAY`) | účet overený; aktivuje sa pri prvom uploade |
| H | Vercel minútové crony | VERCEL PLAN CONFIRMATION REQUIRED | ALREADY DONE (PASS) | J5: 1-MINUTE CRON SUPPORTED |
| I | signing | BLOCKED EXTERNAL | READY (upload key) + TODO (Play App Signing) | upload key existuje a je overený |
| C | — | — | doplnené: nevyčerpané predplatné/refund wording, rola e-Faktúra providera, finančné roly, Play Data Safety / Apple App Privacy rozdelené | podľa open points CLIA |
| D | 4 účtovné body | BLOCKED LEGAL (accountant) | BLOCKED EXTERNAL / ACCOUNTANT-CLIA DECISION | správne priradenie blockera |

Nezmenené (overené ako stále správne): A, J, J2–J5, K, L, G (Apple — nič nie je hotové), produkčné hard stops.

## P. TOP REMAINING PRE-LAUNCH BLOCKERS

Praktické poradie. Technické blokery (J5) sú PASS — zvyšok sú rozhodnutia, externé strany a schválenia.

| # | blocker | štítok | závisí od |
|---|---|---|---|
| 1 | CLIA drafty: privacy policy, subprocesori, retencia, account deletion + nevyčerpané predplatné/refund wording, rola a archív e-Faktúra providera, finančné roly, former-user attribution (očakávané 1. polovica novembra 2026) | `CLIA` | — |
| 2 | Účtovné rozhodnutia: ne-ECB FX, dátum prijatej zahraničnej faktúry, oprava DPH pri vrátenej zdanenej zálohe/bonuse, archív/retencia e-Faktúry | `ACCOUNTANT` · `CLIA` | — |
| 3 | ~~Ceny~~ — rozhodnuté 2026-10-25 (Komplet 15,90 €, J7); zostáva zverejnenie s produkčným deployom | `OWNER DECISION` | 9 |
| 4 | Play target audience 18+, financial features / health / government deklarácie | `OWNER DECISION` · `GOOGLE PLAY` | — |
| 5 | Play Data Safety + Apple App Privacy (vyplniť podľa CLIA) | `CLIA` · `GOOGLE PLAY` · `APPLE` | 1 |
| 6 | Store billing produkty a konfigurácia: Play subscription produkty, license testers, service account, RTDN; Apple App Store Connect + IAP + StoreKit | `GOOGLE PLAY` · `APPLE` · `OWNER DECISION` | 3 |
| 7 | Reviewer / demo účet v produkcii (allowlist + demo firma) | `PRODUCTION APPROVAL` | 8 |
| 8 | Produkčná migrácia (42 migrácií, runbook READY, precheck 0 STOP / 0 WARN, backup potvrdiť znova pred oknom) | `PRODUCTION APPROVAL` | — |
| 9 | Merge RC → `main` + produkčný deploy (dashboard, `/zrusenie-uctu`, crony) | `PRODUCTION APPROVAL` | 8 |
| 10 | Live aktivácie: e-Faktúra live env + webhook, Stripe live, store billing | `PRODUCTION APPROVAL` · `EXTERNAL PROVIDER` · `OWNER DECISION` | 3, 6, 9 |
| 11 | Finálny release AAB → Internal Testing → Play App Signing → produkčné `assetlinks.json` | `FINAL QA` · `GOOGLE PLAY` · `PRODUCTION APPROVAL` | 1–6, 9 |
| 12 | Apple: TestFlight, listing/screenshoty (ak je iOS súčasťou launchu) | `APPLE` · `OWNER DECISION` | 5, 6 |
| 13 | Finálny real-device + PC smoke (sekcia K), screenshoty z demo účtu | `FINAL QA` | 7, 9, 10, 11 |
| 14 | Production rollout / sign-off (L, pilot → širší rollout) | `PRODUCTION APPROVAL` | 13 |
