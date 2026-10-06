# Fakturácia a eFaktúra Esblu — právno-účtovný audit podľa SK predpisov (október 2026)

Interný technický podklad. **Nie je to právne ani daňové stanovisko. Nič v ňom nie je schválené CLIA,
daňovým poradcom ani účtovníčkou.** Prešlé testy dokazujú iba to, že kód robí to, čo je tu opísané.

Vetva `einvoice-port`. Migrácie `20261008100000` – `20261008100004` sú aplikované **iba** na staging
`esblu-test`. Produkčná DB, `main`, produkčné migrácie, produkčné secrets ani live eFaktúra sa nemenili.

Verzia dokumentu: 3 (FX podľa oficiálnych dát ECB, presné § 73). Zmeny sú v sekcii 12.

## 0. Legenda a zdroje

Každé pravidlo má práve jeden typ zdroja:

| Značka | Význam |
| --- | --- |
| **LAW** | priamo z textu zákona (Slov-Lex, citované znenie) |
| **OFFICIAL GUIDANCE** | oficiálny výklad alebo materiál FS SR / MF SR (FAQ, metodické informácie, manuály) — nie je to zákon |
| **PEPPOL/TECH STANDARD** | EN 16931, Peppol BIS Billing 3.0, Peppol SK TDD, SK transpozícia Peppol BIS |
| **PRODUCT DECISION** | rozhodnutie Esblu (prísnejšie alebo pohodlnejšie než predpis); dá sa zmeniť |
| **LEGAL REVIEW** | právna kvalifikácia alebo výklad nie je istý → CLIA / daňový poradca / účtovníčka |

Stav implementácie: **PASS** (implementované a otestované), **GAP** (chýba), **REVIEW** (technicky
hotové, právna kvalifikácia otvorená).

| Skratka | Zdroj | Odkaz (verzia) |
| --- | --- | --- |
| ZoÚ | zákon č. 431/2002 Z. z. o účtovníctve | https://static.slov-lex.sk/static/SK/ZZ/2002/431/20270101.html (znenie účinné od 1. 1. 2027) |
| ZDPH | zákon č. 222/2004 Z. z. o DPH | https://static.slov-lex.sk/static/SK/ZZ/2004/222/20270101.html (znenie účinné od 1. 1. 2027) |
| 385/2025 | novela ZDPH a ZoÚ (eFaktúra), vyhlásená 19. 12. 2025 | https://static.slov-lex.sk/static/SK/ZZ/2025/385/20270101.html |
| FS eFaktúra | FS SR — eFaktúra (FAQ 15. 9. 2026, MI 7/DPH/2025/I, 1/DPH/2026/I, SK transpozícia Peppol BIS v1.11 z 10. 9. 2026) | https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/e-faktura |
| Peppol BIS | Peppol BIS Billing 3.0 (May 2026 release) | https://docs.peppol.eu/poacc/billing/3.0/ — kódy faktúry https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL1001-inv/ , dobropisu https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL1001-cn/ |
| SK TDD | Peppol Slovak Republic Tax Data Document 1.0.0 (14. 4. 2026) | https://docs.peppol.eu/tdd/sk/tdd-sk/ |
| SK transpozícia | FS SR: „Transpozície štandardu Peppol BIS v podmienkach Slovenskej legislatívy“ v1.11 (10. 9. 2026), xlsx 942 719 B | https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Podnikatelia/Dan_z_pridanej_hodnoty/efaktura/2026/2026.09.11_Peppol_Bis3_v1_11.xlsx |
| ECB kurzy | ECB „Euro foreign exchange reference rates“ (publikačné pravidlo, súbory eurofxref, história mien) | https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html |
| NBS kurzy | NBS „Exchange rates“ — referenčné kurzy ECB a mesačné kurzy vybraných mien | https://nbs.sk/en/statistics/exchange-rates/ |

