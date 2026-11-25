# P1-5 — skupina D: plán skutočného výmazu syntetických firiem (príprava, 2026-11-25)

Stav: **iba príprava**. Na staging sa nič nezapisovalo (iba read-only SQL), žiadny kľúč, žiadna záloha, žiadny výmaz,
žiadne volanie eFaktura.sk ani sandboxu, žiadny push.

## 0. Východiskový stav (read-only, 2026-11-25 18:10 UTC)

| Položka | Hodnota |
| --- | --- |
| 16 pôvodných firiem | snímka `b3917b95…` (= skupina C), objekty mimo P15 67 `2b33662b…`, účty 24 `8aaff21a…` |
| billing | 8 dokladov `2aca79be…`, 3 objekty `777e3654…` |
| ISO | 7 objektov, md5 tabuliek a objektov uložené (`scripts/sql/p15-groupD-snapshot.sql`) |
| Exporty skupiny C | dokončené 2026-11-24 21:10–21:16 UTC → **brána ich prijme len do 21:10–21:16 UTC 25. 11.** → runner D vždy urobí nový export |
| API limit | `authenticator.statement_timeout = 8 s`, `service_role` bez vlastného limitu → platí 8 s |

## 1. Šifrovaná záloha 67 objektov (krok D-B) — plán, nevykonané

- Inventár (`scripts/sql/p15-groupD-backup-inventory.sql`, read-only): 63 × `einvoice-documents` (3 firmy),
  1 × `ai-inbox-documents`, 3 × `billing-documents`; spolu ~328 kB; všetky eTagy sú MD5 (žiadny multipart);
  odtlačok inventára teraz `26f004c4…`, najnovší objekt 2026-11-23.
- Runner `scripts/p15-staging/p15-backup.ts` + `storage-backup.ts`, spúšťač `release-backups/p15/run-p15-backup.ps1`:
  - sieť: **iba GET** presne 67 objektov z inventára (list, upload, delete, REST, auth = STOP pred odoslaním);
  - každý objekt: veľkosť a MD5 = eTag (integrita prenosu) → SHA-256 → AES-256-GCM (kľúč scrypt N=2^17 z hesla
    ≥ 20 znakov, AAD viaže blob na jeho meno); šifrovaný manifest (cesty, id, SHA-256, MD5);
  - `header.json` bez ciest a názvov; nový priečinok `release-backups/p15/storage-backup-<čas>` (mimo Git, OneDrive
    zakázaný, nič sa neprepisuje);
  - hneď po zálohe offline `verify` (bez kľúča a siete) a znovu inventár SQL (id/updated_at/eTag nezmenené);
  - `compare` (iba GET) porovná zálohu so živým Storage. **Obnova (upload chýbajúceho objektu, upsert:false)** nie je
    implementovaná — iba po samostatnom schválení.
- Tajomstvá: heslo zálohy (2× SecureString, neukladá sa — bez neho je záloha neobnoviteľná, uschovať mimo PC),
  dočasný kľúč `p15_backup_67` (odvolanie + 401). Žiadne tajomstvo nie je v súboroch ani logoch.

### 1a. Finálna kontrola D-B pred vytvorením zálohy (2026-11-25 18:41 UTC) — verzia 2 runnera

- **Inventár (read-only):** 67 objektov, 67 unikátnych `id` (UUID) aj ciest; buckety einvoice-documents 63 (3 firmy),
  ai-inbox-documents 1, billing-documents 3 (všetky privátne); cesty iba `[A-Za-z0-9._/-]`, bez `..`; metadáta
  `size` = `contentLength`, `eTag`, `mimetype` (pdf/xml), `lastModified`, `version`; najnovší objekt 2026-11-23;
  žiadny prepísaný; odtlačok inventára `26f004c4…` (nezmenený od prípravy).
