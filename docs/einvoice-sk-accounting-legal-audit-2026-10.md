# Fakturácia a eFaktúra Esblu — právno-účtovný audit podľa SK predpisov (október 2026)

Interný technický podklad. **Nie je to právne ani daňové stanovisko a nič v ňom nie je schválené CLIA,
daňovým poradcom ani účtovníčkou.** Prešlé testy dokazujú iba to, že kód robí to, čo je tu opísané.

Vetva `einvoice-port`. Migrácie `20261008100000_invoicing_sk_compliance.sql` a
`20261008100001_invoicing_sk_trigger_fn_revoke.sql` sú aplikované **iba** na staging `esblu-test`.
Produkčná DB, `main`, produkčné secrets ani live eFaktúra neboli zmenené.

## 0. Legenda a zdroje

Pri každom pravidle je typ:

- **ZÁKON** — priamo z textu zákona (Slov-Lex).
- **USMERNENIE** — oficiálny výklad FS / MF SR (FAQ, metodické informácie), nie je to zákon.
- **PRODUKT** — rozhodnutie Esblu (prísnejšie alebo pohodlnejšie než zákon). Dá sa zmeniť.
- **REVIEW** — výklad nie je istý → otázka pre CLIA / daňového poradcu / účtovníčku.

Stav: **PASS** (implementované a otestované), **GAP** (chýba), **REVIEW** (implementované podľa
pracovného výkladu, potrebné potvrdenie).

| Skratka | Predpis | Zdroj (verzia) |
| --- | --- | --- |
| ZoÚ | zákon č. 431/2002 Z. z. o účtovníctve | https://static.slov-lex.sk/static/SK/ZZ/2002/431/20270101.html (znenie účinné od 1. 1. 2027) |
| ZDPH | zákon č. 222/2004 Z. z. o DPH | https://static.slov-lex.sk/static/SK/ZZ/2004/222/20270101.html (znenie účinné od 1. 1. 2027) |
| 385/2025 | novela ZDPH a ZoÚ (eFaktúra), vyhlásená 19. 12. 2025 | https://static.slov-lex.sk/static/SK/ZZ/2025/385/20270101.html |
| FS eFaktúra | Finančná správa — e-faktúra, FAQ (stav 15. 9. 2026) | https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/e-faktura |
| FS sadzby | Finančná správa — sadzby DPH | https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/sadzby-dane |
| EN 16931 / Peppol | EN 16931-1, Peppol BIS Billing 3.0, SK národné pravidlá (xlsx v1.11, 10. 9. 2026) | https://docs.peppol.eu/poacc/billing/3.0/ |

Paragrafy citované nižšie sú zo znení účinných od 1. 1. 2027 (zahŕňajú 385/2025). Pre rok 2026 platí
predchádzajúce znenie; zmeny relevantné pre fakturáciu sú najmä § 71 ods. 5, § 85o ZDPH a § 31, § 35 ZoÚ.
Odkazy na čísla FAQ FS sú podľa stavu 15. 9. 2026 — FS ich priebežne prečísluje, pred citovaním overiť.

---

## 1. Účtovný doklad (ZoÚ § 10, § 31–§ 35)

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Náležitosti § 10 ods. 1 a)–f): označenie, obsah a účastníci, suma/cena za MJ a množstvo, dátum vyhotovenia, dátum uskutočnenia (ak iný), podpisový záznam (ak nie § 32 ods. 3 b/c) | ZÁKON | číslo, strany (snapshot), položky, `issue_date`, `delivery_date`/`tax_point_date`; podpisový záznam sa nahrádza vnútorným kontrolným systémom (audit `invoice_events`, kto finalizoval) | REVIEW (je audit Esblu „vnútorný kontrolný systém“ § 32 ods. 3 c)?) |
| Preukázateľnosť, neporušenosť, čitateľnosť (§ 8, § 31 ods. 3, § 32) | ZÁKON | finalizovaný doklad nemenný (DB trigger, aj pre service_role), XML so SHA-256 | PASS |
| Oprava účtovného záznamu len dokladom; zaznamenať kto, kedy, obsah pred a po (§ 34) | ZÁKON | oprava len dobropisom/ťarchopisom (nový doklad) s `correction_reason`; udalosť `correction_created` na pôvodnej faktúre; pôvodný doklad sa nemení | PASS |
| Elektronický záznam „zaslaný a prijatý“ (§ 31, z. 385/2025 od 1. 1. 2027); uchovanie v elektronickom formáte určenom osobitným predpisom (§ 35 ods. 2) | ZÁKON | pri eFaktúre je dokladom XML; Esblu ho uchováva nemenné | REVIEW (či je účtovným dokladom XML, nie PDF vizualizácia — CLIA/účtovníčka) |

