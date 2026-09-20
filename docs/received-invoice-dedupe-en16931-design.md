# Esblu — Prijaté faktúry, dedupe a EN16931 P1: návrh

**Dátum:** 2026-09-20
**Pokrýva:** Fázy B, C, D, E, F, H, I zo zadania
**Stav:** návrh pripravený na implementáciu; migračné SQL v `supabase/migrations/`
**Východisko:** `docs/esblu-production-db-baseline-2026-09-20.md`

---

## 0. Zásady, ktoré tento návrh nesmie porušiť

Prevzaté zo zadania a záväzné pre každú implementáciu:

1. Canonical invoice DB model je source-of-truth. PDF aj budúci XML sú len renderery toho istého modelu.
2. Nikdy `PDF → OCR → XML`.
3. Nikdy `historická finalized invoice → live business_partner / billing_profile`.
4. Finalized invoice je immutable.
5. Ak historickej faktúre chýba mandatory field pre eInvoice: **fail closed**.
6. Nikdy nevymýšľať chýbajúce právne/daňové hodnoty.
7. AI nesmie rozhodovať o: VAT kategórii, VAT sadzbe, právnom dôvode oslobodenia, právnom základe reverse charge, právnej klasifikácii typu faktúry. AI navrhuje, používateľ potvrdzuje.
8. Expand-only schéma, nullable tam, kde historické faktúry dáta mať nemôžu, žiadny fake backfill, žiadne country defaults.

---

## 1. Fáza B — Prijatá faktúra ako canonical received invoice

### 1.1 Rozhodnutie: jeden model, nie druhý systém

Vydané aj prijaté faktúry zdieľajú `invoices` a jej podtabuľky. Rozlišuje ich `direction`.

Dôvod: tax breakdown, položky, platby, protistrana a totals majú v oboch smeroch rovnakú sémantiku. Duplikovať to by znamenalo duplikovať aj VAT logiku — a tým aj miesto, kde môže vzniknúť nesúlad.

### 1.2 Čo sa mení oproti issued

| Aspekt | issued | received |
|---|---|---|
| Kto určuje `invoice_number` | naša sekvencia | **dodávateľ** — číslo sa preberá z dokladu |
| `invoice_number_sequence_id` | vyplnené | **musí zostať NULL** |
| Protistrana | `customer_business_partner_id` | **`supplier_business_partner_id`** (nové) |
| `invoice_parties.role='seller'` | naša firma (z billing profile) | **dodávateľ** |
| `invoice_parties.role='buyer'` | odberateľ | **naša firma** |
| Význam `document_status='finalized'` | my sme doklad vystavili a uzamkli | **my sme review potvrdili** a uzamkli náš záznam |
| `source` | zvyčajne `manual` | `ai_inbox`, `efaktura_peppol`, alebo `manual` |
| PDF endpoint | generuje náš PDF | **negeneruje** — originál je v `document_attachments` |

**Kritické:** `esblu_finalize_invoice` musí pre `direction='received'`:
- preskočiť prideľovanie čísla zo sekvencie,
- vyžadovať, aby `invoice_number` bolo vyplnené už predtým (číslo dodávateľa),
- naplniť `invoice_parties` tak, že seller = dodávateľ (snapshot z `business_partners`) a buyer = naša firma (snapshot z `company_billing_profile`),
- vypočítať a persistovať tax breakdown rovnako ako pri issued,
- **overiť dedupe fail-closed pravidlo** (§2.5) ešte pred zápisom.

**Toto je jediné miesto, kde sa received a issued reálne rozchádzajú.** Všetko ostatné je zdieľané.

### 1.3 Schema zmeny

```
invoices:
  + supplier_business_partner_id   uuid NULL → business_partners(id)
  + supplier_invoice_number        text NULL     -- pôvodné číslo dodávateľa (audit stopa)
  + received_at                    date NULL     -- kedy doklad fyzicky prišiel
```

Plus constrainty, ktoré strážia, že sa smery nepomiešajú:

```
CHECK (direction <> 'issued' OR supplier_business_partner_id IS NULL)
CHECK (direction <> 'received' OR customer_business_partner_id IS NULL)
CHECK (direction <> 'received' OR invoice_number_sequence_id IS NULL)
```

