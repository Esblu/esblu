# P1-5 — skupina C na stagingu esblu-test (2026-11-24) — priebežný výsledok

Projekt `cjbdijbbcujvmrzezusd`. Zápisy iba pre nové syntetické firmy/účty. Bez eFaktura.sk, bez výmazu,
deregistrácie, rollbacku, produkcie a pushu.

## 1. Syntetické údaje (vytvorené, jedna transakcia, `scripts/p15-staging/seed-group-c.sql`)

| Firma | UUID | Vlastník (UUID, e-mail) | Obsah |
| --- | --- | --- | --- |
| QA-P15-T1 | f1510000-0000-4000-8000-000000000001 | f1500000-…-000000000101, qa-p15-t1@esblu-qa.invalid (+ admin …0105) | 3 finalizované + 1 koncept, UBL, prijaté OK / karanténa / R3, 4 udalosti, mandát, denník, dokument + príloha, vozidlo |
| QA-P15-T2 | f1510000-0000-4000-8000-000000000002 | …0102, qa-p15-t2@esblu-qa.invalid | ako T1 + cieľ poškodeného originálu + neskorý dokument |
| QA-P15-ISO | f1510000-0000-4000-8000-000000000003 | …0103, qa-p15-iso@esblu-qa.invalid | ako T1 (nikdy sa nemaže) |
| QA-P15-PERF | f1510000-0000-4000-8000-000000000004 | …0104, qa-p15-perf@esblu-qa.invalid | 25 000 faktúr, 100 000 položiek, 25 000 udalostí, 5 000 prijatých (300 so súborom) |

Účty: 5 (`@esblu-qa.invalid`, bez hesla). Súbory (manifest `scripts/p15-staging/manifest.json`, SHA-256 každého):
322 — T1 7, T2 8, ISO 7, PERF 300 (XML, UBL, PDF, príloha, karanténa, R3, osirelý). Zoznamy súborov v DB
(`esblu_company_export_file_list`) = manifest (md5 T1 ff448430…, T2 554027e3…, ISO 40d7b790…, PERF 98aafd74…).
**Súbory zatiaľ nie sú nahraté** — vyžaduje runner s kľúčom (vlastník).

## 2. Izolácia pôvodných 16 firiem

Pred zápisom aj po ňom: 16 firiem / 77 faktúr / 36 prijatých / 288 udalostí / 63 objektov, md5
`b3917b95…`; Storage mimo P15: 67 objektov, md5 `2b33662b…`; účty mimo P15: 24, md5 `8aaff21a…`; billing dokumenty 8.
**Bez rozdielu.**

## 3. Testy vykonané (SQL na stagingu, všetko v transakciách s rollbackom)

| Test | Výsledok |
| --- | --- |
| RLS T1 owner: prijaté doklady | iba OK + karanténa; **R3 skrytý**; 0 cudzích |
| RLS T1 owner: udalosti / faktúry / dokumenty / prílohy / vozidlá | iba vlastné; udalosť R3 skrytá |
| RLS ISO owner → T1 a pôvodné firmy | 0 faktúr, 0 dokumentov, 0 cudzích prijatých |
| RLS T1 admin bez finančného oprávnenia | 0 prijatých e-faktúr |
| storage.objects einvoice-documents ako klient | 0 (bez súborov — zopakuje sa po uploade) |
| anon / authenticated: 10 nových RPC + 5 evidenčných tabuliek | **30/30 odmietnuté (42501)** |
| begin: chýbajúci súbor / súbor ISO / R3 súbor | `ESBLU_EXPORT_FILES_MISMATCH` (3×) |
| begin: zmena údajov počas exportu | `ESBLU_EXPORT_DATA_CHANGED` |
| begin: vlastník ISO na T1, admin T1 | `ESBLU_NOT_ACTIVE_OWNER` (2×) |
| begin platný → dávka so zlým SHA-256 XML | beh `failed` / `FILES_CORRUPT` |
| dávka T1 behu vlastníkom ISO | `ESBLU_EXPORT_NOT_FOUND` |
| preflight: waived pri dokladoch / bez exportu / cudzí vlastník / admin | `EXPORT_REQUIRED` / `EXPORT_NOT_VERIFIED` / `NOT_ACTIVE_OWNER` ×2 |
| starý 4-arg commit | `ESBLU_TERMINATION_ACK_REQUIRED` |
| endpointy (kód vetvy) | export a výmaz: `verifyRequestUser` + aktívna firma zo servera + owner; cron: `CRON_SECRET`; žiadna route neprijíma firmu z klienta; DB funkcie overujú vlastníka samostatne |

## 4. Výkon (PERF, DB, 3 merania)

| Operácia | Čas |
| --- | --- |
| `esblu_company_export_fingerprint` (155 000 riadkov) | 2,6 – 2,9 s |
| `esblu_company_export_file_list` (300 súborov) | 14 ms |
| `esblu_company_export_storage_fingerprint` | 10 ms |
| `esblu_company_export_begin` (9-arg, 300 súborov) | 2,7 s (dominuje odtlačok) |

Limit API 8 s (`authenticator.statement_timeout`). Výmaz počíta odtlačok v bráne (~2,7 s) + mazanie ~155 000 riadkov —
**čas výmazu PERF zatiaľ nemeraný** (skupina D). Odhad limitu odtlačku samotného ≈ 450 000 riadkov.
Návrh optimalizácie (neimplementované): (a) poradovo nezávislý odtlačok bez triedenia (súčet/xor hashov) —
odhad 2–3× rýchlejšie; (b) odtlačok raz pred čítaním a v `begin` iba porovnanie počtov + `max(updated_at)`;
(c) vyšší `statement_timeout` iba pre volanie výmazu (vlastná rola/RPC) alebo výmaz ako job na pozadí.