## 2. Faktúra podľa ZDPH (§ 71, § 73, § 74)

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| § 74 ods. 1 c) poradové číslo z jednej alebo viacerých sérií | ZÁKON | séria FA/DO/ID/PF, číslo až pri finalizácii, advisory lock | PASS |
| § 74 ods. 1 d) dátum dodania alebo prijatia platby, ak sa líši od vyhotovenia | ZÁKON | **nové:** finalizácia vydanej riadnej faktúry/ťarchopisu bez `delivery_date` aj `tax_point_date` → `ESBLU_DELIVERY_DATE_REQUIRED` | PASS (PRODUKT: vyžadujeme vždy, aj keď je zhodný s dátumom vyhotovenia) |
| § 74 ods. 1 h) sadzba alebo oslobodenie s odkazom / „dodanie je oslobodené od dane“ | ZÁKON | **nové:** rozpis DPH pre E/K/G/O/AE automaticky dostane text a kód VATEX; PDF aj UBL ich zobrazujú | PASS |
| § 74 ods. 1 i) daň spolu v eurách | ZÁKON | **nové:** `tax_base_eur`, `vat_total_eur` pri cudzej mene (sekcia 8) | PASS |
| § 74 ods. 1 k) „prenesenie daňovej povinnosti“ | ZÁKON | **nové:** text v rozpise (AE) aj `cbc:Note` v UBL | PASS |
| § 27 sadzby 23 / 19 / 5 % (od 1. 1. 2025) | ZÁKON | **nové:** `esblu_sk_vat_rates(date)`; sadzba S mimo zoznamu → `ESBLU_VAT_RATE_NOT_ALLOWED` | PASS (Esblu nerozhoduje, ktorá sadzba patrí tovaru — iba neprijme neexistujúcu) |
| § 73 lehota 15 dní na vyhotovenie | ZÁKON | žiadne upozornenie | GAP |
| § 74 ods. 3 zjednodušená faktúra (≤ 100 €, e-kasa ≤ 400 €) | ZÁKON | Esblu nevystavuje zjednodušené faktúry (vždy plné náležitosti) | PASS (PRODUKT) |

## 3. Nemennosť a číslovanie

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Doklad sa po vyhotovení nemení (ZoÚ § 34, ZDPH § 71 ods. 3) | ZÁKON | trigger deny-by-default: po finalizácii smie meniť len `payment_status`; **nové:** aj zápis do snapshotov (strany, rozpis DPH, odpočty záloh) je zablokovaný; `invoice_events` append-only | PASS |
| Proforma nesmie spotrebovať číslo daňovej série | PRODUKT (vychádza z § 74 ods. 1 c)) | **nové:** vlastná séria `PF` | PASS |
| Medzery v číslovaní (zmazaný draft nemá číslo; číslo vzniká len pri finalizácii) | PRODUKT | medzera nevzniká; report medzier neexistuje | PASS / GAP (report) |