Tretí constraint je dôležitý: **bráni tomu, aby prijatá faktúra kedykoľvek zožrala číslo z našej sekvencie.** To by bola nenapraviteľná chyba v číselnom rade vydaných faktúr.

### 1.4 Flow

```
1. Upload / foto / e-mail / XML
        ↓
2. documents — uloženie originálu + attachment
        ↓
3. Identifikácia typu zdroja
        ├─ validný structured eInvoice → parse (Fáza H), BEZ OCR
        └─ inak → AI/OCR extrakcia → extracted_fields + field_confidence
        ↓
4. Normalizácia do canonical candidate
        ↓
5. DEDUPE CHECK (§2)
        ├─ exact duplicate → fail closed, ponúkni existujúcu faktúru
        ├─ probable duplicate → varovanie, používateľ rozhoduje
        └─ čisté → pokračuj
        ↓
6. Partner matching (§3) — návrh, nie automatické vytvorenie pri neistote
        ↓
7. REVIEW — používateľ kontroluje a opravuje
        ↓
8. Potvrdenie → canonical received invoice
        ↓
9. document_links.invoice_id → originál zostáva prelinkovaný
```

**Krok 5 pred krokom 7 je zámerný.** Používateľ nemá stráviť tri minúty kontrolou faktúry, aby mu systém až potom povedal, že ju už má.

---

## 2. Fáza C — Dedupe

Najdôležitejší a najrizikovejší blok. Bez neho AI Inbox aktívne škodí: tá istá faktúra príde ako foto zo stavby, ako PDF mailom účtovníčke a od 2027 ako Peppol XML.

### 2.1 Štyri vrstvy

#### Vrstva A — exact source hash

`documents.content_sha256` = SHA-256 celého binárneho obsahu nahratého súboru.

Chytí: dvakrát nahratý ten istý súbor.
Nechytí: rovnaká faktúra ako iný sken/foto/formát.

```
documents:
  + content_sha256  text NULL
UNIQUE (company_id, content_sha256) WHERE content_sha256 IS NOT NULL AND deleted_at IS NULL
```

⚠️ Toto **nesmie byť unique na invoices** — dva rôzne súbory môžu legitímne patriť k jednej faktúre (originál + príloha).

#### Vrstva B — structured invoice fingerprint

Deterministický hash z normalizovanej identity dokladu:

```
fingerprint = sha256( join('|', [
    normalize_party_identity(seller),   -- viď nižšie
    normalize_number(invoice_number),
    issue_date::text,                   -- ISO 8601
    normalize_amount(total_amount),     -- na 2 desatinné, ako text
    upper(currency),
    kind                                -- regular / credit_note / debit_note
]) )
```

**`normalize_party_identity(seller)` — v tomto poradí, prvá neprázdna vyhráva:**
1. `vat_identifier` (bez medzier, veľké písmená)
2. `legal_registration_scheme_id || ':' || legal_registration_id`
3. `'SK:ICO:' || ico`
4. **žiadny identifikátor → fingerprint sa NEPOČÍTA** (NULL)

Posledný bod je zásadný. **Bez spoľahlivej identity dodávateľa sa fingerprint nepočíta vôbec**, pretože porovnávať faktúry podľa mena firmy je presne ten typ heuristiky, ktorý spôsobí buď falošnú zhodu, alebo falošné odmietnutie.

`normalize_number`: odstrániť medzery, pomlčky, lomky; veľké písmená; **neodstraňovať vedúce nuly** (FA-0001 a FA-1 sú rôzne doklady).

`normalize_amount`: `to_char(round(v, 2), 'FM999999999990.00')`.

```
invoices:
  + dedupe_fingerprint  text NULL
UNIQUE (company_id, direction, dedupe_fingerprint)
  WHERE dedupe_fingerprint IS NOT NULL AND document_status = 'finalized'
```

Unique index **len na finalized** — rozpracované drafty sa môžu legitímne zhodovať, kým ich používateľ upravuje.

#### Vrstva C — transport ID

```
invoices:
  + transport_message_id      text NULL   -- Peppol message ID / provider ID
  + transport_provider        text NULL   -- ktorý provider ho doručil
UNIQUE (company_id, transport_provider, transport_message_id)
  WHERE transport_message_id IS NOT NULL
```

Najspoľahlivejšia vrstva, ale funguje až od reálnej Peppol prevádzky.

