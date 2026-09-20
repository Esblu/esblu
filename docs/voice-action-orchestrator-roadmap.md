# Esblu — Voice Action Orchestrator: roadmap

**Dátum:** 2026-09-20
**Stav:** ROADMAP — **teraz sa neimplementuje**
**Rozhodnutie:** hlas až po dokončení fakturačného core a eFaktúry

---

## 1. Kde sme

**Máme:**
- Voice transcription
- Intent engine
- Text/voice search
- **Secure assistant action confirmation engine** (`assistant_action_confirmations`, `esblu_create_action_confirmation`, `esblu_claim_action_confirmation`) — canonical args, expected count, nonce, server proof, expirácia
- Company-scoped RLS a permission helpery pod tým všetkým

**Nemáme:** orchestrátor, ktorý to spojí do reťazca `hlas → akcia`.

## 2. Kontext z konkurenčného auditu — čítať pozorne

**AI BOS aj Stavario sú v hlase pred nami, nie za nami.**

- AI BOS: „Celú firmu teraz ovládate hlasom" (17. 7. 2026), AI telefónna ústredňa (19. 9. 2026), hlasovo ovládaný Blender (12. 9. 2026)
- Stavario: hlasové ovládanie naprieč modulmi, Copilot, vstup do stavebného denníka cez WhatsApp textom, fotkou aj hlasovou správou

**Ale:** ani jeden z nich verejne nepopisuje, **ako zabraňuje tomu, aby AI vykonala nesprávnu akciu nad firemnými dátami.**

„Celú firmu ovládate hlasom" je bez potvrdzovacej vrstvy veľmi odvážne tvrdenie pri akciách, ktoré menia účtovné dáta. Esblu má tú vrstvu implementovanú a neháda sa o nej.

**Strategický záver:** nemá zmysel súťažiť s AI BOS v rýchlosti pridávania hlasových funkcií. Má zmysel byť ten, u koho hlas **nemôže spôsobiť škodu** — a hovoriť o tom.

## 3. Cieľový flow

```
hlas
  ↓
transcription                  ← máme
  ↓
intent classification          ← máme (základ)
  ↓
entity resolution              ← CHÝBA (najťažšia časť)
  ↓
permission check               ← máme helpery, chýba napojenie
  ↓
read plan / action plan        ← CHÝBA
  ↓
confirmation                   ← máme engine, chýba napojenie
  ↓
DB write                       ← máme RPC
  ↓
response                       ← CHÝBA
```

## 4. Kde je skutočná ťažkosť

Nie v transkripcii. Nie v klasifikácii intentu. **V entity resolution.**

„Zaplatil som faktúru Novákovi" vyžaduje:
- ktorý Novák — z `business_partners`, v rámci **mojej** firmy
- ktorá faktúra — ak ich má otvorených päť, systém **nesmie hádať**
- akú sumu — ak ju nepovedal, **nesmie ju domyslieť**

**Pravidlo, ktoré sa nesmie porušiť:** pri akejkoľvek neistote sa akcia nevykoná a systém sa spýta. Nikdy nehádať, ktorú faktúru používateľ myslel.

Presne ten istý princíp, ktorý platí pre AI pri prijatých faktúrach: **AI navrhuje, používateľ potvrdzuje.**

## 5. Read vs Action — kľúčové oddelenie

| | Read plan | Action plan |
|---|---|---|
| Mení dáta | nie | áno |
| Potvrdenie | nevyžaduje | **vždy vyžaduje** |
| Príklad | „koľko mi dlhuje Novák" | „označ faktúru 2026014 ako zaplatenú" |
| Riziko pri chybe | používateľ vidí zlú odpoveď | **poškodený účtovný záznam** |

Read plan môže bežať okamžite. Action plan **nikdy** bez confirmation engine.

## 6. Čo hlas nesmie robiť nikdy

Priame rozšírenie zásady č. 7 zo zadania:

- ❌ Finalizovať faktúru
- ❌ Rozhodovať o VAT kategórii, sadzbe, oslobodení alebo reverse charge
- ❌ Vytvárať obchodného partnera bez potvrdenia
- ❌ Mazať čokoľvek
- ❌ Meniť oprávnenia, role alebo členstvo vo firme
- ❌ Odosielať eFaktúru
- ❌ Potvrdzovať prijatú faktúru do canonical podoby

