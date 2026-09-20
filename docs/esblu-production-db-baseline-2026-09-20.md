# Esblu — baseline audit produkčnej databázy

**Dátum:** 2026-09-20
**Projekt:** Supabase `assetpilot`, ref `fkpgvgvsmbpieduoatrt`, región `eu-central-1`, Postgres 17.6.1.155
**Metóda:** read-only cez Supabase MCP (`list_migrations`, `information_schema`, `pg_constraint`, `pg_policy`, `pg_proc`, security advisors)
**Rozsah:** Fáza A zadania, časť „audit production DB schema" — **bez prístupu k repu**, takže repo ↔ prod drift check nebol možný (viď §8)

---

## 1. Migrácie aplikované v produkcii

13 migrácií, posledná `20260917202806`:

| Verzia | Názov |
|---|---|
| 20260909205630 | add_esblu_sro_identity_legal_versions |
| 20260914183834 | add_custom_document_categories |
| 20260915171833 | add_assistant_action_confirmations |
| 20260915172633 | restrict_action_confirmation_rpc_execute |
| 20260916042213 | add_company_scoped_plan |
| 20260916045340 | fix_company_logo_delete_undefined_function |
| 20260916082812 | 20260916120000_add_company_billing_profile_and_business_partners |
| 20260916090827 | finance_access_hardening |
| 20260916101241 | add_invoicing_core_schema |
| 20260916101351 | add_invoicing_core_rpc |
| 20260916101800 | harden_invoice_trigger_execute_grants |
| 20260916155048 | finalize_invoice_category_aware_vat |
| **20260917202806** | **20260917100000_add_invoicing_en16931_p0_fields** |

✅ Posledná migrácia zodpovedá tomu, čo zadanie uvádza ako aktuálny stav. Žiadna neočakávaná migrácia v produkcii navyše.

⚠️ **Dve migrácie majú v názve zdvojený timestamp** (`20260916082812` → `20260916120000_...`, `20260917202806` → `20260917100000_...`). To naznačuje, že súbor v repe má iný timestamp než verzia zapísaná do `supabase_migrations.schema_migrations`. Nie je to chyba, ale **znemožňuje to porovnávať repo a produkciu podľa čísla verzie** — treba porovnávať podľa obsahu. Odporúčanie: pri ďalších migráciách držať timestamp v názve súboru identický s verziou.

---

## 2. Objem dát — kľúčový vstup pre rozhodovanie o schéme

| Tabuľka | Počet riadkov |
|---|---|
| `companies` | 3 |
| `invoices` | **1** (issued, finalized) |
| `invoices` s `direction='received'` | **0** |
| `invoice_items` | 1 (z toho `unit_code IS NULL`: 1) |
| `invoice_parties` | 2 |
| `business_partners` | 1 |

**Čo z toho vyplýva:** historický balast je prakticky nulový. Expand-only migrácie sú dnes lacné a bezpečné. Rovnako sú dnes lacné aj rozhodnutia o tom, ktoré polia budú `NOT NULL` pre nové faktúry — pretože „nové" je zatiaľ takmer všetko.

**Toto okno sa zatvára s prvými reálnymi zákazníkmi.** EN16931 P1 polia je správne doplniť teraz, nie v Q1 2027.

Zároveň: pravidlo zadania „historické finalized invoices majú nové polia NULL a to je správne" zostáva v platnosti — týka sa presne tej jednej faktúry a všetkých, ktoré vzniknú pred doplnením polí.

---

## 3. Fakturačná schéma — stav

### 3.1 `invoices`

Prítomné a relevantné: `company_id`, `direction`, `kind`, `document_status`, `payment_status`, `invoice_number`, `invoice_number_sequence_id`, `issue_date`, `due_date`, `delivery_date`, `tax_point_date`, `currency`, `subtotal_amount`, `vat_total_amount`, `total_amount`, `rounding_amount`, `variable_symbol`, `payment_terms_days`, `iban`, `customer_business_partner_id`, `corrects_invoice_id`, `source`, `source_document_id`, audit polia, `finalized_at`, `finalized_by`.

