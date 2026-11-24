# P1-5 — skupina B: migrácie 20261127100000 + 20261128100000 na staging (2026-11-24)

**Výsledok: PASS.** Projekt esblu-test `cjbdijbbcujvmrzezusd` (overené pred zápisom: get_project, esblu_retention,
20261121 prítomné). Produkcia sa nevolala.

## Pred aplikovaním

- migrácie: 77, 20261127/20261128 neaplikované; posledné 20261124100000, 20261125100000
- záloha `esblu_backup_p15_20261124`: existuje, čitateľná, `completeness` 0 odchýlok; 18/18 tabuliek
  živé = záloha (ID aj obsah md5)
- snímka izolácie = baseline (16 / 77 / 36 / 288 / 63, md5 b3917b95420abdbd3b4ad50cbbece2a2; Storage 67 obj.,
  md5 2b33662ba791a7d7790b1f1de932f82b)
- preflight súborov (commit 5678fff): žiadny top-level INSERT/UPDATE/DELETE/TRUNCATE/DROP TABLE; DML iba v telách
  funkcií; žiadna operácia na storage.objects; jediný DROP FUNCTION = `esblu_company_termination_storage_purged`
  (vytvorená v 20261127)

## Aplikovanie (apply_migration)

| Verzia | Názov |
| --- | --- |
| 20261124194349 | 20261127100000_company_termination_customer_delete |
| 20261124194604 | 20261128100000_termination_purge_export_integrity |

Aplikovaný text = súbory z commitu 5678fff bez vonkajšieho `begin;`/`commit;` (transakciu riadi apply_migration)
a bez úvodných komentárov; príkazy SQL nezmenené.

## Validácia po aplikovaní (read-only)

| Kontrola | Výsledok |
| --- | --- |
| nové funkcie (execute, preflight, fingerprint, file_list, storage_fingerprint, begin 9/8/6-arg, part_files, part, confirm_storage, cleanup_health) | existujú |
| `esblu_company_termination_storage_purged` | odstránená (podľa návrhu) |
| nové tabuľky `company_export_run_files`, `einvoice_misdelivery_incidents` | existujú, RLS zapnuté, anon/authenticated bez práv, service_role iba SELECT |
| EXECUTE nových funkcií | iba service_role; anon/authenticated nie |
| triggery | cleanup: BEFORE INSERT OR UPDATE; brána ukončenia: BEFORE INSERT |
| ochrana billing-documents | trigger odmieta (`ESBLU_CLEANUP_TARGET_PROTECTED`), bez odkazu na esblu_retention |
| starý commit (4-arg) | fail closed (`ESBLU_TERMINATION_ACK_REQUIRED`) |
| existujúce firmy / faktúry / doklady / súbory | snímka = baseline (md5 b3917b95…, Storage 2b33662b…) |
| záloha vs. živé po migrácii | 17/17 tabuliek zhodných v pôvodných stĺpcoch; nové stĺpce u existujúcich riadkov NULL / false |
| ACL ostatných tabuliek a funkcií, RLS politiky (143), storage politiky | md5 nezmenené |
| esblu_retention (počty, funkcie, retention_periods) | nezmenené (archív prázdny, 5 lehôt) |
| security advisors | nové iba INFO „RLS bez politík“ pre 2 nové tabuľky (zámer: iba service_role) |

## Rozdiely

Žiadne nevysvetlené. Jediné zmeny = nové stĺpce/tabuľky/funkcie podľa migrácií; nové evidenčné tabuľky prázdne.

## Odporúčanie pre skupinu C

**GO** po samostatnom schválení: syntetické účty (`@esblu-qa.invalid`) a firmy QA-P15-T1/T2/ISO/PERF, seed údajov
a súborov cez lokálny runner (kľúč iba v prostredí procesu), snímka izolácie pred/po každom kroku. Pred skupinou D
nezávislá šifrovaná kópia Storage (návrh v `docs/p15-staging-backup-result-2026-11-24.md`).