#### Vrstva D — vzťah k zdrojovému dokumentu

```
document_links:
  + invoice_id  uuid NULL → invoices(id)
```

Umožní: „z tohto dokumentu už vznikla faktúra X" a „táto faktúra má tieto 3 zdrojové dokumenty".

### 2.2 Near-duplicate detekcia (nie unique, len varovanie)

Zhoda v **dvoch a viac** z nasledujúcich, ale nie exact fingerprint:
- rovnaká identita dodávateľa
- rovnaké `total_amount` + `currency`
- `issue_date` do ±3 dní
- Levenshtein podobnosť `invoice_number` ≥ 0.85

→ **varovanie, nikdy blokovanie.** UI ponúkne existujúcu faktúru a používateľ rozhodne.

### 2.3 Správanie podľa sily zhody

| Situácia | Reakcia |
|---|---|
| Exact source hash (vrstva A) | Neuložiť nový dokument. Zobraziť existujúci. **Nikdy nemazať.** |
| Exact transport ID (vrstva C) | **Fail closed** — druhá canonical faktúra nevznikne. |
| Exact fingerprint (vrstva B) proti finalized | **Fail closed** — druhá canonical faktúra nevznikne. |
| Near-duplicate | Varovanie, návrh existujúcej faktúry, rozhoduje používateľ. |
| Fingerprint NULL (chýba identita dodávateľa) | Žiadne blokovanie. Upozorniť, že dedupe nemôže bežať. |

**Absolútne pravidlo:** systém nikdy automaticky nemaže dokument. Ani pri exact zhode.

### 2.4 Edge cases — vedomé rozhodnutia

| Prípad | Ako to model rieši |
|---|---|
| Rovnaké číslo faktúry u rôznych dodávateľov | Identita dodávateľa je prvá zložka fingerprintu → rôzny fingerprint ✅ |
| Dobropis s číslom podobným faktúre | `kind` je zložka fingerprintu → rôzny fingerprint ✅ |
| Reissue (dodávateľ poslal opravenú verziu s rovnakým číslom) | Rovnaký fingerprint → **fail closed**. ⚠️ Vedomý trade-off: používateľ musí pôvodnú faktúru najprv stornovať. Alternatíva (povoliť) by otvorila tichý prepis účtovného záznamu — čo je horšie. |
| Oprava cez credit note | Iný `kind` → prejde ✅ |
| OCR preklep v čísle alebo sume | Rôzny fingerprint → **duplikát sa nechytí**. Chytí to near-duplicate vrstva ako varovanie. Preto near-duplicate existuje. |
| PDF vs XML tej istej faktúry | Rôzny source hash, **rovnaký fingerprint** → exact duplicate ✅ — presne ten prípad, kvôli ktorému vrstva B existuje |
| Zálohová a následná ostrá faktúra | Rôzne čísla a `kind` → prejde ✅ |
| Dodávateľ bez IČ DPH a bez IČO | Fingerprint NULL → dedupe nebeží, len near-duplicate varovanie |

### 2.5 Kde sa dedupe vykonáva

**V `esblu_finalize_invoice`, vnútri transakcie, pred zápisom.** Nie v aplikačnej vrstve.

Dôvod: aplikačná kontrola pred zápisom je race condition. Dvaja používatelia môžu potvrdiť tú istú faktúru súčasne. Unique index v DB je jediná skutočná záruka; RPC len prekladá jeho porušenie na zrozumiteľnú chybu.

---

## 3. Fáza C — Partner matching

### 3.1 Priorita

| # | Kritérium | Sila |
|---|---|---|
| 1 | VAT identifier (IČ DPH / EU VAT ID) | **deterministická** — auto-match |
| 2 | legal registration ID + scheme ID | **deterministická** — auto-match |
| 3 | electronic address + scheme ID | **deterministická** — auto-match |
| 4 | IČO (tam, kde dáva zmysel) | silná, ale scheme-závislá — auto-match len v rámci jednej krajiny |
| 5 | legal name | **slabá — nikdy sama osebe auto-match** |

### 3.2 Pravidlá

