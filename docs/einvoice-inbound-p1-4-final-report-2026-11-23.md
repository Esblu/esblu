# E-Faktúra P1-4 — finálny report spoľahlivého príjmu (2026-11-23)

Vetva `fix/einvoice-inbound-pagination-quarantine` (nad `main` 6506e11). Bez merge do `main`, bez produkčného deploya,
bez LIVE. Migrácia `20261125100000_einvoice_inbound_quarantine` je aplikovaná **iba na staging esblu-test**
(verzia 20261123124417); produkcia ju nemá.

## 1. Sandboxový integračný test (historický výsledok — nemení sa)

Beh `MWTC5OSN`, 2026-11-23 14:01–14:05 UTC, harness commit 172c955, staging esblu-test + sandbox eFaktura.sk,
7 syntetických faktúr `QA-P14-MWTC5OSN-1…7` (E2E Partner A → E2E Partner B).

**Výsledok: 8/9 scenárov PASS, celkovo FAIL (exit 1).** Log: `release-backups/p14/p14-integration-20261123-140153.out.txt`.

| Scenár | Výsledok v behu |
| --- | --- |
| F0 invarianty, mapovanie A/B, testovací kľúč | PASS |
| F1 odoslanie 7 faktúr A → B, doručenie 7/7 | PASS |
| F2 súbeh: ACK počas skenu → reštart (2 prechody), nič nepreskočené | PASS |
| F3 stránkovanie (strana 3, prekryv 1, has_more) | PASS |
| F6 limiter 2/min → RATE_LIMITED (použité 2, zamietnuté 1) | PASS |
| F4 XML (SHA-256), koncept vo firme B, ACK presne raz | PASS |
| F5 opakované behy: 0 nových, 0 ACK, 0 duplicít | PASS |
| F8 ochrana cudzích firiem (podvrhnutá nápoveda, odtlačok) | PASS |
| F7 monitoring | **FAIL** |
| Rollout B vrátený na paused, ostatné riadky nezmenené | PASS (kontrola obalu) |
| Revokácia jednorazového kľúča | potvrdená HTTP 401 |

Požiadavky na poskytovateľa: 43 (zoznam 20, XML 9, ACK 7, odoslanie 7).

## 2. Príčina F7 a oprava (commit tohto reportu)

**Chyba testu, nie monitoringu.** F7 očakával `scan_overdue = 0`. Test zámerne skenuje iba E2E Partner B; E2E Partner A
má aktívny príjem, mapovanie z 5. 10. a žiadny záznam skenu. Po prvom skene B (poll s novým kódom beží) ju pravidlo
health správne počíta ako „po termíne“ → `scan_overdue = 1`. Offline selftest chybu nezachytil, lebo organizácie v ňom
vznikali „teraz“ (mladšie ako 2 h).

Oprava (`scripts/einvoice-p14-staging-integration.ts`):
- F7 overuje úplný sken B (< 2 h, `incomplete_streak = 0`, B nie je po termíne) a porovnáva celkový `scan_overdue`
  s nezávislým prepočtom pravidla (`overdueOrgs`) nad mapovaniami a stavmi skenu — nie s pevnou nulou. Hlásenia
  obsahujú skutočné aj očakávané hodnoty.
- Offline selftest zakladá A aj B s mapovaním starším ako 2 h (ako na stagingu). Pred opravou F7: **FAIL** (9/10,
  rovnaká hláška ako na stagingu); po oprave: **PASS** (10/10). Test zlyhania (`--selftest-fault-F3`): ABORT, rollout
  vrátený.
- Rollout B: pri prepnutí sa nastavuje aj `updated_at` (tabuľka nemá touch trigger; v behu ostal 2026-11-13); filter
  mení iba riadok B/sandbox. Obal behu overuje, že `updated_at` riadku B je z aktuálneho behu.

## 3. Dodatočné read-only overenie F7 voči stagingu (samostatné, nie súčasť behu)

2026-11-23 14:17 UTC, iba SELECT, bez kľúča a bez nových zápisov; logika opraveného F7 nad aktuálnymi dátami:

| Kontrola | Výsledok |
| --- | --- |
| B: úplný sken 14:05:26 UTC (12 min), streak 0, nie je po termíne | OK |
| `scan_overdue` health 1 = prepočet 1 (E2E Partner A) | OK |
| `rate_limited_1h` = 1 (zamietnutie z F6) | OK |
| Vyhodnotené alerty | `INBOUND_SCAN_OVERDUE:critical` (A), `INBOUND_FAILED:warning` (starší doklad) |

**Dodatočné overenie F7: PASS.** Historický výsledok behu ostáva 8/9 PASS (F7 FAIL). Časť „uloženie ≠ doručenie“
nebola overená: alerty perzistuje iba cron `einvoice-maintenance`, ktorý na stagingu nebeží (`einvoice_ops_alerts` = 0).

Stav 7 faktúr (14:18 UTC): 7 dokladov vo firme B, 7 `acknowledged`, 7 rôznych ID poskytovateľa, 7 rôznych konceptov,
7 rôznych SHA-256, 7 XML v úložisku pod cestou B; duplicity 0; ostatné firmy a pôvodných 29 dokladov / 253 udalostí
bez zmeny (odtlačky = záloha `esblu_backup_p14_20261123`); rollout B `paused`.

Na stagingu ostáva `scan_overdue = 1` (A nikdy neskenovaná) — správny stav; zmizne po prvom skene A.

## 4. Otvorené body pred produkciou

| Bod | Stav | Návrh |
| --- | --- | --- |
| Spoločný API limiter | limiter pokrýva iba príjem (60/min, poll 40/min) | jeden limiter pre celý partnerský kľúč s kvótami tried (interaktívne 10, odosielanie 30, reconcile 10, príjem 30, feed+údržba 10), kĺzavé okno, testy (návrh 2026-11-23) |
| Doručovanie kritických alertov | ukladá sa iba `MAINTENANCE_CRITICAL` (prvý kód), notifikácia = riadok v logu; drain/e-mail 0 → **žiadne doručenie človeku** | web push cez `lib/push` vlastníkovi interného grantu, evidencia doručenia, ukladanie každého kritického kódu, cron 15 min; záloha: denná Cowork kontrola |
| ACK karantény (R2) | vypnuté (`ESBLU_EINVOICE_INBOUND_QUARANTINE_ACK`) | rozhodnutie vlastníka; bez neho trvalo chybné doklady na vrchu zoznamu môžu pri > 991 nepotvrdených blokovať staršie |
| Produkčná migrácia 20261125100000 | iba staging | poradie: najprv kód, potom migrácia (kód je bez nej fail-open); samostatné schválenie |
| Prevádzkové riziká | pevné minútové okno limitera; lease 120 s po zastavení behu; poradie zoznamu u poskytovateľa overené iba v sandboxe; OPENAI_API_KEY v Preview čitateľný (encrypted); cielená (nie plná) záloha stagingu; syntetické QA-P14 doklady ostávajú na stagingu | riešiť pred LIVE podľa návrhov 2026-11-23 |
