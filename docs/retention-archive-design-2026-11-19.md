# Retenčný archív účtovných dokladov pri ukončení firmy — návrh (2026-11-19)

**Stav:** implementované na vetve `ops/esblu8-p2` (migrácia `20261121100000_retention_archive_company_termination`,
rollback `supabase/rollback/20261121100000_retention_archive_company_termination_rollback.sql`,
testy `npm run test:retention-archive-db`). **Nenasadené.** Produkcia beží na funkciách z `20261112110000`.
**Lehoty v tomto dokumente sú NÁVRH (PROPOSED)** — schvaľuje ich prevádzkovateľ, nie sú právnym stanoviskom.

Súvisiace: `docs/clia-retention-nonconformity-2026-11-19.md` (briefing pre CLIA, DRAFT),
`docs/audits/clia-technical-delta-2026-11-19.md` §2.6–2.7, `docs/prod-cleanup-and-operator-plan-2026-11-19.md`.

---

## 1. Problém

Od 12. 11. 2026 (`20261112110000_company_termination_workflow`) `esblu_company_termination_commit` v režime
`exported` aj `waived` v jednej transakcii **zmaže** finalizované faktúry a všetky ich časti, e-faktúry
(`einvoice_outbound/inbound`), históriu doručenia (`einvoice_events`), odovzdania účtovníkovi
(`accounting_handoff_exports` kaskádou) a XML e-faktúr aj sken prijatej faktúry v Storage (cleanup job).
Mimo tohto workflow sú doklady chránené (triggery, `esblu_company_deletion_retention_blocker`).

## 2. Riešenie v skratke

| Cesta | Pred (20261112110000) | Po (20261121100000) |
|---|---|---|
| `esblu_company_termination_commit(user, company, delete_account, export_mode)` — route `/api/account/delete` (service_role) | maže doklady, XML, dôkazy | **archivuje** doklady + dôkazy do `esblu_retention`, potom zmaže firmu a ostatné údaje ako doteraz; XML a sken prijatej faktúry **ostávajú** v Storage |
| `esblu_account_deletion_commit('owner', …)` | blokované, ak má firma doklady | bez zmeny (blokované) |
| `esblu_company_termination_synthetic_purge(…, p_synthetic_test_data_purge, p_reference, p_justification)` | — | **nová výnimka**: pôvodné správanie (výmaz bez archívu) iba pre syntetické testovacie dáta, iba `postgres` |
| Retenčná purge archívu | — | `esblu_retention.purge_expired` (dry-run default, iba APPROVED lehoty, legal hold) — **nenaplánovaná** |

Signatúra aj návratový tvar `esblu_company_termination_commit` ostávajú (pribudli kľúče `archive_id`,
`termination_mode`, `archived_counts`) → `lib/account-deletion-deps.ts` sa nemení.

## 3. Dátová mapa — čo sa archivuje

Archivuje sa v tej istej transakcii **pred** výmazom; chyba kdekoľvek = rollback celku (žiadny archív bez výmazu,
žiadny výmaz bez archívu).

| Kategória (`retention_periods.category`) | Zdroj | Výber | Storage, ktorý sa NEMAŽE |
|---|---|---|---|
| `accounting_document` | `invoices`, `invoice_items`, `invoice_parties`, `invoice_tax_breakdowns`, `invoice_payments`, `invoice_events`, `invoice_advance_deductions`, `received_advance_links`, `invoice_accounting_state`, `invoice_accounting_state_log` | iba **finalizované** doklady firmy (vrátane dobropisov/ťarchopisov a záloh); koncepty sa mažú ako doteraz | — |
| `accounting_document_source` | `documents` | dokument, na ktorý odkazuje finalizovaná faktúra (`invoices.source_document_id`) — originál prijatej faktúry | `documents.storage_bucket/storage_path` |
| `einvoice_document` | `einvoice_outbound`, `einvoice_inbound` | všetky e-faktúry firmy (aj ku konceptom — XML je originál) | `einvoice-documents`: `ubl_storage_path`, `xml_storage_path`, `pdf_storage_path` |
| `einvoice_delivery_evidence` | `einvoice_events` | všetky | — |
| `accounting_handoff` | `accounting_handoff_exports`, `accounting_handoff_export_items` | všetky (iba metadáta + SHA-256; balík sa negeneruje do Storage) | — |
| (identita firmy) | `companies`, `company_legal_identities`, `company_billing_profile` | snapshot: názov, IČO/DIČ/IČ DPH, adresa, krajina, DPH status, registrácia | — |

