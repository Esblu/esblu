# Ukončenie firmy s účtovnými dokladmi — termination / DPA delete workflow (2026-11-12)

Zdroj: ChatGPT re-audit VOP 1.2 (bod 2), VOP 1.2 čl. 20.2 / 20.6, DPA 1.3 (vrátenie alebo výmaz po skončení služieb).
Migrácia `20261112110000_company_termination_workflow.sql`, rollback `supabase/rollback/20261112110000_…_rollback.sql`.
Stav: **staging only**. Produkcia: HARD STOP do finálneho release checku.

## 1. Dependency audit

### 1.1 Ochranné triggery (finalizované doklady / e-faktúry)

| # | Trigger (tabuľka) | Funkcia | Pôvodne | Po zmene |
|---|---|---|---|---|
| 1 | `esblu_invoices_immutability_delete_guard` (invoices, BEFORE DELETE) | `esblu_block_finalized_invoice_delete` | DELETE finalizovanej faktúry vždy zakázaný (aj service_role) | DELETE povolený **iba** počas termination transakcie |
| 2 | `esblu_invoice_items_immutability_guard` (invoice_items, I/U/D) | `esblu_block_finalized_invoice_items_mutation` | zmeny riadkov finalizovanej faktúry zakázané | iba DELETE počas termination; INSERT/UPDATE zakázané vždy |
| 3 | `esblu_invoice_parties_immutability_guard` (invoice_parties, U/D) | `esblu_block_invoice_snapshot_mutation` | zakázané pre finalizovanú faktúru | iba DELETE počas termination |
| 4 | `esblu_invoice_tax_breakdowns_immutability_guard` (invoice_tax_breakdowns, U/D) | `esblu_block_invoice_snapshot_mutation` | ako #3 | ako #3 |
| 5 | `esblu_advance_deductions_immutability` (invoice_advance_deductions, I/U/D) | `esblu_block_finalized_advance_deductions` | zakázané pre finalizovanú faktúru | iba DELETE počas termination |
| 6 | `esblu_invoice_events_append_only` (invoice_events, U/D) | `esblu_invoice_events_append_only` | append-only vždy | iba DELETE počas termination |
| 7 | `esblu_einvoice_events_guard` (einvoice_events, I/U/D) + `…_no_truncate` (TRUNCATE) | `esblu_einvoice_events_guard` | DELETE iba v kaskáde (depth > 1) | + DELETE počas termination; TRUNCATE zakázaný vždy |
| 8 | `esblu_received_advance_link_guard` (received_advance_links, I/U/D) | `esblu_received_advance_link_guard` | DELETE pri finalizovanej faktúre zakázaný | iba DELETE počas termination |
| 9 | `esblu_retain_finance_documents` (documents, BEFORE DELETE) | `esblu_retain_finance_documents` | finančné dokumenty: mazanie iba service_role / operátor | **bez zmeny** (workflow beží ako service_role) |
| 10 | `esblu_retain_delivery_notes` (ai_evidence, BEFORE DELETE) | `esblu_retain_delivery_notes` | dodacie listy: iba service_role / operátor | **bez zmeny** |

Ostatné DELETE triggery v reťazci (bez zmeny): `subscription_accounts_delete_guard`, `billing_checkout_sessions_delete_guard`
(predplatné — kontroluje aj route, aktívne predplatné = stop), `esblu_archive_legal_acceptance` (archív dôkazu prijatia VOP/DPA),
`esblu_enqueue_media_deletion` (AFTER, fronta médií), `esblu_legal_documents_no_delete` (netýka sa firmy).

**Výnimka nie je globálny bypass:** `esblu_company_termination_in_progress()` je true iba ak (a) transakčne lokálne
nastavenie `esblu.company_termination_id` ukazuje na (b) riadok `company_terminations` so stavom `executing`. Taký riadok
vzniká iba vo vnútri `esblu_company_termination_commit` a pred koncom tej istej transakcie prejde na `completed`
→ nikdy nie je commitnutý ako `executing`, iná session ho nevidí. Podvrhnuté GUC (aj service_role) nič neodomkne (test).

### 1.2 Cudzie kľúče (poradie výmazu)

- `companies` ← ON DELETE **RESTRICT**: ai_evidence, chat_* (5), document_attachments, document_links, document_review_log,
  documents, inventory_items/photos, machine_photos/services, machines, vehicle_photos/services/vignettes, vehicles
  → maže explicitne existujúci `esblu_owner_delete_company` (child → parent).
- `companies` ← **CASCADE**: 37 tabuliek (billing, entitlements, invoices, einvoice_*, push, notification, AI usage, export logy …);
  **SET NULL**: billing_events, billing_store_reports (vlastné záznamy Esblu o platbách — ostávajú bez väzby na firmu).
- `invoices` ← **RESTRICT**: einvoice_outbound.invoice_id, invoice_items.advance_invoice_id; **NO ACTION**:
  invoice_advance_deductions.advance_invoice_id, invoices.corrects_invoice_id; `business_partners` ← RESTRICT invoices.supplier_…
