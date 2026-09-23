# Interná compliance poznámka pre CLIA — uchovávanie a odovzdanie účtovníkovi

Dátum: 2026-09-23 (revidované po audite terminológie)
Stav: **interný podklad na posúdenie. Verejné právne dokumenty NEBOLI menené.**
Súvisiaci kód: migrácie `20260923100000_add_accounting_handoff_lifecycle.sql`
a `20260923140000_harden_accounting_handoff.sql`,
`lib/invoicing/accounting-lifecycle.ts`, `lib/invoicing/export-accounting-handoff.ts`

---

## 1. Čo sa zmenilo v produkte

Do Esblu pribudli štyri veci. Všetky sú **nedeštruktívne** — nič sa nemaže a
nič sa nemaže ani automaticky:

1. **Stav spracovania v účtovníctve** (`invoice_accounting_state`):
   `unprocessed` / `accounted`. Označuje ho človek a dá sa odvolať.
2. **Udalosť exportu** (`accounting_handoff_exports` + `..._export_items`):
   kto, kedy, za aké obdobie a aký smer exportoval, koľko dokladov, aký je
   SHA-256 odtlačok súboru a — od revízie — **akého DRUHU** export bol.
   Záznam sa **nedá zmeniť ani zmazať** (overené: 42501).
3. **Výpočet prevádzkovej lehoty** — stav dokladu voči 24-mesačnému cieľu,
   vrátane upozornenia 30 dní vopred. Iba výpočet a zobrazenie.
4. **Denník účtovného stavu** (`invoice_accounting_state_log`): každá zmena
   označenia „zaúčtované" vrátane odvolania, s časom a autorom. Píše doň
   výhradne trigger; používateľ má iba čítanie.

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
| Udalosť exportu (vrátane druhu) | `accounting_handoff_exports` | nová, nemenná |
| História označenia „zaúčtované" | `invoice_accounting_state_log` | nová, append-only, píše ju trigger |
| Exportovaný súbor | u zákazníka/účtovníka | Esblu ho neukladá, drží len odtlačok |

Exportovaný súbor **Esblu neuchováva**. Uchováva iba jeho SHA-256, aby sa
dalo overiť, že súbor je ten, o ktorom hovorí záznam.

---

## 3b. Export údajov NIE JE odovzdanie dokladov

Toto rozlíšenie pribudlo po audite a je pre posúdenie kľúčové.

Esblu dnes vie vytvoriť **zošit s ÚDAJMI** o dokladoch: hlavičky, položky,
rozpis DPH. **Originály faktúr v ňom nie sú.** Stiahnutie takého súboru
navyše nie je dôkaz, že ho účtovník dostal, otvoril alebo archivoval.

Model preto rozlišuje dva stavy:

| Stav | Čo znamená | Vytvára sa dnes? |
|---|---|---|
| `metadata_exported` | vznikol zošit s údajmi | áno |
| `complete_handoff` | odovzdaný úplný balík vrátane originálov | **nie** |

**Úplný balík** by podľa dohody mal obsahovať (definované na jednom mieste
v `COMPLETE_HANDOFF_CONTENTS`):

- prijatý doklad: originál (PDF/obrázok), údaje dokladu, položky, rozpis
  DPH, snímka partnera, prílohy
- vydaná faktúra: PDF faktúry, údaje dokladu, položky, rozpis DPH, snímka
  partnera, prílohy
- manifest: firma, identifikátory dokladov, čas exportu, kontrolné odtlačky

Esblu si **nevymýšľa** zákonný výmenný formát a netvrdí, že niektorý spĺňa.

Dôsledok pre mazanie: `eligible_for_removal` nastáva **výhradne** pri
`complete_handoff`. Keďže úplný balík zatiaľ nič nevytvára, tento stav je
dnes **nedosiahnuteľný** — overené testom. Je to zámer: podmienka existuje
skôr než mazanie, aby sa mazanie nedalo zapnúť bez nej.

---

## 4. Rozlíšenie, na ktorom stojí celý model

Štyri otázky, štyri odpovede, žiadne odvodzovanie jednej z druhej:

- **Uhradené?** `invoices.payment_status` — o peniazoch.
- **Zaúčtované?** `invoice_accounting_state.accounting_status` — o
  spracovaní v účtovníctve.
- **Exportované?** existencia riadku v `accounting_handoff_export_items` —
  o tom, či sa z dokladu vytvoril súbor s údajmi.
- **Odovzdané?** existencia exportu druhu `complete_package` — o tom, či
  doklad vrátane originálu naozaj opustil Esblu. Dnes nikdy.

Oprávnenosť na odstránenie prevádzkovej kópie závisí **výhradne** od
uplynutia lehoty a od ÚPLNÉHO odovzdania. Na zaúčtovaní nezávisí —
účtovníctvo prebieha mimo Esblu a Esblu o jeho ukončení nemá ako vedieť.
Na exporte údajov nezávisí tiež — originál dokladu v zošite nie je.