- Zhoda na 1–3 → automatický match, používateľovi sa zobrazí ako potvrdený.
- Zhoda len na 4 → návrh, používateľ potvrdzuje.
- Zhoda len na 5 → **návrh, nikdy auto-match**, aj keď je zhoda 100 %.
- **Ambiguita (viac kandidátov) → nikdy auto-match**, vždy výber.
- Žiadna zhoda → ponuka vytvoriť nového partnera z extrahovaných dát, **po potvrdení**.

**Nikdy nevytvoriť partnera automaticky pri neistote.** Zlý partner v master data sa šíri do všetkých budúcich faktúr a do XML.

UI text: „Našli sme pravdepodobného dodávateľa: **{legal_name}** ({ico}). Je to on?" — s možnosťou vybrať iného alebo založiť nového.

---

## 4. Fáza D — EN16931 P1 polia

Pridávame **len to, čo je reálne potrebné pre Peppol BIS sandbox.** Nie celý voliteľný EN16931 set.

### 4.1 `invoice_parties` (snapshot)

```
+ electronic_address              text NULL   -- BT-34 / BT-49
+ electronic_address_scheme_id    text NULL   -- EAS code list (napr. 0088, 9931)
+ legal_registration_id           text NULL   -- BT-30 / BT-47
+ legal_registration_scheme_id    text NULL   -- ICD code list
+ vat_identifier                  text NULL   -- BT-31 / BT-48
+ generic_identifier              text NULL   -- BT-29
+ generic_identifier_scheme_id    text NULL
```

`ico`, `dic`, `ic_dph` **zostávajú** ako country-specific convenience polia. Canonical structured vrstva však na nich nesmie závisieť.

`peppol_identifier` zostáva, ale je **deprecated v prospech** `electronic_address` + `electronic_address_scheme_id`. Bez scheme ID nie je endpoint jednoznačný.

### 4.2 `business_partners` a `company_billing_profile` (master data)

**Tie isté polia.** Bez nich nemá finalize čo snapshotovať.

`company_billing_profile` navyše nemá ani `peppol_identifier` — treba doplniť celý set.

### 4.3 `invoices`

```
+ buyer_reference            text NULL   -- BT-10; v Peppol BIS často mandatory
+ purchase_order_reference   text NULL   -- BT-13
+ payment_means_code         text NULL   -- BT-81, UNTDID 4461 (30 = credit transfer)
+ payment_reference          text NULL   -- BT-83
```

`variable_symbol` zostáva ako SK/CZ convenience pole. `payment_reference` je jeho canonical náprotivok — pri SK doklade sa zvyčajne zhodujú, ale renderer musí čítať `payment_reference`.

### 4.4 Unit codes

`unit` = display label, `unit_code` = UN/ECE Recommendation 20 kód.

Navrhované prefill mapovanie (**suggestion, nie authority**):

| Label | Kód |
|---|---|
| ks | H87 |
| deň | DAY |
| hodina | HUR |
| m | MTR |
| m² | MTK |
| m³ | MTQ |
| kg | KGM |
| t | TNE |
| l | LTR |
| km | KMT |
| bal | XPK |

UI: pole `unit` je voľný text, vedľa neho selector canonical kódu s predvyplneným návrhom podľa tabuľky. **Nikdy neodvodiť kód z voľného textu bez potvrdenia** — „hod", „hod.", „Hod" a „hodina" nie sú spoľahlivý vstup pre automatiku.

### 4.5 VAT exemption reasons

`vat_exemption_reason_code` + `_text` už existujú (P0).

Napojenie: pre `E` a `AE` bude **target profile validácia** (nie canonical) vyžadovať správny reason code podľa cieľového profilu.

**Nevymýšľať slovenský text automaticky pre všetky krajiny.** Prefill návrh len pre SK doklady, a aj ten musí používateľ potvrdiť.

### 4.6 VAT kategórie — OPEN

Dnes `{S, Z, E, AE}`. Peppol BIS pozná aj `G`, `K`, `O`, `L`, `M`.

**Rozhodnutie: zatiaľ nepridávať.** Jediná reálne pravdepodobná je `K` (dodanie do iného členského štátu). Pridať ju až s jasnou sémantikou a validáciou (vyžaduje IČ DPH oboch strán + nulovú sadzbu).

**OPEN — závisí od publikovanej slovenskej CIUS.** Neháda sa.

---

## 5. Fáza E — Validačná architektúra

Tri oddelené vrstvy. **Nemiešať do jednej funkcie.**

