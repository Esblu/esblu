# P1-5 — bezpečnostné opravy po kontrole 2a8aea3 (2026-11-23)

Vetva `fix/p15-termination-export-isolation`. Lokálne: kód, migrácia **20261128100000** (+ rollback), offline testy
(PGlite, syntetické údaje). Bez stagingu, produkcie, pushu, merge a aplikovania migrácií.

## 1. Opravy

| Nález z kontroly | Oprava |
| --- | --- |
| **Súbory e-faktúr sa pri ukončení nemazali, job sa označil za hotový** (kritické) | Job ukončenia nesie `termination_id`; e-faktúry sa smú mazať **iba** v ňom a **iba** pod prefixom `<company_id>/` (DB trigger aj aplikácia). Ciele zahŕňajú XML, UBL, PDF, karanténu, R3 aj **osirelé objekty pod prefixom** (`storage.objects`). Aplikácia po výmaze overí každý cieľ cez `exists()`; **hotovo a `storage_purged_at` zapíše iba DB** (`esblu_cleanup_job_confirm_storage`) po overení, že v `storage.objects` neostal žiaden cieľ ani objekt pod prefixom. Neúplný výmaz = job `pending` so zvyškom cieľov (obnoviteľné), backoff, po vyčerpaní pokusov kritický alert + HTTP 503 cronu. Job ukončenia nemožno ručne označiť za hotový, rozšíriť o ciele ani prepojiť inam. `billing-documents` a e-faktúry mimo ukončenia = chyba zápisu (nie tiché preskočenie). |
| **Odtlačok kryl 16 zo 45 tabuliek** (kritické) | Odtlačok = **všetkých 45** tabuliek exportu (test vynúti zhodu so zoznamom v kóde). |
| **Súbory viazané iba počtom** (kritické) | `company_export_run_files`: každý súbor behu (bucket, cesta, dávka, snímka objektu v Storage — id, čas zmeny, eTag — a SHA-256). Begin overí, že zoznam servera = zoznam DB; dávka overí presnú identitu súborov, nezmenenosť objektov a zapíše SHA-256. Brána porovná aj **odtlačok Storage** → doplnený/vymenený súbor po exporte = STALE. |
| **Deregistrácia zneplatnila export** (vysoké) | Odvolanie mandátu **iba** s `revoked_by_kind = deregistration`, `COMPANY_TERMINATION` a existujúcim deregistračným jobom ukončenia je očakávané; každé iné odvolanie, nový mandát či zmena mandátu odtlačok zmení. Technické lease/retry stĺpce prenosu e-faktúr sa nezapočítavajú (žiadne falošné STALE z cronov). |
| **Originály bez overenia SHA-256** (vysoké) | Dávka porovná SHA-256 stiahnutého XML/UBL s nemennými `xml_sha256` / `ubl_sha256` → nesúlad = beh `failed` (`FILES_CORRUPT`) → výmaz zablokovaný. |
| **R3 výmaz bez stopy** (vysoké) | Pred výmazom `einvoice_misdelivery_incidents`: hash ID u poskytovateľa, SHA-256 a veľkosť XML, čas, UUID schránky, ukončenie. Žiadny obsah, cesta, strany ani číslo dokladu; čítanie iba `service_role`, zápis iba funkcia výmazu. `deleted_counts` rozlišuje R3. |

Spätná kompatibilita: pôvodné RPC exportu ostávajú (beh bez väzby súborov na ukončenie nestačí); bez migrácie
je ukončenie fail closed, export funguje po starom. Starší nedokončený job s chráneným cieľom sa nikdy neoznačí
za hotový (→ retry → alert); kontrola pred aplikovaním: `scripts/sql/p15-termination-precheck.sql` (iba SELECT).

## 2. Testy (offline)

| Sada | Výsledok |
| --- | --- |
| `test:p15-termination-db` — prod-like (bez 20261121) aj staging-like (s ňou) | **54/54** |
| produkčné poradie migrácií (20261123\* pred 20261122\*, bez 20261121) | replay OK |
| `test:company-termination-db` / `test:company-termination` | 23/23 / 14/14 |
| `test:account-deletion-orchestration` (overenie výmazu, retry, alert) | 23/23 |
| `test:billing-ops-db` (billing-documents) / `test:einvoice-mandate-db` | 24/24 / 34/34 |
| `test:grants-replay-db` (ACL, rollback → re-apply každej migrácie) | 43/43 |
| retention-archive (legacy), subscriptions, multi-company, einvoice-\* (10 sád), export, handoff, i18n, mobile, invoicing-flow | všetky PASS |
| `tsc --noEmit`, ESLint zmenených súborov | OK |

Pokryté scenáre: doplnené vozidlo, výmena súboru pri rovnakom počte, nový súbor, súbor zmenený počas exportu,
údaje zmenené počas exportu, chýbajúci/cudzí/R3 súbor v zozname, zlý SHA-256 XML aj UBL; deregistrácia
(zlyhanie poskytovateľa, timeout lease, opakovanie, dokončenie bez nového exportu), operátorská deregistrácia,
odvolanie používateľom, nový mandát, nový prijatý doklad počas ukončovania; čiastočný výmaz, neskorý objekt pod
prefixom, idempotentné overenie, ručné „hotovo“, rozšírenie cieľov, cudzí prefix, billing-documents; cross-company,
klientske roly bez EXECUTE, RLS, rollback a re-apply 20261127/20261128.

## 3. Zostávajúce riziká

1. **Reálne Storage API** (mazanie, `exists()`, konzistencia `storage.objects`) PGlite nesimuluje — overiť na
   stagingu so syntetickou firmou.
2. **Výkon odtlačku** (45 tabuliek, md5 riadkov) pri veľkej firme nezmeraný — merať na stagingu.
3. **Prísnosť**: akákoľvek zmena údajov firmy po exporte vyžaduje nový export (bezpečné, ale menej pohodlné).
4. **8-dňové obnoviteľné kópie** (Smernica 10.4.3) v kóde neexistujú; po zavedení ich musí výmaz zahrnúť.
5. **Retencia** mandátov a auditu — návrh `docs/p15-retention-proposal-2026-11-23.md`, rozhodnutie otvorené.
6. Produkcia nemá RLS 20261125100000 — musí byť aplikovaná pred LIVE eFaktúrou.

## 4. Odporúčanie

**Pripravené na stagingové testovanie** za podmienok: samostatné schválenie; read-only precheck; cielená záloha;
aplikovať 20261127100000 + 20261128100000 spolu; iba syntetická firma; overiť reálny výmaz a overenie Storage,
export s dávkami, deregistráciu v sandboxe a čas výpočtu odtlačku. Do produkcie až po úspešnom stagingu.