- **eTag sa nepokladá za MD5:** všetkých 67 má tvar 32 hex bez „-N“ a v tom istom projekte sa 322/322 syntetických
  objektov zhodovalo s MD5 obsahu — to je však iba empirické pozorovanie (S3 eTag nie je MD5 napr. pri multipart
  alebo SSE-KMS). Runner v2: autorita = SHA-256 vypočítaný runnerom; každý objekt stiahne **2×** a obe kópie musia
  mať rovnaký SHA-256 a veľkosť = inventár; eTag je nepriehľadný identifikátor verzie (spolu s `id`, `updated_at`)
  a MD5↔eTag sa zapisuje iba informatívne (`match` / `mismatch` / `not_md5`); zmenu objektu počas zálohy odhalí
  opakovaný inventár SQL hneď po zálohe.
- **Iba čítanie:** sieťová poistka pustí výhradne `GET /storage/v1/object/<bucket>/<cesta>` pre 67 ciest z
  inventára (bez query, bez tela); test so skutočným supabase-js: upload, upsert, update, remove, list, move, copy,
  signed URL, objekt ISO, billing mimo inventára, REST a RPC → zablokované pred odoslaním (aj opakované pokusy
  storage-js). Inventár musí mať SHA-256 schválený parametrom `-InventorySha256`.
- **Kryptografia:** AES-256-GCM, 96-bit náhodné IV na blob, 128-bit tag (`final()` zlyhá pri zmene), AAD = formát +
  názov blobu (výmena blobov odhalená); scrypt N=2^17 r=8 p=1, 16 B soľ, heslo ≥ 20 znakov (NFC) → 64 B = šifrovací +
  MAC kľúč; **nové:** hlavička chránená HMAC-SHA256 (zmena KDF, soli, počtu, hashov, času = STOP); SHA-256 a MD5
  obsahu v šifrovanom manifeste.
- **Žiadne nešifrované kópie:** obsah iba v pamäti procesu Node (supabase-js → `arrayBuffer`), na disk iba šifrované
  bloby (`wx`, nič sa neprepisuje); test prehľadá všetky zapísané súbory na úryvky plaintextu = 0. Zostatkové riziko:
  pamäť procesu môže skončiť v stránkovacom súbore Windows.
- **Cieľ archívu:** `release-backups\p15\storage-backup-<čas>` — `release-backups/` je v `.git/info/exclude`
  (.ps1 to overí), OneDrive je samostatný priečinok `C:\Users\roiaj\OneDrive` (.ps1 aj runner odmietnu cestu v
  OneDrive / `%OneDrive*%`), odkaz (junction/symlink) v ceste = STOP, existujúci priečinok = STOP.
- **Logy:** runner vypisuje iba počty, kódy a odtlačky; iné chyby (napr. ENOENT s cestou, JSON s úryvkom) iba ako
  „neočakávaná chyba (typ:kód)“; .ps1 skontroluje všetky 4 logy na kľúč, `sb_secret_`, JWT **aj heslo zálohy**
  (únik = prepis logu); heslo a kľúč sa odstránia z prostredia vo `finally`.
- **Nezávislé overenie:** `scripts/p15-staging/verify-backup-independent.py` (Python `hashlib` + `cryptography`,
  iná implementácia): syntetický archív 67 objektov dešifrovaný, HMAC, GCM, SHA-256/MD5/veľkosť = manifest a SHA-256
  = pôvodné syntetické bajty 67/67; zlé heslo → HMAC STOP; zmenený bajt → `InvalidTag`.
- **Preflight** (`-PreflightOnly`): syntax, 6 SHA-256, lock + strom @supabase, Node, čisté prostredie, cieľ (Git,
  OneDrive, odkazy), potom Node v režime `preflight` bez kľúča, hesla a siete → `PREFLIGHT_OK`.