### Vrstva 1 — Canonical validation
Interná konzistencia Esblu faktúry: povinné canonical polia, prítomnosť oboch party snapshotov, súlad totals s položkami a breakdownom, referenčná integrita, prítomnosť `unit_code`, daňová sémantika (napr. AE ⇒ sadzba 0).
**Beží vždy**, pri drafte aj pri finalize.

### Vrstva 2 — EN16931 validation
Sémantické business rules normy (BR-*, BR-CO-*).
**Beží pri exporte**, nie pri finalize.

### Vrstva 3 — Target profile / Peppol validation
Peppol BIS 3.0, CIUS, syntax binding, code lists, Schematron/XSD.
**Beží pri odoslaní cez providera.**

**Dôsledok pre historické faktúry:** faktúra finalizovaná pred doplnením P1 polí prejde vrstvou 1, ale **neprejde vrstvou 2 a 3 — a to je správne.** Fail closed. XML export takej faktúry musí zlyhať s konkrétnou správou, ktoré polia chýbajú. Nikdy ich nedopĺňať odhadom ani z live master data.

---

## 6. Fáza F — UBL 2.1 outbound renderer

### Pravidlá
- **Len finalized** faktúry
- Vyžaduje finance permission
- Company isolated
- **Nikdy nečíta live master data** — výhradne `invoice_parties` snapshot
- Žiadna AI
- **Žiadny prepočet VAT** — používa persistované `invoice_tax_breakdowns` a `invoices.*_amount` hodnoty tak, ako sú
- Deterministický: rovnaký vstup → bajtovo rovnaký výstup

### Mapovanie (skrátene)

| UBL | Zdroj |
|---|---|
| `cbc:ID` | `invoices.invoice_number` |
| `cbc:IssueDate` | `invoices.issue_date` |
| `cbc:DueDate` | `invoices.due_date` |
| `cbc:InvoiceTypeCode` | z `invoices.kind` (380 regular, 381 credit note, 383 debit note) |
| `cbc:DocumentCurrencyCode` | `invoices.currency` |
| `cbc:BuyerReference` | `invoices.buyer_reference` |
| `cac:OrderReference/cbc:ID` | `invoices.purchase_order_reference` |
| `cac:AccountingSupplierParty` | `invoice_parties` role='seller' |
| `cac:AccountingCustomerParty` | `invoice_parties` role='buyer' |
| `cbc:EndpointID` + `@schemeID` | `electronic_address` + `electronic_address_scheme_id` |
| `cac:PartyLegalEntity/cbc:CompanyID` + `@schemeID` | `legal_registration_id` + `_scheme_id` |
| `cac:PartyTaxScheme/cbc:CompanyID` | `vat_identifier` |
| `cac:PaymentMeans/cbc:PaymentMeansCode` | `invoices.payment_means_code` |
| `cac:PaymentMeans/cbc:PaymentID` | `invoices.payment_reference` |
| `cac:PayeeFinancialAccount/cbc:ID` | `invoice_parties.iban` (seller) |
| `cac:TaxSubtotal` | `invoice_tax_breakdowns` (1:1) |
| `cbc:TaxExemptionReasonCode` / `Reason` | `vat_exemption_reason_code` / `_text` |
| `cac:InvoiceLine` | `invoice_items` |
| `cbc:InvoicedQuantity` + `@unitCode` | `quantity` + `unit_code` |
| `cac:LegalMonetaryTotal` | `subtotal_amount`, `vat_total_amount`, `total_amount`, `rounding_amount` |

### XML bezpečnosť
- `DOCTYPE` zakázaný, external entity resolution vypnutá (XXE)
- Žiadne načítavanie externých URL
- Žiadne spúšťanie skriptov
- Korektný escaping všetkých používateľských dát
- Rozumné limity veľkosti (počet položiek, dĺžka textových polí)
- Žiadne secrets v XML ani v chybových hláškach

### ⚠️ Zatiaľ žiadne verejné tlačidlo „Odoslať eFaktúru"
Len interný development/validation nástroj.

---

## 7. Fáza H + I — Inbound structured eInvoice a jednotná pipeline