Citované paragrafy sú zo znenia účinného od 1. 1. 2027; § 26, § 72 a § 73 som porovnal aj so znením 1. 1. 2026 – 31. 12. 2026 (https://static.slov-lex.sk/static/SK/ZZ/2004/222/20260101.html) — sú zhodné. Pre rok 2026 platí predchádzajúce znenie;
pre fakturáciu sa líšia najmä § 71 ods. 5, § 76a, § 85o ZDPH a § 31, § 35 ZoÚ. Čísla otázok vo FAQ FS
sa môžu meniť — pred citovaním overiť.

---

## 1. Kurzy cudzej meny (§ 26 ZDPH) — podľa oficiálnych dát ECB

### 1a. LAW

§ 26 ods. 1 (znenie 2026 aj 2027 zhodné): platba v cudzej mene sa prepočíta „referenčným výmenným kurzom
určeným a vyhláseným Európskou centrálnou bankou alebo Národnou bankou Slovenska v deň predchádzajúci
dňu vzniku daňovej povinnosti“. Alternatíva: „kurz platný podľa colných predpisov v deň vzniku daňovej
povinnosti“ — rozhodnutie treba vopred písomne oznámiť daňovému úradu a je „záväzné počas celého
kalendárneho roka“. „Pri oprave základu dane podľa § 25 sa použije kurz, ktorý sa použil pri vzniku
daňovej povinnosti.“ Zákon výslovne nerieši deň, v ktorý sa kurz nevyhlásil.

### 1b. ECB/NBS publication rule

| Pravidlo | Zdroj | Typ |
| --- | --- | --- |
| ECB aktualizuje referenčné kurzy okolo 16:00 SEČ **každý pracovný deň okrem dní zatvorenia TARGET** | stránka ECB „Euro foreign exchange reference rates“ | OFFICIAL GUIDANCE (ECB) |
| Súbory eurofxref obsahujú každý deň, keď ECB kurzy vyhlásila; deň, ktorý chýba, nebol dňom vyhlásenia | štruktúra oficiálnych súborov ECB (overené na dátach: 25.–26. 12. 2025, 1. 1., 3. 4., 6. 4., 1. 5. 2026 chýbajú; 6. 1., 1. 9., 15. 9. 2026 sú prítomné) | PEPPOL/TECH STANDARD (dátový formát) |
| Slovenský sviatok sám osebe neznamená, že kurz ECB neexistuje (napr. 6. 1. 2026, 15. 9. 2026 — kurz ECB vyhlásený) | dáta ECB | OFFICIAL GUIDANCE (ECB) |
| NBS na svojom webe zverejňuje referenčné kurzy ECB; vlastné „kurzy vybraných cudzích mien“ NBS sú **mesačné a len informatívne** | stránky NBS „ECB foreign exchange reference rates“ a „Exchange Rates of Selected Foreign Currencies“ | OFFICIAL GUIDANCE (NBS) |
| Ak sa v deň predchádzajúci dňu vzniku kurz nevyhlásil, použije sa posledný vyhlásený kurz pred ním | technický výklad (zákon to výslovne neuvádza) | **LEGAL REVIEW** |
| Mesačné kurzy NBS pre meny mimo zoznamu ECB ako „kurz vyhlásený v deň predchádzajúci“ | — | **LEGAL REVIEW** (Esblu ich nepoužíva) |

### 1c. PRODUCT IMPLEMENTATION (`20261008100004_fx_official_reference_rates.sql`)

**Čo bolo nepresné (verzia 2, `20261008100003`):** dostupnosť kurzu určoval ručne zakódovaný kalendár
TARGET (víkendy, 1. 1., Veľký piatok, Veľkonočný pondelok, 1. 5., 25. a 26. 12.) + tabuľka výnimiek.
Nebol to slovenský sviatkový kalendár (slovenské sviatky správne neovplyvňoval), ale bol to predpoklad,
nie oficiálny údaj: nevedel, či ECB kurz konkrétnej meny v daný deň skutočne vyhlásila, a **hodnotu kurzu
neoveroval vôbec**. Kalendár, výnimky a TS nápoveda boli odstránené.

| Prvok | Implementácia | Stav |
| --- | --- | --- |
| Oficiálne dáta | `fx_reference_rates` (ECB, mena, dátum, kurz) + `fx_rate_import_batches` (URL ECB, SHA-256, meny, interval úplného pokrytia); obe append-only aj pre service_role; čítanie pre prihlásených (verejné dáta) | PASS |
| Import | `lib/fx/ecb-reference-rates.ts` (prísny parser eurofxref XML, iba `https://www.ecb.europa.eu/`), `GET /api/cron/fx-rates` (CRON_SECRET) → `esblu_fx_import_ecb_batch` (iba service_role); idempotentný podľa SHA-256; iný kurz pre ten istý deň = `ESBLU_FX_RATE_CONFLICT`; nový kurz v už pokrytom intervale = `ESBLU_FX_COVERAGE_CONFLICT` — minulosť sa nikdy nemení | PASS |
| Pokrytie | od prvého dňa v súbore po deň pred stiahnutím (Europe/Bratislava); deň stiahnutia iba ak ho súbor už obsahuje | PASS |
| Vyhľadanie | `esblu_fx_official_rate(mena, deň vzniku)` = posledný kurz meny s dátumom ≤ deň vzniku − 1; vyžaduje, aby celý interval po deň vzniku − 1 bol pokrytý importom (inak `data_missing`); ak ECB v intervale vyhlásila iné meny a túto nie → `not_published` | PASS |
| Finalizácia (vydaná, ECB/NBS) | povinne `ok`, presný dátum (`ESBLU_FX_RATE_DATE_INVALID`) a presná hodnota kurzu (`ESBLU_FX_RATE_MISMATCH`); bez dát `ESBLU_FX_RATE_DATA_MISSING` / `ESBLU_FX_RATE_NOT_PUBLISHED` — žiadny odhad ani 10-dňové okno | PASS |
| Nemennosť | uloží sa `fx_rate`, `fx_rate_date`, `fx_rate_source`, `fx_tax_point_date` (rozhodný deň), `fx_reference_rate_id`, `tax_base_eur`, `vat_total_eur`; po finalizácii nemenné (trigger, aj service_role) | PASS |
| Oprava (§ 25) | kurz, dátum, zdroj, rozhodný deň aj referencia z pôvodnej faktúry; nevyžaduje nové dáta | PASS |
| Colný kurz | dátum = deň vzniku; v kalendárnom roku sa v rámci firmy nemieša s ECB/NBS; hodnota sa neoveruje (dáta colných kurzov Esblu nemá); evidencia oznámenia daňovému úradu chýba | PASS / GAP |
| Zobrazenie faktúry | žiadne sieťové volanie; UI číta oficiálny kurz z DB (`esblu_fx_official_rate`) iba pri koncepte | PASS |
| Prijaté doklady | kurz a dátum sa preberajú z dokladu dodávateľa, pravidlo dňa sa nevynucuje | LEGAL REVIEW |
| Prevádzka | cron zatiaľ nie je naplánovaný (`vercel.json`); odporúčané denne ráno; bez importu sa doklady v cudzej mene so zdrojom ECB/NBS nefinalizujú | GAP (produkčný krok) |
| Staging | importované reálne kurzy ECB (USD, CZK: 9. 7. – 6. 10. 2026 a okná okolo 25. 12. 2025 – 9. 1. 2026, Veľkej noci a 1. 5. 2026) | PASS |

## 2. Faktúra k prijatej platbe a kód 386

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Platba pred dodaním → daňová povinnosť dňom prijatia platby (§ 19 ods. 4) → faktúra (§ 71, § 73 ods. 1 b)) | LAW | `payment_received_invoice` vyžaduje dátum prijatia platby | PASS |
| Proforma (výzva na platbu) nie je daňový doklad | OFFICIAL GUIDANCE (FAQ FS) | druh `proforma`, séria PF, neodosiela sa ako e-faktúra, nejde do balíka ako daňový doklad | PASS |
| Faktúra k prijatej platbe v UBL ako `InvoiceTypeCode` **386 (Prepayment invoice)** | PEPPOL/TECH STANDARD | **PEPPOL PASS:** 386 je v Peppol BIS Billing 3.0 (UNCL1001-inv subset, May 2026 release) | PASS |
| 386 v slovenskom profile | PEPPOL/TECH STANDARD | **SK TDD 1.0.0:** 386 je v code liste `UNCL1001-inv`. **SK transpozícia Peppol BIS v1.11 (FS, 10. 9. 2026), prečítaná:** BT-3 je povinný (1..1), popis „Obchodné faktúry a dobropisy sú definované podľa položiek číselníka UNTDID 1001. Ostatné položky UNTDID 1001 sa môžu u konkrétnych faktúr alebo dobropisov použiť podľa potreby“; žiadne slovenské obmedzenie kódov (380/381/383/386) v hárkoch pravidiel ani termínov (UBL-CR-380 … UBL-CR-389 sú čísla pravidiel UBL, nie kódy typu faktúry). Pri BT-3 je poznámka „nebude doplnené do § 74, bude riešené v podzákonnej norme“ | **technicky PASS; SLOVAK PROFILE REVIEW** (podzákonná norma ešte nie je) |
| Konečná faktúra odpočíta zálohy; UBL `PrepaidAmount` (BT-113) | LAW (§ 74) + PEPPOL | `invoice_advance_deductions`, `PrepaidAmount` | PASS (DB/UBL), GAP (UI) |