**Ostáva mimo archívu, ako doteraz:** `public.company_terminations` (audit ukončenia, bez FK — prežije, teraz aj
`termination_mode`, `archive_id`, `archived_counts`, pri výnimke `operator_reference`, `justification`),
`public.company_export_runs` (dôkaz exportu).

**Maže sa ako doteraz (nie je potrebné uchovať):** členstvá, pozvánky, chat, vozidlá/stroje/sklad, fotky,
neúčtovné dokumenty a AI výstupy, nastavenia, koncepty faktúr, predplatné, účet používateľa (ak `delete_account`).

### Minimalizácia / pseudonymizácia

- Riadky sa ukladajú ako JSONB (`to_jsonb(row)`) **bez** stĺpcov s odkazom na používateľa: `created_by`, `updated_by`,
  `finalized_by`, `recorded_by`, `actor_user_id`, `accounted_by`, `changed_by`, `requested_by`,
  `correction_reviewed_by`, `advance_reviewed_by`, `user_id`, `client_mutation_id`, `locked_until`.
- `documents`: bez `ai_raw_output`, `extracted_fields`, `field_confidence`, `ai_model`, `note`, kategórie a stavov.
- Snapshot firmy **bez** `owner_id`, kontaktného e-mailu, IBAN, loga.
- Archív nemá FK na `auth.users` ani `companies` → výmaz účtu ho neblokuje ani nemaže.
- **Ostávajú** údaje, ktoré sú obsahom dokladu (strany faktúry vrátane mien, adries, IČO, IBAN na doklade, e-mail
  strany v `invoice_parties`, ak bol na doklade; poznámka platby; Peppol identifikátory v XML). Ich rozsah určuje
  zákon o DPH § 74 / účtovný zákon — otvorená otázka O4 nižšie.
- Každý riadok má `payload_sha256` (SHA-256 kanonického JSONB) — kontrola integrity pri exporte.

## 4. Prístup

| Kto | Prístup |
|---|---|
| anon, authenticated (owner, admin, employee, účtovník, iný tenant) | **žiadny** — bez USAGE na schému, bez grantov, bez EXECUTE; schéma nie je v Data API |
| service_role | USAGE na schému; **žiadny** priamy prístup k tabuľkám; EXECUTE iba `operator_list_archives`, `export_archive`, `set_legal_hold`, `purge_expired`. Keďže schéma nie je exponovaná v PostgREST, ide iba o priame DB pripojenie (operátorský skript) — nie o volanie z aplikácie |
| postgres (SQL editor) | všetko vyššie + `approve_retention_period` + výnimka `esblu_company_termination_synthetic_purge` |

Všetky operátorské funkcie vyžadujú `operator_ref` (tiket / číslo schválenia, regex `^[A-Za-z0-9][A-Za-z0-9_:./-]{5,119}$`)
a pri čítaní/exporte účel (≥ 10 znakov). Odmietnu kontext `anon`/`authenticated` aj cez JWT.

**Access log** (`esblu_retention.access_log`, append-only — UPDATE/DELETE/TRUNCATE blokované triggerom aj pre postgres):
`archive_created`, `list`, `export` (+ SHA-256 exportu), `legal_hold_set/clear`, `purge_dry_run`, `purge`,
`retention_period_approved`, `synthetic_test_data_purge`, `synthetic_test_data_purge_skipped`; s `db_session_user`, `invoker_role`, `jwt_role`, `operator_ref`, účelom.

