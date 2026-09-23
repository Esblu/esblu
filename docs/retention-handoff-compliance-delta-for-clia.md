# Interná compliance poznámka pre CLIA — uchovávanie a odovzdanie účtovníkovi

Dátum: 2026-09-23
Stav: **interný podklad na posúdenie. Verejné právne dokumenty NEBOLI menené.**
Súvisiaci kód: migrácia `20260923100000_add_accounting_handoff_lifecycle.sql`,
`lib/invoicing/accounting-lifecycle.ts`, `lib/invoicing/export-accounting-handoff.ts`

---

## 1. Čo sa zmenilo v produkte

Do Esblu pribudli tri veci. Všetky sú **nedeštruktívne** — nič sa nemaže a
nič sa nemaže ani automaticky:

1. **Stav spracovania v účtovníctve** (`invoice_accounting_state`):
   `unprocessed` / `accounted`. Označuje ho človek a dá sa odvolať.
2. **Udalosť odovzdania** (`accounting_handoff_exports` +
   `..._export_items`): kto, kedy, za aké obdobie a aký smer odovzdal,
   koľko dokladov a aký je SHA-256 odtlačok odovzdaného súboru. Záznam sa
   **nedá zmeniť ani zmazať** (overené: 42501).
3. **Výpočet prevádzkovej lehoty** — stav dokladu voči 24-mesačnému cieľu,
   vrátane upozornenia 30 dní vopred. Iba výpočet a zobrazenie.

**Mazanie dokladov nie je implementované.** Ani automatické, ani ručné,
ani po uplynutí lehoty. Finalizovaná faktúra je v databáze naďalej chránená
proti zmene aj zmazaniu (`esblu_block_finalized_invoice_mutation`,
`esblu_block_finalized_invoice_delete`).

---

## 2. Produktové stanovisko, ktoré CLIA posudzuje

Znenie, ktoré vlastník produktu formuloval a ktoré je podkladom pre ďalší
text:

> Esblu nie je zákonný dlhodobý účtovný archív. Je to prevádzkový systém:
> doklad sa prijme, spracuje, skontroluje, odovzdá účtovníkovi a po čase sa
> jeho prevádzková kópia z Esblu odstráni. Dlhodobé uchovávanie podľa
> zákona prebieha mimo Esblu — u zákazníka, jeho účtovníka, v jeho účtovnom
> softvéri alebo v jeho vlastnom archíve — podľa ich vlastného právneho a
> zmluvného nastavenia.

Ďalej:

- Cieľová **maximálna prevádzková** doba uchovávania plných dokladov a
  príloh v Esblu: **24 mesiacov**.
- 24 mesiacov je **produktový cieľ**, nie tvrdenie o zákonnej lehote.
- Kratšie obdobia (6 alebo 12 mesiacov) sú možné neskôr; konfigurovateľná
  lehota sa teraz **neimplementovala** — jedna hodnota je zrozumiteľnejšia
  než nastavenie, ktoré nikto nevyplní.
- Zodpovednosť za dlhodobé uchovávanie zostáva zákazníkovi a jeho
  účtovníkovi či cieľu exportu.
- Po prípadnom odstránení plného dokladu môže byť potrebné ponechať
  minimum technických/auditných metadát.

---

## 3. Čo sa deje s dátami dnes (fakticky)

| Dáta | Kde sú | Čo sa s nimi deje |
|---|---|---|
| Faktúra (hlavička, položky, rozpis DPH) | `invoices`, `invoice_items`, `invoice_tax_breakdowns` | zostávajú; finalizované sú immutable |
| Originál dokladu (foto/PDF) | Storage `ai-inbox-documents` + `documents` | zostáva; maže iba používateľ ručne |
| Stav účtovníctva | `invoice_accounting_state` | nový, mení ho človek |
| Udalosť odovzdania | `accounting_handoff_exports` | nová, nemenná |
| Odovzdaný súbor | u zákazníka/účtovníka | Esblu ho neukladá, drží len odtlačok |

Odovzdaný súbor **Esblu neuchováva**. Uchováva iba jeho SHA-256, aby sa
dalo overiť, že súbor u účtovníka je ten, o ktorom hovorí záznam.

---

## 4. Rozlíšenie, na ktorom stojí celý model

Tri otázky, tri odpovede, žiadne odvodzovanie jednej z druhej:

- **Uhradené?** `invoices.payment_status` — o peniazoch.
- **Zaúčtované?** `invoice_accounting_state.accounting_status` — o
  spracovaní v účtovníctve.
- **Odovzdané?** existencia riadku v `accounting_handoff_export_items` — o
  tom, či doklad opustil Esblu.

Oprávnenosť na odstránenie prevádzkovej kópie závisí **výhradne** od
uplynutia lehoty a od odovzdania. Na zaúčtovaní nezávisí — účtovníctvo
prebieha mimo Esblu a Esblu o jeho ukončení nemá ako vedieť.

Doklad po lehote, ktorý **nebol odovzdaný**, má vlastný stav
(`overdue_not_handed_off`) a **nikdy** nie je oprávnený na odstránenie.
Je to jediný záznam o tej transakcii, aký zákazník má.

---

## 5. Navrhovaný minimálny technický pozostatok (tombstone)

**Toto je návrh na posúdenie, nie rozhodnutie.** Zoznam vychádza z toho,
čo Esblu technicky potrebuje, nie z právnej analýzy.

Polia, ktoré by po odstránení plného dokladu zostali:

| Pole | Technický dôvod |
|---|---|
| `invoice_id` | integrita odkazov (väzby, exporty) |
| `company_id` | izolácia nájomníkov, RLS |
| `invoice_number` | jedinečnosť čísla a nepretržitosť číselného radu |
| `direction` | číselný rad je vedený samostatne pre vydané a prijaté |
| `issue_date` | zaradenie do číselného radu a obdobia |
| `dedupe_fingerprint` | zabránenie opätovnému nahratiu toho istého dokladu |
| čas odstránenia + kto | audit |
| čas odovzdania + odtlačok | dôkaz, že doklad opustil Esblu pred odstránením |

**Otvorené a zámerne nerozhodnuté:** či tento zoznam nie je priveľký alebo
primalý, a či `issue_date` a `invoice_number` smú zostať po výmaze osobných
údajov. Rozhodnutie patrí CLIA.

---

## 6. Otázky pre CLIA

1. Je **24 mesiacov** vhodné ako maximálna **prevádzková** doba uchovávania
   plných účtovných dokladov v Esblu?
2. Môže Esblu jasne uviesť, že **nie je zákonný archív**? Ak áno, kde — v
   Podmienkach, v DPA, alebo v oboch?
3. Aké presné znenie má vysvetliť, že dlhodobé uchovávanie je **mimo Esblu**
   a zodpovedá zaň zákazník?
4. Aké **minimálne metadáta** smú po odstránení plného dokladu zostať?
   (návrh v §5)
5. Smú **číslo dokladu, dátum vystavenia a odtlačok** zostať kvôli
   technickej integrite aj po výmaze?
6. Má sa **udalosť odovzdania** uchovávať dlhšie než samotný doklad? Ak
   áno, ako dlho?
7. Aké **načasovanie a oznámenie** má Esblu použiť pred odstránením?
   (dnes: upozornenie 30 dní vopred, žiadne automatické mazanie)
8. Ako opísať úlohu **externej účtovníčky**? Pozri už existujúcu poznámku
   `docs/invoicing-compliance-delta-for-clia.md` — právne postavenie
   externej účtovníčky sa v technickej dokumentácii naďalej neurčuje.
9. Ktoré **verejné právne dokumenty** treba upraviť?
   Kandidáti: Ochrana osobných údajov, DPA, Podmienky používania,
   Subprocessors, znenie o uchovávaní a znenie o mazaní.

---

## 7. Čo je implementované a čo odložené

**Implementované (nedeštruktívne):**
stav zaúčtovania · udalosť odovzdania s odtlačkom · export podkladu pre
účtovníka (XLSX: doklady, položky, rozpis DPH) · výpočet prevádzkovej
lehoty · upozornenie 30 dní vopred · označenia v registri

**Odložené (vedome):**
mazanie prevádzkovej kópie v ktorejkoľvek podobe · tombstone tabuľka ·
konfigurovateľná lehota · balík odovzdania vrátane PDF a príloh v ZIP ·
štandardizovaný výmenný formát (Esblu si žiadny nevymýšľa a netvrdí, že
niektorý spĺňa)

**Dôvod odkladu mazania:** bez odpovedí na otázky v §6 by sa rozhodovalo o
tom, čo smie zmiznúť a čo musí zostať, na základe odhadu. Pri účtovných
dokladoch je odhad to, čo sa nerobí.
