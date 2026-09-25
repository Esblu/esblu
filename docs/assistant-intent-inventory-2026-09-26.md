# Asistent — inventár intentov (2026-09-26)

Stav po oprave gramatiky príkazov (lib/intents/command-grammar.ts). 64 registrovaných intentov; každý má frázy v trvalej matici `scripts/assistant-grammar-tests.ts` (hlas = text, mutácie, kolízie).

Stĺpce: prijaté akcie (príklady slovies), typ entity, pravidlo vytiahnutia mena, povinné sloty, zapečatená otázka pri chýbajúcom slote, potvrdenie, dostupnosť (nástenka / hlas / text). Oprávnenia rieši `lib/intents/permissions.ts` (nezmenené).

| Intent | Akcie | Typ entity | Vytiahnutie mena | Povinné sloty | Otázka (slot) | Potvrdenie | Nástenka | Hlas | Text |
|---|---|---|---|---|---|---|---|---|---|
| OPEN_VEHICLE | otvor/ukáž/nájdi, holá ŠPZ | vozidlo | ŠPZ (normalizovaná) alebo meno za typom | vozidlo | vehicle | nie (čítanie) | áno | áno | áno |
| SEARCH_VEHICLE | nájdi/ukáž/zoznam | vozidlo | meno za typom „vozidlo/auto“ (bez typového slova) | — | — | nie (čítanie) | áno | áno | áno |
| SHOW_VEHICLE_DOCUMENTS | ukáž doklady | vozidlo | ŠPZ | vozidlo | vehicle | nie (čítanie) | áno | áno | áno |
| SHOW_VEHICLE_SERVICE | ukáž servis/história | vozidlo | ŠPZ alebo kontext obrazovky | vozidlo | vehicle | nie (čítanie) | áno | áno | áno |
| VEHICLE_STK_STATUS | kedy končí/platí STK | vozidlo | ŠPZ | vozidlo | vehicle | nie (čítanie) | áno | áno | áno |
| VEHICLE_EK_STATUS | kedy končí EK | vozidlo | ŠPZ | vozidlo | vehicle | nie (čítanie) | áno | áno | áno |
| VEHICLE_VIGNETTE_STATUS | kedy končí známka | vozidlo | ŠPZ | vozidlo | vehicle | nie (čítanie) | áno | áno | áno |
| VEHICLE_COST_SUMMARY | koľko sme minuli na servis | vozidlo | ŠPZ + rok | vozidlo | — | nie (čítanie) | áno | áno | áno |
| VEHICLE_REPORT | report | vozidlo | ŠPZ | vozidlo | — | nie (čítanie) | áno | áno | áno |
| OPEN_MACHINE | otvor/ukáž/nájdi | stroj | meno za typom „stroj“ | stroj | machine | nie (čítanie) | áno | áno | áno |
| SEARCH_MACHINE | nájdi/zoznam | stroj | meno bez typového slova | — | — | nie (čítanie) | áno | áno | áno |
| SHOW_MACHINE_SERVICE | ukáž servis/história | stroj | meno alebo kontext | stroj | machine | nie (čítanie) | áno | áno | áno |
| MACHINE_REPORT | report | stroj | meno | stroj | — | nie (čítanie) | áno | áno | áno |
| OPEN_INVENTORY_ITEM | otvor/ukáž | skladová položka | meno za typom (bez „položka/skladová“) | položka | inventory_item | nie (čítanie) | áno | áno | áno |
| SEARCH_INVENTORY_ITEM | nájdi/zoznam/holé „Sklad“ | skladová položka | voľný text bez slovies a typov | — | — | nie (čítanie) | áno | áno | áno |
| INVENTORY_ITEM_STATUS | koľko máme / stav | skladová položka | meno bez „stav/koľko“ | položka | inventory_item | nie (čítanie) | áno | áno | áno |
| SEARCH_DOCUMENTS | ukáž/nájdi doklady | doklady | typ, obdobie, dodávateľ, suma (celé slová) | — | — | nie (čítanie) | áno | áno | áno |
| EXPORT_DOCUMENTS | exportuj | doklady | filtre ako hľadanie | filter | — | áno | áno | áno | áno |
| UPCOMING_DEADLINES | aké termíny / čo končí | termíny | typy termínov | — | — | nie (čítanie) | áno | áno | áno |
| CREATE_DOCUMENT_CATEGORY | vytvor/založ | zložka | meno za „zložku“ | meno | — | áno | áno | áno | áno |
| RENAME_DOCUMENT_CATEGORY | premenuj … na … | zložka / priečinok (holé „zložka“: zhoda oboch = otázka) | zdroj + cieľ za „na“ | zdroj, cieľ | folder | áno | áno | áno | áno |
| ASSIGN_DOCUMENTS_TO_CATEGORY | daj/priraď/presuň filtrom | zložka | filter + cieľová zložka | filter, cieľ | — | áno | áno | áno | áno |
| OPEN_MODULE | otvor/prejdi do | modul | názov modulu | modul | — | nie (čítanie) | áno | áno | áno |
| SEARCH_INVOICE | nájdi/otvor faktúru | faktúra | číslo faktúry | číslo | — | nie (čítanie) | áno | áno | áno |
| SHOW_UNPAID_INVOICES | ukáž neuhradené / nie sú zaplatené | faktúra | stav (so záporom) | — | — | nie (čítanie) | áno | áno | áno |
| SEARCH_PARTNER | nájdi/otvor partnera | partner | meno za typom | — | partner_name | nie (čítanie) | áno | áno | áno |
| DELETE_DOCUMENT_CATEGORY | vymaž/zmaž/odstráň | zložka / priečinok (holé „zložka“: zhoda oboch = otázka) | meno za „zložku“ | meno | folder | áno — nevratné | áno | áno | áno |
| MOVE_DOCUMENTS_TO_CATEGORY | presuň doklady zo zložky A do B | zložka | zdroj + cieľ | zdroj, cieľ | — | áno | áno | áno | áno |
| SHOW_INVOICES_BY_STATUS | ukáž uhradené/po splatnosti/prijaté/… | faktúra | stav | — | — | nie (čítanie) | áno | áno | áno |
| SHOW_LOW_STOCK | čo dochádza / pod minimom | sklad | — | — | — | nie (čítanie) | áno | áno | áno |
| SHOW_MACHINE_DOCUMENTS | ukáž doklady stroja | stroj | meno za „stroja“ | stroj | — | nie (čítanie) | áno | áno | áno |
| SHOW_MACHINE_PHOTOS | ukáž fotky stroja | stroj | meno za „stroja“ | stroj | — | nie (čítanie) | áno | áno | áno |
| OPEN_DOCUMENT_FOLDER | otvor/ukáž zložku | zložka | meno za „zložku“ | meno | — | nie (čítanie) | áno | áno | áno |
| PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE | spracuj ako prijatú faktúru | otvorený doklad | kontext obrazovky | otvorený doklad | — | nie (čítanie) | nie (vyžaduje otvorený doklad) | áno | áno |
| FOLDER_CREATE | vytvor/založ | priečinok | meno za „priečinok“ | meno | — | áno | áno | áno | áno |
| FOLDER_OPEN | otvor/ukáž | priečinok | meno za „priečinok“ | meno | folder | nie (čítanie) | áno | áno | áno |
| FOLDER_ADD_ITEMS | pridaj/daj do priečinka | priečinok + doklady | priečinok + filter/výber | priečinok, doklady | folder | áno | áno | áno | áno |
| FOLDER_REMOVE_ITEMS | odstráň/vyraď z priečinka | priečinok + doklady | priečinok + filter | priečinok, doklady | folder | áno — nevratné | áno | áno | áno |
| FOLDER_LIST_ITEMS | čo je v priečinku | priečinok | meno | priečinok | folder | nie (čítanie) | áno | áno | áno |
| FOLDER_EXPORT | stiahni/exportuj priečinok | priečinok | meno | priečinok | folder | áno | áno | áno | áno |
| DOCUMENTS_EXPORT | stiahni doklady | doklady | filter | filter | — | áno | áno | áno | áno |
| DOCUMENTS_LIST_UNDOWNLOADED | nestiahnuté / neboli stiahnuté | doklady | filter | — | — | nie (čítanie) | áno | áno | áno |
| DOCUMENTS_DOWNLOAD_STATUS | koľko nestiahla / stiahla? | doklady | filter + účtovník | — | — | nie (čítanie) | áno | áno | áno |
| FOLDER_DELETE | vymaž/zmaž/odstráň | priečinok | presné meno (hlasový kľúč) | priečinok | folder | áno — nevratné | áno | áno | áno |
| INVENTORY_ITEM_CREATE | vytvor/založ/pridaj novú | skladová položka | meno, množstvo, jednotka | meno | — | áno | áno | áno | áno |
| INVENTORY_QUANTITY_ADJUST | pridaj do/k, zvýš, zníž, uber, nastav | skladová položka | meno + množstvo (číslicou/slovom) | položka, množstvo | quantity / inventory_item | áno | áno | áno | áno |
| INVENTORY_ITEM_DELETE | vymaž/zmaž/odstráň | skladová položka | presné meno | položka | inventory_item | áno — nevratné | áno | áno | áno |
| MACHINE_CREATE | pridaj nový / vytvor s názvom | stroj | výslovné založenie + meno | meno | — | áno | áno | áno | áno |
| MACHINE_SERVICE_ADD | pridaj/zaeviduj servis, údržbové slová | stroj | meno + popis + suma | stroj, popis | machine / service_title | áno | áno | áno | áno |
| MACHINE_DELETE | vymaž/zmaž/odstráň | stroj | presné meno / kontext | stroj | machine | áno — nevratné | áno | áno | áno |
| MACHINE_PHOTO_ADD | pridaj/nahraj fotku | stroj | meno | stroj | — | nie (čítanie) | áno | áno | áno |
| VEHICLE_CREATE | pridaj nové / vytvor | vozidlo | ŠPZ | ŠPZ | — | áno | áno | áno | áno |
| VEHICLE_SERVICE_ADD | pridaj/zaeviduj servis | vozidlo | ŠPZ + popis + suma | vozidlo, popis | vehicle / service_title | áno | áno | áno | áno |
| VEHICLE_DELETE | vymaž/zmaž/odstráň | vozidlo | ŠPZ / meno / kontext | vozidlo | vehicle | áno — nevratné | áno | áno | áno |
| VEHICLE_PHOTO_ADD | pridaj/nahraj fotku | vozidlo | ŠPZ | vozidlo | — | nie (čítanie) | áno | áno | áno |
| DOCUMENT_INTAKE | pridaj/nahraj/odfoť doklad | doklad | typ dokladu | — | — | nie (čítanie) | áno | áno | áno |
| ENTITY_CREATE | vytvor/pridaj položku bez modulu | modul podľa obrazovky | meno | modul | create_module | nie (čítanie) | áno | áno | áno |
| INBOX_LIST_UNASSIGNED | ukáž/koľko nepriradených | doklady Inboxu | typy | — | — | nie (čítanie) | áno | áno | áno |
| PARTNER_CREATE | pridaj/vytvor nového partnera | partner | meno, IČO, DIČ | meno | partner_name | nie (čítanie) | áno | áno | áno |
| FOLDER_RENAME | premenuj priečinok … na … | priečinok | zdroj + cieľ | zdroj, cieľ | folder | áno | áno | áno | áno |
| INVENTORY_ITEM_RENAME | premenuj položku … na … | skladová položka | zdroj + nový názov | položka, názov | inventory_item / new_name | áno | áno | áno | áno |
| INVENTORY_ITEM_EDIT | uprav/zmeň (bez hodnoty) | skladová položka | meno za typom | položka, pole | edit_field → quantity / new_name | dialóg, sám nezapisuje | áno | áno | áno |
| INBOX_DELETE_UNASSIGNED | vymaž nepriradené | doklady Inboxu | typy | — | — | áno — nevratné | áno | áno | áno |
| CREATE_INVOICE_DRAFT | vytvor/vystav faktúru | faktúra (koncept) | odberateľ, položky, sumy, DPH | odberateľ, položky, ceny, DPH | invoice (DB kontext) / invoice_start | koncept na kontrolu | áno | áno | áno (na nástenke iba cez dialóg asistenta) |

