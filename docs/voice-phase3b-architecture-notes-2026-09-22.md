# Voice Phase 3B — dohodnutá architektúra (ešte NEIMPLEMENTOVANÁ)

Dátum: 2026-09-22
Stav: návrh. Žiadny bod z tohto dokumentu nie je v produkcii.

Vznikol pri P0 oprave (viacpoložkový draft prežije upresnenie partnera + stabilná
typografia hlasového panela). Body §17–34 zadania sa do tej opravy zámerne
nepribalili — menili by smerovanie intentov, prepojenie Inbox → Faktúry a
väzby na vozidlá/stroje, čo je príliš veľa naraz na jeden commit vedľa
funkčnej fakturačnej a bezpečnostnej vrstvy.

---

## 1. Prečo sa to oddelilo

P0 chyba bola úzka: odpoveď používateľa sa smerovala podľa TEXTU namiesto podľa
POLOŽENEJ OTÁZKY. Oprava sa dotkla jednej vetvy a doplnila štruktúrovanú
odpoveď pri ťuknutí na tlačidlo. To sa dá overiť testami a vrátiť jedným
revertom.

Body nižšie naopak menia, čo systém vôbec považuje za zámer používateľa.
Keby prišli v tom istom commite, pri regresii by sa nedalo povedať, ktorá
zmena ju spôsobila — a fakturačné jadro je posledné miesto, kde chceme hádať.

---

## 2. Rozlišovanie zámerov (§17–18) — pripravené

### Problém

Veta „faktúra pre Tester1" môže znamenať tri rôzne veci: vytvor faktúru,
nájdi faktúry tohto partnera, otvor konkrétnu faktúru. Dnes o tom rozhoduje
poradie kľúčových slov v deterministickom parseri a `matchesInvoiceCreation()`
je výnimka pridaná dodatočne, aby vytváranie nespadlo do vyhľadávania.
Výnimka funguje, ale je to záplata, nie pravidlo.

### Dohodnutý model

Tri signály, vyhodnocované v tomto poradí:

1. **Sloveso zámeru** (`vytvor`, `vystav`, `nájdi`, `otvor`, `koľko`) —
   ak je prítomné jednoznačne, rozhoduje ono a nič iné.
2. **Prítomnosť sumy alebo položky** — veta so sumou je takmer vždy
   vytváranie; vyhľadávanie sumu nepotrebuje.
3. **Aktuálna obrazovka** (už existuje ako `ui-context`) — iba ako
   rozhodovač pri remíze, nikdy ako samostatný dôvod.

Keď po týchto troch krokoch zostanú dva kandidáti nad prahom, systém sa
**spýta**. Nehádže mincou a nevyberá „pravdepodobnejší" zámer: vytvorenie
faktúry a vyhľadanie faktúry sú neporovnateľne rozdielne dôsledky.

### Čo sa NESMIE stať

Zámer sa neurčuje podľa toho, čo používateľ robil minule, ani podľa
histórie jeho príkazov. Pohodlie tu nestojí za nepredvídateľnosť.

---

## 3. Kanonické smerovanie Inbox → Faktúry (§19–20) — HOTOVÉ 2026-09-23

> Stav sa zmenil. Implementované v `lib/invoicing/received-invoice-route.ts`
> spolu s odstránením zložky „Faktúry" z Inboxu. Zvyšok tejto kapitoly
> popisuje návrh tak, ako bol dohodnutý; skutočnosť sa od neho neodchýlila.


### Dnešný stav

Hlas z otvoreného dokumentu vie navigovať na
`/ai-evidencia?openDocument=<id>&processReceived=1`. Je to funkčné, ale
smerovanie je zakódované v jednom handleri a URL je de facto neformálne API.

### Dohodnutý model

Jedna funkcia `receivedInvoiceRoute(documentId)` ako jediný zdroj pravdy pre
túto cestu, volaná z hlasu aj z UI. Dôvod je rovnaký ako pri fakturačnom
zápise: dve cesty k tomu istému cieľu znamenajú dve sady chýb, pričom
druhá sa objaví až vtedy, keď na nej bude záležať.

Vstupné podmienky (už platia, len sa presunú na jedno miesto):

- `document_type = 'invoice'`
- `extracted_fields` nie je prázdne
- volajúci má `finance.manage` — overené PRED kontrolou oprávnenosti
  dokumentu, aby sa z chybovej hlášky nedalo čítať, čo v Inboxe je

Cieľová obrazovka zostáva review, nikdy nie priame založenie dokladu.

---

## 4. Väzba na vozidlá a stroje (§19) — pripravené, s prahmi

### Riziko

„Faktúra za servis bagra" — ak systém sám priradí doklad ku konkrétnemu
stroju, vznikne tichá chyba v evidencii nákladov na majetok. Nikto si jej
nevšimne, kým sa nepočítajú náklady na stroj.

### Dohodnuté úrovne istoty

| Úroveň | Podmienka | Správanie |
|---|---|---|
| exact | presná zhoda ŠPZ / výrobného čísla / interného kódu | priradí sa, zobrazí sa v review |
| strong | celé meno stroja bez zvyšku, jediný kandidát | **navrhne sa**, potvrdzuje používateľ |
| suggestion | čiastočná zhoda alebo viac kandidátov | ponúkne sa zoznam, nič sa nepriradí |
| none | nič nad prahom | väzba zostane prázdna |

Automaticky sa priraďuje **iba** pri `exact`. Rovnaké pravidlo ako pri
partneroch: podobnosť nie je dôkaz.

Číslo v názve sa nesmie deliť — `Bager1` nesmie navrhnúť `Bager11`.
Tú logiku už má `containsWithoutSplittingNumber` v `lib/partner-matching.ts`
a použije sa spoločná, nie druhá kópia.

---

## 5. Viacjazyčné sémantické regresie (§21–34) — odložené

### Čo existuje dnes

225 testov v piatich sadách (`test:voice`, `test:partners`, `test:dates`,
`test:items`, `test:state`), bežiacich v čistom Node bez závislostí.
Pokrývajú čísla, meny, DPH, položky, dátumy a stavový automat v SK/CZ/DE/EN.

### Čo chýba

Sémantická matica: tá istá veta v štyroch jazykoch cez celý dialóg, nie iba
cez jeden parser. To znamená testovaciu dvojicu „vstup → očakávaný zámer +
očakávané sloty" a spustenie proti celej reťazi vrátane upresňovania.

### Prečo je to odložené, nie zrušené

Táto matica má zmysel až po §17–18. Keby sa napísala teraz, zafixovala by
súčasné, priznane záplatované rozhodovanie o zámere — a testy, ktoré strážia
záplatu, sa potom opravujú spolu s ňou. Poradie je preto: najprv pravidlo,
potom jeho matica.

---

## 6. Čo sa v tejto fáze naďalej NEROBÍ

Nezmenené hranice z predošlých fáz, pre istotu zopakované:

- žiadna hlasová finalizácia faktúry
- žiadna hlasová platba ani zmena stavu úhrady
- žiadny hlasový pohyb skladu
- žiadne mazanie strojov, vozidiel ani partnerov
- žiadne automatické zakladanie partnera či dodávateľa
- žiadne automatické rozhodovanie o DPH kategórii ani sadzbe

Hlas zostáva vypĺňaním formulára diktovaním. Výsledkom je vždy draft, ktorý
človek otvorí a skontroluje.
