# Esblu — MASTER PRE-LAUNCH CHECKLIST

Kanonický zoznam všetkého, čo musí byť hotové pred verejným spustením. Aktualizovať pri každom bloku.
Posledná aktualizácia: **2026-10-13** (branch `preprod-release-candidate` @ `16e468c` + staging alignment / eInvoice RC validácia).

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
| files / signed URL | PASS (DB politiky, autoritatívne) | media baseline = produkcia; role/odchod/cross-tenant/anon; HTTP podpis URL NOT YET RUN (TTL 3600 s, vydaná URL platí do expirácie) |
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
| eInvoice finálny staging QA (sandbox provider HTTP E2E) | BLOCKED (owner) — driver allowlist povoľuje RC, ale preview env (sandbox kľúč, E2E secret, CRON_SECRET) je viazaný iba na `einvoice-port`; `ESBLU_STAGING_E2E_SECRET` chýba |
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
| Vercel plán podporuje minútové crony (e-Faktúra) | READY (nepriamo: preview `16e468c` s `* * * * *` = READY; Hobby by deployment zamietol) — potvrdiť plán v dashboarde |
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
| signed URL / media model | PASS (staging DB politiky = produkcia; HTTP podpis NOT YET RUN) |
| poradie zrušenia účtu (DB → Storage → auth) | PASS |
| logovanie / PII (webhook payloady) | TODO (audit pri integrácii) |
| zálohy | TODO (pred produkčnou migráciou) |
| rollback plány | READY (rollback skripty v repe) |
| observability | TODO |

## K. FINAL FULL SMOKE — spustiť IBA keď finálny RC obsahuje multi-company + eInvoice + voice + billing + finálnu legal/store konfiguráciu

Status: **NOT YET RUN.** Rozsah: mobil + desktop; auth, Google login, multi-company, roly, faktúry, e-Faktúra
odoslanie/príjem, partneri, vozidlá, stroje, sklad, súbory, chat, hlas, push, billing, zrušenie účtu, offline,
reconnect, oprávnenia, notifikácie, aplikácia nainštalovaná z obchodu.

## L. PRODUCTION ROLLOUT (všetko ⛔ až po súhlase)

1. read-only produkčný precheck (owner invariant, multi-membership, drift)
2. skutočná história migrácií
3. záloha / logický dump
4. schema fingerprint
5. **výslovný súhlas**
6. migrácie po jednej (poradie: `docs/einvoice-rc-integration-audit-2026-10-13.md` §3)
7. merge / deploy
8. ECB import (fx-rates)
9. crony
10. live e-Faktúra env + webhook
11. billing provideri
12. interná firma — smoke
13. monitoring
14. pilot
15. širší rollout