## 3. Účtovný doklad — originál XML, vizualizácia, koncept

Dátový model (technický stav):

| Vrstva | Čo to je | Integrita | Stav |
| --- | --- | --- | --- |
| **Originálny UBL/XML** (prijatý aj odoslaný) | nemenný originálny elektronický dokument | privátny bucket `einvoice-documents` (žiadna storage policy pre klientov; zápis iba server s `upsert: false`); `einvoice_inbound`/`einvoice_outbound` drží SHA-256, cestu a veľkosť — po zápise ich trigger nedovolí zmeniť (`ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE`); pri exporte sa hash znovu overí | PASS |
| **PDF / render** | ľudsky čitateľná vizualizácia generovaná z dát Esblu | nie je originálom; v balíku pre účtovníka sa pri e-faktúre vždy pribalí aj originál XML s overeným SHA-256 | PASS |
| **Koncept / review v Esblu** | samostatný aplikačný záznam (`invoices` draft + položky) | vzniká z XML; úpravy používateľa ani AI sa zapisujú iba do konceptu, **nikdy do XML**; finalizácia prijatej e-faktúry musí súhlasiť so súčtami a rozpisom DPH z XML (`ESBLU_EINVOICE_FINALIZE_TOTALS_MISMATCH`, 20261003100000) | PASS |
| Záznam o úpravách konceptu po poliach (pred/po) | — | neexistuje; „pred“ = XML, „po“ = finalizovaný záznam | GAP |

