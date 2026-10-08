# Zdanená záloha v konečnej e-faktúre — model podľa FS SR (7. 10. 2026)

> **8. 10. 2026:** faktúra k prijatej platbe sa odosiela s `InvoiceTypeCode` **388** (FS FAQ tech. príklad 22); príjem
> akceptuje 388 aj 386. Sandbox E2E v sekcii 3 (7. 10.) prebehol ešte s kódom 386.

Zdroj pravdy: Finančná správa SR, FAQ k eFaktúre (verzia 15. 9. 2026), technická séria, **príklad 38**.
Toto je technická implementácia metodiky FS. Nejde o právne stanovisko ani o schválenie CLIA. Predkontácia
(účtovanie mínusového riadku) je otázka pre účtovníčku a Esblu ju nerozhoduje.

## 1. Daňový model

| | A) ZDANENÁ záloha | B) NEZDANENÁ záloha |
| --- | --- | --- |
| Podmienka | k platbe existuje faktúra k prijatej platbe (UBL **388**; prijímame aj 386) | faktúra k prijatej platbe neexistuje |
| V konečnej faktúre | samostatný **mínusový riadok** `InvoiceLine` | `PrepaidAmount` (BT-113) |
| UBL riadok | `InvoicedQuantity` = **−1**, `PriceAmount` = základ zálohy (kladný, BR-27), `LineExtensionAmount` = −základ | — |
| DPH | kategória a **sadzba zálohovej faktúry**, DPH riadka = DPH zálohy | rozpis DPH sa **nemení** |
| Rekapitulácia DPH (BG-23) | znižuje základ aj daň v danej sadzbe | bez vplyvu |
| Väzba | `BillingReference/InvoiceDocumentReference` (BT-25, BT-26) na faktúru k prijatej platbe | voliteľný text (referencia) |
| Suma na úhradu | `PayableAmount` = celkom s DPH (už po odpočte) − nezdanená záloha | dtto |
| `PrepaidAmount` pre túto zálohu | **nikdy** | áno |

**DB (vydané):**
- počas konceptu sa odpočty zadávajú do `invoice_advance_deductions`;
- validácia prebehne hneď pri zadaní:
  - existujúca **finalizovaná vlastná faktúra k prijatej platbe** (odosiela sa ako 388);
  - rovnaký odberateľ a mena;
  - rovnaká kategória a sadzba (inak `ESBLU_ADVANCE_DEDUCTION_RATE_MISMATCH`);
  - suma najviac do zostatku základu aj DPH (inak `ESBLU_ADVANCE_DEDUCTION_EXCEEDS`);
- pri finalizácii z nich vzniknú riadky `invoice_items`:
  - `is_advance_deduction`, `advance_invoice_id`;
  - `advance_vat_amount` = DPH zálohy, pevne určená, nerozpočítava sa;
- nezdanená záloha sa ukladá do `invoices.untaxed_prepaid_amount` (a voliteľne `untaxed_prepaid_reference`).

**DB (prijaté):**
- mínusové riadky z XML sa uložia ako riadky odpočtu;
- párovanie prebieha po riadkoch na prijaté faktúry k prijatej platbe (388 alebo staršie 386) v rámci tej istej firmy a dodávateľa podľa BT-25 (+ BT-26), sadzby a zostatku základu;
- výsledkom je `proposed`, inak `review` s dôvodom;
- dôvody review:
  - `ADVANCE_REFERENCE_MISSING`, `ADVANCE_NOT_FOUND`, `ADVANCE_SUPPLIER_MISMATCH`, `ADVANCE_AMBIGUOUS`;
  - `ADVANCE_CURRENCY_MISMATCH`, `ADVANCE_ALREADY_DEDUCTED`, `ADVANCE_RATE_MISMATCH`, `ADVANCE_VAT_MISMATCH`;
- `received_advance_links` nesie kategóriu a sadzbu;
- guard zabráni dvojitému odpočtu a priradeniu cudzej firmy;
- BT-113 na prijatej faktúre = nezdanená záloha, ktorá sa nepáruje.

**Saldo:**
- zdanené zálohy sú už v `total_amount`, takže sa neodpočítavajú druhýkrát;
- odpočíta sa iba nezdanená záloha;
- staršie finalizované konečné faktúry bez mínusových riadkov ostávajú v pôvodnom výpočte.