## 4. Dobropis a ťarchopis (ZDPH § 25, § 71 ods. 2, § 74 ods. 3 c), § 85o ods. 5)

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Opravný doklad obsahuje poradové číslo pôvodnej faktúry a menené údaje | ZÁKON | `corrects_invoice_id` (povinné), **nové:** `correction_reason` povinný pri finalizácii (`ESBLU_CORRECTION_REASON_REQUIRED`), v PDF aj UBL (BT-22 Note, BillingReference) | PASS |
| UBL: dobropis = `CreditNote` (381), ťarchopis = `Invoice` (383) | USMERNENIE (Peppol BIS 3.0) | áno | PASS |
| Súčet dobropisov ≤ pôvodná faktúra + ťarchopisy | PRODUKT | `ESBLU_CREDIT_EXCEEDS_ORIGINAL` | PASS |
| Rovnaká mena a kurz ako pôvodná faktúra (§ 26 ods. 1 — pri oprave kurz pôvodnej) | ZÁKON | `ESBLU_CORRECTION_CURRENCY_MISMATCH`, `ESBLU_CORRECTION_FX_RATE_MISMATCH` | PASS |
| Proforma sa neopravuje dobropisom | USMERNENIE (proforma nie je daňový doklad) | `ESBLU_CORRECTION_OF_PROFORMA` | PASS |
| Úhrada sa neeviduje na dobropis | PRODUKT | `ESBLU_PAYMENT_ON_CREDIT_NOTE` | PASS |
| UI ťarchopisu | — | **nové:** tlačidlo „Vytvoriť ťarchopis“ | PASS |
| FS odporúča pri e-faktúre dobropis + novú faktúru namiesto zložitých opráv | USMERNENIE | podporované | PASS |
| Prijaté dobropisy cez Peppol | — | stále odmietnuté (`CREDIT_NOTE_NOT_SUPPORTED`), idú na ručné spracovanie | GAP |

## 5. Zálohy: proforma vs. faktúra k prijatej platbe vs. konečná faktúra

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Platba pred dodaním → daňová povinnosť dňom prijatia platby (§ 19 ods. 4) → faktúra do 15 dní | ZÁKON | `payment_received_invoice` vyžaduje dátum prijatia platby (`ESBLU_PAYMENT_RECEIVED_DATE_REQUIRED`) | PASS |
| Proforma (výzva na platbu) nie je daňový doklad | USMERNENIE (FAQ FS) | **nové:** druh `proforma`, séria PF, iba vydaná, v PDF upozornenie, vylúčená z odovzdania účtovníkovi ako daňový doklad (`not_tax_document`), UBL ju neodošle | PASS |
| Konečná faktúra odpočíta zálohy (základ a daň podľa sadzieb) | ZÁKON (§ 72, § 74) | **nové:** `invoice_advance_deductions` + RPC; kontrola, že záloha je vlastná finalizovaná faktúra k platbe toho istého odberateľa, rovnaká mena, nepresiahne zálohu (`ESBLU_ADVANCE_DEDUCTION_*`); UBL `PrepaidAmount` | PASS (DB/UBL) |
| UI pre odpočet záloh | — | chýba (iba RPC) | GAP |
| Kód dokladu 386 pre faktúru k prijatej platbe v UBL | REVIEW | Esblu posiela 386; akceptácia v SK národných pravidlách nie je potvrdená | REVIEW (daňový poradca / eFaktura.sk) |

## 6. Režimy DPH (sadzba oddelene od režimu)

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Režim (kategória S/Z/E/AE/K/G/O) je oddelený od sadzby; 0 % ≠ oslobodené ≠ nepodlieha | ZÁKON + EN 16931 | kategória a sadzba sú samostatné polia; E/K/G/O/AE majú vlastné texty | PASS |
| Neplatiteľ DPH nefakturuje DPH | ZÁKON | **nové:** `ESBLU_NON_VAT_PAYER_CATEGORY` (iba O) | PASS |
| AI iba navrhuje režim/sadzbu, nerozhoduje | PRODUKT | AI návrh ide do konceptu, finalizuje človek s oprávnením | PASS |
| Správnosť zvolenej sadzby pre konkrétny tovar/službu (príloha 7, 7a) | ZÁKON | Esblu to neoveruje | REVIEW (zodpovednosť používateľa — uviesť vo VOP) |

## 7. Prenesenie daňovej povinnosti (§ 69 ods. 12, § 74 ods. 1 k))

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Text „prenesenie daňovej povinnosti“, faktúra bez dane | ZÁKON | AE → text + VATEX-EU-AE, daň 0 | PASS |
| IČ DPH odberateľa povinné (AE, K) | ZÁKON | `ESBLU_BUYER_VAT_ID_REQUIRED` | PASS |
| Či plnenie spadá pod § 69 ods. 12 (šrot, stavebné práce, mobily ≥ 5 000 € …) | ZÁKON | Esblu nerozhoduje | REVIEW (používateľ) |