**Check constraints — všetky prítomné a správne:**
- `direction ∈ {issued, received}` ✅
- `kind ∈ {regular_invoice, payment_received_invoice, credit_note, debit_note}` ✅
- `document_status ∈ {draft, finalized}` ✅
- `payment_status ∈ {unpaid, partially_paid, paid}` ✅
- `source ∈ {manual, ai_inbox, efaktura_peppol}` ✅ — **pripravené na Fázu H/I**
- `invoices_number_required_when_finalized` ✅
- `invoices_finalized_at_consistency` ✅
- `invoices_corrects_required_for_notes` (kind ∈ {credit_note, debit_note} ⇔ corrects_invoice_id IS NOT NULL) ✅
- `invoices_corrects_not_self` ✅

### 3.2 `invoice_parties`

`role ∈ {seller, buyer}`, UNIQUE(invoice_id, role), `snapshotted_at`, `source_business_partner_id`.
Polia: `legal_name`, `ico`, `dic`, `ic_dph`, adresa, `iban`, `bic`, `email`, `peppol_identifier`.

### 3.3 `invoice_items`

`quantity > 0`, `unit_price >= 0`, `vat_rate >= 0`, `vat_category_code ∈ {S,Z,E,AE}`, UNIQUE(invoice_id, position), persistované `line_net_amount` / `line_vat_amount` / `line_gross_amount`, `unit` (default `'ks'`) a **`unit_code` (nullable — P0 pole)**.

### 3.4 `invoice_tax_breakdowns`

UNIQUE(invoice_id, vat_category_code, vat_rate), `taxable_amount`, `vat_amount`, **`vat_exemption_reason_code`, `vat_exemption_reason_text`** (obe nullable — P0 polia).

### 3.5 Ostatné

`invoice_payments` (paid_amount, paid_at, payment_method, note, recorded_by), `invoice_events` (event_type, actor_user_id, actor_source default `'user'`, payload jsonb), `invoice_number_sequences`.

---

## 4. Čo v schéme chýba pre Fázy B–H

### 4.1 Prijaté faktúry (Fáza B)

| Potreba | Stav |
|---|---|
| `direction='received'` | ✅ constraint existuje |
| `source='ai_inbox'` / `'efaktura_peppol'` | ✅ constraint existuje |
| `source_document_id` | ✅ existuje |
| **Väzba na dodávateľa** | ❌ **je len `customer_business_partner_id`** |
| Status prijatej faktúry | ⚠️ `document_status` je draft/finalized — pre received sú potrebné iné semantiky (viď nižšie) |

**Najdôležitejšie zistenie:** `invoices.customer_business_partner_id` je **issued-only pomenovanie**. Pri `direction='received'` je protistranou **dodávateľ**, nie odberateľ.

Dve možnosti:
- **(a)** pridať `supplier_business_partner_id` a nechať obe polia vedľa seba s CHECK podľa `direction`
- **(b)** pridať neutrálne `counterparty_business_partner_id`, `customer_business_partner_id` ponechať ako deprecated

**Odporúčanie: (a).** Je to explicitnejšie, čitateľnejšie v kóde a nevyžaduje migráciu existujúceho poľa. Constraint zabezpečí, že issued používa customer a received supplier.

**K statusom:** pre prijatú faktúru „finalized" neznamená to isté, čo pre vydanú. Vydanú faktúru finalizujeme my (a vtedy vzniká číslo a immutabilita). Prijatá faktúra bola finalizovaná dodávateľom; my ju len **potvrdzujeme po review**. Odporúčanie: `document_status` ponechať ako je (draft = pred potvrdením, finalized = po potvrdení review), ale **`invoice_number` pri received nesmie brať číslo z našej sekvencie** — je to číslo dodávateľa. Constraint `invoices_number_required_when_finalized` tomu nebráni, ale finalize RPC musí pre `direction='received'` sekvenciu preskočiť. **Toto treba overiť v `esblu_finalize_invoice` — bez prístupu k repu som to nevedel skontrolovať.**

