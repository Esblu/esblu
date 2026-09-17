# Esblu — EN16931 / eFaktúra canonical model: GAP ANALYSIS (Fáza 3B)

**Dátum:** 17. september 2026
**Status:** AUDIT ONLY. Žiadny provider, žiadne odosielanie, žiadny produkčný XML renderer, žiadny XML download button. Implementované boli výhradne 2 minimálne, nullable, expand-only schema polia klasifikované ako P0 (bod 6 nižšie) — nič iné sa nemenilo (žiadny provider výber, žiadny RLS zásah, žiadna zmena finalize RPC logiky, žiadna zmena existujúcich právnych textov).
**Nadväzuje na:** `docs/invoicing-efaktura-architecture-2026-09-15.md` (Fáza 0, podmienečne schválená používateľom 15.9.2026) — tento dokument je jej priamym pokračovaním ("Fáza 5: kompletná EN16931 business-term matica", tam avizovaná), teraz preznačeným ako Fáza 3B. Právne zistenia z Fázy 0 (§85o, §76a, §71 ods.1 písm.b, 5-corner Peppol CTC model, SK TDD, PDS nie je jediný kanál, faktúra k prijatej platbe JE daňový doklad, proforma NIE JE modelovaná v `invoices`) sa týmto dokumentom nepresahujú duplicitne — sú prevzaté ako platné a rozšírené o technickú EN16931/Peppol maticu, ktorá vo Fáze 0 chýbala.

## Ako čítať tento dokument

Každý riadok mapovacej matice má **Status**: `COVERED` / `PARTIAL` / `MISSING` / `NOT APPLICABLE` / `NEEDS LEGAL CONFIRMATION`, a gapy majú **Action**: `P0` (blocker pre validný EN16931/eInvoice dokument) / `P1` (podmienené/vysoká hodnota, potrebné pred provider sandboxom) / `P2` (voliteľné/budúce).

**Dôležitá metodická poznámka k BT/BG kódom:** Presné číslovanie EN16931 Business Terms bolo overované primárne cez oficiálne zdroje (docs.peppol.eu, ec.europa.eu/digital-building-blocks). Pri niekoľkých menej centrálnych termoch (referencie, delivery, kontakt, allowances/charges) web-fetch nástroj vrátil **vzájomne si odporujúce číslovanie** naprieč pokusmi (pravdepodobne artefakt AI-sumarizácie zložitých stromových/tabuľkových stránok, nie chyba zdroja samotného) — tam, kde som si číslom kódu **nebol na 100 % istý**, je to v matici explicitne označené `(BT/BG kód — OVERIŤ pred XML mapovaním)` namiesto tvrdenia neoverenej hodnoty ako faktu. Toto je zámerné dodržanie pravidla zadania "NEVYMYSLI mapping" — samotný **názov/sémantika** business termu a **Status/Action** klasifikácia sú spoľahlivé nezávisle od presného čísla kódu; presné číslo je až vec finálneho XML mapperu (Fáza 5+), ktorý sa v tejto fáze nepíše.

---

## 1. Oficiálne zdroje použité