## 8. Cudzie meny (§ 26 ZDPH)

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Kurz ECB/NBS z dňa predchádzajúceho vzniku daňovej povinnosti, alebo colný kurz | ZÁKON | **nové:** `fx_rate` (jednotky meny za 1 EUR), `fx_rate_date`, `fx_rate_source` (ECB/NBS/CUSTOMS); kontrola dátumu (`ESBLU_FX_RATE_DATE_INVALID`) | PASS |
| Uložiť menu, kurz, zdroj, dátum, EUR základ a daň; nikdy neprepočítavať | ZÁKON + PRODUKT | `tax_base_eur`, `vat_total_eur` sa vypočítajú raz pri finalizácii a sú nemenné | PASS |
| Pri oprave kurz pôvodnej faktúry | ZÁKON | sekcia 4 | PASS |
| Automatické načítanie kurzu ECB | — | nie (zadáva používateľ) | GAP |
| Cudzia mena v UBL | — | generátor stále blokuje ne-EUR (BT-6/BT-111 nedoplnené) | GAP |
| Kurz pri prijatých faktúrach v AI kontrole | — | polia v UI chýbajú | GAP |
| Tolerancia dátumu kurzu ECB/NBS (posledných 10 dní pre víkendy/sviatky) | PRODUKT | áno | REVIEW |

## 9. Prijaté faktúry

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Prijaté XML sa nemení, ukladá sa so SHA-256 | ZÁKON (§ 71 ods. 3) | áno | PASS |
| Kontrola (review) je oddelená od dokladu | PRODUKT | koncept z XML, finalizuje človek | PASS |
| Esblu netvrdí nárok na odpočet DPH | PRODUKT | žiadne automatické rozhodnutie o odpočte | PASS |
| Automaticky založený dodávateľ nie je účtovné rozhodnutie | PRODUKT | iba kmeňový záznam z XML | PASS / REVIEW (účtovníčka: kontrola pri prvom doklade?) |
| Prijaté cez eFaktúru — väzba na zdrojový dokument pri odovzdaní účtovníkovi | — | **nové:** XML sa počíta ako originál a pribalí sa do balíka | PASS |

## 10. Úhrady

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Úhrada nemení doklad | ZÁKON | po finalizácii sa mení len `payment_status` | PASS |
| Čiastočné, viacnásobné úhrady, preplatok | PRODUKT | povolené, testované | PASS |
| Stav úhrady zohľadní dobropisy a zálohy; stav „preplatená“ | — | nie | GAP |
| § 75 ods. 2 dohoda o platbách pri e-faktúre | USMERNENIE (FAQ FS) | Esblu nepodporuje | PASS (n/a) |

## 11. eFaktúra 2027 (§ 71 ods. 5, § 85o ZDPH, z. 385/2025)

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| 1. 1. 2027 – 30. 6. 2030: povinná e-faktúra medzi tuzemskými platiteľmi B2B/B2G, aj pri prijatej platbe; výnimky oslobodené plnenia (§ 28–43, § 47) a zjednodušená faktúra (§ 85o ods. 1–2) | ZÁKON | Esblu vie odoslať UBL cez eFaktura.sk (sandbox); rozhodnutie, ktorá faktúra musí ísť ako e-faktúra, nie je automatizované | GAP (pravidlo „povinná e-faktúra“ v UI) |
| Formát EN 16931 (§ 85o ods. 4), Peppol BIS 3.0, `0245:DIČ` | ZÁKON + USMERNENIE | áno | PASS |
| Opravné doklady tiež ako e-faktúra, s číslom pôvodnej, rovnakou cestou (§ 85o ods. 5) | ZÁKON | dobropis/ťarchopis sa generuje ako UBL; prijaté dobropisy GAP (sekcia 4) | PASS / GAP |
| Oznamovanie cez doručovaciu službu, lehoty 15 dní, pokuty (§ 85o ods. 6–14) | ZÁKON | rieši poskytovateľ eFaktura.sk | REVIEW (zmluva) |
| Certifikovaný poskytovateľ (§ 85o ods. 18–19) | ZÁKON | eFaktura.sk; Esblu nie je poskytovateľ | REVIEW (CLIA) |
| Produkcia | — | **vypnutá**, žiadny live kľúč, žiadna zmluva | — |