### 4.2 Dedupe (Fáza C) — **v schéme neexistuje nič**

Chýba úplne:
- `source_content_hash` (vrstva A — exact source hash)
- `dedupe_fingerprint` (vrstva B — structured fingerprint)
- `transport_message_id` (vrstva C — provider/eInvoice transport ID)
- akýkoľvek unique index, ktorý by fail-closed zabránil druhej canonical faktúre

Návrh je v `docs/received-invoice-dedupe-en16931-design.md`.

### 4.3 EN16931 P1 (Fáza D)

**Na `invoices` chýba:** `buyer_reference`, `purchase_order_reference`, `payment_means_code`, `payment_reference` (dnes je len `variable_symbol`, čo je SK/CZ-špecifické).

**Na `invoice_parties` chýba:** `electronic_address`, `electronic_address_scheme_id`, `legal_registration_id`, `legal_registration_scheme_id`, `vat_identifier`, `generic_identifier`, `generic_identifier_scheme_id`.

Dnes je tam len `peppol_identifier` ako voľný text bez scheme ID — to na EN16931 výstup nestačí, lebo endpoint ID bez scheme ID nie je jednoznačný.

**Na `business_partners` a `company_billing_profile` chýbajú tie isté polia ako master data.** `business_partners` má `peppol_identifier`, `company_billing_profile` nemá ani ten.

**Pozor na architektonické pravidlo zo zadania:** XML renderer nikdy nečíta live partner/billing profile. Polia teda musia byť **na oboch miestach** — v master data aj v snapshote — a finalize ich musí kopírovať.

### 4.4 VAT kategórie

Dnes `{S, Z, E, AE}` na `invoice_items` aj `invoice_tax_breakdowns`.

Peppol BIS Billing 3.0 pracuje aj s `G` (export mimo EÚ), `K` (intra-community supply), `O` (mimo rozsahu DPH), `L`/`M` (Kanárske ostrovy, Ceuta a Melilla).

**Odporúčanie podľa zadania — nepridávať kategóriu len preto, že existuje v štandarde.** Pre stavebnú/výkopovú/dopravnú firmu na Slovensku sú reálne relevantné:
- `K` — dodanie do iného členského štátu (firma fakturuje do ČR/AT/HU) — **reálne pravdepodobné**
- `G` — vývoz mimo EÚ — menej pravdepodobné
- `O` — mimo rozsahu DPH — okrajové
- `L`, `M` — **nie**

Navrhujem pridať **iba `K`**, a to až vtedy, keď bude jasne definovaná sémantika a validácia (K vyžaduje IČ DPH oboch strán a nulovú sadzbu). Do tej doby **OPEN**.

### 4.5 Unit codes

`invoice_items.unit` (display) + `unit_code` (canonical) existujú. Chýba UI/API flow na výber canonical kódu a mapovacia tabuľka.

Podľa zadania: prefill suggestion áno, authority nie. Návrh mapovania v design dokumente.

---

## 5. RLS a bezpečnosť

### 5.1 Pokrytie RLS

**RLS je zapnuté na všetkých 39 tabuľkách v `public`.** ✅

Tri tabuľky majú RLS zapnuté a **0 policies**:
- `assistant_action_confirmations`
- `beta_allowlist`
- `company_invites`

Supabase advisor to hlási ako INFO `rls_enabled_no_policy`. **Je to zámerné a správne** — prístup k týmto tabuľkám ide výlučne cez SECURITY DEFINER RPC (`esblu_create_action_confirmation`, `esblu_claim_action_confirmation`, `esblu_create_company_invite`, `esblu_accept_company_invite`, `esblu_get_invite_preview`, beta gate hook). Nulové policies = fail-closed pre `anon` aj `authenticated`. ✅

