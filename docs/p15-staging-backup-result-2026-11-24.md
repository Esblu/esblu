# P1-5 — skupina A: cielená záloha stagingu (2026-11-24)

**Projekt:** esblu-test `cjbdijbbcujvmrzezusd` (eu-west-1) — overené cez get_project pred zápisom; navyše má
`esblu_retention` a migráciu 20261121100000, ktoré produkcia assetpilot nemá. Produkcia sa nevolala.

## Zápis

Jediný zápis: `scripts/sql/p15-staging-backup.sql` (audit pred spustením: iba `create schema`, `revoke` na novej
schéme a `create table … as select` do `esblu_backup_p15_20261124`; žiadne drop/delete/update/insert/alter
existujúcich objektov). 20 tabuliek, 557 kB. Schéma bez prístupu pre anon / authenticated / service_role
(overené `has_schema_privilege` / `has_table_privilege`).

## Integrita

| Tabuľka | Živé = záloha (počet) | Množina ID | Obsah (md5 všetkých riadkov) |
| --- | --- | --- | --- |
| companies 16, company_members 27, company_terminations 1, company_export_runs 4, account_deletion_cleanup_jobs 1 | áno | áno | áno |
| invoices 77, invoice_items 89, invoice_events 202, invoice_accounting_state_log 0 | áno | áno | áno |
| documents 3, einvoice_inbound 36, einvoice_outbound 27, einvoice_events 288 | áno | áno | áno |
| einvoice_mandates 0, einvoice_deregistrations 0, einvoice_organizations 5, billing_invoice_documents 8 | áno | áno | áno |
| storage_objects (metadáta) 67 | áno | áno | áno |

`completeness where not ok` = 0. `function_defs` = 5 nahrádzaných funkcií (commit wrapper volá
`esblu_retention.termination_execute`, cleanup trigger odkazuje na `esblu_retention.archived_records` — zodpovedá
vetve rollbacku s esblu_retention).

## Snímka izolácie

| | Pred zálohou | Po zálohe | Baseline (precheck) |
| --- | --- | --- | --- |
| firmy / faktúry / prijaté / udalosti / objekty firiem | 16 / 77 / 36 / 288 / 63 | 16 / 77 / 36 / 288 / 63 | rovnaké |
| md5 firiem | b3917b95420abdbd3b4ad50cbbece2a2 | rovnaké | rovnaké |
| všetky objekty Storage | 67, md5 2b33662ba791a7d7790b1f1de932f82b | rovnaké | — |
| dokumenty / migrácie | 3 / 77 | 3 / 77 | — |

Žiadne rozdiely; medzi precheckom a zálohou nevznikli legitímne ani iné zmeny.

## Pripravenosť obnovy (nevykonaná)

- **Funkcie:** rollback 20261128 → 20261127 (offline overené v zložení stagingu, vetva s esblu_retention).
- **Dáta:** `scripts/sql/p15-staging-restore.sql` — INSERT … ON CONFLICT DO NOTHING, prienik stĺpcov (migrácie
  pridávajú stĺpce), poradie podľa FK. Offline overené: záloha → migrácie → strata → obnova → zhoda, opakovanie
  idempotentné. **Bez režimu replica obnovu odmietnu insert triggery** (ENTITLEMENT_DENIED); rola postgres na
  stagingu nie je superuser — či smie `session_replication_role`, nie je overené. Záložný postup (vypnutie user
  triggerov v transakcii) vyžaduje osobitné schválenie.
- **Storage:** záloha obsahuje iba metadáta, nie bajty.

## Storage — je potrebná nezávislá kópia?

- **Migrácie 20261127/20261128 Storage nemenia:** obsahujú iba DDL a definície funkcií; žiadny top-level zápis,
  žiadna operácia na `storage.objects`. Mazanie súborov nastane až pri výmaze firmy (skupina D) a iba pod prefixom
  syntetickej firmy (DB trigger + overenie).
- **Pre skupinu B kópia nie je potrebná.**
- **Pred skupinou D odporúčaná** (nízky náklad, 67 objektov / ~330 kB): chyba v logike prefixu alebo operátora by
  bez kópie znamenala trvalú stratu 63 XML dôkazov E2E/P14, 3 účtovných PDF (Stripe test) a 1 dokumentu.
  Návrh (osobitné schválenie): vlastník spustí lokálny skript s kľúčom iba v prostredí procesu → stiahne objekty cez
  Storage API do dočasného priečinka mimo repozitára a OneDrive → SHA-256 manifest = `storage.objects` → archív
  7-Zip AES-256 (heslo v správcovi hesiel) → zmazanie nešifrovaného priečinka → overenie rozbalením a porovnaním
  SHA-256.

## Riziká

1. Obnova dát závisí od možnosti vypnúť triggery (neoverené).
2. Bez nezávislej kópie Storage je výmaz (D) bez možnosti obnoviť súbory existujúcich firiem — preto kópia pred D.
3. Platformové zálohy Supabase neoverené.

## GO / NO-GO pre skupinu B

**GO.** Záloha je úplná a overená, existujúce údaje nezmenené, migrácie neovplyvňujú Storage ani existujúce dáta,
rollback funkcií je pripravený. Odporúčané poradie: B → (C) → kópia Storage → D.
