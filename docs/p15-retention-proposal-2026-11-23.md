# P1-5 — návrh minimálnej retencie: mandáty, deregistrácie, audit výmazu (2026-11-23)

**Stav: NÁVRH na rozhodnutie vlastníka.** Nič sa neimplementuje, existujúce záznamy sa neanonymizujú ani nemažú.
Vychádza iba z dodaných podkladov CLIA (23. 11. 2026, `legal-inbox/clia-2026-11-23`); CLIA sa nekontaktovala.
Body označené **[NEOVERENÉ]** sú technický návrh, nie právne stanovisko.

## 1. Východiská z podkladov CLIA

| Podklad | Obsah relevantný pre retenciu |
| --- | --- |
| DPA 2.0 čl. 6.3.9, 10.4 | po skončení služieb podľa rozhodnutia Prevádzkovateľa údaje vrátiť alebo vymazať **vrátane existujúcich kópií**, ak právo EÚ/SR nevyžaduje ďalšie uchovávanie |
| DPA 2.0 čl. 10.5 | pretrvávajú povinnosti súvisiace s vrátením, výmazom alebo zákonným uchovávaním |
| ZPČ prevádzkovateľa, účel 5 | údaje na preukázanie vzniku, obsahu a plnenia zmluvy so Zákazníkom **najviac 5 rokov od skončenia**; pri nároku/konaní do vysporiadania |
| ZPČ prevádzkovateľa, účel 1 | technické záznamy najviac 90 dní; záznamy administrátorských prístupov a zásahov najviac 12 mesiacov; pri incidente podľa osobitných lehôt |
| Smernica 10.3 | evidencia a posudzovanie porušení ochrany osobných údajov (čl. 33, 34 GDPR) |
| Smernica 10.4.3 | obnoviteľné kópie zákazníckych súborov najviac 8 dní (mechanizmus v kóde zatiaľ neexistuje) |

## 2. Návrh

| Záznam | Obsah po výmaze firmy | Účel (rola Esblu) | Navrhovaná lehota | Po lehote |
| --- | --- | --- | --- | --- |
| `einvoice_mandates` | user id, meno, e-mail, rola, verzia + SHA-256 vyhlásenia, rozsah, časy, hash IP/UA, odpoveď poskytovateľa (hash) | preukázanie oprávnenia konať voči poskytovateľovi eFaktúry (Esblu ako prevádzkovateľ — vlastný oprávnený záujem) **[NEOVERENÉ]** | **5 rokov od zániku mandátu** (analógia ZPČ účel 5) **[NEOVERENÉ]** | výmaz riadku |
| ↳ minimalizácia pri ukončení firmy | meno a e-mail nahradiť NULL; ponechať user id, verziu/SHA-256 vyhlásenia, rozsah, časy, hashe | — | ihneď pri ukončení | — |
| `einvoice_deregistrations` | firma (UUID), ID organizácie a účastníka u poskytovateľa, `requested_by`, snímka organizácie | dôkaz ukončenia registrácie u poskytovateľa | 5 rokov od dokončenia **[NEOVERENÉ]** | výmaz riadku |
| `company_terminations` | žiadateľ (UUID), režim, počty, verzia + SHA-256 potvrdenia, hash IP/UA, SHA-256 zoznamu cieľov, čas overeného výmazu | dôkaz vrátenia/výmazu (DPA 10.5) | 5 rokov od výmazu **[NEOVERENÉ]** | anonymizácia žiadateľa a hashov, ponechať počty a časy (štatistika) alebo výmaz |
| `company_export_runs`, `company_export_run_files` | žiadateľ, SHA-256, počty; pri súboroch bucket/cesta (cesta obsahuje UUID firmy a technické ID) | dôkaz odovzdania exportu pred výmazom | 5 rokov (spolu s ukončením) **[NEOVERENÉ]**; **súbory behu: navrhujem 90 dní** — cesty nie sú potrebné na dôkaz (stačí SHA-256 a počty) | výmaz riadkov súborov; beh anonymizovať |
| `account_deletion_cleanup_jobs` | user id, firma, počty; ciele sa po overenom výmaze vyprázdnia | technický záznam | 90 dní od dokončenia (ZPČ účel 1) | výmaz |
| `einvoice_misdelivery_incidents` | hash ID u poskytovateľa, SHA-256 a veľkosť XML, čas, UUID schránky | evidencia incidentu (Smernica 10.3) | do uzavretia incidentu + 5 rokov **[NEOVERENÉ]** | výmaz |
| `einvoice_ops_alerts` (firma bez FK) | kód, počty, UUID firmy | prevádzka | 12 mesiacov | výmaz |
| zálohy platformy (Supabase) | kópie DB/Storage z obdobia pred výmazom | dostupnosť | podľa plánu poskytovateľa **[NEOVERENÉ — overiť plán a zmluvu]** | prirodzený zánik zálohy; informovať v DPA/Privacy |

## 3. Technické dôsledky (na neskoršie schválenie)

1. **Mandáty sú append-only** (ani `service_role` nemení meno/e-mail). Minimalizácia vyžaduje novú migráciu s
   jednorazovou, auditovanou výnimkou (napr. `esblu_einvoice_mandate_minimize(termination_id)` volaná výhradne
   z výmazu firmy; povolené iba `granted_by_name/email → NULL`).
2. **Retenčný job** (cron, za príznakom ako `ESBLU_GDPR_RETENTION_PURGE_ENABLED`): dávkový výmaz/anonymizácia
   podľa tabuľky vyššie, najprv dry-run s počtami, nič bez výslovného zapnutia.
3. **8-dňové obnoviteľné kópie** (Smernica 10.4.3): po implementácii musí výmaz firmy zahrnúť aj kópie (alebo
   ich zánik do 8 dní preukázať) — dnes mechanizmus v kóde neexistuje.
4. **Zálohy**: doplniť do DPA/Privacy informáciu o zániku údajov v zálohách po uplynutí ich cyklu.

## 4. Otvorené právne otázky (pre CLIA, neoverené)

- Je 5-ročná lehota pre dôkaz mandátu, deregistrácie a výmazu primeraná (analógia ZPČ účel 5, premlčanie)?
- Je evidencia R3 incidentu (bez obsahu) potrebná a v akom rozsahu, keď ide o doklad tretej osoby doručený
  poskytovateľom do nesprávnej schránky — kto je prevádzkovateľ a komu sa incident oznamuje?
- Postačuje informovanie o zálohách, alebo treba garantovať lehotu ich zániku?