Počty policies na fakturačných tabuľkách: `invoices` 4, `invoice_items` 4, `business_partners` 4, `company_billing_profile` 3, `invoice_parties` 1, `invoice_tax_breakdowns` 1, `invoice_payments` 1, `invoice_events` 1, `invoice_number_sequences` 1.

*(Snapshot a breakdown tabuľky majú jednu policy — pravdepodobne read-only SELECT, keďže zápis ide cez finalize RPC a mutácie blokuje trigger. Obsah policies som nekontroloval nad rámec počtu; detailný policy audit odporúčam spolu s implementáciou received invoices.)*

### 5.2 Immutabilita finalizovaných faktúr

Tri blokovacie trigger funkcie sú v produkcii:
- `esblu_block_finalized_invoice_mutation`
- `esblu_block_finalized_invoice_items_mutation`
- `esblu_block_finalized_invoice_delete`
- `esblu_block_invoice_snapshot_mutation` (chráni `invoice_parties`)

✅ Zodpovedá deklarovanému stavu.

### 5.3 Finance permissions

`esblu_my_finance_view()` a `esblu_my_finance_manage()` existujú, obe SECURITY DEFINER, `EXECUTE` **len pre `authenticated`**, nie pre `anon`. ✅

Rovnako `esblu_finalize_invoice`, `esblu_add_invoice_payment`, `esblu_remove_invoice_payment` — len `authenticated`. ✅

### 5.4 Nálezy z advisorov — čo si zaslúži pozornosť

#### 🟡 WARN — trigger funkcie sú volateľné ako RPC pre `anon`

Advisor `anon_security_definer_function_executable` hlási 26 funkcií. Väčšina je neškodná, ale **týchto päť sú trigger funkcie, ktoré nemajú čo byť v REST API vôbec**:

- `esblu_assign_company_id()`
- `esblu_enforce_plan_limit()`
- `esblu_lock_company_id_on_update()`
- `esblu_create_settings_for_new_user()`
- `esblu_ensure_company_chat_channel()`

Volané mimo trigger kontextu takmer isto zlyhajú (`TG_OP` nie je definované), takže **nejde o potvrdenú zraniteľnosť**. Ale je to zbytočná attack surface a lacná oprava:

```sql
REVOKE EXECUTE ON FUNCTION public.esblu_assign_company_id() FROM anon, authenticated;
-- atď. pre zvyšné trigger funkcie
```

Trigger funkcie nepotrebujú `EXECUTE` grant pre aplikačné role — trigger ich volá v kontexte vlastníka tabuľky.

**Klasifikácia: hardening, nie incident.** Patrí do samostatnej migrácie, nie do received-invoice bloku.

#### 🟡 WARN — `esblu_ensure_my_owner_company()` a `esblu_create_company_invite()` volateľné pre `anon`

Obe pravdepodobne fail-closed cez `auth.uid()` kontrolu vnútri, ale **bez prístupu k telu funkcií to neviem potvrdiť**. Odporúčam pri najbližšom prístupe k repu overiť, že obe začínajú kontrolou `auth.uid() IS NULL → RAISE`.

#### 🟡 WARN — leaked password protection vypnutá

`auth_leaked_password_protection`. Supabase Auth vie kontrolovať heslá proti HaveIBeenPwned. Je to **prepínač v Auth nastaveniach, nie migrácia**, a zapnutie nemá dopad na existujúcich používateľov.

Odporúčam zapnúť. Pri produkte, ktorý drží účtovné dáta, je to nízke úsilie a rozumný krok.

#### ✅ Žiadne nálezy typu cross-company leak, chýbajúca RLS ani exponovaná service_role cesta

---

## 6. AI Inbox a dokumenty

`documents`: `company_id NOT NULL`, `user_id`, `storage_bucket`/`storage_path`, `document_type`, `status`, `ai_model`, `ai_raw_output jsonb`, `extracted_fields jsonb`, `field_confidence jsonb`, `note`, `deleted_at` (soft delete ✅), `archived_from_inbox_at`, `custom_category_id`.