## 12. Uchovávanie a archivácia

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Účtovné doklady 10 rokov nasledujúcich po roku (ZoÚ § 35 ods. 3 c)), faktúry 10 rokov (ZDPH § 76, § 85o ods. 15) | ZÁKON | povinnosť má **klient**; Esblu uchováva XML a PDF, ale **nesľubuje zákonný archív** | REVIEW |
| Archív musí obsahovať XML (nie len vizualizáciu) | USMERNENIE (FAQ FS) | XML uložené | PASS |
| Musí archív obsahovať aj obálku/dôkaz poskytovateľa? | REVIEW | ukladá sa dôkaz doručenia (povolené polia) | REVIEW |
| Zmluvný záväzok 10-ročného archívu, export po ukončení zmluvy | — | **CLIA blocker**; marketing ani UI nesmú tvrdiť zákonný archív | GAP / CLIA |

## 13. Export pre účtovníka

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Úplné podklady: doklad, opravy, úhrady, režimy DPH | PRODUKT | **nové:** balík obsahuje metadata opráv (`corrects_invoice_number`, dôvod), FX a EUR sumy, úhrady, odpočty záloh, texty oslobodenia, e-faktúra stav a dôkaz doručenia, overené XML (`original.xml` / `einvoice-received.xml` / `einvoice-sent.xml`, SHA-256) | PASS |
| Proforma nie je v balíku ako daňový doklad | USMERNENIE | `not_tax_document` | PASS |
| Hromadný export za obdobie (napr. pri ukončení služby) | — | nie | GAP |

## 14. Roly a bezpečnosť

| Pravidlo | Typ | Esblu | Stav |
| --- | --- | --- | --- |
| Finalizovať a meniť fakturačné polia smie iba `finance.manage` v aktívnej firme | PRODUKT | RPC aj RLS; testované owner/admin-fin/accountant/employee/admin bez financií/iná firma | PASS |
| RPC s whitelistom polí | PRODUKT | `esblu_set_invoice_compliance_fields` iba 5 polí, iba draft | PASS |
| Triggerové funkcie nie sú volateľné cez REST | PRODUKT | `20261008100001` (Supabase advisor 0028/0029) | PASS |
| Finančné helpery používajú ľubovoľné členstvo namiesto aktívnej firmy (pozorovanie z auditu) | — | nezmenené | REVIEW (bezpečnostné) |

---

## 15. Implementácia (tento audit)

| Súbor | Zmena |
| --- | --- |
| `supabase/migrations/20261008100000_invoicing_sk_compliance.sql` | proforma, FX polia, EUR sumy, `correction_reason`, sadzby, compliance trigger pri finalizácii, odpočty záloh, texty oslobodenia, INSERT guardy, append-only udalosti, blok úhrady na dobropis, udalosť `correction_created`, séria PF |
| `supabase/migrations/20261008100001_invoicing_sk_trigger_fn_revoke.sql` | revoke EXECUTE na triggerové funkcie |
| `supabase/rollback/20261008100000_invoicing_sk_compliance_rollback.sql` | rollback (finalize sa obnoví z `20260923190000`) |
| `lib/einvoice/ubl/*`, `lib/einvoice/load-finalized-invoice.ts` | 386, BT-22 dôvod opravy, PrepaidAmount, poznámka AE, proforma neodosielateľná |
| `lib/invoices.ts`, `lib/invoicing/pdf-renderer.tsx` | nové polia, chyby, PDF poznámky (proforma, dôvod opravy, oslobodenie, kurz, EUR sumy) |
| `app/faktury/InvoiceDetailView.tsx`, `app/faktury/new/page.tsx` | dátum prijatia platby, dôvod opravy, kurz/dátum/zdroj, ťarchopis, proforma |
| `app/api/accounting-handoff/package/route.ts`, `lib/invoicing/handoff-package.ts` | úplnejší export (sekcia 13) |
| i18n sk/en/de | nové texty a chybové kódy |