**Finalizácia faktúry a potvrdenie prijatej faktúry sú vedome mimo hlasu.** Sú to okamihy, kde vzniká nemenný účtovný záznam. Patria na obrazovku, kde používateľ vidí, čo potvrdzuje.

## 7. Čo hlas môže robiť (v poradí zavádzania)

**Fáza 1 — len čítanie (najnižšie riziko, najvyššia okamžitá hodnota):**
- „Koľko mi dlhuje Novák?"
- „Ktoré faktúry sú po splatnosti?"
- „Kedy má Avia STK?"
- „Koľko máme na sklade štrku?"
- „Čo čaká v Inboxe?"

**Fáza 2 — nízkorizikové zápisy s potvrdením:**
- Pridať poznámku k vozidlu, stroju, faktúre
- Založiť záznam o servise
- Nahrať fotku k entite
- Označiť dokument v Inboxe na review

**Fáza 3 — finančné zápisy s potvrdením:**
- Zaznamenať platbu faktúry
- Vytvoriť draft faktúry (**nie finalizovať**)

**Fáza 4 — neskôr, po zákazkách:**
- Priradiť stroj/vozidlo na zákazku
- Vydať materiál zo skladu na zákazku

## 8. Pripravenosť naprieč modulmi

Orchestrátor musí byť od začiatku navrhnutý pre všetky domény, aj keď sa zavádzajú postupne:

| Doména | Read | Write | Poznámka |
|---|---|---|---|
| Faktúry | ✅ Fáza 1 | ⚠️ Fáza 3, **nikdy finalize** | |
| Vozidlá | ✅ Fáza 1 | ✅ Fáza 2 | servisy, poznámky, STK/PZP |
| Stroje | ✅ Fáza 1 | ✅ Fáza 2 | |
| Sklad | ✅ Fáza 1 | ⚠️ Fáza 4 | pohyby ešte neexistujú |
| Partneri | ✅ Fáza 1 | ❌ **nikdy bez potvrdenia** | zlý partner sa šíri do XML |
| Inbox | ✅ Fáza 1 | ⚠️ len označenie na review | potvrdenie faktúry nie |
| Zákazky | — | — | až keď existujú |

## 9. Bezpečnostné pravidlá

1. **Permission check pred plánom, nie po ňom.** Používateľ bez `finance.view` sa nesmie dozvedieť ani to, že faktúra existuje — vrátane toho, že orchestrátor odpovie „na to nemáš právo" spôsobom, ktorý potvrdí jej existenciu.
2. **Company scope v každom kroku.** Entity resolution nikdy nesmie siahnuť mimo `esblu_my_active_company_id()`.
3. **Žiadny service_role → load all → filter v aplikácii.** Platí rovnako ako všade inde.
4. **Canonical args do confirmation engine, nie voľný text.** Potvrdzuje sa štruktúrovaná akcia, nie prepis vety.
5. **Expected count.** Ak sa má zmeniť 1 riadok a plán by zasiahol 4, akcia sa nevykoná.
6. **Prepis hlasu sa nesmie dostať do logov ani chybových hlášok.** Môže obsahovať mená, sumy a citlivé firemné údaje.
7. **Retencia prepisov.** Musí byť definovaná a publikovaná — patrí do CLIA delta dokumentu.

## 10. Prečo nie teraz

| Dôvod | |
|---|---|
| **eFaktúra má termín** | 1. 1. 2027, ~15 mesiacov, mapper neexistuje |
| **Hlas potrebuje, nad čím operovať** | „Koľko som zaplatil dodávateľom?" bez prijatých faktúr nemá odpoveď |
| **Entity resolution je náročnejšia než vyzerá** | Je to jadro celej veci a robí sa raz poriadne, nie trikrát narýchlo |
| **Súťaž v rýchlosti funkcií sa nedá vyhrať** | AI BOS pridáva funkcie každé dva týždne. Súťaž v bezpečnosti sa vyhrať dá. |

**Čo sa môže robiť už teraz bez veľkej implementácie:** pri návrhu received invoice review flow a partner matchingu držať canonical args v tvare, ktorý bude orchestrátor vedieť použiť. To nestojí nič navyše a ušetrí to neskorší refaktor.
