# Esblu — MASTER PRE-LAUNCH CHECKLIST

Kanonický zoznam všetkého, čo musí byť hotové pred verejným spustením. Aktualizovať pri každom bloku.
Posledná aktualizácia: **2026-10-22** (branch `preprod-release-candidate` — **PRE-LAUNCH TECHNICAL BLOCKERS: PARTIAL**, sekcia **J5**; predtým GRANULAR TEAM PERMISSIONS: PASS, sekcia **J4**).

Statusy: **PASS** · **READY** (pripravené, čaká na vykonanie/súhlas) · **BLOCKED LEGAL** · **BLOCKED EXTERNAL** ·
**TODO** · **NOT YET RUN**

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
| files / signed URL | PASS (DB politiky, autoritatívne) · HTTP PARTIAL | media baseline = produkcia; role/odchod/cross-tenant/anon; HTTP anon/public/forged/traversal PASS (staging, 2026-10-22); prihlásené A/B/C/E/F/G čakajú na `scripts/storage-signed-url-http-smoke.ts` (vlastník) — sekcia J5 |
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
| subscriptions staging QA (fake/test provider) | NOT YET RUN (po integrácii) |
| finálny staging schema fingerprint | PASS (pred/po v audite §13; dáta bez zmeny) |

## C. LEGAL / CLIA

| položka | status |
|---|---|
| privacy policy (finálna) | BLOCKED LEGAL |
| zoznam subprocesorov | BLOCKED LEGAL |
| OpenAI (DPA, prenos) | BLOCKED LEGAL |
| Firebase / FCM | BLOCKED LEGAL |
| Stripe | BLOCKED LEGAL |
| Google Play | BLOCKED LEGAL |
| Apple | BLOCKED LEGAL |
| e-Faktúra provider (zmluva, DPA) | BLOCKED LEGAL |
| retencia (účtovné záznamy, e-faktúry, XML) | BLOCKED LEGAL |
| texty zrušenia účtu / odchodu z firmy | BLOCKED LEGAL |
| retencia hashovaných trial claimov | BLOCKED LEGAL |
| obchodné podmienky predplatného | BLOCKED LEGAL |
| refund policy | BLOCKED LEGAL |
| merchant-of-record rozhodnutia | BLOCKED LEGAL |
| B2B/B2C DPH / OSS | BLOCKED LEGAL |
| Data Safety odpovede (Play) / App Privacy (Apple) | BLOCKED LEGAL |
| autor účtovných záznamov pri zrušení loginu (pseudonymizácia) | BLOCKED LEGAL |

## D. ACCOUNTING — ACCOUNTING DECISION REQUIRED

| položka | status |
|---|---|
| ne-ECB kurzy (FX) | BLOCKED LEGAL (accountant) |
| dátum prijatej zahraničnej faktúry | BLOCKED LEGAL (accountant) |
| oprava DPH pri vrátenej zdanenej zálohe / bonuse | BLOCKED LEGAL (accountant) |
| úloha e-Faktúry v archivácii (archív vs. kópia) | BLOCKED LEGAL (accountant) |

## E. BILLING / SUBSCRIPTIONS

| položka | status |
|---|---|
| rozhodnutie o cenách | TODO (biznis) |
| cena per firma | TODO (biznis) |
| multi-company zľava / balík | TODO (biznis) |
| e-Faktúra free / platený addon / v pláne | TODO (biznis) |
| Stripe test integrácia | READY (fake/test v kóde) |
| Google Play test produkt | BLOCKED EXTERNAL |
| license testers | BLOCKED EXTERNAL |
| Play service account | BLOCKED EXTERNAL |
| RTDN | BLOCKED EXTERNAL |
| Apple IAP produkty | BLOCKED EXTERNAL |
| Mac StoreKit compile | NOT YET RUN |
| schválenie live aktivácie | ⛔ hard stop |

## F. GOOGLE PLAY

| položka | status |
|---|---|
| developer účet overený | BLOCKED EXTERNAL |
| app vytvorená | BLOCKED EXTERNAL |
| content rating | TODO |
| ads declaration | TODO |
| financial features | TODO |
| health | TODO |
| government | TODO |
| kategória | TODO |
| privacy policy URL | BLOCKED LEGAL |
| Data Safety | BLOCKED LEGAL |
| target audience 18+ | TODO |
| reviewer účet | ⛔ hard stop |
| store listing, screenshoty, feature graphic | TODO |
| Internal Testing AAB | NOT YET RUN |
| Play App Signing + App Signing SHA-256 | BLOCKED EXTERNAL |
| assetlinks produkčná aktualizácia | ⛔ hard stop |
| closed / production rollout | TODO |

## G. APPLE

| položka | status |
|---|---|
| App Store Connect setup | BLOCKED EXTERNAL |
| privacy disclosures | BLOCKED LEGAL |
| IAP produkty | BLOCKED EXTERNAL |
| StoreKit compile / test | NOT YET RUN |
| screenshoty / listing | TODO |
| review účet | ⛔ hard stop |
| TestFlight | NOT YET RUN |
| production rollout | TODO |

## H. WEB

| položka | status |
|---|---|
| nový dashboard — produkčný merge / deploy | ⛔ hard stop (READY v RC) |
| `/zrusenie-uctu` v produkcii | READY (RC) |
| privacy / legal stránky | BLOCKED LEGAL |
| billing web (Stripe) | READY (test) / ⛔ live |
| Vercel plán podporuje minútové crony (e-Faktúra) | VERCEL PLAN CONFIRMATION REQUIRED (plán nie je čitateľný cez API; preview READY nie je autoritatívny dôkaz) |
| produkčný monitoring | TODO |

