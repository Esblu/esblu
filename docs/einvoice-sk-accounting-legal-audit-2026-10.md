# Fakturácia a eFaktúra Esblu — právno-účtovný audit podľa SK predpisov (október 2026)

Interný technický podklad. **Nie je to právne ani daňové stanovisko. Nič v ňom nie je schválené CLIA,
daňovým poradcom ani účtovníčkou.** Prešlé testy dokazujú iba to, že kód robí to, čo je tu opísané.

Vetva `einvoice-port`. Migrácie `20261008100000` – `20261008100003` sú aplikované **iba** na staging
`esblu-test`. Produkčná DB, `main`, produkčné migrácie, produkčné secrets ani live eFaktúra sa nemenili.

Verzia dokumentu: 2 (korekčný audit). Zmeny oproti verzii 1 sú v sekcii 12.

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

Citované paragrafy sú zo znenia účinného od 1. 1. 2027. Pre rok 2026 platí predchádzajúce znenie;
pre fakturáciu sa líšia najmä § 71 ods. 5, § 76a, § 85o ZDPH a § 31, § 35 ZoÚ. Čísla otázok vo FAQ FS
sa môžu meniť — pred citovaním overiť.

---

## 1. Kurzy cudzej meny (§ 26 ZDPH) — OPRAVENÉ

**Text zákona (LAW, § 26 ods. 1):** platba v cudzej mene sa prepočíta „referenčným výmenným kurzom
určeným a vyhláseným Európskou centrálnou bankou alebo Národnou bankou Slovenska v deň predchádzajúci
dňu vzniku daňovej povinnosti“. Alternatíva: „kurz platný podľa colných predpisov v deň vzniku daňovej
povinnosti“; rozhodnutie treba vopred písomne oznámiť daňovému úradu a je „záväzné počas celého
kalendárneho roka“. „Pri oprave základu dane podľa § 25 sa použije kurz, ktorý sa použil pri vzniku
daňovej povinnosti.“

**Čo bolo nesprávne (verzia 1):** migrácia `20261008100000` pri ECB/NBS prijala **ľubovoľný** dátum
kurzu v okne ⟨deň vzniku − 10; deň vzniku). Nešlo o hľadanie posledného vyhláseného kurzu — prijala aj
svojvoľne zvolený starší kurz v bežný pracovný deň a dátum, ku ktorému sa kurz nevyhlasuje (nedeľa).
Navyše opravný doklad vystavený neskôr ako 10 dní po pôvodnej faktúre s pôvodným dátumom kurzu by
finalizácia odmietla.

**Oprava (`20261008100003_fx_rate_date_exact.sql`):**

| Pravidlo | Typ | Implementácia | Stav |
| --- | --- | --- | --- |
| ECB/NBS: prípustný je **práve jeden** dátum kurzu = `esblu_fx_reference_rate_date(deň vzniku, zdroj)` | LAW | finalizácia odmietne iný dátum (`ESBLU_FX_RATE_DATE_INVALID`, v `detail` požadovaný dátum) | PASS |
| Ak sa v deň predchádzajúci dňu vzniku kurz nevyhlásil (víkend, sviatok), použije sa posledný vyhlásený kurz pred ním | LEGAL REVIEW (zákon tento prípad výslovne nerieši; ide o technický výklad) | algoritmus ide spätne po dňoch, kým nenájde deň vyhlásenia (max. 30 dní) | REVIEW |
| Dni vyhlásenia = pracovné dni TARGET: bez sobôt, nedieľ, 1. 1., Veľkého piatku, Veľkonočného pondelka, 1. 5., 25. 12., 26. 12. | PEPPOL/TECH STANDARD (kalendár ECB/TARGET) | `esblu_fx_is_publication_day`; mimoriadne nevyhlásené dni v tabuľke `fx_rate_publication_exceptions` (iba service_role) | PASS |
| NBS kurzy pre meny, ktoré ECB nevyhlasuje — rovnaký kalendár | LEGAL REVIEW | rovnaký kalendár + výnimky pre zdroj NBS | REVIEW |
| Deň vzniku = DUZP (`tax_point_date`), inak dátum dodania, inak dátum vyhotovenia; pri faktúre k prijatej platbe deň prijatia platby | LAW (§ 19) | `coalesce(tax_point_date, delivery_date, issue_date)` | PASS |
| Colný kurz: dátum = deň vzniku; v kalendárnom roku sa v rámci firmy nemieša s ECB/NBS | LAW | `ESBLU_FX_SOURCE_YEAR_MISMATCH`; písomné oznámenie daňovému úradu Esblu neeviduje | PASS / GAP (evidencia oznámenia) |
| Oprava (§ 25): kurz, dátum aj zdroj pôvodnej faktúry; pravidlo dňa sa nepočíta znova | LAW | `ESBLU_CORRECTION_FX_RATE_MISMATCH` | PASS |
| Mena, kurz, dátum, zdroj, základ a DPH v EUR sa uložia raz pri finalizácii a nikdy sa neprepočítavajú | LAW + PRODUCT DECISION | stĺpce sú po finalizácii nemenné (trigger, aj pre service_role) | PASS |
| Prijaté doklady: kurz a dátum preberá Esblu z dokladu dodávateľa, pravidlo dňa nevynucuje | LEGAL REVIEW | — | REVIEW |
| Hodnota kurzu (nie dátum) sa neoveruje voči ECB/NBS | — | zadáva používateľ; automatické načítanie kurzu chýba | GAP |
| UI nápoveda požadovaného dátumu | PRODUCT DECISION | `lib/invoicing/sk-deadlines.ts` `fxReferenceRateDate` — zhodný s DB pre každý deň 2025–2027 (test) | PASS |