**Nemennosť archívu:** `archived_records` — UPDATE iba prepočtu `retention_until` (pri schválení lehoty), DELETE iba počas
behu `purge_expired` (GUC + necommitnutý `executing` riadok `purge_runs`, rovnaký vzor ako termination — podvrhnuté GUC
nič neodomkne); `archived_companies` sa nemaže nikdy (po purge ostane minimalizovaný riadok `status = purged`).

## 5. Export pre úrad / účtovníka

```sql
-- 1. nájsť archív (logované)
select * from esblu_retention.operator_list_archives('OPS-2026-12-001', 'žiadosť DÚ č. … o predloženie dokladov', '<source_company_id>');
-- 2. export (logované, vráti JSON: snapshot firmy + záznamy po kategóriách + SHA-256 + zoznam Storage objektov)
select esblu_retention.export_archive('<archive_id>', 'OPS-2026-12-001', 'žiadosť DÚ č. … o predloženie dokladov');
```

Súbory (XML, sken) zo zoznamu `storage_objects` stiahne operátor zo Storage (service key, mimo aplikácie) a k exportu
priloží manifest SHA-256. PDF vydaných faktúr sa generujú z dát (v archíve sú všetky údaje faktúry); generátor PDF
z archívu zatiaľ nie je (otvorené O7).

## 6. Lehoty (tabuľka `esblu_retention.retention_periods`) — **PROPOSED**

| Kategória | Návrh | Kotva | Opora (na overenie CLIA / účtovníčkou) |
|---|---|---|---|
| `accounting_document` | 10 r. | koniec roka dokladu + 10 r. | z. 431/2002 § 35 ods. 2; z. 222/2004 § 76 ods. 1 |
| `accounting_document_source` | 10 r. | 〃 | 〃 (originál prijatej faktúry) |
| `einvoice_document` | 10 r. | 〃 | z. 222/2004 § 71, § 76 |
| `einvoice_delivery_evidence` | 10 r. | 〃 | z. 222/2004 § 71; oprávnený záujem (právne nároky) |
| `accounting_handoff` | 10 r. | 〃 | na posúdenie — alternatíva 5 r. (dôkaz zmluvného vzťahu) |

`retention_until = make_date(rok(document_date) + roky, 12, 31)`; `document_date` = dátum vystavenia (fallback prijatie /
finalizácia / vytvorenie). Ostrá purge maže **iba** kategórie so stavom `APPROVED`. Schválenie (iba postgres, logované,
prepočíta `retention_until` uchovaných záznamov):

```sql
select esblu_retention.approve_retention_period('accounting_document', 10, 'OPERATOR-SCHVALENIE-2026-12', 'schválené po stanovisku CLIA zo dňa …');
```

## 7. Automatická retencia (purge)

```sql
-- dry-run (default): nič nemaže, vráti počty, zapíše purge_runs + access_log
select esblu_retention.purge_expired('PURGE-2027-01');
-- simulácia k budúcemu dátumu (iba dry-run)
select esblu_retention.purge_expired('PURGE-2027-01', true, '2037-01-01');
-- ostrý beh (iba k dnešnému dátumu)
select esblu_retention.purge_expired('PURGE-2027-01', false);
-- legal hold (blokuje purge celej archivovanej firmy)
select esblu_retention.set_legal_hold('<archive_id>', true, 'daňová kontrola …', 'HOLD-2027-001');
```

Výsledok: `eligible`, `purged`, `by_category`, `skipped_legal_hold`, `skipped_unapproved_period`, `archives_closed`,
`storage_objects` (XML/skeny na výmaz zo Storage — **volajúci ich musí zmazať**; zoznam ostáva aj v `purge_runs.result`).
Firma bez zostávajúcich záznamov → `archived_companies.status = purged`, snapshot zredukovaný na krajinu.