- **Izolácia (read-only, 18:41 UTC):** 16 firiem `b3917b95…`, objekty mimo P15 67 `2b33662b…`, účty 24 `8aaff21a…`,
  billing 8 `2aca79be…` / 3 objekty `777e3654…`, ISO `eb82cbeb…` = východisko; P15 4 firmy / 322 objektov.
- **Testy:** storage-backup-tests 9/9, groupD-tests 20/20, nezávislé Python overenie OK, `tsc --strict` OK.
  **Neoverené:** beh .ps1 na Windows PowerShell 5.1 (iba statická kontrola).

### 1b. Oprava: ParserError v run-p15-backup.ps1 (Windows PowerShell 5.1)

- **Príčina:** chyba môjho generátora skriptu (Python skladal hlavičku + telo zo skriptu skupiny C). Telo sa bralo
  od riadku 20 skriptu C, ktorého hlavička po verzii 3 končí až na riadku 21 → do súboru sa dostali 2 riadky starej
  hlavičky (`Subor je iba ASCII.` a `#>`) a druhý `[CmdletBinding()]`. Za prvým `#>` teda stál atribút, text mimo
  komentára a ďalší atribút pred `param(` → ParserError na riadkoch 16, 17, 19, 20. Kontrola počtu zátvoriek to
  nemohla odhaliť (zátvorky boli vyvážené).
- **Oprava:** odstránené 3 duplicitné riadky (16–18). Štruktúra: 1 blokový komentár (1–15), `[CmdletBinding()]`,
  `param(` (5 parametrov). Telo bez zmeny; všetky kontroly (6 × SHA-256, lock, strom @supabase, URL stagingu,
  čisté prostredie, Git/OneDrive/odkazy, ochrana hesla a kľúča v logoch) ostali. Ostatné .ps1 (C, D, diag) majú
  správnu štruktúru (statická kontrola: 1 komentár, 1 atribút, 1 param, bez duplicitných funkcií).
- **Nezávislá kontrola syntaxe na Windows:** `release-backups/p15/check-p15-ps-syntax.ps1` — oficiálny parser
  PowerShellu (`Parser::ParseFile`) pre 4 skripty bez ich spustenia: chyby parsera, názvy parametrov, CmdletBinding,
  duplicitné funkcie, ne-ASCII, SHA-256. Sandbox nemá PowerShell (stiahnutie blokované) → beh na Windows neoverený.

## 2. Allowlist výmazu

| Kľúč | Firma | UUID | Vlastník | E-mail |
| --- | --- | --- | --- | --- |
| t1 | QA-P15-T1 | f1510000-0000-4000-8000-000000000001 | …0101 | qa-p15-t1@esblu-qa.invalid |
| t2 | QA-P15-T2 | f1510000-0000-4000-8000-000000000002 | …0102 | qa-p15-t2@esblu-qa.invalid |
| perf | QA-P15-PERF | f1510000-0000-4000-8000-000000000004 | …0104 | qa-p15-perf@esblu-qa.invalid |

Chránené: QA-P15-ISO (…0003, vlastník …0103), 16 pôvodných firiem, `billing-documents`.
Read-only overenie (staging): každý vlastník má práve 1 členstvo (T1 aj admin …0105), 0 organizácií e-Faktúry,
0 billing dokladov, 0 predplatných/checkoutov, všetky cesty súborov v DB pod prefixom vlastnej firmy, 0 objektov
bez DB odkazu mimo `einvoice-documents`; R3 riadky T1 1, T2 1; karanténa T1 1, T2 1; UBL T1 1, T2 1; osirelý T1 1.

## 3. Aktuálnosť a obnovenie exportov T1/T2 (24 h)

