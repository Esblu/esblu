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
