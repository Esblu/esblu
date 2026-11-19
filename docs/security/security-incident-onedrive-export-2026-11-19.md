# Bezpečnostný záznam — produkčný DB export v osobnom OneDrive (2026-11-19)

Klasifikácia: interný bezpečnostný incident (možné porušenie ochrany osobných údajov — posúdenie v § 5). Postup podľa `docs/data-breach-procedure.md`.

## 1. Čo sa stalo
- 19:06–19:07 SEČ: pri tvorbe zálohy pred vyčistením produkcie sa v Supabase Dashboard (SQL editor → Export → Download CSV) dvakrát spustilo sťahovanie výsledku read-only dotazu.
- Prehliadač v aplikácii Claude zobrazil systémový dialóg „Uložiť ako“ s predvoleným priečinkom osobného OneDrive. Súbor sa uložil ako `C:\Users\roiaj\OneDrive\Supabase Snippet Untitled query.csv` (270 849 B, 19:07:08).
- Prevádzkovateľ potvrdil, že súbor sa **synchronizoval do osobného OneDrive** (cloud Microsoft).

## 2. Obsah súboru (overené lokálne, bez kopírovania mimo zariadenia)
- 113 riadkov = 113 tabuliek (`public` 102, `auth.users`, `auth.identities`, ďalšie `auth`/`storage` metadáta, zoznam migrácií); 77 neprázdnych.
- **Osobné údaje:** 14 rôznych e-mailových adries (6 odstraňovaných testovacích účtov, 3 chránené účty, beta zoznam, obchodní partneri), mená, metadáta Auth/Google identít, chat správy testovacích firiem, záznamy o súhlasoch, 1 IBAN (testovacia faktúra), 1 push token zariadenia (FCM) a 2 web-push odbery (endpoint + kľúče).
- **Neobsahuje:** heslové hashe (`encrypted_password` vylúčený), relačné/refresh tokeny, API kľúče, service_role, Stripe kľúče, obsah Storage súborov.
- Dotknuté osoby: prevádzkovateľ, 3 interné/testovacie účty (playreview, gdpresblu, zamestnanec), 5 testerov/testovacích účtov, 2–3 adresy z beta zoznamu a partnerov. Žiadni platiaci zákazníci (produkcia bola v uzavretej bete).

## 3. Vykonané opatrenia
| Čas | Opatrenie |
|---|---|
| 19:08 | Súbor identifikovaný (presná cesta, veľkosť, SHA-256 `9766a770…f8c3`). |
| 19:09 | Šifrovaná a overená záloha vytvorená mimo synchronizácie: `C:\Users\roiaj\esblu-backups\2026-11-19-prod-cleanup\` (AES-256-GCM). Overené, že obsahuje **bajtovo zhodné** dáta (SHA-256 CSV v metadátach zálohy = SHA-256 súboru v OneDrive). OneDrive súbor teda nebol jedinou kópiou. |
| 19:09 | Prehľadaný celý `C:\Users\roiaj\OneDrive` (názvy + obsah CSV/JSON/TXT/SQL): **žiadny iný export Esblu.** |
| 19:10:45 | Súbor odstránený z lokálneho OneDrive priečinka (po pokyne prevádzkovateľa). OneDrive klient zmazanie synchronizuje → položka prejde do **online koša OneDrive** (uchováva sa tam do 30 dní). |
| 19:11 | `C:\Users\roiaj\Downloads`: overené, že nezostal žiadny nešifrovaný export (dočasné ZIP/CSV súbory presunuté a zmazané); plaintext v izolovanom pracovnom prostredí Claude zmazaný. |
| — | Ďalšie exporty už nešli cez dialóg „Uložiť ako“; nová záloha sa zapisuje priamo do `C:\Users\roiaj\esblu-backups` (mimo OneDrive). |

## 4. Otvorené kroky
1. **Online kôš OneDrive:** odstrániť iba položku `Supabase Snippet Untitled query.csv` (a z kôša druhej úrovne, ak sa tam presunie). Vyžaduje prihlásenie do Microsoft účtu — v prehliadači v aplikácii prihlásenie neexistuje.
2. **Zdieľanie:** súbor bol v koreni osobného OneDrive. Predvolene nie je zdieľaný; overenie (OneDrive web → Zdieľané / Podrobnosti súboru → Prístup) tiež vyžaduje prihlásenie.
3. Prevencia: v prehliadači v aplikácii nastaviť predvolený priečinok sťahovania mimo OneDrive; produkčné exporty iba do `C:\Users\roiaj\esblu-backups` a iba šifrovane.

## 5. Posúdenie GDPR (technický podklad, nie právne stanovisko)
- Ide o prenos osobných údajov z produkčnej databázy do osobného cloudového úložiska prevádzkovateľa (Microsoft OneDrive, osobný účet) **mimo zmluvne evidovaných sprostredkovateľov** Esblu → porušenie zásady integrity a dôvernosti / obmedzenia uloženia je možné.
- Faktory znižujúce riziko: prístup iba k účtu samotného prevádzkovateľa (ak sa nepreukáže zdieľanie), krátka doba (~4 min do zmazania lokálnej kópie), malý počet dotknutých osôb, väčšina sú interné/testovacie účty, žiadne heslá ani finančné prístupy; IBAN pochádza z testovacej faktúry.
- Návrh: zapísať do **internej evidencie porušení** (čl. 33 ods. 5). Oznámenie ÚOOÚ do 72 h (čl. 33 ods. 1) sa javí ako nepotrebné, ak sa potvrdí, že súbor nebol zdieľaný a bol odstránený aj z online koša („nepravdepodobné riziko“); oznámenie dotknutým osobám (čl. 34) nie je potrebné. **Konečné rozhodnutie a jeho zdôvodnenie patrí prevádzkovateľovi**, prípadne CLIA.
- Lehota 72 h od zistenia (19. 11. 2026 ~19:08) uplynie 22. 11. 2026 ~19:08.

## 6. Doplnenie 2026-11-19 20:10 SEČ
- Lokálny OneDrive: súbor neexistuje; iný export Esblu v OneDrive ani v Downloads/Desktop/Documents nie je (overené menom aj obsahom).
- Online kôš a zdieľanie: **neoverené** — prehliadač v aplikácii nie je prihlásený do Microsoft účtu (stránka login.live.com je otvorená).
- Prevencia: všetky ďalšie exporty idú iba do `C:\Users\roiaj\esblu-backups` (šifrované); exporty cez dialóg „Uložiť ako“ sa nepoužívajú.
- Upresnenie posúdenia: prevádzkovateľ uvádza, že účty vytváral na testovanie. Súbor však obsahoval aj e-mailové adresy reálnych beta testerov a kontaktov z beta zoznamu / partnerov (identifikovateľné fyzické osoby) → ide o osobné údaje, nie anonymné. Riziko pre práva dotknutých osôb hodnotím ako nízke (úložisko prevádzkovateľa, krátka doba, žiadne heslá ani finančné prístupy). Ak sa potvrdí, že súbor nebol zdieľaný a bude odstránený z online koša, technický podklad podporuje záver „nepravdepodobné riziko“ (iba interná evidencia podľa čl. 33 ods. 5). Rozhodnutie a lehota 22. 11. 2026 ~19:08 patria prevádzkovateľovi.