Doklad po lehote, ktorý nebol úplne odovzdaný, má vlastný stav
(`retention_exceeded`) a **nikdy** nie je oprávnený na odstránenie. Je to
jediný záznam o tej transakcii, aký zákazník má.

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
| čas úplného odovzdania + odtlačok | dôkaz, že doklad opustil Esblu pred odstránením |

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
   áno, ako dlho? (Osobitne: má sa uchovávať aj udalosť obyčajného exportu
   údajov, alebo stačí tá s úplným balíkom?)
7. Aké **načasovanie a oznámenie** má Esblu použiť pred odstránením?
   (dnes: upozornenie 30 dní vopred, žiadne automatické mazanie)
8. Ako opísať úlohu **externej účtovníčky**? Pozri už existujúcu poznámku
   `docs/invoicing-compliance-delta-for-clia.md` — právne postavenie
   externej účtovníčky sa v technickej dokumentácii naďalej neurčuje.
9a. Je prijateľné, že Esblu v UI nikde netvrdí „odovzdané účtovníkovi",
   kým odovzdanie nevie doložiť? Má sa to niekde povedať aj zákazníkovi
   výslovne?
9. Ktoré **verejné právne dokumenty** treba upraviť?
   Kandidáti: Ochrana osobných údajov, DPA, Podmienky používania,
   Subprocessors, znenie o uchovávaní a znenie o mazaní.

---

## 7. Čo je implementované a čo odložené

**Implementované (nedeštruktívne):**
stav zaúčtovania · denník jeho zmien vrátane odvolaní · udalosť exportu s
druhom a odtlačkom · export ÚDAJOV pre účtovníka (XLSX: doklady, položky,
rozpis DPH) · **úplný balík odovzdania (ZIP)** · výpočet prevádzkovej lehoty ·
upozornenie 30 dní vopred · označenia v registri, ktoré netvrdia viac, než
Esblu vie doložiť

**Odložené (vedome):**
mazanie prevádzkovej kópie v ktorejkoľvek podobe · tombstone tabuľka ·
konfigurovateľná lehota · štandardizovaný výmenný formát (Esblu si žiadny
nevymýšľa a netvrdí, že niektorý spĺňa)

---

## 8. Úplný balík odovzdania — čo pribudlo (2026-09-23)

`complete_handoff` prestal byť nedosiahnuteľný. Doplnené je to, čo ho robí
dosiahnuteľným, **nie** to, čo by z neho niečo mazalo.

### Čo balík obsahuje

ZIP s koreňovým priečinkom `esblu-accounting-handoff-RRRR-MM-DD-HHMM/`:

| súbor | čo to je |
| --- | --- |
| `manifest.json` | zoznam všetkých súborov s SHA-256, identifikátormi dokladov a pôvodom |
| `README.txt` | čo balík je a čo nie je |
| `issued/<doklad>/invoice.pdf` | PDF vydanej faktúry z finalizovaného dokladu |
| `issued|received/<doklad>/metadata.json` | kanonické údaje: hlavička, strany, položky, rozpis DPH |
| `received/<doklad>/original.<ext>` | **originál od dodávateľa**, bajt po bajte |
| `<doklad>/attachments/` | prílohy naviazané na ten doklad |

Prijatý doklad dostane originál, nie prerozprávanie. Esblu naň nevygeneruje
vlastné PDF a nevydáva ho za doklad dodávateľa.

### Integrita

`manifest.json` obsahuje SHA-256 každého súboru v balíku **okrem seba
samého** — sám seba obsiahnuť nemôže, lebo zapísaním odtlačku by sa zmenil.
Odtlačok manifestu (`manifest_sha256`) a odtlačok celého ZIP-u
(`package_sha256`) sú uložené v Esblu v zázname o odovzdaní. Reťaz je úplná
a nikde sa nezacyklí:

    súbory → manifest.json → záznam v Esblu
    celý ZIP ──────────────→ záznam v Esblu

Balík sa po zbalení otvorí znova a každý súbor sa porovná s manifestom.
Až keď to sedí, vznikne záznam a až potom sa balík vydá.

### Fail-closed

Stav `complete_handoff` vznikne iba vtedy, keď sa podarilo **všetko**.
Zastaví ho okrem iného: chýbajúci originál prijatého dokladu, originál,
ktorého bajty sa od nahratia zmenili, neúspešné generovanie PDF, doklad
v stave koncept, doklad bez položiek a doklad, ktorého základ + daň sa
nerovná celkovej sume. Neúspešný pokus sa zapíše so stavom `failed` a
dôvodom; `completed` bez odtlačku, veľkosti a času dokončenia nepustí ani
databázový CHECK.

### Čo balík NEOBSAHUJE

Koncepty (nemajú číslo ani finalizáciu, môžu sa ešte zmeniť), fotky vozidiel,
strojov a skladu, prílohy chatu a akýkoľvek dokument, ktorý nie je na doklad
naviazaný cez `document_links.invoice_id`.

### Balík sa neukladá

