# eFaktúra — daňové a účtovné otvorené body: overenie voči primárnym zdrojom (7. 10. 2026)

Interný podklad. **Nie je to daňové ani účtovné stanovisko.** Zdroje:
- znenia ZDPH (222/2004) a ZoÚ (431/2002) účinné od 1. 1. 2027 na static.slov-lex.sk;
- daňový poriadok (563/2009);
- FAQ Finančnej správy k eFaktúre (9/DPH/2025/IM, verzia 15. 9. 2026);
- znalostná báza podpora.financnasprava.sk;
- SK transpozícia Peppol BIS v1.11 (FS, 11. 9. 2026) a SK TDD;
- NBS.

Overenie robil read-only výskum. Tvrdenia s dopadom na produkt (príklad 38 FAQ a lehota § 85o ods. 6) som
dodatočne prečítal priamo z textu FAQ.

Kategórie: **A** = vyriešené primárnym zdrojom · **B** = čaká na podzákonnú normu / oficiálny výklad ·
**C** = skutočne interpretačné (má zmysel externý názor).

| # | Bod | Kat. | Výsledok | Zdroj | Dopad na Esblu |
| --- | --- | --- | --- | --- | --- |
| 1a | Kurz pri nevyhlásenom dni pred vznikom daňovej povinnosti | **A** | Použije sa posledný vyhlásený kurz pred tým dňom (FS: piatkový kurz platí aj pre sobotu). | § 26 ods. 1 ZDPH; podpora.financnasprava.sk/648215; FAQ FS príklad 64 | žiadny — implementované presne tak |
| 1b | Mesačné informatívne kurzy NBS pre meny mimo ECB | **C** | FS uvádza kurz NBS pre meny, ktoré ECB nevyhlasuje. Mesačný lístok NBS je však „len informatívny“; či spĺňa „deň predchádzajúci“, text nerieši. | § 26 ods. 1 ZDPH; nbs.sk | Esblu tieto kurzy nepoužíva (finalizácia mimo ECB meny vyžaduje vlastný postup) |
| 2 | Kurz pri prijatej faktúre v cudzej mene | **A** (DPH) / **C** (účtovníctvo) | DPH prepočítava dodávateľ. Príjemca odpočítava daň uvedenú v eurách na faktúre. V účtovníctve príjemca prepočítava referenčným kurzom ku dňu účtovného prípadu; ktorý deň to je pri prijatej faktúre, je výklad. | § 26 ods. 1, § 49 ods. 2 a), § 74 ods. 1 i) ZDPH; § 24 ods. 2 a) ZoÚ | Esblu preberá kurz z dokladu dodávateľa — pre DPH správne; účtovný kurz rieši účtovníctvo klienta |
| 3 | UBL 386 v slovenskom profile | **B** | SK TDD má 386 v číselníku a FS vyžaduje e-faktúru aj k prijatej platbe. Transpozícia v1.11 pri BT-3 uvádza, že typy dokladov „bude riešené v podzákonnej norme“. Splnomocnenie ani návrh normy sa nenašli. | SK TDD UNCL1001-inv; FAQ FS príklady 34, 38; transpozícia v1.11 (BT-3) | ostáva REVIEW; Esblu 386 odosiela aj prijíma |
| 4 | Čo je účtovným dokladom pri e-faktúre | **A** | Dokladom je štruktúrované XML a uchováva sa v XML. Vizualizácia slúži len na čitateľnosť. | § 85o ods. 4 ZDPH; § 10, § 31, § 35 ods. 2 ZoÚ (2027); FAQ FS tech. príklad 16, všeob. príklad 59 | potvrdzuje model Esblu (nemenné originálne XML, export XML) |
| 5 | Vnútorný kontrolný systém / vierohodnosť a neporušenosť | **C** | Zákon pripúšťa „iný spôsob“ zabezpečenia (§ 71 ods. 3 d)). Vnútorný kontrolný systém však určuje účtovná jednotka sama (osoby, spôsob kontroly). Technické opatrenia softvéru ho samy osebe netvoria. | § 71 ods. 3 ZDPH; § 31, § 32 ods. 3 a 6 ZoÚ | Esblu netvrdí, že je VKS |
| 6a | Lehota faktúry k prijatej platbe | **A** | Do 31. 12. 2026: § 73 ods. 1 b) — 15 dní alebo koniec mesiaca (alternatívy). Od 1. 1. 2027 pri tuzemskej e-faktúre: 15 dní od prijatia platby; v lehote musí byť faktúra aj odoslaná. Súhrnná e-faktúra je možná do 15 dní po skončení mesiaca. | § 73 ods. 1 b), § 85o ods. 6 b), ods. 7 ZDPH; FAQ FS príklady 13, 74 | **opravené** v kóde: od 1. 1. 2027 iba 15-dňový termín (upozornenie, nikdy blokovanie) |
| 6b | Posun lehoty na pracovný deň | **A** | Lehota § 73 je hmotnoprávna, § 27 ods. 4 daňového poriadku sa neuplatní — neposúva sa. | podpora.financnasprava.sk/903288; DP § 27 ods. 4 | Esblu neposúva (už predtým) — potvrdené |
| 7 | Dobropis kód 83 (bonus bez položiek), vrátenie zálohy | **C** | Rámec je jasný (§ 25 ods. 1 b), § 53 ods. 1, § 71 ods. 2, § 85o ods. 5). Kvalifikácia bonusu za viac faktúr a priradenie k pôvodným faktúram zákon ani FS neriešia. | ZDPH; SK TDD UNCL1001-cn | Esblu: 83 → review, nič automaticky |
| 8 | Kto nesie 10-ročnú povinnosť uchovávania | **A** | Platiteľ a účtovná jednotka (10 rokov, v XML). Poverenie inej osoby ich zodpovednosti nezbavuje. Poskytovateľ doručovacej služby ani výrobca softvéru zákonnú povinnosť nemajú. | § 76, § 85o ods. 15 ZDPH; § 5 ods. 2, § 35 ZoÚ; FAQ FS tech. príklad 18 | zmluvný záväzok Esblu je otázka pre CLIA, nie účtovníčku |
| 9 | Kto zodpovedá za sadzbu a režim DPH | **A** | Dodávateľ (platiteľ) uvádza uplatnenú sadzbu alebo oslobodenie. Správnosť je zodpovednosťou odosielateľa. | § 69 ods. 1, § 74 ods. 1 h) ZDPH; FAQ FS tech. príklad 10 | formulácia vo VOP → CLIA |
| 10 | Odpočet DPH z prijatej zálohy a odpočet zálohy v konečnej faktúre | **A** | Daňová povinnosť aj právo na odpočet vznikajú dňom prijatia platby (§ 19 ods. 4, § 49, § 51 ods. 1 a)). Zdanená záloha sa v konečnej e-faktúre odpočíta **mínusovým riadkom** (základ + DPH, rovnaká sadzba, BT-25). **PrepaidAmount (BT-113) je iba pre nezdanené zálohy.** | ZDPH § 19 ods. 4, § 49, § 51; **FAQ FS tech. príklad 38** | **NÁLEZ → OPRAVENÉ 7. 10.** (`20261008100009/100010`) — pozri nižšie |