Právna kvalifikácia:

| Otázka | Typ | Stav |
| --- | --- | --- |
| Čo je účtovným dokladom pri e-faktúre (XML, XML + vizualizácia, alebo záznam v účtovníctve)? ZoÚ § 10, § 31 (elektronický záznam „zaslaný a prijatý“ od 1. 1. 2027), § 35 ods. 2 a ZDPH § 71 ods. 1 b) („elektronickou faktúrou je faktúra … vydaná a prijatá v akomkoľvek elektronickom formáte“) | LEGAL REVIEW | Esblu **netvrdí**, že XML je jediný zákonný účtovný doklad. FS uvádza, že e-faktúra „nie je len obyčajný PDF súbor“ (OFFICIAL GUIDANCE, stránka eFaktúra), čo podporuje uchovanie XML, ale nerieši právnu kvalifikáciu konceptu ani PDF. |
| Technická integrita originálu (vierohodnosť pôvodu, neporušenosť, čitateľnosť — § 71 ods. 1 c), d), ods. 3 ZDPH; § 31 ods. 3 ZoÚ) | LAW | technicky PASS (hash, nemennosť, dôkaz doručenia); právne posúdenie postačujúcosti → LEGAL REVIEW |

## 4. Vnútorný kontrolný systém (ZoÚ § 32 ods. 3 c)) — iba technický opis

Esblu **netvrdí**, že jeho audit trail je vnútorným kontrolným systémom v zmysle zákona. Technicky
poskytuje:

| Prvok | Ako | Stav |
| --- | --- | --- |
| Nemenný originál | XML v privátnom úložisku, identita (hash, cesta, veľkosť) nemenná | PASS |
| Hash | SHA-256 pri príjme aj odoslaní, overenie pri exporte | PASS |
| Audit opráv | oprava iba novým dokladom (dobropis/ťarchopis) s povinným dôvodom; udalosť `correction_created` na pôvodnej faktúre; pôvodný doklad sa nemení | PASS |
| Identita používateľa | `invoice_events.actor_user_id`, `updated_by`, operátorské akcie v `einvoice_events` | PASS |
| Čas | `finalized_at`, `created_at` udalostí (DB čas, nie zadaný používateľom) | PASS |
| Stav pred/po | pri dokladoch: pôvodný doklad + opravný doklad (nemenné oba); pri prijatých: XML + finalizovaný záznam; prechody stavov e-faktúry v `einvoice_events` | PASS; GAP: diff úprav konceptu po poliach |
| Append-only udalosti | `invoice_events` nemožno meniť ani mazať (aj service_role) | PASS |
| Dôkaz doručenia | `einvoice_outbound` dôkaz poskytovateľa (povolené polia), stav `delivered` | PASS |
| **Či toto spĺňa požiadavku vnútorného kontrolného systému** | — | **LEGAL REVIEW** |

## 5. Lehota na vyhotovenie faktúry (§ 73 ZDPH) — presné pravidlá, inak REVIEW