- `einvoice_inbound/outbound` ← NO ACTION einvoice_events.
- Preto termination maže v poradí: einvoice_events → einvoice_outbound → einvoice_inbound → received_advance_links →
  invoice_advance_deductions → invoice_items → invoice_events / parties / tax_breakdowns → invoices (jeden príkaz — samoväzba
  corrects_invoice_id sa overí na konci príkazu) → `esblu_account_deletion_commit('owner')` (zvyšok firmy, partneri kaskádou).

### 1.3 Storage

Ciele sa zbierajú v tej istej transakcii PRED výmazom riadkov: documents, document_attachments, ai_evidence,
machine/inventory/vehicle photos, company-logos, chat_attachments (existujúci zber) + **einvoice-documents** (XML prijatých
a odoslaných e-faktúr — nové). Cleanup job (`account_deletion_cleanup_jobs`) ich maže až po commite; zlyhanie Storage = job
ostáva `pending` → retry cron `/api/cron/account-deletion-cleanup` (exponenciálny backoff, idempotentné).

### 1.4 Ostatné kategórie

partners, vehicles, machines, inventory, chat, attachments — existujúci owner výmaz (bez zmeny); AI/kontext
(assistant_*, ai_*_usage) — kaskáda; push/notification/subscription technické dáta — kaskáda (aktívne predplatné blokuje
route aj DB guard); auditné / log tabuľky firmy (invoice_accounting_state_log, document_download_events, export logy,
einvoice_webhook_events) — kaskáda; `legal_acceptance_evidence` — archív dôkazu prijatia VOP/DPA ostáva (5 r.).

## 2. Workflow

1. **Nastavenia → Zrušiť firmu** (owner). Preflight zistí blokáciu `FINALIZED_ACCOUNTING_DOCUMENTS` / `EINVOICE_RECORDS`
   → namiesto bežného zrušenia sa zobrazí termination panel. `EINVOICE_PROVIDER_ENROLLED` naďalej blokuje (najprv ukončiť
   registráciu u providera).
2. **Export** (`POST /api/company/export`, owner-only): údaje JSON + CSV a súbory v dávkach (ZIP, SHA-256).
3. Owner zvolí `exported` (export prevzal) alebo `waived` (výmaz bez exportu), potvrdí nevratnosť, napíše `ZRUŠIŤ FIRMU`,
   pri bežiacom zaplatenom období potvrdí prepadnutie.
4. Route (`/api/account/delete`): auth, aktívna firma zo servera, owner, fráza, owner_id, predplatné (fail closed) →
   `esblu_company_termination_commit` (service_role) → JEDNA transakcia → Storage z cleanup jobu.
5. Zlyhanie: rollback celku; `esblu_company_termination_record_failure` zapíše iba kód chyby (audit).
6. Opakovanie / dvojité kliknutie: zámok riadku firmy serializuje; po úspechu `already_completed` (nič ďalšie sa nemaže).

**Rozlíšenie údajov:** zákaznícke údaje (Esblu = sprostredkovateľ) sa vymažú. Vlastné údaje Esblu na vlastnom právnom
základe ostávajú: `company_terminations` (identifikátory, stav, režim exportu, agregované počty — bez obsahu, 5 r. ako dôkaz
zmluvného vzťahu), `legal_acceptance_evidence` (dôkaz prijatia VOP/DPA, 5 r.), `billing_events` / `billing_store_reports`
(SET NULL — evidencia platieb Esblu podľa účtovných predpisov Esblu).

## 3. Rollback / forward-fix

- Rollback súbor vráti 7 funkcií do pôvodného znenia a odstráni termination funkcie; tabuľku `company_terminations` ponechá,
  ak obsahuje auditné záznamy. Overené v PGlite (rollback + 2× re-apply).
- Forward-fix: chyba vo workflow → nová migrácia `create or replace` príslušnej funkcie; triggery sa nemenia. Zlyhané pokusy
  sú v `company_terminations` (status `failed`, kód) a v logoch Vercel (iba kód).
- Neúplné Storage mazanie: `account_deletion_cleanup_jobs` (`storage_status = pending`, `last_error_code`) → cron retry;
  ručný zásah zapísať do `docs/ops/service-intervention-log.md`.

## 4. Testy

`npm run test:company-termination-db` (12): ochrana mimo workflow (aj service_role), podvrhnuté GUC, bežné zrušenie blokované,
owner-only + klient bez EXECUTE, potvrdenie exportu, registrácia u providera, **zlyhanie uprostred → žiadny partial delete**,
retry → úspech (Storage ciele vrátane XML), izolácia firmy B, dvojité spustenie → already_completed, audit bez klientského
prístupu, rollback + re-apply. `npm run test:company-termination` (7): export (rozsah, dávky, cesty, CSV), owner-only route,
wiring route/UI, guardy, kontakt.

## 5. Zostávajúce riziká

- Retencia `company_terminations` (5 r.) zatiaľ nie je v retenčnej purge (purge je vypnutá flagom) — doplniť pri jej aktivácii.
- Veľmi veľké firmy: export súborov po 100 kusoch v jednej funkcii (limit času/pamäte Vercel) — pri desaťtisícoch súborov
  pomalé; výmaz DB v jednej transakcii — pri extrémnom objeme dlhší zámok firmy.
- Storage mazanie je „eventually consistent“ (DB okamžite, súbory po retry), čo je zámerný model existujúceho výmazu.