Brána (DB trigger, bez zmeny): posledný `completed` export toho istého vlastníka, `missing_files = 0`,
`completed_at > now() − 24 h`, aktuálny dátový aj Storage odtlačok, súbory viazané na beh s SHA-256.
Postup v runneri D (pre každú firmu, tesne pred výmazom): **nový export** cez rovnaký kód ako skupina C
(`Runner.runExport`: odtlačok → čítanie → begin → dávky so SHA-256 každého súboru) → stav `completed:-` → inak STOP
bez výmazu. Starý export sa nemení. Ak sa údaje medzi exportom a výmazom zmenia, brána vráti `EXPORT_STALE` a nič sa
nezmaže (overené v skupine C). PERF export ~70 s.

## 4. Oprávnené ukončenie (bez oslabenia pravidiel)

- **Čerstvé prihlásenie** (≤ 30 min, DB brana): runner vygeneruje magic link cez Auth Admin API (e-mail sa
  neposiela; doména `.invalid`) a overí ho cez GoTrue `verify` (publishable key) → skutočné prihlásenie, ktoré
  zapíše `last_sign_in_at`; relácia sa hneď odhlási; runner overí `last_sign_in_at < 5 min`. Žiadna zmena DB brány,
  žiadny priamy zápis do `auth.users`, žiadne heslo.
- **Vyhlásenie oprávnenej osoby**: `buildTerminationAck` z kódu appky — text z i18n, verzia
  `termination-authority-2026-11-23.sk`, SHA-256 `8f42b97e…6279e6`, `confirmed_at` ≤ 15 min; IP/UA iba ako SHA-256.
- **Výmaz**: `orchestrateAccountDeletion(supabaseTerminationDeps(...))` — ten istý kód ako `/api/account/delete`
  (DB najprv, Storage až po commite, overenie neprítomnosti, DB potvrdenie, zrušenie účtu vlastníka). Bez
  deregistrácie: firma s organizáciou u poskytovateľa = STOP (eFaktura.sk sa nevolá).
- Riziko: syntetickí používatelia nemajú záznam v `auth.identities` (vytvorení SQL) — správanie GoTrue `verify`
  v tomto stave je neoverené; zlyhanie = STOP pred výmazom (nič sa nezmaže). Nie je pripravená žiadna náhrada, ktorá
  by obchádzala prihlásenie.

## 5. Testy skutočného výmazu na stagingu (každý krok samostatne schváliť)

| Krok | Čo | Očakávanie |
| --- | --- | --- |
| D-T1 | T1 úplný výmaz | firma, faktúry, XML, UBL, karanténa, R3 (+ incident), osirelý súbor, dokument + príloha, vozidlo, členstvá (aj admin …0105) preč; účet …0101 zrušený; `completed` + `storage_purged_at`; job done; ISO a 16 firiem bez zmeny |
| D-T2 | T2 so simulovaným výpadkom Storage (runner vráti 503 pre prvé DELETE v `einvoice-documents` bez odoslania) | job `pending`, pokusy 1, kód `ESBLU_STORAGE_REMOVE_FAILED`, `storage_purged_at` null, health 0 → retry (rovnaký kód ako cron) → done; potom ako T1 |
| D-A | alerty (SQL, vždy ROLLBACK, `p15-groupD-alert-rollback-test.sql`) | `exhausted = 1`, `termination_unpurged_24h = 1`, ručné „done“ → `ESBLU_CLEANUP_UNVERIFIED`, cudzí / billing cieľ → `ESBLU_CLEANUP_TARGET_PROTECTED`/`IMMUTABLE` |
| D-PERF | PERF (25 000 faktúr, 100 000 položiek, 5 000 prijatých, 300 súborov) cez API | **pravdepodobne prekročí 8 s** → PostgREST zruší transakciu → nič sa nezmaže, zapíše sa iba `failed` (bezpečné zlyhanie = test) |
| D-PERF-B | ak D-PERF zlyhá na limite: Claude zavolá tú istú DB funkciu `esblu_company_termination_execute` cez SQL (bez 8 s limitu, rovnaká brána: export ≤ 24 h, reautentifikácia ≤ 30 min z behu D-PERF, ack ≤ 15 min) → runner `-Mode cleanup` zmaže súbory a účet a overí | samostatné schválenie; meranie času |
| D-F | záverečná kontrola (SQL, read-only) | snímka chránených údajov = východisko; P15 ostáva iba ISO |