**LAW** (znenie 1. 1. 2026 aj 1. 1. 2027 zhodné): faktúra **podľa § 72** do 15 dní a) odo dňa dodania,
b) odo dňa prijatia platby pred dodaním **alebo** do konca kalendárneho mesiaca prijatia platby,
c) od konca mesiaca dodania tovaru oslobodeného podľa § 43, d) od konca mesiaca dodania služby (alebo
prijatia platby pred dodaním služby) s miestom dodania podľa § 15 ods. 1 v inom členskom štáte, e) od konca
mesiaca skutočnosti rozhodnej pre opravu podľa § 25 ods. 1; a) a b) platia, „ak odsek 2 neustanovuje
inak“. **Ods. 2:** platiteľ, ktorý splnil registračnú povinnosť, no do uplynutia lehoty nemá IČ DPH → do
5 pracovných dní od doručenia rozhodnutia o registrácii. **§ 72 ods. 1** ukladá povinnosť platiteľovi,
**§ 72 ods. 2** neplatiteľovi iba pri službe s miestom dodania v inom členskom alebo treťom štáte,
**§ 72 ods. 8** — faktúra sa nevyhotovuje pri tuzemských plneniach oslobodených podľa § 28 až 42.

**PRODUCT IMPLEMENTATION** (`lib/invoicing/sk-deadlines.ts`): výsledok je `determined` (termín),
`review` (Esblu termín neurčí a žiadny nepodsunie) alebo `not_applicable`. Vystavenie sa nikdy neblokuje.

| Prípad | Výsledok | Stav |
| --- | --- | --- |
| Platiteľ s IČ DPH, odberateľ SK, kategórie S / AE (§ 69 ods. 12) / E+S, bežná faktúra | a) dátum dodania (inak DUZP) + 15 | PASS |
| To isté, faktúra k prijatej platbe | b) zobrazia sa **oba** termíny (deň platby + 15 a koniec mesiaca); oneskorenie sa hlási až po neskoršom | PASS / LEGAL REVIEW (výklad „alebo“) |
| Výlučne K (§ 43), odberateľ mimo SK, bežná faktúra | c) koniec mesiaca dodania + 15 | PASS |
| Dobropis/ťarchopis so zadaným dňom skutočnosti rozhodnej pre opravu | e) koniec mesiaca + 15 | PASS |
| Dobropis/ťarchopis bez tohto dňa | REVIEW (`correction_fact_date_missing`) — dátum dodania pôvodného plnenia sa nepoužije | PASS |
| Odberateľ mimo SK okrem čistého K (služby do EÚ — d), tretie štáty, AE so zahraničným odberateľom), zmiešané K + iné | REVIEW (`cross_border_or_mixed`) — Esblu nerozlišuje tovar/službu ani miesto dodania podľa § 15 | PASS (bez aproximácie) |
| Kategórie O, G, Z | REVIEW (`unclassified_vat_category`) | PASS |
| Platiteľ bez IČ DPH | REVIEW (`vat_registration_pending`, možný § 73 ods. 2) | PASS |
| Neznámy stav platiteľa | REVIEW (`seller_vat_status_unknown`) | PASS |
| Výlučne E, odberateľ SK | `not_applicable` (§ 72 ods. 8) | PASS |
| Neplatiteľ: odberateľ SK → `not_applicable`; odberateľ mimo SK → REVIEW (§ 72 ods. 2) | — | PASS |
| Proforma, prijatá faktúra | `not_applicable` | PASS |
| Posun konca lehoty na pracovný deň | neriešené → termín je konzervatívny | LEGAL REVIEW |
| UI | termín / oba termíny pri b) / varovanie po lehote / text „lehotu Esblu neurčuje“ pri REVIEW | PASS |
| Export (`metadata.json`) | `issue_deadline_status`, `issue_deadline`, `issue_deadline_alternative`, `issue_deadline_rule`, `issue_deadline_review_reason`, `issued_after_deadline`, `finalized_at` | PASS |

## 6. Prijaté dobropisy a opravy cez Peppol — NÁVRH (neimplementované)

Stav: **GAP**. Dnes sa prijatý `CreditNote` odmietne (`UNSUPPORTED_PROFILE` / `CREDIT_NOTE_NOT_SUPPORTED`),
XML sa uloží, koncept nevznikne → ručné spracovanie.

**Typy dokumentov (PEPPOL/TECH STANDARD):**

