# E-Faktúra — P1-4 prijímanie: stránkovanie, nápovedy, karanténa, R3 (2026-11-23)

Vetva `fix/einvoice-inbound-pagination-quarantine` (z `main` 6506e11). Lokálny commit, bez pushu, bez deployu.

## Čo sa zmenilo
| Oblasť | Zmena | Bez migrácie? |
|---|---|---|
| Stránkovanie `GET /v1/agent/peppol/received` | `limit` + `offset` (overené R1), koniec podľa `meta.has_more` (inak počet riadkov < limit); `ESBLU_EFAKTURA_RECEIVED_PAGINATION=none` = kill-switch (iba prvá stránka). `syncInboundList` ide po stránkach (100 × max. 10), zastaví sa pri `PAGINATION_IGNORED` (stránka bez nových ID) a `PAGINATION_LIMIT` | áno |
| Nápoveda z udalosti | `inboundHintId` (receivedId / received_id / documentId / document_id — názov poľa poskytovateľ nezdokumentoval, NEOVERENÉ) → overenie `GET /received/{id}/xml` v kontexte organizácie z mapovania → registrácia. Firma nikdy z tela udalosti | áno |
| Report cronu | `pages`, `already_known`, `hints_registered`, `stopped`, `pagination` | áno |
| R3 RECIPIENT_MISMATCH | zoznam, detail a stiahnutie XML (`downloadStoredDocument`) ho firme nevrátia (404 ako neexistujúci) | áno |
| Karanténa | `quarantined_at`, `quarantine_reason`, `provider_acknowledged_at`; iba `failed` s uloženým XML (cesta + SHA-256), nikdy RECIPIENT_MISMATCH; udalosť `failed->quarantined` v `einvoice_events` | **migrácia 20261125100000 (pripravená, neaplikovaná)** |
| ACK karantény (R2) | iba pri `ESBLU_EINVOICE_INBOUND_QUARANTINE_ACK=enabled` (cron); default **vypnuté** | – |
| RLS (R3) | politika `einvoice_inbound_select_finance` vylúči RECIPIENT_MISMATCH aj pre Data API | migrácia |
| Monitoring | health + `quarantined`, `quarantined_unacked`, `recipient_mismatch`; alerty `INBOUND_RECIPIENT_MISMATCH` (critical), `INBOUND_QUARANTINED` (warning); bez migrácie = 0 | migrácia (alerty v kóde) |

## R1 — read-only overenie v sandboxe (2026-11-23, PASS)
Skript `release-backups/s17/2026-11-22-migration/r1-efaktura-received-pagination-probe.ps1` v2 (mimo Gitu; iba GET, partnerský sandbox kľúč overený odtlačkom). Prvý beh v1 vrátil 403: použil starý kľúč iného sandbox účtu (pred 5. 10.).
Výsledok v2: `limit` a `offset` fungujú (offset=3 = ďalšie 3 odlišné doklady), `page`/`per_page` poskytovateľ ignoruje, zoradenie zostupné (najnovšie prvé), odpoveď `{ data, meta: { limit, offset, has_more } }`; pri `acknowledged=false` bol 1 doklad.

## R3 — postup pri doklade adresovanom inému účastníkovi
1. Alert `INBOUND_RECIPIENT_MISMATCH` (critical). Doklad je `failed`, firma ho nevidí, nič sa nepotvrdilo poskytovateľovi.
2. Operátor (service_role, mimo Data API) overí iba: `provider_received_id`, organizáciu, `xml_sha256`, `last_error_code`, `error_message` (detail RECIPIENT_*), čas prijatia. Obsah XML neotvára, ak to nie je nevyhnutné.
3. Nahlási poskytovateľovi (podpora eFaktura.sk) ID dokladu a organizácie — bez obsahu faktúry — s požiadavkou na presmerovanie / vrátenie. Doklad nepotvrdzuje (ACK) a nepresúva do inej firmy.
4. Po vyriešení u poskytovateľa: záznam incidentu (dátum, ID, výsledok) v prevádzkovej evidencii; uložené XML sa zmaže až po rozhodnutí CLIA o lehote (navrhované: najkratšia nutná, napr. 30 dní po uzavretí incidentu).
5. Minimalizovaná evidencia: iba technické identifikátory a hash, žiadne údaje z obsahu faktúry, žiadny prístup firmy, ktorej doklad nepatrí.

## Testy (offline, PGlite + falošný poskytovateľ)
`test:einvoice-inbound` 68/68 (nové: T1/T2 65 chybných neblokuje platnú faktúru v oboch zoradeniach, dôkaz pôvodného problému, A2 nápoveda, T3 ignorované stránkovanie, T4 strop, T5 cudzie ID, T6 duplicita, T7 karanténa bez ACK, T7b/T9 ACK s povolením a opakovanie, T8 bez originálu, R3 RLS + health, T10/T11 izolácia a oprávnenia), `test:einvoice-efaktura` 21/21 (stránkovacie parametre), `test:einvoice-ops` 24/24 (R3 download 404, alerty). Ostatné sady e-faktúry, grants guard, archív a ukončenie: PASS.