## 2. Faktúra k prijatej platbe a kód 386

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Platba pred dodaním → daňová povinnosť dňom prijatia platby (§ 19 ods. 4) → faktúra (§ 71, § 73 ods. 1 b)) | LAW | `payment_received_invoice` vyžaduje dátum prijatia platby | PASS |
| Proforma (výzva na platbu) nie je daňový doklad | OFFICIAL GUIDANCE (FAQ FS) | druh `proforma`, séria PF, neodosiela sa ako e-faktúra, nejde do balíka ako daňový doklad | PASS |
| Faktúra k prijatej platbe v UBL ako `InvoiceTypeCode` **386 (Prepayment invoice)** | PEPPOL/TECH STANDARD | **PEPPOL PASS:** 386 je v Peppol BIS Billing 3.0 (UNCL1001-inv subset, May 2026 release) | PASS |
| 386 v slovenskom profile | PEPPOL/TECH STANDARD | **SK TDD:** 386 je v code liste `UNCL1001-inv` Peppol SK TDD 1.0.0 (14. 4. 2026); v obchodných pravidlách SK TDD som nenašiel pravidlo, ktoré by 386 vylučovalo (prehľadané podľa kľúčových slov, nie celý dokument). **SK transpozícia Peppol BIS v1.11 (xlsx FS, 10. 9. 2026) nebola prečítaná** — stiahnutie súboru vyžaduje súhlas | **SLOVAK PROFILE REVIEW** |
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

## 5. Lehota 15 dní (§ 73 ZDPH) — DOPLNENÉ

| Pravidlo (§ 73 ods. 1) | Typ | Výpočet v Esblu (`issueDeadline`) | Stav |
| --- | --- | --- | --- |
| a) 15 dní odo dňa dodania | LAW | dátum dodania (inak DUZP) + 15 | PASS |
| b) 15 dní odo dňa prijatia platby **alebo** do konca mesiaca prijatia platby | LAW | neskorší z oboch dátumov | PASS / LEGAL REVIEW (výklad „alebo“) |
| c) 15 dní od konca mesiaca dodania tovaru oslobodeného podľa § 43 | LAW | položka kategórie K → koniec mesiaca + 15 | PASS |
| d) 15 dní od konca mesiaca dodania služby s miestom dodania v inom členskom štáte | LAW | AE a odberateľ mimo SK → koniec mesiaca + 15 | PASS (aproximácia) / LEGAL REVIEW |
| e) 15 dní od konca mesiaca skutočnosti rozhodnej pre opravu (§ 25) | LAW | dobropis/ťarchopis: DUZP opravy (inak dátum dodania) → koniec mesiaca + 15 | PASS |
| § 73 ods. 2 (registrácia pre daň), posun konca lehoty na pracovný deň | LAW / LEGAL REVIEW | neriešené → upozornenie je konzervatívne (skôr) | GAP |
| Upozornenie, **nie blokovanie**; doklad po lehote sa vystaví so skutočným dátumom vyhotovenia | PRODUCT DECISION | UI: info o lehote, varovanie po lehote; finalizácia prebehne; `issue_date` aj `finalized_at` ostávajú | PASS |
| Export | PRODUCT DECISION | `metadata.json`: `issue_deadline`, `issue_deadline_rule`, `issued_after_deadline`, `finalized_at` | PASS |

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