## I. ANDROID

| položka | status |
|---|---|
| finálny AAB build | NOT YET RUN |
| signing | BLOCKED EXTERNAL |
| billing ON/OFF matica | PASS (debug, RC kit) |
| manifest / permissions / targetSdk | PASS (RC audit) |
| secret scan produkčného bundlu | NOT YET RUN (finálny) |
| reálny test inštalácie z Play | NOT YET RUN |

## J. SECURITY

| položka | status |
|---|---|
| RLS / tenant izolácia (multi-company) | PASS (PGlite + staging) |
| eInvoice RLS (SELECT iba aktívna firma + finance) | PASS (staging DB) |
| secrets (žiadne v repe, server-only) | PASS (scan) |
| signed URL / media model | PASS (staging DB politiky = produkcia) · HTTP PARTIAL (J5) |
| poradie zrušenia účtu (DB → Storage → auth) | PASS |
| logovanie / PII (webhook payloady) | TODO (audit pri integrácii) |
| zálohy | EXTERNAL CONFIRMATION REQUIRED — Supabase org plán Pro (denné zálohy 7 dní); PITR a posledný recovery point potvrdí vlastník v Dashboarde (J5) |
| rollback plány | READY — per skupina v `docs/production-migration-runbook-2026-10-22.md` §G (vrátane „podmienečne“ / „STAGING ONLY“ výhrad) |
| observability | TODO |
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

**PRE-LAUNCH TECHNICAL BLOCKERS: PARTIAL** (RC `f06abe9`). Detail: `docs/production-migration-runbook-2026-10-22.md`.
Produkcia iba čítaná (read-only SELECT, Vercel GET) — žiadny zápis, migrácia, deploy ani zmena env/plánu.

| položka | status | poznámka |
|---|---|---|
| Vercel plan / cron capability | PASS | **VERCEL 1-MINUTE CRON: SUPPORTED** — Vercel API: produkčný aj RC Preview deployment `plan: "pro"`; billing ledger (Committed, Additional Team Seats, fakturované využitie); RC Preview s `* * * * *` READY; docs: Pro min. interval 1 min, 100 cronov |
| cron inventory | PASS | 8 cronov (prod dnes 1); všetky `CRON_SECRET` + timingSafeEqual + 401; idempotentné / SKIP LOCKED + lease; eInvoice bez prod env = no-op; `CRON_SECRET` samostatné záznamy pre Production / Preview; crony bežia iba na produkcii; `test:prelaunch-blockers` |
| signed URL HTTP test | PARTIAL | reálne HTTP (staging): public URL 400 pre všetky buckety, anon sign 400 aj pre existujúci objekt, forged token 400 InvalidJWT, traversal 400; prihlásené A/B/E/F/G → `scripts/storage-signed-url-http-smoke.ts` spustí vlastník (Claude sa heslom neprihlasuje) |
| signed URL cross-company isolation | PARTIAL | DB politika PASS (predošlý audit); HTTP pre prihláseného cudzinca (C) v tom istom skripte |
| production migration diff | PASS | presne **38** migrácií absent v produkcii (baseline + `20261002100000` … `20261023100000` okrem `20261005090000/091000`); repo × prod história (56) × staging história |
| production migration runbook | PASS (READY) | precheck, backup, poradie, expected state, grants, smoke, rollback, STOP, okno, súhlasy; `scripts/sql/prod-migration-precheck.sql` — dry-run na produkcii 0 STOP / 0 WARN |
| legacy baseline `20260720000000` | CONDITIONAL | no-op (9/9 tabuliek v produkcii); APPLY pre paritu histórie so stagingom, STOP ak ≠ 9 |
| backup / recovery confirmation | EXTERNAL CONFIRMATION REQUIRED | Supabase Pro → denné zálohy 7 dní; PITR + posledný recovery point: vlastník, Dashboard → Database → Backups |
| **production rollout** | ⛔ NOT YET RUN / PENDING APPROVAL | runbook §I |

## K. FINAL FULL SMOKE — spustiť IBA keď finálny RC obsahuje multi-company + eInvoice + voice + billing + finálnu legal/store konfiguráciu

Status: **NOT YET RUN.** Rozsah: mobil + desktop; auth, Google login, multi-company, roly, faktúry, e-Faktúra
odoslanie/príjem, partneri, vozidlá, stroje, sklad, súbory, chat, hlas, push, billing, zrušenie účtu, offline,
reconnect, oprávnenia, notifikácie, aplikácia nainštalovaná z obchodu.

## L. PRODUCTION ROLLOUT (všetko ⛔ až po súhlase)

Autoritatívny postup: `docs/production-migration-runbook-2026-10-22.md` (38 migrácií, STOP podmienky, rollback per skupina).

1. read-only produkčný precheck (`scripts/sql/prod-migration-precheck.sql` + `scripts/sql/einvoice-prod-precheck.sql`)
2. skutočná história migrácií
3. záloha / logický dump
4. schema fingerprint
5. **výslovný súhlas**
6. migrácie po jednej (poradie: `docs/einvoice-rc-integration-audit-2026-10-13.md` §3)
   → hneď za poslednou RC migráciou `20261021100000_explicit_data_api_grants` a `20261022100000_grants_locale_and_policy_hygiene` (audit grants §7; ACL + policy md5 kontrola po)
   → potom `20261023100000_team_granular_permissions` (J4; po aplikovaní md5 funkcií/politík/ACL == replay)
7. merge / deploy
8. ECB import (fx-rates)
9. crony
10. live e-Faktúra env + webhook
11. billing provideri
12. interná firma — smoke
13. monitoring
14. pilot
15. širší rollout