Pred a po každom kroku: `scripts/sql/p15-groupD-snapshot.sql` (Claude). Opakovanie: druhý beh tej istej firmy →
runner STOP (firma neexistuje); DB funkcia vráti `already_completed` (idempotentné).

## 6. Prečo výmaz nezasiahne ISO, 16 firiem ani billing-documents (vrstvy)

1. **Allowlist v kóde** (`groupD-core.ts`): iba `t1|t2|perf` (vlastné kľúče, nie prototyp) → presné UUID, vlastník,
   názov, e-mail; zhoda so schválenými identitami skupiny C; ISO = STOP pred sieťou (aj UUID, prázdne, veľké písmená).
2. **Sieťová poistka** (`deletionGuardedFetch`, každá požiadavka): RPC iba 10 povolených funkcií a iba s
   `p_company_id`/`p_user_id` aktívneho cieľa; Storage DELETE iba `einvoice-documents`/`ai-inbox-documents` a každá
   cesta pod `<cieľ>/` (zmiešaná dávka = celá zablokovaná); `billing-documents` nikdy; REST mutácie iba PATCH jobu tohto
   ukončenia; Auth iba vlastník cieľa; upload, iné služby a iný projekt zakázané. Zablokovaná požiadavka sa neodošle
   a beh skončí FAIL.
3. **Precheck** pred výmazom: identita v DB, vlastník bez iných firiem (zrušenie účtu nezasiahne inú firmu), bez
   e-Faktúry/billing, cesty pod prefixom, brána OK.
4. **DB** (bez zmeny): výmaz iba firmy, ktorej je volajúci aktívny vlastník a `owner_id`; e-faktúry iba pod prefixom
   firmy; trigger jobu zakáže `billing-documents` a cudzí prefix; DB potvrdenie výmazu overí každý cieľ aj sweep prefixu.
5. **Kód appky**: `deletionAllowed` (billing nikdy, e-faktúry iba prefix ukončovanej firmy).
6. **Kontrola po kroku**: ISO (runner + SQL) a 16 firiem + billing (SQL) = východisko.
7. **ISO vlastník** sa nikdy neprihlási → aj keby sa všetko ostatné obišlo, brána vráti `REAUTH_REQUIRED`.

## 7. Nezvratnosť

| Kategória | Položky |
| --- | --- |
| Nezvratné (staging) | riadky cieľovej firmy (faktúry, položky, udalosti, prijaté vrátane R3 a karantény, odoslané, dokumenty, prílohy, vozidlá, členstvá, firma), objekty Storage (XML, UBL, PDF, prílohy, osirelé, R3), účty …0101/…0102/…0104 |
| Obnoviteľné (znovuvytvorením, nie obnovou) | syntetické údaje: `seed-group-c.sql` + manifest + runner C (nové `created_at`, iné id behov) |
| Obnoviteľné zo zálohy | 67 objektov pôvodných firiem (D-B; obnova iba so súhlasom), DB riadky pôvodných firiem (`esblu_backup_p15_20261124`, skupina A) |
| Ostáva (evidencia) | `company_terminations` (vrátane `failed`), `company_export_runs` + súbory behov (cesty, SHA-256), mandáty (bez FK), incidenty R3 (hash ID), cleanup joby, účet admina …0105 bez firmy, celá ISO |
| Osobitný súhlas | každá firma zvlášť (D-T1, D-T2, D-PERF), D-PERF-B (SQL mimo API), každý dočasný kľúč, D-B záloha (čítanie skutočných súborov), obnova zo zálohy, D-A, neskoršie odstránenie …0105 a ISO, oprava HTTP 400 v kóde appky |

## 8. 28 × HTTP 400 (triedenie podľa neexistujúceho `id`) — samostatne