`npm run test:invoicing-sk` — 28 testov (PGlite so všetkými migráciami), z toho nové v tomto audite:

- § 26 kalendár: pracovný deň, víkend, Veľká noc, 1. 1., Vianoce, 1. 5., mimoriadna výnimka podľa zdroja;
- TS nápoveda = DB pravidlo pre každý deň 2025–2027 (ECB aj NBS);
- finalizácia: kurz v deň vzniku, nedeľa, starší kurz v 10-dňovom okne → odmietnuté; jediný správny dátum → OK;
- pracovný deň (streda → utorok) a dodanie po Veľkej noci (NBS);
- colný kurz: dátum = deň vzniku, nemiešanie v roku;
- oprava o 2 mesiace neskôr: aktuálny kurz, iný dátum, iný zdroj → odmietnuté; pôvodný → OK;
- historický doklad: po úhrade aj po pokuse o zmenu ako service_role sú kurz a EUR sumy nezmenené;
- § 73 výpočty (a–e, proforma, prijatá) a finalizácia po lehote nie je blokovaná, `finalized_at` uložený;
- cross-company finance (sekcia 7).

## 10. Na potvrdenie (LEGAL REVIEW)

1. Posun na posledný vyhlásený kurz ECB/NBS, ak sa v deň predchádzajúci dňu vzniku kurz nevyhlásil; kalendár pre NBS kurzy.
2. Kurz pri prijatých dokladoch (preberá sa z dokladu dodávateľa).
3. 386 v SK transpozícii Peppol BIS v1.11 (xlsx FS) — Peppol BIS aj SK TDD code list 386 obsahujú.
4. Čo je účtovným dokladom pri e-faktúre (XML / vizualizácia / záznam) — ZoÚ § 10, § 31, § 35 ods. 2.
5. Či technické prvky v sekcii 4 spĺňajú vnútorný kontrolný systém (ZoÚ § 32 ods. 3 c)).
6. § 73 ods. 1 b) — „alebo“ ako neskorší z dvoch termínov; § 73 ods. 1 d) — aproximácia cez AE + krajinu odberateľa; posun konca lehoty.
7. Návrh prijatých dobropisov (sekcia 6), najmä kód 83 a vrátenie peňazí.
8. Uchovávanie a archív (zmluva Esblu aj eFaktura.sk), rola Esblu voči FS — `docs/clia-delta-einvoice-api-partner-2026-10-06.md`.
9. Zodpovednosť za voľbu sadzby a režimu DPH vo VOP.

## 11. Produkčné blokery

Produkčné migrácie `20261002…` až `20261008100003` nespustené; zmluva a DPA s eFaktura.sk; CLIA;
potvrdenie účtovníčky; retencia a export; produkčný kľúč eFaktura.sk. Nič z toho nebolo vykonané.

## 12. Zmeny oproti verzii 1

- § 26: 10-dňové okno nahradené presným dátumom; oprava používa pôvodný kurz aj dátum; colný kurz za rok.
- 386: rozdelené na PEPPOL PASS a SLOVAK PROFILE REVIEW (predtým nepresne ako otázka akceptácie 386).
- Účtovný doklad: odstránené tvrdenie „pri eFaktúre je dokladom XML“; technická integrita PASS, kvalifikácia LEGAL REVIEW.
- Vnútorný kontrolný systém: iba technický opis, nie tvrdenie o splnení.
- § 73: z GAP na upozornenie + export.
- Prijaté dobropisy: návrh namiesto „GAP“ bez riešenia.
- Finance helpery: z „REVIEW (bezpečnostné)“ na auditované (nezneužiteľné) + defenzívna oprava a testy.
