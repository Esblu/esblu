# P1-5 / GDPR 2.0 — ukončenie firmy bez zákazníckeho archívu a izolácia RECIPIENT_MISMATCH (2026-11-23)

> **Oprava (bezpečnostná kontrola 2a8aea3):** tvrdenia o „preukázateľnom výmaze vrátane kópií“ a o exporte „PDF
> prijatých e-faktúr“ v tomto reporte neplatili (súbory e-faktúr sa nemazali; `pdf_storage_path` aplikácia
> nevypĺňa). Opravy a aktuálny stav: `docs/p15-security-fixes-2026-11-23.md` (migrácia 20261128100000).

Vetva `fix/p15-termination-export-isolation` (nad 4a08264). Iba lokálna implementácia a offline testy (PGlite,
syntetické údaje). Žiadna stagingová ani produkčná migrácia, žiadny push, merge ani deploy.

## Priorita 1 — náhrada 20261121100000

**Migrácia `20261127100000_company_termination_customer_delete` (NEAPLIKOVANÁ) + rollback.** Samostatná: funguje bez
20261121100000 (produkcia) aj po nej (staging — objekty `esblu_retention` sa nemenia ani nemažú).

| Požiadavka | Riešenie |
| --- | --- |
| Bez povinného 10-ročného zákazníckeho archívu | `esblu_company_termination_execute` maže doklady, e-faktúry a súbory (XML, UBL, PDF prijatých) — nič neprenáša do `esblu_retention`; režim `customer_delete` |
| Ochrana účtovných kópií Esblu | cleanup trigger nikdy nezahrnie bucket `billing-documents` (platí aj bez 20261121); test v `billing-ops-db` |
| Export → potvrdenie → výmaz | brána (BEFORE INSERT `company_terminations`): `waived` pri finalizovaných dokladoch/e-faktúrach zakázané; `exported` iba s dokončeným behom < 24 h bez chýbajúcich súborov **a zhodným odtlačkom dát** (`ESBLU_TERMINATION_EXPORT_STALE`, ak sa údaje po exporte zmenili) |
| Úplnosť exportu pred výmazom | DB odtlačok (`esblu_company_export_fingerprint`: SHA-256 obsahu 16 účtovných/dokladových tabuliek, bez R3); route ho číta PRED exportom a overí počty; zmena počas exportu = `ESBLU_EXPORT_DATA_CHANGED` |
| Oprávnenie rozhodujúcej osoby | owner + `authority_confirmed` (boolean), verzia a SHA-256 zobrazeného textu (server z i18n), čas ≤ 15 min, prihlásenie ≤ 30 min (`ESBLU_TERMINATION_ACK_REQUIRED` / `_REAUTH_REQUIRED`); IP/UA iba SHA-256 so soľou firmy |
| Žiadny nevratný krok pred overením | `esblu_company_termination_preflight` = tá istá brána bez zmeny údajov; route ju volá PRED deregistráciou u poskytovateľa a pred výmazom |
| Preukázateľný výmaz vrátane kópií | `storage_purged_at` sa zapíše, keď cleanup job dokončí výmaz súborov; audit bez obsahu |
| Stará cesta | 4-arg `esblu_company_termination_commit` odmietne (fail closed) |
| Mandáty eFaktúry | ostávajú (append-only dôkaz oprávnenia, bez FK) — **otvorené pre DPA/CLIA**: retencia dôkazu po ukončení |

**Stratégia nasadenia (rozhodnutie vlastníka):**
- **A (odporúčané):** produkcia dostane 20261121100000 a hneď za ním 20261127100000 v jednom okne (história migrácií
  zhodná so stagingom; archív sa nikdy nepoužije, schéma `esblu_retention` ostane prázdna). Nevýhoda: v produkcii
  vznikne nepoužívaná schéma.
- **B:** 20261121100000 sa v produkcii označí ako preskočená (`migration repair`), aplikuje sa iba 20261127100000.
  Čistejšia produkcia, ale história sa líši od stagingu.
- Poradie: **migrácia pred kódom** (nový kód volá `esblu_company_termination_execute`; bez migrácie je ukončenie
  firmy fail closed, export funguje v pôvodnom režime).

## Priorita 2 — RECIPIENT_MISMATCH (R3) ako bezpečnostná otázka

Doklad `RECIPIENT_MISMATCH` = XML adresovaný inému účastníkovi, doručený do schránky firmy; môže patriť inému
zákazníkovi Esblu alebo tretej osobe.

| Cesta | Pred | Po (táto vetva) |
| --- | --- | --- |
| Data API (RLS) | v produkcii viditeľný (20261125100000 chýba) | RLS skrýva riadok aj udalosti (20261125100000, test PGlite) |
| UI zoznam / detail faktúry | filter iba v zozname | spoločný `lib/einvoice/visibility.ts`, filter aj v detaile podľa faktúry |
| Stiahnutie XML | 404 | bez zmeny (404) |
| Storage `einvoice-documents` | bez klientskych politík | overené testom: klient nečíta nič |
| **Export firmy (service role)** | **riadky, udalosti aj XML súbory sa exportovali** | vylúčené z dát, životného cyklu, čitateľnej vrstvy aj súborov; `excluded_counts` v manifeste |
| Účtovný balík | nezahrnuté (bez faktúry) | explicitný filter navyše |
| Odtlačok / ukončenie | — | odtlačok R3 nezapočíta; pri výmaze firmy sa kópia v jej schránke zmaže |

Doplnené časti exportu: PDF prijatých e-faktúr, `invoice_accounting_state_log`, `einvoice_mandates` (+ metadáta:
odtlačok, SHA-256 manifestu v evidencii behu). Schéma exportu `2026-11-23.gdpr2-isolation`.

## Testy (offline, syntetické údaje)

| Sada | Výsledok |
| --- | --- |
| `test:p15-termination-db` (nová; prod-like bez 20261121 + staging-like s ním) | 36/36 |
| `test:company-termination-db` | 23/23 |
| `test:company-termination` | 13/13 |
| `test:retention-archive-db` (legacy, replay do 20261127) | 22/22 |
| `test:billing-ops-db` (billing-documents pri ukončení) | 24/24 |
| `test:einvoice-mandate-db` (mandáty prežijú ukončenie) | 34/34 |
| `test:grants-replay-db` | 43/43 |
| `test:company-export-readable`, `test:handoff`, `test:i18n` | 11/11, 122/122, 114/114 |
| einvoice-inbound / ops / ui / mandate / outbound / reception / hardening / production-gate / rate-limit | všetky PASS |
| multi-company-db, multi-company-einvoice-db, einvoice-db, clia-gdpr-db, account-deletion-* | všetky PASS |
| `tsc --noEmit` | OK |

Negatívne testy: owner inej firmy, admin, klientske roly bez EXECUTE, export inej firmy, starý/neúplný/zlyhaný
export, export bez odtlačku, zmena údajov po exporte aj počas exportu, chýbajúce/neplatné/staré potvrdenie, staré
prihlásenie, `waived` pri dokladoch, cudzí GUC.

## Otvorené

- Rozhodnutie A/B pre 20261121100000; stagingová aplikácia 20261127100000 (samostatné schválenie).
- Retencia mandátov a auditných záznamov ukončenia po výmaze firmy (DPA 2.0 / CLIA).
- 8-dňové obnoviteľné kópie (zálohy) — informovanie v DPA/Privacy (priorita 3–5).
- ESLint: 1 existujúca chyba v `app/nastavenia/page.tsx` (`checkUser`, nesúvisí so zmenou).