```
INPUT (upload / foto / e-mail / provider)
        ↓
   identify source
        │
   ┌────┴─────────────────────┐
   │                          │
validný structured        všetko ostatné
eInvoice (UBL/XML)              │
   │                            │
 parse                    AI/OCR extrakcia
 validate                       │
   │                            │
   └────────┬───────────────────┘
            ↓
        normalize → canonical candidate
            ↓
        DEDUPE (§2)
            ↓
        REVIEW (structured: menej polí na kontrolu)
            ↓
        canonical received invoice
```

**Structured data má absolútnu prioritu pred AI/OCR.**

Ak príde validný eInvoice, **nikdy ho neposielať do OCR**, aby sa z neho znova hádali údaje, ktoré už sú v ňom explicitne a strojovo čitateľne uvedené. To je priamo zásada č. 2 zo zadania.

Originálny XML sa zachová ako `document_attachments` záznam s `attachment_type='source_xml'`.

Pri structured vstupe je review kratší — potvrdzujú sa len partner matching a prípadné nejasnosti, nie každé pole.

---

## 8. Fáza J — Payments: čo overiť, nič nemeniť

Existujúci payment flow sa **nesmie rozbiť**. Bankové API sa teraz nerobí.

Canonical model je na budúce bank transaction matching pripravený:
- `invoices.payment_reference` (nové) + `variable_symbol` — párovacie kľúče ✅
- `invoice_parties.iban` — účet ✅
- `invoice_payments` — partial payments už podporované ✅
- `payment_status` — unpaid / partially_paid / paid ✅

**Čo ešte chýba pre budúcnosť (needávať teraz):**
- overpayment (dnes by prepočet `payment_status` musel riešiť `paid > total`)
- efekt credit note na payment status pôvodnej faktúry
- väzba platby na konkrétny bankový účet

Zaznamenané ako OPEN, neimplementuje sa.

---

## 9. Test matrix

### Security
owner · finance.view · finance.manage · admin bez financií · employee bez financií · používateľ z cudzej firmy · anonymous

### Received invoice
manuálne · z AI Inbox · zo structured XML · duplicate · near duplicate · neznámy partner · matchnutý partner · ambiguous partner

### VAT
S · Z · E · AE

### Money
jedna sadzba · viac sadzieb · zaokrúhľovanie · čiastočná platba

### História
- stará finalized faktúra s NULL novými EN poliami **musí zostať čitateľná**
- PDF **musí naďalej fungovať**
- eInvoice export **musí zlyhať fail-closed**, ak chýbajú mandatory structured polia

### Dedupe (doplnené)
- ten istý súbor 2× → vrstva A
- PDF a XML tej istej faktúry → vrstva B, fail closed
- rovnaké číslo, iný dodávateľ → prejde
- dobropis s podobným číslom → prejde
- OCR preklep → near-duplicate varovanie, nie blokovanie
- dodávateľ bez identifikátorov → fingerprint NULL, dedupe nebeží, žiadny pád
- súbežné potvrdenie tej istej faktúry dvoma používateľmi → unique index drží

---

## 10. Poradie commitov

1. `received invoice canonical core` — supplier partner, constrainty, finalize RPC
2. `dedupe` — hash, fingerprint, transport ID, unique indexy, document_links.invoice_id
3. `EN16931 P1 schema + snapshot` — party polia, invoice polia, master data, finalize snapshot
4. `UBL mapper + validator` — interný nástroj, bez verejného tlačidla
5. `inbound structured invoice` — parser, structured-first pipeline
6. `UX` — received/issued rozlíšenie, filtre, source type, document link
7. `docs` — tento dokument a ostatné

---

## 11. OPEN — nerozhoduje sa bez ďalších informácií

| # | Otázka | Prečo OPEN |
|---|---|---|
| O1 | VAT kategória `K` (a prípadne `G`, `O`) | Závisí od publikovanej SK CIUS. Neháda sa. |
| O2 | Povinné reason codes pre `E` a `AE` v SK profile | Závisí od SK CIUS. |
| O3 | Či je `buyer_reference` v SK CIUS mandatory | V Peppol BIS často áno; SK profil nepotvrdený. |
| O4 | Správanie pri reissue (§2.4) | Navrhnutý fail-closed. Ak sa v praxi ukáže ako príliš tvrdé, riešiť storno flow — nie povolením prepisu. |
| O5 | Výber Peppol providera | Zadanie správne hovorí nevyberať. Adapter interface áno, provider nie. |