## Nález s dopadom na produkt (bod 10)

> **Stav 7. 10. 2026 (neskôr): OPRAVENÉ v kóde.** Model podľa FS príkladu 38 je implementovaný a overený reálnym
> sandbox E2E — `docs/einvoice-taxed-advance-model-2026-10-07.md`. Text nižšie popisuje pôvodný stav a dočasné opatrenie.
> Účtovné zaúčtovanie mínusového riadku (predkontácia) ostáva otázkou pre účtovníčku; Esblu ho nerozhoduje.

Esblu dnes pri vydanej konečnej faktúre odpočítava zálohy (vždy zdanené, z faktúry k prijatej platbe) cez
BT-113. Rozpis DPH konečnej faktúry pritom ostáva v plnej výške. Podľa FAQ FS (príklad 38) to v e-faktúre
nie je správne, pretože odpočet zdanenej zálohy má ovplyvniť daňovú rekapituláciu.

**Opatrenie v tejto fáze (fail-closed):**
- Konečná faktúra s odpočtom zálohy sa ako e-faktúra **nevygeneruje**: readiness kód
  `ADVANCE_DEDUCTION_EINVOICE_UNSUPPORTED` s prekladom sk/en/de a testom. Faktúra sa dá naďalej
  finalizovať a odoslať iným spôsobom (rok 2026).
- **Prijatá konečná faktúra** podľa FS (mínusové riadky) sa automaticky nespracuje. Ide na manuálne
  spracovanie (`NON_POSITIVE_QUANTITY`), originálne XML sa uloží.
- **Párovanie cez BT-113** (`20261008100008`) ostáva funkčné pre dodávateľov, ktorí BT-113 posielajú. Nejde
  o rozhodnutie o DPH.

**Pred 1. 1. 2027 treba prepracovať model konečnej faktúry:**
- vydanie aj príjem;
- zhoda medzi XML, PDF a rozpisom DPH v DB, keďže dokladom je XML (bod 4).

Je to samostatná úloha, nie oprava v tejto fáze.

## Otázky pre účtovníčku / daňového poradcu (iba kategória C)

1. **(1b)** Smieme pri mene, ktorú ECB nevyhlasuje, použiť na účely § 26 ods. 1 ZDPH mesačný informatívny
   kurz NBS? Ak áno, kurz ktorého mesiaca platí pre daňovú povinnosť vzniknutú prvý deň mesiaca?
2. **(2)** Ktorý dátum je pri prijatej faktúre v cudzej mene dňom uskutočnenia účtovného prípadu podľa
   § 24 ods. 2 písm. a) ZoÚ (dodanie, vyhotovenie alebo prijatie faktúry)? Smie sa účtovný kurz líšiť
   od kurzu dodávateľa pre DPH?
3. **(5)** Stačí nemenné XML s hashom SHA-256, append-only audit, opravy iba novým dokladom a dôkaz
   doručenia ako „iný spôsob“ podľa § 71 ods. 3 písm. d) ZDPH? Čo musí klient doplniť do internej smernice
   (zodpovedné osoby, spôsob kontroly podľa § 32 ods. 6 ZoÚ)?
4. **(7)** Je prijatý dobropis s kódom 83 (bonus bez položiek, za viac faktúr) opravou základu dane podľa
   § 25 ods. 1 b) s povinnosťou príjemcu podľa § 53? Alebo ide o samostatné plnenie? Ako ho priradiť
   k pôvodným faktúram a ako opraviť daň pri vrátení zálohy?

Účtovníčke sa NEPOSIELAJÚ (vyriešené primárnym zdrojom): 1a, 2 (DPH časť), 4, 6a, 6b, 8, 9, 10.
Bod 3 (386) čaká na podzákonnú normu; účtovníčka ho nevyrieši.

Nedostupné / neoverené:
- legislatívny proces MF SR k podzákonnej norme (bod 3);
- poznámka pod čiarou 28s k § 85o ods. 4 v konsolidovanom HTML;
- stránka ECB (fakt o dňoch publikácie je z NBS).