Staging `esblu-test`: obe migrácie aplikované 6. 10. 2026; telá funkcií overené voči repu (zhoda
logiky, rozdiel iba v komentároch), RLS a granty overené, nové advisor nálezy 0.

## 16. Testy

Nový `npm run test:invoicing-sk` (19 testov, PGlite so všetkými migráciami): dátumy, sadzby, číslovanie
FA/PF, nemennosť (aj service_role), dobropis (dôvod, udalosť, strop), ťarchopis, proforma (oprava,
úhrada), zálohy (dátum, odpočty), AE/E/O texty, neplatiteľ, FX (povinnosť, dátum, nemennosť, kurz pri
oprave), úhrady, append-only udalosti, roly, whitelist, revoke triggerových funkcií.

Regresia: einvoice-ubl 63, einvoice-ui 53, einvoice-db 44, outbound 47, inbound 47, ops 23, partner 23,
hardening 19, reception 23, efaktura 17, sandbox-e2e selftest 27 PASS + 1 PARTIAL (offline webhook,
zámerne), partner-e2e selftest 25, staging-guard 8, l3-inbound-one 16, handoff 107, i18n 114,
lifecycle 30, register 23, money 41, vat 29, pricemode 55, gross 230, items 109, state 43, format 55,
m1-authz-db 47, p0-bank-sql 17, push-db 31, company-lookup-db 13, closed-beta-p0 36, folders 45,
intent-permissions 44. `tsc --noEmit` bez chýb. Lint dotknutých súborov: iba pre-existujúce
`react-hooks` chyby v `InvoiceDetailView.tsx` a `new/page.tsx` (rovnaké na `main`).
`test:plan-entitlements` 46/47 — pre-existujúce zlyhanie regexu na CRLF súbore, nesúvisí.

## 17. Otvorené body

**GAP (technické, bez právneho rozhodnutia):** prijaté dobropisy; UI odpočtu záloh; UBL v cudzej mene;
automatický kurz ECB; FX v kontrole prijatých faktúr; stav úhrady s dobropismi/zálohami a „preplatená“;
upozornenie na 15-dňovú lehotu; report medzier v číslovaní; hromadný export; pravidlo „kedy je
e-faktúra povinná“ v UI; mobilná aplikácia neprešla lintom.

**Na potvrdenie CLIA / daňovým poradcom / účtovníčkou (nič z toho nie je vyriešené):**

1. Je audit Esblu (`invoice_events`, kto finalizoval) vnútorným kontrolným systémom podľa ZoÚ § 32 ods. 3 c)?
2. Je pri e-faktúre účtovným dokladom XML a PDF iba vizualizácia (ZoÚ § 31, § 35 ods. 2)?
3. Akceptuje SK Peppol / FS kód 386 pre faktúru k prijatej platbe?
4. Tolerancia 10 dní pre dátum kurzu ECB/NBS (víkendy, sviatky) — postačuje?
5. Musí archív obsahovať aj obálku a dôkaz poskytovateľa?
6. Zmluvný záväzok k retencii a exportu (Esblu aj eFaktura.sk), formulácia VOP „Esblu neposkytuje zákonný archív“.
7. Rola Esblu voči FS a eFaktura.sk (nie je poskytovateľ, nie je certifikovaný) — `docs/clia-delta-einvoice-api-partner-2026-10-06.md`.
8. Kontrola automaticky založeného dodávateľa pri prvom prijatom doklade.
9. Zodpovednosť za voľbu sadzby a režimu (príloha 7/7a, § 69 ods. 12) — VOP.

**Produkčné blokery:** produkčné migrácie (20261002… až 20261008100001) nespustené; zmluva a DPA
s eFaktura.sk; CLIA stanovisko; potvrdenie účtovníčky; retenčná politika a export; produkčný kľúč
eFaktura.sk. Nič z toho nebolo vykonané.