## 6. Záverečná kontrola po runneri (2026-11-24 21:20–21:30 UTC, read-only + testy s rollbackom)

Runner (vlastník, Windows PS 5.1): 13/13 PASS, exit 0, kľúč `sb_secret_s9kI1…` odvolaný.

| Kontrola | Výsledok |
| --- | --- |
| 16 pôvodných firiem vs záloha `esblu_backup_p15_20261124` (18 tabuliek, celé riadky podľa id) | 0 zmenených/chýbajúcich, 0 nových mimo P15; snímka `b3917b95…`, Storage mimo P15 67 obj. `2b33662b…`, účty 24 `8aaff21a…` — **zhoda** |
| 322 objektov Storage vs manifest (eTag = MD5 obsahu + veľkosť, po firmách) | T1 7, T2 8, ISO 7, PERF 300; súhrny = manifest (`53c95bd8…`); 0 duplicít, 0 multipart; T2 poškodený cieľ = pôvodné bajty (obnovený); prepísané iba 2 (E1, E5) |
| Exporty (7 behov = presne scenár runnera) | E1 T1 `FILES_CHANGED`, E2 T1 completed 5 súb., E3 ISO completed 5, E4 T2 `FILES_MISSING`, E5 T2 `FILES_CORRUPT`, E6 T2 completed 7, P1 PERF completed 300 (3 časti) |
| SHA-256 exportovaných súborov vs manifest | T1 `4a7fc90a…`, T2 `93791d73…`, ISO `8ce997f8…`, PERF `e6f6f919…` = manifest; XML/UBL SHA = `xml_sha256` v DB; R3 a osirelé 0× v exporte; 0 cudzích ciest |
| Aktuálnosť exportov | dátový aj Storage odtlačok = aktuálny stav DB/Storage pre všetky 4; počty (T1 inbound 2 bez R3) sedia; súbory dokončených behov = aktuálne objekty (id, eTag, veľkosť, čas) |
| RLS (T1/T2/ISO vlastník, T1 admin, anon) s reálnymi objektmi | iba vlastné riadky a súbory; R3 skrytý; admin 0 e-faktúr; evidenčné tabuľky a anon 42501; anon Storage 0 |
| RPC anon/authenticated (11 RPC + 5 tabuliek) | 32/32 `42501` |
| begin/part negatívne | chýbajúci, cudzí (ISO), R3 (RECIPIENT_MISMATCH), osirelý súbor → `FILES_MISMATCH`; starý odtlačok → `DATA_CHANGED`; ISO/T2 vlastník, T1 admin → `NOT_ACTIVE_OWNER`; dávka cudzím vlastníkom → `EXPORT_NOT_FOUND`; zlé SHA XML → `FILES_CORRUPT` |
| Preflight ukončenia T1/T2 (simulovaná reautentifikácia, rollback) | exported = OK pre T1 aj T2; waived → `EXPORT_REQUIRED`; bez oprávnenia → `ACK_REQUIRED`; cudzí vlastník/admin → `NOT_ACTIVE_OWNER`; zmena údajov T1 → `EXPORT_STALE`, T2 neovplyvnená; bez reautentifikácie → `REAUTH_REQUIRED` |
| Mandáty / ukončenie | 3 mandáty (sandbox, neodvolané, syntetické e-maily); 0 ukončení, 0 deregistrácií, 0 cleanup jobov, 0 incidentov pre P15 |
| Neočakávané záznamy | od runnera iba 7 behov + 336 súborov behov + 322 objektov; 0 otvorených behov; 0 duplicít; po testoch bez zvyškov (md5 behov, mandátov, objektov a P15 účtov nezmenené) |
| Kľúč (logy API, iba prefix/hash) | 1 secret key, 2 545 požiadaviek 21:06:41–21:17:38, iba `rest` + `storage`, iba GET/POST (0 DELETE/PUT/PATCH), RPC iba export; posledné 200 o 21:16:03, potom 1× 401 `UNAUTHORIZED_INVALID_API_KEY_TYPE`, ďalšie použitie 0 |

Poznámka: 28× HTTP 400 pri čítaní 3 tabuliek bez stĺpca `id` (`order=id`) — každé hneď nasledované úspešným čítaním bez triedenia; 326× 400 v Storage = sondy „objekt neexistuje“ pred nahraním.

**Výsledok: PASS. Príprava skupiny D: GO** (samotné spustenie D iba po samostatnom schválení).

## 5. Čaká na runner (vlastník)

`release-backups/p15/run-p15-groupC.ps1` → `scripts/p15-staging/p15-staging-storage-export.ts` (SHA-256 kontroluje .ps1):
upload 322 súborov + overenie SHA-256; E1 zmena súboru počas exportu → FILES_CHANGED; E2 úplný export T1
(počty = DB, R3 vylúčený, súbory izolované, SHA-256 = manifest aj DB originál); E3 export ISO; E4 chýbajúce súbory →
FILES_MISSING; E5 poškodený originál → FILES_CORRUPT; P1 export PERF s časmi. Potom (Claude, SQL, rollback):
RLS na reálnych objektoch Storage, preflight T1 = null, STALE po doplnení vozidla / výmene súboru, snímka izolácie.