| Dokument | Kód | Návrh |
| --- | --- | --- |
| `ubl:CreditNote` — Credit note | 381 | podporiť (hlavný prípad) |
| `ubl:CreditNote` — related to goods or services / financial adjustments | 81 / 83 | podporiť ako 381 (83 = bonus/zľava bez položiek tovaru — LEGAL REVIEW pre DPH) |
| `ubl:CreditNote` — factored / forwarder's | 396 / 532 | odmietnuť → ručné spracovanie |
| `ubl:Invoice` — Debit note | 383 | podporiť ako prijatý ťarchopis |
| `ubl:Invoice` — Corrected invoice | 384 | odmietnuť → ručné (FS odporúča dobropis + novú faktúru — OFFICIAL GUIDANCE) |
| `ubl:Invoice` — Prepayment invoice | 386 | podporiť ako prijatá faktúra k platbe (bez nároku Esblu na posúdenie odpočtu) |

**Väzba na originál:**

1. Zdroj väzby: `cac:BillingReference/cac:InvoiceDocumentReference` (BT-25 číslo, BT-26 dátum). § 74 ods. 3
   c) vyžaduje poradové číslo pôvodnej faktúry (LAW) → chýbajúce BT-25 = koncept na ručnú kontrolu.
2. Párovanie iba v rámci **tej istej firmy** (`company_id` z príjmu e-faktúry, nie z XML), smeru
   `received`, toho istého dodávateľa (`supplier_business_partner_id` podľa Peppol ID / IČO z XML) a
   `supplier_invoice_number = BT-25`. Viac zhôd alebo žiadna → koncept bez väzby, používateľ vyberie.
3. Dátový model: dnes CHECK vyžaduje `corrects_invoice_id` pri `credit_note`. Návrh: pre
   `direction = 'received'` povoliť `corrects_invoice_id` null, ak je vyplnený nový stĺpec
   `corrected_document_reference` (BT-25 + BT-26 ako text), a doplniť `corrects_invoice_id` neskôr
   (iba v koncepte).

**Ochrana proti cross-tenant väzbe:**

- DB trigger pri vložení aj zmene: `corrects_invoice_id` musí ukazovať na doklad s rovnakým `company_id`,
  rovnakým `direction` a (pri prijatých) rovnakým dodávateľom; inak `ESBLU_CORRECTION_CROSS_TENANT`.
- Párovanie beží v SECURITY DEFINER funkcii s `company_id` z riadku `einvoice_inbound`, nikdy z XML.
- Regresný test: dobropis firmy B s BT-25 = číslo faktúry firmy A sa nesmie naviazať.

**DPH a saldo:**

- Sumy kladné, znamienko podľa druhu (`accounting_sign = −1`) — rovnako ako vydané dobropisy.
- DPH z dobropisu znižuje odpočet príjemcu (oprava odpočítanej dane, § 53 ZDPH — LEGAL REVIEW pre presné uplatnenie); Esblu o nároku na odpočet nerozhoduje
  (PRODUCT DECISION) — v exporte iba znamienko a rozpis DPH z XML.
- Saldo pôvodnej faktúry = suma − úhrady − finalizované dobropisy + ťarchopisy; úhrada sa na dobropis
  neeviduje (už platí). Vrátenie peňazí dodávateľom → nový typ záznamu „prijaté vrátenie“ k pôvodnej
  faktúre (návrh), nie úhrada dobropisu.
- Kurz pri cudzej mene: z XML dobropisu; kontrola zhody s kurzom pôvodnej prijatej faktúry iba ako
  upozornenie (LEGAL REVIEW).

Implementácia čaká na potvrdenie tohto návrhu.

## 7. Finance oprávnenie viazané na firmu — AUDIT A OPRAVA

**Zistenie z verzie 1:** `esblu_my_finance_manage()` a `esblu_my_finance_view()` vyhodnocovali
„prvé aktívne členstvo“ (`limit 1`) bez väzby na firmu zdroja.

**Audit (server-side a RLS, staging):**

- Unikátny index `company_members_one_active_per_user_idx` (od 20260814…) dovoľuje používateľovi
  **najviac jedno aktívne členstvo** (staging overené: 0 používateľov s viac ako jedným aktívnym).
  Prvé aktívne členstvo = aktívna firma.
- Všetky RLS politiky a SECURITY DEFINER funkcie, ktoré volajú `esblu_my_finance_*`, porovnávajú
  zároveň `company_id` zdroja s `esblu_my_active_company_id()` (staging dotaz: 0 výnimiek).
- Serverové route (PDF, UBL, odovzdanie účtovníkovi, operátorské akcie e-faktúry) čítajú zdroj cez
  RLS alebo porovnávajú `company_id` riadku s aktívnou firmou (`esblu_einvoice_operator_begin`).