- Zdroj: export (`app/api/company/export/route.ts` → `fetchAll`, runner C rovnako) triedi každú tabuľku `order=id`
  a pri `42703` zopakuje bez triedenia. Tri tabuľky nemajú `id` (PK = `company_id` / `invoice_id`):
  `company_billing_profile` (2 čítania na export: tabuľka + zdroj loga), `company_legal_identities`,
  `invoice_accounting_state`. 7 exportov × 4 = **28** zbytočných požiadaviek, každá hneď nasledovaná úspešným čítaním.
- Dopad: žiadna strata údajov (počty = DB odtlačok), iba šum v logoch a 1 round-trip navyše; platí aj v produkcii.
- Návrh (neimplementované, aby sa nemenili pinované súbory pred D): v `lib/company-export.ts` pridať k týmto 3
  tabuľkám `orderColumn` (`company_id` / `invoice_id`) a v `fetchAll` triediť podľa neho (stabilné stránkovanie podľa
  PK); fallback na `42703` ponechať ako poistku. Test: počty a obsah exportu T1/ISO pred = po; 0 × 400 v logoch.
  Nasadenie bežnou cestou (vetva → Preview → review), po skupine D.

## 9. Dočasné Supabase kľúče

1. Jeden kľúč = jeden beh (`p15_backup_67`, `p15_groupD_t1`, `p15_groupD_t2`, `p15_groupD_perf`, prípadne
   `…_cleanup`); vytvára vlastník v dashboarde esblu-test tesne pred behom, nikdy pre produkciu.
2. Zadanie iba cez `Read-Host -AsSecureString`; kľúč žije iba v prostredí procesu Node počas behu; odstraňuje sa vo
   `finally`; logy sa kontrolujú na `sb_secret_` / JWT (únik = prepis logu); schránka Win+V vymazať.
3. Spúšťač pred kľúčom overí 20 (D) / 6 (záloha) SHA-256, lock závislostí, čisté prostredie a v preflighte aj proces
   Node bez kľúča a siete.
4. Odvolanie vždy (aj pri chybe), potom overenie HTTP 401 skriptom; Claude potom z logov API (iba prefix + hash)
   overí, že po 401 už nebola žiadna požiadavka a že kľúč volal iba povolené cesty.
5. Žiadny kľúč pre ISO; legacy `service_role` JWT sa nepoužíva; publishable key je verejný (iba `verify`).

## Offline testy (2026-11-25, Linux sandbox, Node 22.23.5)

| Sada | Výsledok |
| --- | --- |
| `groupD-tests.ts` (allowlist, sieťová poistka, skutočný kód appky + supabase-js proti falošnému serveru, priebeh runnera, cleanup) | **20/20** |
| `storage-backup-tests.ts` (inventár, šifrovanie, zlé heslo, zmena bajtu, výmena blobov, zmenený manifest, sieť iba GET, OneDrive) | **6/6** |
| `p15-termination-isolation-pglite-tests.ts` (DB logika výmazu, dva replaye migrácií) | 54/54 |
| `account-deletion-orchestration-tests.ts` (orchestrácia, cron, alert) | 23/23 |
| `company-termination-tests.ts` | 14/14 |
| `tsc --strict` (nové súbory) | bez chýb |
| preflight entry D (t1/t2/perf OK; iso/t3/prázdne/zlá URL/zmenený súbor/injekcia mimo t2 = STOP) | OK |

Nájdená a opravená chyba počas testov: `resolveDeletionTarget("__proto__")` vrátil prototyp objektu (prešiel by
kontrolou „je v allowliste“) — teraz iba vlastné kľúče `t1|t2|perf`.
**Neoverené:** spúšťače .ps1 na Windows (iba statická kontrola: ASCII, zátvorky, odtlačky = súbory) a GoTrue
`verify` pre používateľov bez `auth.identities`.