ZIP sa vydá priamo do prehliadača a nikde sa neukladá. Uložiť ho by znamenalo
držať kópiu všetkých dokladov firmy na ďalšom mieste a odpovedať na otázku,
ako dlho tam má ležať — čo je presne otázka z §6, na ktorú odpoveď zatiaľ
nemáme. Dôkazom o odovzdaní je záznam s odtlačkami, nie uložená kópia.

### Dôkaz o odovzdaní prežije zmazanie dokladu

`accounting_handoff_export_items` malo `ON DELETE CASCADE` na faktúru —
zmazanie dokladu by ticho zmazalo aj riadok, ktorý hovorí, že bol odovzdaný.
Odkaz sa teraz pri zmazaní vynuluje a v riadku zostane snímka (číslo, smer,
dátum, suma, mena). Overené v produkcii: po zmazaní faktúry riadok zostal a
snímka bola čitateľná. História sa navyše nedá ani prepísať, ani zmazať —
`authenticated` nemá na tieto tabuľky UPDATE ani DELETE.

### Čo presne `complete_handoff` znamená

**Znamená:** balík sa zložil, overil, spočítali sa odtlačky, zapísal sa
záznam a HTTP odpoveď začala odchádzať.

**Neznamená:** že sa súbor stiahol, že sa uložil, ani že ho niekto poslal
účtovníkovi. Prenos v prehliadači sa môže prerušiť kedykoľvek po odoslaní
hlavičiek a server sa to spoľahlivo nedozvie. Prevzatie účtovníkom prebieha
mimo Esblu a Esblu o ňom nemá žiadny záznam.

Toto je technická hranica, nie opomenutie. Vymyslieť si potvrdenie prevzatia,
ktoré nikto nedal, by bola tá istá chyba ako vydávať stiahnutý zošit za
odovzdanie dokladov.

Preto sa v UI stav volá **„Kompletný balík vytvorený"**, nie „Doklady
odovzdané". Názov hodnoty v databáze (`complete_handoff`) zostáva —
premenovať ho by znamenalo migráciu bez úžitku a riziko, že sa niekde rozíde.

Ak by sa niekedy malo zaznamenávať skutočné odovzdanie, musí to byť
**samostatná udalosť s vlastným úkonom používateľa** („odovzdal som balík
účtovníkovi dňa…"), nie vedľajší produkt stiahnutia súboru.

### Trvalá závora pred mazaním

`REMOVAL_DESIGN_APPROVED = false` v `lib/invoicing/accounting-lifecycle.ts`.

`removalBlockers()` preto vracia `pending_removal_design` **vždy**, na prvom
mieste zoznamu, a `isRemovalAuthorized()` vracia `false` pre každý vstup —
vrátane dokladu, ktorý má úplný balík aj prekročenú lehotu.

Vytvorenie balíka je technický úkon. Sám osebe nesmie stačiť na to, aby sa
účtovný doklad stal zmazateľným. Otvoriť závoru znamená zmeniť kód, prejsť
revíziou a vedome prevziať zodpovednosť — nie prekliknúť nastavenie.

`retentionStatus()` naďalej hlási stav `eligible_for_removal`, ale je to
**popis** („balík vytvorený, po lehote"), nie povolenie. Budúce mazanie sa
smie pýtať výhradne `isRemovalAuthorized()`.

**Mazanie sa nezaviedlo.** Žiadne tlačidlo, žiadne RPC, žiadny plánovač,
žiadne automatické odstraňovanie. To je samostatné rozhodnutie, ktoré čaká
na §6.

### Originál verzus príloha

Originál prijatého dokladu sa berie **výhradne** z
`invoices.source_document_id`. Dokumenty prepojené cez `document_links` idú
do balíka ako **sprievodné** (`supporting/`) a nikdy nenahradia chýbajúci
originál od dodávateľa.

Pôvodná implementácia hľadala originál cez `document_links` a stačila jej
existencia hociktorého prepojeného dokumentu — prijatá faktúra bez originálu,
ale s pripnutým potvrdením o úhrade, by tak prešla ako úplne odovzdaná.
Opravené a pokryté testom.

### Koncepty

Bežný koncept sa z balíka **vynechá** a povie sa to („Vynechaných konceptov:
N"). Nezastaví balík a nezabráni odovzdaniu dokladov, ktoré sú v poriadku.

Koncept, ktorý je navyše pokazený (bez položiek, s nesediacimi sumami), balík
zastaví — vtedy už nejde o rozpracovanosť, ale o chybný údaj.

Ak vo výbere nie je ani jeden finalizovaný doklad, balík **nevznikne** a
používateľ dostane jasnú vetu. Prázdny „hotový" balík by tvrdil, že sa niečo
odovzdalo.

**Dôvod odkladu mazania:** bez odpovedí na otázky v §6 by sa rozhodovalo o
tom, čo smie zmiznúť a čo musí zostať, na základe odhadu. Pri účtovných
dokladoch je odhad to, čo sa nerobí.