- **Záver:** dnes **nie je zneužiteľné** — väzba však bola iba implicitná (závislá od indexu).

**Oprava (defense in depth, `20261008100002_finance_helpers_bind_active_company.sql`):** helpery
explicitne vyhodnotia oprávnenie pre `esblu_my_active_company_id()`. Sémantika rolí nezmenená.
PGlite baseline doplnený o produkčné unikátne indexy (predtým chýbali — testy by multi-membership
nezachytili).

**Regresné testy:** (1) owner firmy A s neaktívnym členstvom vo firme B nevidí faktúry B, nefinalizuje,
nemení polia ani nezapíše úhradu; (2) pozvaný (nie aktívny) owner B s aktívnym členstvom bez financií v A
nemá finance nikde; (3) druhé aktívne členstvo DB odmietne; (4) pri simulovanom porušení invariantu
(index dočasne odstránený) sa oprávnenie vyhodnotí pre aktívnu firmu a druhá firma je neviditeľná.

---

## 8. Ostatné oblasti (bez zmeny oproti verzii 1, iba nové značky)

| Oblasť | Pravidlo | Typ | Stav |
| --- | --- | --- | --- |
| Náležitosti dokladu | ZoÚ § 10 ods. 1 a)–f) | LAW | PASS; podpisový záznam → sekcia 4 (LEGAL REVIEW) |
| Náležitosti faktúry | ZDPH § 74 ods. 1 (číslo, dátumy, sadzba/oslobodenie, daň v EUR, „prenesenie daňovej povinnosti“) | LAW | PASS |
| Sadzby | § 27: 23 / 19 / 5 % od 1. 1. 2025; Esblu neprijme neexistujúcu sadzbu, nerozhoduje o správnej | LAW + PRODUCT DECISION | PASS; voľba sadzby → LEGAL REVIEW (zodpovednosť používateľa) |
| Nemennosť, číslovanie | séria FA/DO/ID/PF, číslo pri finalizácii, nemenný snapshot aj pre service_role | LAW (§ 74 ods. 1 c), ZoÚ § 34) + PRODUCT DECISION | PASS; report medzier GAP |
| Dobropis/ťarchopis vydaný | § 25, § 71 ods. 2, § 74 ods. 3 c), § 85o ods. 5; UBL 381/383 | LAW + PEPPOL | PASS |
| Režimy DPH | kategória oddelená od sadzby; E/K/G/O/AE texty; neplatiteľ iba O | LAW + PEPPOL | PASS |
| Prenesenie daňovej povinnosti | § 69 ods. 12, IČ DPH odberateľa | LAW | PASS; či plnenie spadá pod § 69 ods. 12 → LEGAL REVIEW |
| Úhrady | doklad sa úhradou nemení; čiastočné/viacnásobné | PRODUCT DECISION | PASS; saldo s dobropismi/zálohami GAP |
| eFaktúra 2027 | § 85o: povinná pre tuzemských platiteľov od 1. 1. 2027, EN 16931, opravné doklady tiež e-faktúrou | LAW + PEPPOL | PASS formát; GAP pravidlo „povinná e-faktúra“ v UI; poskytovateľ a zmluva → LEGAL REVIEW |
| Uchovávanie | ZoÚ § 35 ods. 3 c), ZDPH § 76 — 10 rokov; povinnosť klienta | LAW | Esblu **nesľubuje** zákonný archív; zmluvný záväzok → LEGAL REVIEW (CLIA blocker) |
| Export pre účtovníka | opravy, kurzy, úhrady, zálohy, overené XML, lehota § 73 | PRODUCT DECISION | PASS; hromadný export GAP |

## 9. Testy

`npm run test:invoicing-sk` — **33 testov** (PGlite so všetkými migráciami). FX testy používajú nezmenený
výňatok oficiálnych kurzov ECB (`scripts/fixtures/ecb-reference-rates-2025-2026.json`, 186 kurzov USD/CZK,
stiahnuté 6. 10. 2026 z www.ecb.europa.eu):