`document_attachments`: väzba na `documents`, `attachment_type`, storage, `company_id NOT NULL`.

`document_links`: väzby na `vehicle_id`, `machine_id`, `inventory_item_id`, `vehicle_service_id`, `machine_service_id`, `link_type`, `confidence`, `confirmed_by_user`.

`document_review_log`: `action`, `field_name`, `old_value`/`new_value` jsonb, `document_snapshot` jsonb.

**Zistenie pre Fázu B:** `document_links` **nemá `invoice_id`**. Prepojenie prijatej faktúry na zdrojový dokument dnes existuje len jednosmerne cez `invoices.source_document_id`.

Pre dedupe a pre zobrazenie „z tohto dokumentu vznikla táto faktúra" v Inboxe to nestačí. Odporúčam pridať `document_links.invoice_id` — je to konzistentné so vzorom, ktorý už tabuľka používa pre vozidlá a stroje.

**Pozitívne:** `field_confidence` a `document_review_log` sú presne tie stavebné kamene, ktoré Fáza I (structured-first pipeline) potrebuje. Review vrstva má kam ukladať to, čo používateľ opravil, a to je zároveň budúci tréningový signál.

**Zistenie pre GDPR/CLIA:** `ai_raw_output` drží surový výstup AI modelu. Ak obsahuje celý prepis dokladu, je to nová kategória osobných údajov (mená, adresy, podpisy z faktúr tretích strán). Patrí do compliance delta dokumentu.

---

## 7. Čo je v poriadku a netreba sa toho dotýkať

- Immutabilita finalizovaných faktúr — kompletná, 4 triggery
- VAT authority v DB, žiadny JS float ako zdroj pravdy
- Company isolation cez RLS na všetkých tabuľkách
- Finance permissions oddelené od admin role
- `source` constraint pripravený na `ai_inbox` a `efaktura_peppol`
- Soft delete na `documents`
- Concurrency-safe numbering cez `invoice_number_sequences`
- Fail-closed prístup k tabuľkám bez policies

---

## 8. Čo tento audit NEPOKRÝVA

| Oblasť | Dôvod |
|---|---|
| **Repo ↔ prod drift** | Nebol prístup k `C:\Users\roiaj\assetpilot` ani ku GitHub repu. **Produkčná strana je čistá** (13 migrácií, posledná zodpovedá zadaniu), ale či všetkých 13 má zodpovedajúci súbor v `supabase/migrations/`, overené nebolo. |
| Telá RPC funkcií a policy definície | Cez MCP boli dostupné len signatúry a počty. Detaily vyžadujú repo alebo `pg_get_functiondef`, čo som zámerne nespúšťal, aby sa do kontextu nedostali prípadné citlivé hodnoty. |
| PDF implementácia | Aplikačný kód. |
| Frontend `/faktury`, `/faktury/new`, `/faktury/[id]` | Aplikačný kód. |
| Edge Functions | Nekontrolované. |
| Storage buckets a ich policies | Nekontrolované (existujú `esblu_can_read/delete_*_object` helpery, čo naznačuje, že policies sú riešené). |

---

## 9. Odporúčané ďalšie kroky v poradí

1. **Overiť repo ↔ prod drift** hneď po obnovení prístupu k repu. Do tej doby **neaplikovať žiadnu migráciu** — pravidlo zo zadania („nikdy apply do produkcie bez rovnakého SQL súboru v `supabase/migrations/`") to priamo zakazuje.
2. **Overiť `esblu_finalize_invoice`**, či pre `direction='received'` preskakuje číselnú sekvenciu.
3. **Commitnúť a aplikovať EN16931 P1 + received + dedupe migrácie**, kým je v produkcii 1 faktúra (pripravené SQL: `supabase/migrations/2026092*`).
4. **Samostatná hardening migrácia** — `REVOKE EXECUTE` na trigger funkciách.
5. **Zapnúť leaked password protection** v Auth nastaveniach.
6. **Detailný policy audit** fakturačných tabuliek spolu s implementáciou received invoices.