**Plánovanie (zatiaľ NIE):** purge sa nikde nespúšťa. Možnosti po schválení lehôt:
1. Manuálne raz ročne (január) v SQL editore: dry-run → kontrola → ostrý beh → zmazanie `storage_objects` zo Storage.
2. Vercel cron route (vzor `app/api/cron/account-deletion-cleanup`, `CRON_SECRET` + `timingSafeEqual`): keďže schéma
   nie je v Data API, potrebuje public wrapper `public.esblu_retention_purge_run(…)` (service_role, s manifestom grantov
   `supabase/grants/public-data-api-grants.json`) + flag `ESBLU_RETENTION_ARCHIVE_PURGE_ENABLED` (default OFF) + mazanie
   Storage objektov z výsledku. Nie je súčasťou tejto zmeny.

## 8. Kontrolovaná výnimka — syntetické testovacie dáta

```sql
-- IBA postgres (SQL editor). service_role nemá EXECUTE; volanie s JWT (Data API) → ESBLU_OPERATOR_ONLY.
select public.esblu_company_termination_synthetic_purge(
  '<owner_user_id>'::uuid, '<company_id>'::uuid, true, 'waived',
  true,                                   -- p_synthetic_test_data_purge (povinné true)
  'OPS-2026-11-19-synthetic-cleanup',      -- p_reference (schválenie)
  'Syntetické testovacie dáta z vývoja, nie účtovné doklady — rozhodnutie prevádzkovateľa 2026-11-19.');
```

Zapíše `company_terminations.termination_mode = 'synthetic_test_data_purge'`, `operator_reference`, `justification`
(CHECK vynúti ich prítomnosť) a `access_log` akciu `synthetic_test_data_purge`. Správa sa ako pôvodný workflow
(vrátane XML v cleanup jobe). Nikdy z UI / route.

**Guard proti opakovanému purge (doplnené 2026-11-19, esblu8):** ak `company_id` už má riadok
`company_terminations` so `status = 'completed'` (akýkoľvek režim a žiadateľ — vrátane historických riadkov
s `termination_mode = null`, napr. 5 syntetických firiem vyčistených v produkcii 2026-11-19), funkcia po validácii
príznaku/referencie/odôvodnenia **nič nemaže** a vráti `already_completed: true, skipped: true` + pôvodné
`termination_id` / `archive_id` / `termination_mode`. Pokus sa zapíše do `access_log` ako
`synthetic_test_data_purge_skipped` (`details.reason = 'already_completed'`). Súbežné volania pre to isté
`company_id` serializuje `pg_advisory_xact_lock`. Implementované všeobecne, bez natvrdo zadaných ID.
Rollback tento CHECK zoznam akcií nemení (zapísané audit riadky ostávajú platné).

**Vyčistenie 2026-11-19 (5 testovacích firiem vrátane Anchar Bau, FA20260001 / TEST-2026-002):** beží v produkcii
**na pôvodných funkciách** (táto migrácia nie je nasadená) cez `esblu_company_termination_commit(…, 'waived')` podľa
`prod-cleanup-and-operator-plan-2026-11-19.md` §4 — správanie je identické s touto výnimkou. Vzniknuté riadky
`company_terminations` budú mať `termination_mode = null` (= „pred 20261121100000, výmaz“); rozhodnutie
prevádzkovateľa o syntetickom charaktere je v pláne vyčistenia a v `service-intervention-log.md`. Ak by vyčistenie
prebehlo **až po** nasadení tejto migrácie, musí ísť cez `esblu_company_termination_synthetic_purge` (bežná funkcia by
testovacie doklady archivovala).

## 9. Nasadenie a rollback

- Poradie: po `20261120100000_internal_operator_entitlement`; nasadiť cez `apply_migration` s názvom súboru (nie `db push`).
- **Brána pred nasadením:** schválené znenie UI (`settings.termination.*` v `lib/i18n/dictionaries/{sk,en,de}.ts` dnes
  tvrdí „vymazať údaje vrátane dokladov“) a `/zrusenie-uctu` — po nasadení by text nezodpovedal správaniu. Návrh v
  `docs/clia-retention-nonconformity-2026-11-19.md` (DRAFT).