- parser eurofxref a pokrytie; neoficiálny zdroj odmietnutý;
- import: idempotentný, rozpor kurzu a zmena pokrytej minulosti odmietnuté, append-only aj pre service_role, klient neimportuje;
- **bežný pracovný deň** (7. 10. → 6. 10., 1,1269) a **víkend** (5. 10. → 2. 10.; nedeľa → piatok);
- **slovenský sviatok, ktorý nie je dňom zatvorenia TARGET:** 6. 1. 2026, 15. 9. 2026, 1. 9. 2026 → kurz ECB z toho dňa;
- **dni zatvorenia TARGET:** 25.–26. 12. 2025 (→ 24. 12.), 1. 1. 2026 (→ 31. 12.), Veľký piatok + Veľkonočný pondelok (→ 2. 4.), 1. 5. (→ 30. 4.);
- chýbajúce dáta a nevyhlásená mena → nikdy odhad;
- finalizácia: zlý dátum, svojvoľná hodnota kurzu, chýbajúce dáta odmietnuté; uložená referencia a rozhodný deň;
- **oprava používa pôvodný kurz** (o 2 mesiace neskôr, bez dát za december) a preberá referenciu;
- historický doklad sa po úhrade ani po pokuse o zmenu neprepočíta;
- colný kurz; § 73 (všetky prípady vrátane REVIEW a § 72 ods. 8); finalizácia po lehote nie je blokovaná;
- cross-company finance (sekcia 7).

Staging `esblu-test`: telá funkcií zhodné s repom (md5), oficiálne kurzy importované, lookup vrátil rovnaké
výsledky ako testy (pracovný deň, víkend, SK sviatky, dni TARGET, chýbajúce dáta).

## 10. Na potvrdenie (LEGAL REVIEW)

1. Posun na posledný vyhlásený kurz ECB, ak sa v deň predchádzajúci dňu vzniku kurz nevyhlásil; zdroj „NBS“ = kurzy ECB zverejnené NBS; mesačné kurzy NBS pre iné meny Esblu nepoužíva.
2. Kurz pri prijatých dokladoch (preberá sa z dokladu dodávateľa).
3. 386: Peppol BIS, SK TDD aj SK transpozícia v1.11 ho nevylučujú; zoznam typov dokladov má upraviť podzákonná norma (zatiaľ nie je).
4. Čo je účtovným dokladom pri e-faktúre (XML / vizualizácia / záznam) — ZoÚ § 10, § 31, § 35 ods. 2.
5. Či technické prvky v sekcii 4 spĺňajú vnútorný kontrolný systém (ZoÚ § 32 ods. 3 c)).
6. § 73 ods. 1 b) — výklad „alebo“ (Esblu zobrazuje oba termíny); posun konca lehoty na pracovný deň; prípady označené REVIEW (cezhraničné plnenia, O/G/Z, ods. 2).
7. Návrh prijatých dobropisov (sekcia 6), najmä kód 83 a vrátenie peňazí.
8. Uchovávanie a archív (zmluva Esblu aj eFaktura.sk), rola Esblu voči FS — `docs/clia-delta-einvoice-api-partner-2026-10-06.md`.
9. Zodpovednosť za voľbu sadzby a režimu DPH vo VOP.

## 11. Produkčné blokery

Produkčné migrácie `20261002…` až `20261008100004` nespustené; plánovaný import kurzov ECB (cron); zmluva a DPA s eFaktura.sk; CLIA;
potvrdenie účtovníčky; retencia a export; produkčný kľúč eFaktura.sk. Nič z toho nebolo vykonané.

## 12. Zmeny

Verzia 3:

- FX: ručný kalendár TARGET + výnimky nahradené oficiálnymi dátami ECB (import, pokrytie, append-only); overuje sa aj hodnota kurzu; uložený rozhodný deň a referencia; oprava preberá referenciu.
- § 73: overené znenie 2026 aj 2027 vrátane ods. 2 a § 72 ods. 2, 8; odstránené aproximácie (písm. d) cez AE, oprava cez dátum dodania); neurčiteľné prípady = REVIEW, nie termín.
- 386: prečítaná SK transpozícia v1.11 — žiadne obmedzenie; ostáva REVIEW kvôli budúcej podzákonnej norme.

Verzia 2 (oproti 1):

- § 26: 10-dňové okno nahradené presným dátumom; oprava používa pôvodný kurz aj dátum; colný kurz za rok.
- 386: rozdelené na PEPPOL PASS a SLOVAK PROFILE REVIEW (predtým nepresne ako otázka akceptácie 386).
- Účtovný doklad: odstránené tvrdenie „pri eFaktúre je dokladom XML“; technická integrita PASS, kvalifikácia LEGAL REVIEW.
- Vnútorný kontrolný systém: iba technický opis, nie tvrdenie o splnení.
- § 73: z GAP na upozornenie + export.
- Prijaté dobropisy: návrh namiesto „GAP“ bez riešenia.
- Finance helpery: z „REVIEW (bezpečnostné)“ na auditované (nezneužiteľné) + defenzívna oprava a testy.