## 2. Migrácie (iba staging `esblu-test`)

| Migrácia | Obsah | Staging |
| --- | --- | --- |
| `20261008100009_taxed_advance_deduction_lines` | model A/B, finalizácia, compliance, saldo, prijaté párovanie, create_draft, tolerancia DPH ±0,01 | aplikovaná 7. 10.; md5 18 funkcií = PGlite |
| `20261008100010_received_advance_match_safeupdate` | oprava nálezu z E2E (nižšie) | aplikovaná 7. 10.; md5 = PGlite |

Rollbacky: `supabase/rollback/20261008100009_…`, `…100010_…`. Produkčný precheck: kontroly 24–25 (záporné ceny, CHECK `unit_price`).

## 3. Reálny sandbox E2E (eFaktura.sk sandbox, 7. 10. 2026)

Firma A (dodávateľ) → firma B (odberateľ), obe syntetické staging firmy, Preview `einvoice-port`.

| Krok | Výsledok |
| --- | --- |
| A: 386 FA20260014 (100 € @ 23 %) a FA20260015 (40 € @ 19 %) | finalizované |
| A: odpočet 386 @ 19 % so sadzbou 23 % | odmietnuté `ESBLU_ADVANCE_DEDUCTION_RATE_MISMATCH` |
| A: konečná FA20260016: 300 € @ 23 % + 100 € @ 19 %, odpočty oboch záloh, nezdanená záloha 10 € | riadky −100/−23 a −40/−7,60; rozpis 23 %: 200/46, 19 %: 60/11,40; celkom 317,40; na úhradu 307,40 |
| A: druhý odpočet tej istej zálohy | odmietnuté `ESBLU_ADVANCE_DEDUCTION_EXCEEDS` |
| Odoslanie všetkých troch dokladov cez route → provider | `sent` → **`delivered`** (provider UBL s mínusovými riadkami a BT-113 prijal) |
| B: príjem konečnej faktúry **pred** zálohami | koncept, `review` (`ADVANCE_NOT_FOUND`), súčty = XML |
| B: príjem 386 FA20260015 po konečnej faktúre | **NÁLEZ** — pozri nižšie; po oprave `20261008100010` prijaté |
| B: dodatočné párovanie | `proposed`; väzby 100/23 (@23 %) a 40/7,60 (@19 %) |
| A sa pokúsi priradiť zálohu na faktúru B | `ESBLU_INVOICE_NOT_FOUND` (cross-tenant) |
| B: finalizácia konečnej faktúry pred finalizáciou záloh | `ESBLU_RECEIVED_ADVANCE_NOT_FINALIZED` |
| B: finalizácia 386 a potom konečnej | OK, `linked`; saldo: položky 488, zdanené zálohy 170,60, nezdanená 10, na úhradu 307,40 |
| Export pre účtovníka A aj B | 200, SHA balíka sedí, `advance-deductions.csv` a `received-advance-links.csv` prítomné |

**Nález z E2E:**
- Supabase pre spojenia PostgREST načítava `pg_safeupdate`, ktorý odmietne `DELETE` bez `WHERE` (SQLSTATE 21000).
- Párovanie mazalo dočasné tabuľky bez `WHERE`.
- PGlite ani `execute_sql` pod rolou postgres to neodhalia.
- Prejavilo sa to iba vtedy, keď 386 prišla po konečnej faktúre a párovanie došlo až do výpočtu.
- Oprava: `where true` (migrácia `100010`).
- Regresný test (`einvoice-ui`): platná definícia žiadnej funkcie nesmie mať `DELETE` bez `WHERE`.

Upratovanie po E2E:
- `ESBLU_STAGING_E2E_ENABLED=false`;
- dočasný secret zmazaný;
- bypass zrušený (počet 0);
- rollout A/B späť na `paused`.

Na stagingu ostali dva koncepty A z negatívnych testov (nefinalizované).

## 4. Čo ostáva mimo kódu

- Predkontácia mínusového riadku je otázka pre účtovníčku (kategória C).
- Validácia provider-side v sandboxe prebehla iba ako „delivered“. Formálny validačný report SK profilu od providera nemáme (otázka v e-maile pre eFaktura.sk).