## Nájdené nedosiahnuteľné / kolidujúce intenty (opravené)

Tieto intenty mal predtým iba AI klasifikátor. Deterministický parser však bežnú vetu zachytil skôr (a AI sa už nepýta), takže boli bežnou vetou nedosiahnuteľné:

| Veta | Predtým | Teraz |
|---|---|---|
| „Ukáž neuhradené faktúry" | SEARCH_DOCUMENTS (všetky faktúry) | SHOW_UNPAID_INVOICES |
| „Ukáž faktúry po splatnosti" | UPCOMING_DEADLINES | SHOW_INVOICES_BY_STATUS (overdue) |
| „Ukáž doklady stroja X" | SEARCH_DOCUMENTS „y stroja x" | SHOW_MACHINE_DOCUMENTS |
| „Ukáž fotky stroja X" | OPEN_MACHINE „fotky x" | SHOW_MACHINE_PHOTOS |
| „Otvor / Ukáž zložku X" | OPEN_MODULE / OPEN_VEHICLE | OPEN_DOCUMENT_FOLDER |
| „Presuň doklady zo zložky A do zložky B" | SEARCH_DOCUMENTS (nezmysel) | MOVE_DOCUMENTS_TO_CATEGORY |
| „Spracuj tento doklad ako prijatú faktúru" | SEARCH_DOCUMENTS | PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE |
| „Vymaž zložku X" | null → od 5257071 „nerozumel" (AI nesmie mazať) | DELETE_DOCUMENT_CATEGORY / FOLDER_DELETE |
| „Uprav skladovú položku X" | SEARCH_INVENTORY_ITEM „uprav x" | INVENTORY_ITEM_EDIT (nový dialógový intent) |
| „Nájdi vozidlo X", „open inventory item X" | meno s typovým slovom | meno bez typového slova |
| „Stiahla účtovníčka …?", „Ktoré doklady neboli stiahnuté" | SEARCH_DOCUMENTS | DOCUMENTS_DOWNLOAD_STATUS / LIST_UNDOWNLOADED |

Zámerne nezmenené (produktové rozhodnutie): náklady vozidla iba so slovom „servis"; „faktúra pre X" = nová faktúra; „Nájdi stroj X" otvorí stroj (OPEN ≈ SEARCH).

## „Zložka" — nejednoznačný kontajner

Holé „zložka" môže znamenať zložku dokumentov aj priečinok dokladov. Výslovný pojem („priečinok", „kategória", „zložka dokumentov") platí priamo. Pri holom „zložka" sa overia oba typy (iba tie, na ktoré má volajúci právo): jedna zhoda = ten typ, zhoda oboch = otázka „Myslíte zložku dokumentov „X“ alebo priečinok „X“?" (žiadny náhľad ani potvrdenie pred odpoveďou), žiadna zhoda = nenájdené. Založenie: typ podľa obrazovky (Priečinky / Inbox), inak otázka.