- Po nasadení: `get_advisors`; overiť `has_schema_privilege('authenticated','esblu_retention','USAGE') = false`;
  že `esblu_retention` nie je v *Exposed schemas* (Dashboard → API).
- Rollback vráti pôvodný commit (**znova maže doklady**) a odstráni výnimku + purge; **archív, logy a stĺpce auditu
  nikdy nemaže**, čítanie/export archívu ostáva. Preferovaný je forward-fix.

## 10. Testy (`scripts/retention-archive-pglite-tests.ts`, 16 kontrol)

Schéma a ACL; bežné ukončenie archivuje (14 záznamov / 12 tabuliek, koncept nie, XML a sken ostávajú, maže sa iba
neúčtovná fotka); minimalizácia + SHA-256; izolácia owner/admin/employee/iný tenant/anon (tabuľky aj funkcie) a
service_role bez priameho prístupu; access log pri list/export + odmietnutie bez referencie/účelu; append-only a
nemennosť aj pre postgres, podvrhnuté GUC; idempotencia; rollback celku pri chybe; bežné zrušenie ostáva blokované;
výnimka (bez príznaku/referencie/odôvodnenia/JWT/service_role → stop; s nimi → výmaz + audit); guard opakovaného
purge (tá istá firma iným/rovnakým žiadateľom, historický riadok bez `termination_mode`, firma ukončená archívom →
`already_completed`, nič sa nezmaže, `synthetic_test_data_purge_skipped` v logu); Storage politiky a buckety pred = po
migrácii a ponechané XML/sken nečíta žiadny tenant ani anon; purge (PROPOSED sa
nemaže, schválenie iba postgres, legal hold, budúci dátum iba dry-run, maže iba po `retention_until`, uzavretie firmy,
idempotentná); rollback migrácie bez straty archívu + re-apply. Upravený `company-termination-pglite-tests.ts`
(cleanup job už neobsahuje XML).

## 11. Otvorené rozhodnutia (prevádzkovateľ / CLIA / účtovníčka)

| # | Rozhodnutie |
|---|---|
| O1 | **Právny titul Esblu uchovávať doklady zákazníka po ukončení** — Esblu je pri dokladoch zákazníka sprostredkovateľ (DPA: vrátenie alebo výmaz po skončení, čl. 28 ods. 3 písm. g GDPR „pokiaľ právo Únie alebo členského štátu nevyžaduje uchovávanie“). Povinnosť podľa § 35 ZoÚ má účtovná jednotka (zákazník). Treba potvrdiť, či a na akom základe smie / musí Esblu archív držať (zmluvný pokyn vo VOP/DPA, oprávnený záujem, alebo voliteľná služba „archív“), prípadne či archív má byť **voľbou zákazníka**. |
| O2 | Schválenie lehôt v `retention_periods` (všetky PROPOSED). |
| O3 | Či `waived` (výmaz bez exportu) má po nasadení znamenať „bez exportu, ale archív ostáva“ (implementované) alebo sa má režim zrušiť. |
| O4 | Rozsah údajov v archíve: stačí minimalizácia (bez user ID), alebo treba pseudonymizovať aj fyzické osoby na dokladoch (SZČO, e-mail strany) — pravdepodobne nie, sú obsahom dokladu. |
| O5 | Lehota a purge pre `company_terminations` a `company_export_runs` (dnes neobmedzene, návrh 5 r.) — mimo tejto zmeny. |
| O6 | Plánovanie purge (manuálne vs. cron), mazanie Storage objektov z výsledku, monitoring. |
| O7 | Generovanie PDF vydaných faktúr z archívu pri žiadosti úradu. |
| O8 | Znenie UI / `/zrusenie-uctu` / Zásady / DPA (DRAFT v CLIA briefingu) — **brána nasadenia**. |
| O9 | Či bežné `esblu_account_deletion_commit('owner')` (dnes blokované) prepnúť na rovnaký archív namiesto bloku. |
| O10 | Prílohy dokumentov (`document_attachments`) zdrojového dokladu sa dnes nearchivujú — posúdiť. |