## Spoľahlivosť príjmu (2026-11-23, druhá časť)
**Sken zoznamu (kotva + reštart).** Stránka k začína na `offset_{k-1} + limit − 1` — posledný doklad predchádzajúcej stránky (kotva) sa musí objaviť znova. Ak chýba, pred ním ubudli doklady (ACK iným procesom) a hrozí preskočenie → nový prechod od offsetu 0 (max. 3 prechody). Nové doklady na vrchu (najnovšie prvé) kotvu iba posunú nadol → nič sa nepreskočí, nové prevezme ďalší beh. Sken je **úplný** iba po dosiahnutí konca (`has_more=false`, inak menej riadkov ako limit) bez straty kotvy. Registrácia je idempotentná (`provider, environment, provider_received_id`), takže opakované čítanie nevadí.
Kódy zastavenia: `SCAN_SHIFTED` (3 prechody nestačili), `PAGINATION_LIMIT` (10 strán = 100 + 9 × 99 = 991 dokladov), `REQUEST_BUDGET`, `PAGINATION_IGNORED`, `ANCHOR_UNAVAILABLE`, `LIST_FAILED`, `SCAN_INCOMPLETE` (kill-switch `none`).
**Stav skenu (migrácia 20261125100000, neaplikovaná):** tabuľka `einvoice_inbound_scan_state` (posledný beh, posledný úplný sken, kód, počet neúplných po sebe), RPC `esblu_einvoice_org_record_inbound_scan`, `esblu_einvoice_inbound_scan_order` (iba service_role). Poll skenuje organizácie od najdlhšie neúplne skenovanej → pri vyčerpaní rozpočtu sa žiadna trvalo nevynechá. Bez migrácie: pôvodné poradie, stav iba v reporte cronu.

**Priepustnosť (`runInboundProcessBudget`).** Cron `einvoice-inbound` (každých 10 min, maxDuration 60 s): namiesto 5 dokladov max. **30 dokladov / beh**, termín 40 s, claim po 10 (FOR UPDATE SKIP LOCKED + lease 120 s), max. **20 požiadaviek na zoznam**. Najhorší beh ≈ 20 + 2 × 30 = 80 požiadaviek (zdieľaný partnerský limit ≥ 100/min; feed udalostí a odosielanie majú vlastné behy). 429 beh okamžite zastaví (`PROVIDER_RATE_LIMITED`), 3 po sebe idúce dočasné chyby poskytovateľa (`PROVIDER_DEGRADED`). Ustálená kapacita ≈ 180 dokladov/h na všetky organizácie (pôvodne 30/h). Webhook ostáva pri malej dávke (5).

**Monitoring.** Health `inbound.scan_overdue` (aktívny príjem bez úplného skenu > 2 h) → `INBOUND_SCAN_OVERDUE` (critical); `inbound.scan_incomplete` → `INBOUND_SCAN_INCOMPLETE` (warning); `oldest_stuck_age_seconds ≥ 7200` → `INBOUND_BACKLOG_AGING` (critical). Existujúce `INBOUND_STUCK`, `INBOUND_FAILED`, `INBOUND_ACK_PENDING_TOO_LONG`, `INBOUND_RECIPIENT_MISMATCH` ostávajú.

**Obmedzenia.** (1) Pri trvalom súbežnom potvrdzovaní (každú stránku) beh skončí `SCAN_SHIFTED` — doklady sa nestratia, prevezme ich pokojnejší beh; trvalý stav hlási alert. (2) Viac ako 991 nepotvrdených na organizáciu: beh končí `PAGINATION_LIMIT`, zvyšok sa prevezme po spracovaní vrchu; ak by vrch tvorili trvalo chybné doklady (bez ACK karantény, R2 vypnuté), staršie by čakali — alert `INBOUND_SCAN_OVERDUE`. (3) Po zastavení behu (429 / výpadok / termín) držia claimnuté nespracované riadky lease 120 s; ďalší cron o 10 min ich vezme. (4) Záruka úplnosti závisí od stabilného zoradenia poskytovateľa (R1: najnovšie prvé) — overiť v stagingovom integračnom teste.

**Testy:** `test:einvoice-inbound` 87/87 (+ R1 trvalý posun, R2 rozpočet a rotácia, L100, L250, L1100, C1 súbežné webhooky + poll, O1 429/503/výpadok zoznamu, O2 ACK 429, O3 termín, M1/M2 monitoring a oprávnenia, S3 opravený — preskočenie už nenastáva), `test:einvoice-efaktura` 22/22 (explicitný offset).

## Limit požiadaviek a udalostná cesta (2026-11-23, pred stagingom)
Audit našiel zosilnenie: každá udalosť `peppol.document.received` (webhook aj feed — feed spracuje až 500 udalostí za beh) spúšťala plný sken (až 30 požiadaviek na zoznam) + dávku 5 dokladov. Oprava:
- `runInboundEvent`: nápoveda (≤ 1) + 1 stránka zoznamu + max. 3 doklady → **≤ 8 požiadaviek na udalosť**, stav skenu nezapisuje (úplný sken robí iba poll).
- **Zdieľaný limiter v DB** (`einvoice_provider_rate_window`, `esblu_einvoice_rate_acquire`, okno 1 min, atomický upsert): príjem spolu ≤ 60/min, poll ≤ 40/min. Zamietnutie = lokálne `EINVOICE_PROVIDER_RATE_LIMITED` → beh/udalosť sa zastaví ako pri 429 (udalosť → retry, feed `STOPPED_ON_FAILURE` a pokračuje ďalším behom). Odosielanie, feed a údržba limiter nepoužívajú (≈ 30–40 req/min v najhoršom prípade podľa dávok cronov). Bez migrácie / pri chybe DB fail-open.
- Health `inbound.rate_limited_1h` → `INBOUND_RATE_LIMITED` (warning ≥ 20/h).
- `scan_overdue` počíta organizáciu bez záznamu až keď poll s novým kódom beží (žiadny falošný kritický alert pri poradí nasadenia); stav skenu má FK na mapovanie organizácie (cascade).