| Zdroj | Typ | Čo potvrdzuje |
|---|---|---|
| [EN 16931 compliance](https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108950/EN+16931+compliance) | Oficiálny EK | 3-úrovňový compliance model (document/implementation/specification level) |
| [Registry of supporting artefacts to implement EN16931](https://ec.europa.eu/digital-building-blocks/sites/spaces/DIGITAL/pages/467108974/Registry+of+supporting+artefacts+to+implement+EN16931) | Oficiálny EK | Validačné artefakty pre UBL 2.1 + CII 16b, aktuálna verzia 1.3.16; EAS/VATEX code listy spravuje DIGITAL |
| [Technical guidance for tax codes in EN 16931 (PDF, v1)](https://ec.europa.eu/digital-building-blocks/sites/download/attachments/467108974/eInvoicing%20technical%20guidance%20document_v1.pdf) | Oficiálny EK | VATEX/VAT category technické usmernenie (referencované, nie plne fetchnuté) |
| [Peppol BIS Billing 3.0 — May 2026 Release](https://docs.peppol.eu/poacc/billing/3.0/) | Oficiálny OpenPeppol | Aktuálna implementovaná verzia, UBL 2.1, väzba na EN16931:2017 |
| [Peppol BIS Billing 3.0 — VATEX code list](https://docs.peppol.eu/poacc/billing/3.0/codelist/vatex/) | Oficiálny OpenPeppol | Presné VATEX kódy vrátane VATEX-EU-AE + BR-AE-10 |
| [Peppol BIS Billing 3.0 — bis overview](https://docs.peppol.eu/poacc/billing/3.0/bis/) | Oficiálny OpenPeppol | UNTDID 1001 typy dokladov (380/381), payment means kódy, EAS/ICD schémy |
| [Finančná správa SR — e-Faktúra](https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/e-faktura) | Oficiálny SK | Kto musí vystavovať/prijímať, dátumy, B2B/B2G/B2C |
| [FS FAQ 9/DPH/2025/IM (26.8.2026, PDF)](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Zverejnovanie_dok/Aktualne/DPH/2026/2026.08.26_009_DPH_2025_IM_FaQ_eFaktura.pdf.pdf) | Oficiálny SK, priebežne aktualizovaný FAQ | Formát (EN16931/UBL/CII), Digitálny poštár, eReporting do 30.6.2030, zrušenie KV DPH od 1.7.2030 |
| `docs/invoicing-efaktura-architecture-2026-09-15.md` (interný, Fáza 0) | Interný, už použil slov-lex + financnasprava.sk priamo | §85o/§76a/§71, 5-corner CTC + SK TDD, PDS nie je jediný kanál, payment_received_invoice = daňový doklad |

**Sekundárne zdroje použité VÝHRADNE na dopočet technického kontextu (nikdy ako autorita pre mapping, v súlade so zadaním):** genorma.com, finbite.eu, eu-einvoicing.com — použité len na dátumy/čísla publikácie EN 16931-1:2026, nie na business-term mapping.

## 2. Stav normy — 2017 vs. 2026

- **EN 16931-1:2026** schválená CEN 13.3.2026, publikovaná 18.3.2026 — **nahrádza EN 16931-1:2017+A1:2019**. Národné normalizačné orgány ju musia zaviesť/potvrdiť do 30.9.2026; konfliktné národné normy musia byť stiahnuté do 31.3.2029.
- **2017 edícia je formálne stiahnutá, ale zostáva compliant počas prechodného obdobia** — konkrétny migračný plán (kto/dokedy prejde na 2026) **nie je v žiadnom skúmanom zdroji definitívne stanovený** (potvrdené aj sekundárnym zdrojom, aj chýbajúcou zmienkou na oficiálnych EK stránkach EN16931 registry, ktoré k dátumu tohto auditu hovoria výhradne o 2017-based artefaktoch).
- **Obsah zmeny:** 2026 revízia pridáva **52 nových business termov** (164→216) a **7 nových business groups** (32→39), zamerané na "bundled deliveries, multi-purchase-order invoices, richer payment/tax exemption detail", explicitne navrhnuté ako **"ViDA-ready"** pre cezhraničné Digital Reporting Requirements od 2030. **Presný zoznam** týchto 52 nových termov nebol v rámci tohto auditu získaný z primárneho zdroja (CEN norma je platená/nie je voľne publikovaná) — OPEN, netvrdím konkrétne nové BT čísla.
- **Peppol BIS Billing 3.0 (aktuálny máj/august 2026 release) je AKTUÁLNE stále postavený na EN16931:2017** ("CIUS built on the CEN/EN 16931:2017 standard") — **2026 a Peppol bežia na paralelných, nezávislých tratiach**, migrácia Peppolu na 2026 model **nie je potvrdená ani naplánovaná v skúmaných zdrojoch**.
- **Dôsledok pre Esblu:** Keďže (a) slovenská eFaktúra 2027 povinnosť explicitne cituje formát "Peppol BIS/EN16931 cez UBL 2.1 alebo CII" a (b) Peppol BIS Billing 3.0 dnes implementuje 2017 model, **cieľom pre XML mapper (budúca Fáza 5) musí byť aktuálne EN16931:2017 (cez Peppol BIS Billing 3.0 CIUS), NIE 2026** — 2026 revízia sa sleduje ako budúci, zatiaľ nezáväzný cieľ. Kanonický `invoices` model v Esblu (bod 5 nižšie) je navrhnutý sémanticky syntax- aj verzia-neutrálne (žiadne pole nepredpokladá konkrétnu XML syntax ani konkrétnu revíziu), takže migrácia na 2026 model neskôr **nevyžaduje prerobenie DB modelu**, iba úpravu budúceho XML mapovacieho kódu — v súlade s hlavným pravidlom zadania.

## 3. Peppol BIS aktuálny cieľ

Peppol BIS Billing 3.0 (May 2026 Release) — UBL 2.1 syntax, EN16931:2017-based CIUS. Podporované business dokumenty: **Invoice (UNTDID 1001 kód 380)** a **CreditNote (kód 381)** ako samostatné UBL root dokumenty. Debit note **nemá vlastný, samostatne dokumentovaný Peppol BIS Billing 3.0 proces** (pozri bod 9.3 nižšie — OPEN).

## 4. Slovensko — cieľ k 1.1.2027

Zhoduje sa s Fázou 0 aj s nezávisle overeným FAQ 9/DPH/2025/IM (26.8.2026): platitelia DPH musia **vystavovať** eFaktúry pri domácich B2B/B2G dodávkach od 1.1.2027; **prijímať** musí vedieť každá právnická osoba/podnikateľ vrátane neplatiteľov DPH; B2C vylúčené; formát EN16931 cez UBL 2.1 alebo CII XML; doručenie cez certifikovaného "Digitálneho poštára" na Peppol sieti (FS = Peppol Authority pre SK); eReporting automaticky splnený doručením cez PDS do 30.6.2030, KV DPH sa ruší od 1.7.2030; opravné doklady musia odkazovať na pôvodnú faktúru (BT-25 ekvivalent).

---

## 5. Aktuálny Esblu canonical model (zhrnutie auditu)

Audit vykonaný priamo nad produkčnou DB (`fkpgvgvsmbpieduoatrt`) a kódom (`lib/invoices.ts`, `lib/invoicing/vat-engine.ts`, `lib/invoicing/pdf-renderer.tsx`, migrácia `esblu_finalize_invoice`), 17.9.2026.

**Tabuľky:** `invoices`, `invoice_items`, `invoice_parties` (immutable snapshot, vzniká presne raz pri finalize), `invoice_tax_breakdowns` (normalizovaná, agregovaná per kategória×sadzba), `invoice_number_sequences` (concurrency-safe, 3 nezávislé série: `regular`/`credit_note`/`debit_note`), `invoice_payments`, `invoice_events`, `company_billing_profile`, `business_partners`.

**Kľúčové vlastnosti, ktoré už zodpovedajú EN16931 princípom bez zmeny:**
- Immutable snapshot strán (`invoice_parties`) oddelený od mutable master dát (`business_partners`/`company_billing_profile`) — presne princíp "finalizovaná faktúra sa nikdy neopiera o live master data".
- `invoice_tax_breakdowns` = normalizovaná realizácia BG-23 VAT breakdown (agregácia per kategória+sadzba, BR-CO-17 pravidlo už replikované — sadzba sa aplikuje na súčet základu, nie na súčet už zaokrúhlených súm).
- `corrects_invoice_id` (self-FK) + DB CHECK (`invoices_corrects_required_for_notes`) = priama realizácia BT-25 Preceding Invoice Reference, vynútená na DB úrovni, nie len UI.
- `document_status` iba `draft`→`finalized` (jednosmerné), finalizácia iba cez `SECURITY DEFINER` RPC, RLS zakazuje priamy klientský zápis na finalizovanú faktúru — immutabilita vynútená na DB, nie UI.
- Peňažná aritmetika `decimal.js` na klientovi + nezávislý SQL prepočet v RPC (defense-in-depth), nikdy floating-point.
- `InvoiceSource` už obsahuje `'efaktura_peppol'` ako pripravenú (zatiaľ nepoužitú) hodnotu — potvrdzuje, že pôvodný Fáza 2 návrh už počítal s touto históriou.

**Čo v modeli chýba úplne (potvrdené, nie odhadnuté):** štandardizovaný unit code (iba voľný text `unit`), VAT exemption/reverse-charge reason (kód aj text), akékoľvek scheme ID pri IČO/DIČ/IČ DPH/Peppol identifikátore, elektronická adresa vlastnej firmy (`company_billing_profile` nemá `peppol_identifier` vôbec — má ho iba `business_partners`), buyer/PO/contract/project referencie, allowances/charges (riadkové aj dokladové), delivery location/party (iba `delivery_date` existuje), kontakt (telefón sa v `business_partners` eviduje, ale **nesnapshotuje sa** do `invoice_parties` pri finalize), voľná poznámka k faktúre (invoice note).

---

## 6. Mapovacia matica

| EN16931 business term | BT/BG kód | Povinnosť | Esblu zdroj | Status | Action |
|---|---|---|---|---|---|
| Invoice identifier | BT-1 | Povinné | `invoices.invoice_number` | COVERED | — |
| Invoice issue date | BT-2 | Povinné | `invoices.issue_date` | COVERED | — |
| Invoice type code | BT-3 | Povinné | `invoices.kind` (text enum) | PARTIAL | P0 — mapovanie kind→UNTDID 1001 kód nie je 1:1 pre všetky 4 hodnoty (bod 9.3) |
| Invoice currency code | BT-5 | Povinné | `invoices.currency` | COVERED | — |
| VAT accounting currency code | BT-6 (OVERIŤ) | Podmienené | — | NOT APPLICABLE | P2 — relevantné iba pri odlišnej účtovnej mene, dnes nepoužité |
| VAT point date / VAT point date code | BT-7/BT-8 (OVERIŤ) | Podmienené | `invoices.tax_point_date` | COVERED | — |
| Payment due date | BT-9 | Podmienené | `invoices.due_date` | COVERED | — |
| Buyer reference | BT-10 | Podmienené (Peppol: BT-10 **alebo** BT-13 povinné) | — | MISSING | P1 — potrebné pred provider sandboxom |
| Project reference | BG/BT (OVERIŤ) | Voliteľné | — | MISSING | P2 |
| Contract reference | BG/BT (OVERIŤ) | Voliteľné | — | MISSING | P2 |
| Purchase order reference | BT-13 (OVERIŤ) | Podmienené (viď buyer reference vyššie) | — | MISSING | P1 |
| Sales order reference | BG/BT (OVERIŤ) | Voliteľné | — | NOT APPLICABLE | P2 |
| Invoice note | BT (OVERIŤ, bežne citované ako BT-22) | Voliteľné | — | MISSING | P2 |
| Preceding invoice reference | BT-25 | Povinné pre credit/debit note | `invoices.corrects_invoice_id` | COVERED | — |
| Seller name | BT-27 | Povinné | `company_billing_profile.legal_name` → `invoice_parties.legal_name` | COVERED | — |
| Seller identifier | BT-29 | Voliteľné | — | NOT APPLICABLE | P2 — relevantné len pri GLN a pod. |
| Seller legal registration identifier | BT-30 | Podmienené | `ico` | COVERED | P1 pre scheme ID (bod 7) |
| Seller VAT identifier | BT-31 | Podmienené (povinné ak platiteľ DPH) | `ic_dph` | COVERED | — |
| Seller electronic address | BT-34 (OVERIŤ) | Peppol: povinné pre doručenie | — (`company_billing_profile` nemá `peppol_identifier`) | MISSING | P1 — blokuje Peppol sandbox úplne (bod 8) |
| Seller postal address | BG (address_line1/2, city, postal_code, country_code) | Povinné (aspoň krajina) | `company_billing_profile.*` | COVERED | — |
| Seller country code | v rámci seller address | Povinné | `company_billing_profile.country_code` | COVERED | — |
| Seller contact (point/tel/email) | BG (OVERIŤ) | Voliteľné | `company_billing_profile.contact_email` (iba email) | PARTIAL | P2 — telefón/meno kontaktu chýba |
| Buyer name | BT-44 | Povinné | `business_partners.legal_name` → `invoice_parties.legal_name` | COVERED | — |
| Buyer identifier | BT (OVERIŤ) | Voliteľné | — | NOT APPLICABLE | P2 |
| Buyer legal registration identifier | BT (OVERIŤ) | Podmienené | `ico` | COVERED | P1 pre scheme ID |
| Buyer VAT identifier | BT-48 (OVERIŤ) | Podmienené | `ic_dph` | COVERED | — |
| Buyer electronic address | BT-49 (OVERIŤ) | Peppol: povinné pre doručenie | `business_partners.peppol_identifier` → snapshot do `invoice_parties.peppol_identifier` | PARTIAL | P1 — bez scheme ID (bod 8) |
| Buyer postal address | BG | Povinné (aspoň krajina) | `business_partners.*` | COVERED | — |
| Buyer country code | v rámci buyer address | Povinné | `business_partners.country_code` | COVERED | — |
| Buyer contact (point/tel/email) | BG (OVERIŤ) | Voliteľné | `business_partners.email`, `.phone` — **phone sa nesnapshotuje** | PARTIAL | P2 |
| Payment means type code | BT (OVERIŤ) | Podmienené | Odvoditeľné (IBAN prítomný ⇒ credit transfer) | PARTIAL | P1 — nie je explicitný stĺpec, iba odvodené |
| Payment account identifier | BT-84 (OVERIŤ) | Podmienené (ak bank transfer) | `company_billing_profile.iban` / `invoice_parties.iban` | COVERED | — |
| Payment service provider identifier | BT (OVERIŤ) | Voliteľné | `company_billing_profile.bic` / `invoice_parties.bic` | COVERED | — |
| Payment terms | BT-20 | Voliteľné | `invoices.payment_terms_days` | COVERED | — |
| Remittance information / payment reference | BT (OVERIŤ, bežne BT-83) | Voliteľné/podmienené | `invoices.variable_symbol` | COVERED (SK-špecifický názov, sémanticky ekvivalentné) | P2 — zvážiť generic alias na mapovacej vrstve, nie DB migráciu (bod 12 zadania) |
| Buyer accounting reference | BT (OVERIŤ) | Voliteľné | — | NOT APPLICABLE | P2 |
| Invoice line identifier | BT-126 (OVERIŤ) | Povinné per riadok | `invoice_items.position` | COVERED | — |
| Item name / description | BT-153 | Povinné per riadok | `invoice_items.description` | COVERED | — |
| Invoiced quantity | BT-129 | Povinné per riadok | `invoice_items.quantity` | COVERED | — |
| Invoiced quantity unit of measure code | BT-130 (OVERIŤ) | **Povinné per riadok** (UN/ECE Rec 20/21 kód, nie voľný text) | `invoice_items.unit` (voľný text) | MISSING | **P0** — bez platného unit code XML neprejde UBL schema validáciou |
| Item net price | BT-146 (OVERIŤ) | Povinné per riadok | `invoice_items.unit_price` | COVERED | — |
| Invoice line net amount | BT-131 | Povinné per riadok | `invoice_items.line_net_amount` | COVERED | — |
| VAT category code (per riadok) | BT-151 (OVERIŤ) | Povinné per riadok | `invoice_items.vat_category_code` | PARTIAL | P1 — iba S/Z/E/AE, chýbajú G/K/O/L/M (bod 9) |
| VAT rate (per riadok) | BT-152 (OVERIŤ) | Podmienené (povinné ak kategória S) | `invoice_items.vat_rate` | COVERED | — |
| VAT category taxable amount | BT-116 (OVERIŤ) | Povinné (breakdown) | `invoice_tax_breakdowns.taxable_amount` | COVERED | — |
| VAT category tax amount | BT-117 (OVERIŤ) | Povinné (breakdown) | `invoice_tax_breakdowns.vat_amount` | COVERED | — |
| VAT exemption reason code | BT-121 (OVERIŤ) | **Podmienene povinné pre kategórie E/AE** (BR-E-10, BR-AE-10 — BR-AE-10 potvrdené priamo cez oficiálny VATEX code list docs.peppol.eu) | — | MISSING | **P0** — E aj AE sú už aktívne používané kategórie v produkcii |
| VAT exemption reason text | BT-120 (OVERIŤ) | Podmienene povinné (alternatíva/doplnok ku kódu) | — | MISSING | **P0** (spolu s kódom vyššie) |
| Document level allowances | BG-20 (OVERIŤ) | Voliteľné | — | NOT APPLICABLE (dnes nepoužité, žiadne UI) | P2 — renderer musí fail-closed, ak sa objaví dopyt |
| Document level charges | BG-21 (OVERIŤ) | Voliteľné | — | NOT APPLICABLE | P2 |
| Line level allowance/charge | BG-27/28 (OVERIŤ) | Voliteľné | — | NOT APPLICABLE | P2 |
| Sum of invoice line net amounts | BT-106 (OVERIŤ) | Povinné | `invoices.subtotal_amount` | COVERED | — |
| Invoice total amount without VAT | BT-109 (OVERIŤ) | Povinné | `invoices.subtotal_amount` | COVERED | — |
| Invoice total VAT amount | BT-110 (OVERIŤ) | Povinné | `invoices.vat_total_amount` | COVERED | — |
| Invoice total amount with VAT | BT-111/112 (OVERIŤ) | Povinné | `invoices.total_amount` | COVERED | — |
| Paid amount (prepaid) | BT-113 (OVERIŤ) | Voliteľné | `invoice_payments` (súčet, nie priame pole na `invoices`) | PARTIAL | P2 — odvoditeľné agregáciou, nie priamy stĺpec |
| Rounding amount | BT-114 (OVERIŤ) | Voliteľné | `invoices.rounding_amount` | COVERED | — |
| Amount due for payment | BT-115 (OVERIŤ) | Povinné | Odvoditeľné (`total_amount` − zaplatené) | PARTIAL | P2 — odvoditeľné, nie priamy stĺpec |
| Delivery date (actual) | BT-72 (OVERIŤ) | Voliteľné | `invoices.delivery_date` | COVERED | — |
| Delivery location / party | BG-13 (OVERIŤ) | Voliteľné | — | MISSING | P2 |
| Payee (ak iný než seller) | BG-10 (OVERIŤ) | Voliteľné | — | NOT APPLICABLE | P2 — dnes vždy seller=payee |
| Seller tax representative | BG-11 (OVERIŤ) | Podmienené | — | NOT APPLICABLE | P2 — vyžadovalo by legal confirmation ak relevantné |

**Poznámka k „OVERIŤ":** koncept/sémantika a Status/Action klasifikácia každého takto označeného riadku sú spoľahlivé (overené oficiálnou dokumentáciou Peppol/EK, kde vôbec ide o BT existujúci v štandarde); presné číslo BT/BG treba pred písaním skutočného XML mapperu (Fáza 5+) skontrolovať priamo oproti oficiálnemu zoznamu obchodných termov (napr. `docs.peppol.eu/poacc/billing/3.0/bis/` detailný strom, alebo priamo platený text CEN EN 16931-1) — toto NIE JE urobené teraz, pretože XML mapper sa v tejto fáze zámerne nepíše (bod 20/29 zadania).

---

## 7. Party identity gaps (bod 4 zadania)

`ico`/`dic`/`ic_dph` (slovenské doménové pomenovanie) **ostávajú nezmenené** — nesmú sa odstrániť. Chýbajú: **scheme identifier** pri `ico` (BT-30-1, napr. ISO 6523 ICD kód `0151` pre SK IČO — presná hodnota pre SK register **nebola v tomto audite nezávisle overená**, OPEN), a všeobecný `seller/buyer identifier + scheme` (BT-29/BT-46) pre prípady mimo IČO (napr. GLN). **Klasifikácia: P1** — potrebné pred Peppol/provider sandboxom (Peppol routing sa typicky opiera o scheme-qualified identifikátor), nie blokujúce pre bázovú EN16931 sémantickú validitu domácej SK faktúry. **Neimplementované teraz** — žiadny P0 dôvod na okamžitú migráciu.

## 8. Electronic address / Peppol gaps (bod 5 zadania)

`business_partners.peppol_identifier` existuje ako holý text, **bez scheme ID** (Peppol EAS kód, napr. `9930` pre SK IČO-based endpoint — **presná SK EAS hodnota nebola nezávisle overená**, OPEN). **Kritickejšie zistenie: `company_billing_profile` nemá `peppol_identifier`/elektronickú adresu vôbec** — ak Esblu firma sama vystavuje eFaktúru (`direction='issued'`), jej VLASTNÁ elektronická adresa (potrebná ako BT-34 seller electronic address pre Peppol doručenie) dnes **neexistuje nikde v schéme**. **Klasifikácia: P1** (blokuje priamo Peppol/provider sandbox — bez toho nemožno vôbec smerovať odchádzajúcu správu — ale nie P0, keďže EN16931 samotný elektronickú adresu ako mandatory field v core modeli nevyžaduje, iba Peppol transportná vrstva). **Neimplementované teraz** — odporúčaná budúca zmena: `company_billing_profile.peppol_identifier` + `peppol_scheme_id` (obe nullable), analogicky `business_partners.peppol_scheme_id` doplniť k existujúcemu `peppol_identifier`.

## 9. VAT gaps

### 9.1 Kategórie (bod 9 zadania)
DB CHECK dnes vynucuje **iba S/Z/E/AE** (`invoice_items_vat_category_code_check`, `invoice_tax_breakdowns_vat_category_code_check`). Chýbajú **G** (export mimo EÚ), **K** (intra-EÚ dodanie), **O** (nepredmet DPH) — všetky potvrdené ako reálne EN16931/Peppol kategórie priamo cez oficiálny VATEX code list. **L/M** (Kanárske ostrovy/Ceuta-Melilla, IGIC) — **NOT APPLICABLE** pre Esblu (Slovensko/bežné EÚ trhy), neimplementovať bez konkrétneho obchodného dôvodu. **Klasifikácia: P1** — potrebné pred akoukoľvek cezhraničnou/exportnou faktúrou v štruktúrovanom eFaktúra flow, nie blokujúce pre dnešné domáce SK použitie (S/Z/E/AE pokrýva prevažnú väčšinu domácich scenárov). **Neimplementované teraz.**

### 9.2 VAT exemption / reverse-charge reason (bod 10 zadania)
Pozri maticu vyššie — **P0**, implementované ako nullable stĺpce (bod 13 nižšie) bez UI/RPC prepojenia (schema-ready, nie funkčné teraz).

### 9.3 Invoice type code mapping (bod 7 zadania)
| `invoices.kind` | UNTDID 1001 | Status |
|---|---|---|
| `regular_invoice` | **380** (Commercial invoice) | COVERED — priama, nesporná zhoda |
| `credit_note` | **381** (Credit note) | COVERED — priama, nesporná zhoda, potvrdené aj Peppol BIS overview |
| `debit_note` | **NEISTÉ** — UNTDID 1001 má všeobecný číselník obsahujúci aj kódy pre debit note, ale **oficiálna Peppol BIS Billing 3.0 dokumentácia explicitne opisuje iba dva podporované UBL root dokumenty: Invoice (380) a CreditNote (381)** — samostatný "DebitNote" UBL dokument **nebol v Peppol BIS Billing 3.0 dokumentácii nájdený ako podporovaný proces**. | **NEEDS LEGAL CONFIRMATION / OPEN** — neinventujem mapovanie. Najpravdepodobnejšie riešenie (bežná prax v iných krajinách s podobným obmedzením): ťarchopis sa v Peppol/EN16931 posiela ako **Invoice (380)** s kladnou sumou a referenciou na pôvodnú faktúru cez BT-25, nie ako samostatný typ — **toto musí byť overené priamo v SK CIUS (ak/keď bude publikovaná) alebo dopytom na efaktura@financnasprava.sk pred Fázou 5**, presne v duchu Fázy 0 bodu "C — podlieha budúcej zmene". |
| `payment_received_invoice` | **NEISTÉ** | **NEEDS LEGAL CONFIRMATION / OPEN** — Fáza 0 (bod 14) potvrdila, že ide o plnohodnotný daňový doklad podľa §74 podliehajúci eFaktúre, ale **žiadny zo skúmaných zdrojov (SK aj Peppol) nepomenúva explicitný samostatný EN16931/UNTDID typ pre "faktúru k prijatej platbe"** oddelene od bežnej faktúry (380). Pracovný predpoklad (neoverený): pravdepodobne sa exportuje tiež ako 380 — **OPEN, neimplementovať bez potvrdenia.** |

**Dôsledok:** Invoice type code mapping je `PARTIAL`, nie `MISSING` (2 zo 4 hodnôt majú istú zhodu) — klasifikované ako **P0 pre mapovaciu logiku samotnú** (musí byť vyriešené pred akýmkoľvek XML rendererom, keďže BT-3 je povinné pole), ale **žiadna DB migrácia sa z toho nevyplýva** — `invoices.kind` ako zdroj dát je dostatočný, ide čisto o rozhodovaciu logiku budúceho mapovacieho kódu, ktorá sa dnes zámerne nepíše.

## 10. Unit codes (bod 6 zadania)

Pozri maticu (P0). Odporúčaná realizácia — presne podľa zadania: **`unit_code`** (kanonický UN/ECE Rec 20/21 kód, napr. `C62` kus, `DAY` deň, `HUR` hodina, `MTR` meter, `KGM` kilogram) **oddelene od `unit`** (zostáva používateľom zadávaný display label, napr. "ks", "Deň", "hod" — nemení sa, aby sa nerozbilo žiadne existujúce UI/dáta). **Mapovanie voľného textu na kód sa NEROBÍ automaticky/naslepo** (zadanie explicitne zakazuje) — `unit_code` je nový nullable stĺpec, ktorý sa vyplní až budúcim UI (výber zo zoznamu štandardných kódov s pridruženým display labelom), nie odvodením z existujúceho `unit` textu. Implementované ako schema-ready (bod 13), bez backfillu (`unit_code` zostáva `NULL` pre všetky existujúce aj nové riadky, kým sa nepostaví UI).

## 11. Allowances / charges (bod 11 zadania)

Esblu dnes nemá žiadny spôsob zadať zľavu/prirážku na úrovni riadku ani dokladu (žiadne UI, žiadne DB polia). **Status: NOT APPLICABLE** (nie MISSING — neexistuje dáta, z ktorých by sa dalo čerpať), **Action: P2**. Odporúčanie: keďže dáta dnes neexistujú, žiadna migrácia teraz nie je potrebná. Budúci XML renderer (Fáza 5+) musí explicitne **fail-closed** (odmietnuť export s jasnou chybou), ak by sa niekedy v budúcnosti objavila faktúra vyžadujúca allowances/charges skôr, než bude táto funkcia implementovaná — nie tichým ignorovaním.

## 12. Payment means / reference (bod 12 zadania)

`iban`/`bic`/`variable_symbol` ostávajú nezmenené. `variable_symbol` je sémanticky priamym ekvivalentom "remittance information/payment reference" — **odporúčam NEpridávať nový stĺpec `payment_reference` teraz** (bolo by to duplicitné pole s tou istou hodnotou), ale namiesto toho zdokumentovať mapovanie na mapovacej/render vrstve budúcej Fázy 5 (`variable_symbol` → BT payment reference pole). Toto je **P2, neimplementované** — minimálna zmena je práve *neurobiť* zbytočnú migráciu, presne v duchu zadania bodu 21/22.

## 13. Implementované schema zmeny (P0 gapy)

**Stav: aplikované na produkčnú DB** (`fkpgvgvsmbpieduoatrt`), migrácia `20260917100000_add_invoicing_en16931_p0_fields`. Overené po aplikácii: obe existujúce riadky (`invoice_items`: 1, `invoice_tax_breakdowns`: 1) majú pre všetky 3 nové stĺpce `NULL` — žiadny backfill, žiadny default. RLS policy count pred/po nezmenený (`invoice_items`: 4, `invoice_tax_breakdowns`: 1) — stĺpcová zmena nezasahuje do row-level politík. `esblu_finalize_invoice()` vykonáva explicitné pomenované INSERT/UPDATE (nie `SELECT *`/`INSERT ... SELECT *`), takže nové nullable stĺpce bez defaultu nemôžu zlomiť finalizáciu existujúceho ani nového draftu — logicky garantované zdrojom RPC, nezávisle overené.

Jedna migrácia, dve tabuľky, aditívne, nullable, expand-only (žiadny backfill, žiadny prepis finalizovaných faktúr, žiadny country-specific default):

1. **`invoice_items.unit_code text NULL`** — kanonický UN/ECE Rec 20/21 jednotkový kód, oddelene od existujúceho `unit` (display label, nezmenený).
2. **`invoice_tax_breakdowns.vat_exemption_reason_code text NULL`** a **`invoice_tax_breakdowns.vat_exemption_reason_text text NULL`** — VATEX kód a voľný text, na úrovni VAT breakdown (kde ich EN16931 BG-23 skupina sémanticky umiestňuje), nie na úrovni riadku.

**Čo sa VEDOME NEROBILO v tejto fáze** (mimo P0 rozsahu, viď zadanie bod 21/22 "neimplementuj všetko len preto, že štandard to umožňuje"):
- Žiadna zmena `esblu_finalize_invoice()` RPC — nové stĺpce zostávajú `NULL` pre všetky faktúry (historické aj nové) kým sa nepostaví budúce UI/RPC prepojenie na ich vyplnenie. Toto je vedomé, dočasné obmedzenie, nie prehliadnutie.
- Žiadne UI zmeny (draft editor, finalize flow) — nič sa nezobrazuje ani nevynucuje.
- Žiadne rozšírenie VAT category CHECK constraint (G/K/O) — P1, neskôr.
- Žiadne `company_billing_profile.peppol_identifier`/scheme ID polia — P1, neskôr.
- Žiadne buyer/PO reference polia — P1, neskôr.

Toto zámerne udržiava migráciu **výhradne v rozsahu P0** — presne podľa explicitného pravidla zadania.

---

## 14. Validačná architektúra (3 vrstvy, bod 26 zadania)

Navrhované (koncepčne, **nie implementované** — žiadny validačný kód sa v tejto fáze nepíše, keďže by predpokladal existenciu XML rendera, ktorý je mimo rozsahu):

1. **Canonical invoice validation** — dnes už čiastočne existuje (`validateDraftBeforeFinalize` v `lib/invoices.ts` + DB-level CHECK constraints + `esblu_finalize_invoice()` RPC validácie). Kontroluje iba interné Esblu invarianty (povinné polia, kladné množstvá, existencia business partnera), **nezávisle od EN16931**.
2. **EN16931 semantic validation** — nová, budúca vrstva: overí, že kanonický záznam (po finalize) obsahuje všetky polia mandatory/conditional podľa matice v bode 6 (napr. "ak kategória E, musí existovať `vat_exemption_reason_code` alebo `_text`"). Beží NAD kanonickým modelom, nezávisle od cieľovej XML syntaxe.
3. **Syntax/Peppol/CIUS validation** — najvonkajšia vrstva, špecifická pre konkrétny XML syntax binding (UBL 2.1) a konkrétny CIUS (Peppol BIS Billing 3.0 + budúca SK CIUS, ak bude publikovaná) — typicky XSD schema + Schematron (oficiálne Peppol/CEN validačné artefakty, nie vlastná reimplementácia pravidiel).

**Fail-closed princíp naprieč všetkými 3 vrstvami:** chýbajúce mandatory pole v ktorejkoľvek vrstve **zastaví export s jasnou chybou**, nikdy nevygeneruje neúplný/neplatný XML ani nedopĺňa hodnotu z live master dát po finalizácii (bod 24 zadania). Vrstvy sa **nemiešajú do jednej funkcie** — každá je nezávisle testovateľná a vymeniteľná (napr. výmena CIUS bez zásahu do vrstvy 1/2).

## 15. Code-list stratégia (bod 27 zadania)

| Code list | Zdroj pravdy | Stratégia |
|---|---|---|
| Mena (ISO 4217) | Statický, stabilný zoznam | Vstavaný constant zoznam (nemenný, nízka údržba) |
| Krajina (ISO 3166-1 alpha-2) | Statický, stabilný zoznam | `CHECK (country_code ~ '^[A-Z]{2}$')` už existuje — formálna validácia formátu, nie zoznamu; zoznam platných kódov na UI úrovni |
| Unit codes (UN/ECE Rec 20/21) | Externe udržiavaný, stovky kódov | **NEhardcodovať ručne kompletný zoznam.** Odporúčanie: pri budúcej Fáze (UI pre `unit_code`) použiť malú, kuratovanú podmnožinu relevantnú pre stavebníctvo/servis/dopravu (ks, deň, hodina, m, m², m³, kg, t, l) s explicitným "iný kód" fallbackom, nie plný niekoľkosto-položkový zoznam v UI |
| VAT category codes | EN16931/Peppol pevná množina (S/Z/E/AE/G/O/K/L/M) | Vstavaný constant zoznam (malý, stabilný) — dnes `VAT_CATEGORY_CODES` v `vat-engine.ts`, rozšíriteľné aditívne |
| VATEX (exemption reason) kódy | ~88 kódov, oficiálny zoznam docs.peppol.eu | Vstavaný zoznam s pravidelnou kontrolou voči oficiálnemu registru pred Fázou 5 (nie teraz) |
| Invoice type codes (UNTDID 1001) | Malá, stabilná podmnožina relevantná pre Esblu (380/381 + OPEN bod 9.3) | Vstavaný mapping v budúcom XML mapperi, nie DB |
| Payment means codes | Malá podmnožina (30/58 SEPA credit transfer relevantné pre Esblu) | Vstavaný mapping |
| Electronic address scheme (EAS) / identifier scheme (ICD) | Externe udržiavaný číselník | Nehardcodovať teraz — vyžaduje samostatné overenie SK-relevantnej hodnoty (OPEN, bod 8) pred akoukoľvek implementáciou |

**Update stratégia:** žiadny z týchto zoznamov sa nemá kopírovať ručne položku-po-položke do repozitára pri prvej príležitosti — malé/stabilné zoznamy (mena, VAT kategórie, invoice type) ako vstavané konštanty s komentárom-odkazom na zdroj; veľké/externe-udržiavané zoznamy (unit codes, EAS/ICD) až pri budovaní konkrétneho UI, ktoré ich potrebuje, s odkazom na live oficiálny zdroj v komentári.

---

## 16. Test fixtures (návrh, bod 28 zadania — NEPOUŽITÉ na produkčné dáta, iba návrh scenárov pre budúcu Fázu 5 test suite)

| # | Scenár | Účel |
|---|---|---|
| A | Štandardná zdaniteľná faktúra (kategória S, jedna sadzba) | Baseline — dnes plne funkčné, viď FÁZA 3A test matrix |
| B | Viacero sadzieb DPH na jednej faktúre (napr. 23 % + 10 %) | BR-CO-17 agregácia per sadzba |
| C | Nulová sadzba (kategória Z) | Overiť, že `vat_amount=0` bez potreby exemption reason (na rozdiel od E/AE) |
| D | Oslobodené plnenie (kategória E) | Vyžaduje `vat_exemption_reason_code`/`_text` — dnes MISSING (P0, schema pripravená, dáta chýbajú kým nie je UI) |
| E | Prenesenie daňovej povinnosti (kategória AE) | Vyžaduje VATEX-EU-AE — rovnaký P0 gap ako D |
| F | Dobropis (`credit_note`) | Referencia cez `corrects_invoice_id`/BT-25 — dnes funkčné |
| G | Cezhraničný EÚ partner (iná krajina, kategória K) | Dnes NEMOŽNÉ — CHECK constraint neumožňuje K (P1 gap, bod 9.1) |
| H | Partner s Peppol/elektronickou adresou | Dnes čiastočné — `business_partners.peppol_identifier` existuje, ale bez scheme ID (P1) |
| I | Faktúra bez povinného EN16931 poľa → validation fail | Dnes nemá kam zlyhať (validačná vrstva 2 z bodu 14 neexistuje) — dôkaz, prečo je vrstva 2 budúca priorita pred akýmkoľvek XML výstupom |

Scenáre C-E, G, H **neboli** v rámci tejto fázy spustené ako reálne SQL testy nad produkčnou DB (na rozdiel od bezpečnostných/RLS testov nižšie) — sú to **návrhové špecifikácie budúcej test suite** pre Fázu 5, nie súčasný stav.

---

## 17. GDPR dopad

Nové stĺpce (`unit_code`, `vat_exemption_reason_code`, `vat_exemption_reason_text`) **neobsahujú žiadne osobné údaje** — sú to technické/daňové klasifikačné kódy a text (napr. "prenesenie daňovej povinnosti podľa §69 ods. 12"), nie údaje o fyzickej osobe. **Žiadny nový GDPR dopad** oproti existujúcemu stavu. Dátová minimalizácia dodržaná — žiadne rodné číslo, dátum narodenia ani iné blokované kategórie sa nikde nenavrhujú ani nepridávajú.

## 18. Blokátory pred XML rendererom (Fáza 5)

1. **P0 gapy** (unit code UI/RPC prepojenie, VAT exemption reason UI/RPC prepojenie) — schema pripravená, funkčnosť chýba.
2. **Invoice type code mapping pre `debit_note` a `payment_received_invoice`** — NEEDS LEGAL CONFIRMATION, nesmie sa uhádnuť.
3. **SK CIUS** — k dátumu tohto auditu nepublikovaná (potvrdené aj Fázou 0); XML mapper sa nedá finalizovať bez nej, iba pripravovať proti všeobecnému Peppol BIS Billing 3.0.
4. **Presné BT/BG čísla** pri termoch označených `(OVERIŤ)` v matici bodu 6 — nutné overiť pred písaním skutočného XML generátora.
5. **EAS/ICD scheme hodnoty pre SK** (elektronická adresa, IČO scheme) — nezávisle neoverené v tomto audite (bod 7/8).

## 19. Blokátory pred provider sandboxom (Fáza 6)

Zhoduje sa s Fázou 0 (bod 18a/37) — výber PDS providera je samostatné obchodné rozhodnutie, nezávislé od tohto auditu. Dodatočne z tohto auditu: **P1 gapy (elektronická adresa vlastnej firmy, buyer/PO reference, scheme ID)** musia byť implementované predtým, než má zmysel čokoľvek reálne skúšať v sandboxe — bez nich by ani syntakticky správne XML nemuselo prejsť Peppol network routing.

---

## 20. Zhrnutie P0/P1/P2

**P0 (implementované ako schema-ready v tejto fáze):**
- Unit code per riadok (`invoice_items.unit_code`)
- VAT exemption/reverse-charge reason (`invoice_tax_breakdowns.vat_exemption_reason_code`/`_text`)
- Invoice type code mapping pre `debit_note`/`payment_received_invoice` — NEEDS LEGAL CONFIRMATION, nie schema gap, ale rozhodovací gap

**P1 (zdokumentované, NEimplementované — budúca fáza):**
- Elektronická adresa vlastnej firmy (`company_billing_profile.peppol_identifier` + scheme)
- Scheme ID pri IČO/DIČ/Peppol identifikátoroch
- Buyer reference / PO reference
- Rozšírenie VAT kategórií o G/K/O (cezhraničné scenáre)
- Explicitný payment means type code stĺpec

**P2 (zdokumentované, voliteľné/budúce):**
- Allowances/charges (dnes NOT APPLICABLE — žiadne dáta)
- Contract/project reference, invoice note
- Delivery location/party
- Kontakt (telefón) snapshot do `invoice_parties`
- Payee (ak iný než seller), seller tax representative
- Generic `payment_reference` alias (odporúčanie: riešiť na mapovacej vrstve, nie DB)
