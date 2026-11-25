# Esblu — overenie zálohovania pred prvou produkčnou zálohou (2026-11-20)

Vetva `ops/daily-backup-2026-11-20`. Žiadny export produkčných osobných údajov, žiadny nový kľúč, žiadna zmena
nastavení Supabase, plánovaná úloha nespustená. Produkcia iba read-only metadáta (katalóg, oprávnenia, počty).

## 1. Oprávnenia zálohovacieho kľúča
| Typ prístupu | Môže meniť / mazať? | Zdroj |
|---|---|---|
| Supabase secret kľúč `sb_secret_…` / legacy `service_role` | **ÁNO** — obchádza RLS, plný zápis aj mazanie v DB aj Storage; Supabase nemá režim „iba čítanie“ | dokumentácia Supabase API keys |
| Storage S3 prístupové kľúče | **ÁNO** — plný prístup ku všetkým bucketom | dokumentácia Supabase Storage S3 |
| **Nová Postgres rola `esblu_backup`** (`supabase/ops/esblu-backup-readonly-role.sql`) | **NIE** (overené, nižšie) | PGlite + produkčný katalóg |

**Pôvodný návrh (secret kľúč) teda NEspĺňa požiadavku „nemôže meniť ani mazať“.** Kód zálohy síce volá iba GET/list,
ale kompromitovaný kľúč na PC by dal útočníkovi plnú kontrolu nad produkciou. Pozn.: rovnaký produkčný service_role kľúč
je už dnes v čistom texte v `C:\Users\roiaj\assetpilot\.env.local`.

**Dôkaz pre rolu `esblu_backup`** — test na celej schéme Esblu (všetky migrácie, PGlite / PostgreSQL 18):
- SELECT na všetkých 112 public tabuľkách aj cez RLS (BYPASSRLS) + `storage.objects/buckets`, `auth.users/identities`.
- INSERT / UPDATE / DELETE / TRUNCATE na **každej** tabuľke = `permission denied` (42501) — aj po `set transaction_read_only = off`.
- žiadna SECURITY DEFINER funkcia (nemôže obísť oprávnenia cez RPC), žiadne CREATE v žiadnej schéme, žiadne členstvo v inej role
  (nevie prepnúť na `service_role`), nie superuser/createrole; budúce tabuľky čitateľné automaticky, nie zapisovateľné.
- **Produkcia (read-only overenie podmienok):** PUBLIC má na `public` iba USAGE, žiadne tabuľkové oprávnenia; v žiadnej schéme
  nie je SECURITY DEFINER funkcia spustiteľná pre PUBLIC (iba 9 nemenných pomocných funkcií); rola `postgres` má BYPASSRLS
  + CREATEROLE a SELECT s GRANT OPTION na `auth.users` → rolu je v produkcii možné vytvoriť presne takto.
- Po vytvorení sa v produkcii spustí overovací dotaz zo súboru (5 kontrol, každá musí byť `true`).

**Storage:** Supabase nemá kľúč iba na čítanie súborov. Bezpečná alternatíva = malý serverový endpoint vo Verceli
(iba čítanie: zoznam + stiahnutie súboru), chránený vlastným náhodným tokenom; service_role zostane iba na serveri.
Únik tokenu = možnosť čítať súbory, nie meniť/mazať. Vyžaduje zmenu kódu + premennú vo Verceli + deploy (schválenie).
Do jeho nasadenia: **pomenované riziko** — secret kľúč na PC (iba dedikovaný, samostatne zrušiteľný, DPAPI).

## 2. Šifrovanie a súkromný kľúč
- Každá záloha: náhodný AES-256-GCM kľúč, zabalený **verejným** RSA-4096-OAEP-SHA256 kľúčom; hlavička (odtlačok kľúča,
  zabalený kľúč) je chránená GCM tagom; odtlačok verejného kľúča je pripnutý (podvrhnutý kľúč = beh zlyhá).
- Test: počas zálohy bol súkromný kľúč **fyzicky presunutý mimo dosah** — záloha prebehla; otvoriť ju vie iba súkromný
  kľúč + heslo; iný kľúč, nesprávne heslo a zmena 1 bajtu (dáta aj hlavička) = odmietnuté.
- Súkromný kľúč: PKCS#8 šifrovaný heslom (AES-256-CBC, ≥ 16 znakov). Uloženie: 2 offline kópie (USB v trezore + papierová/
  správca hesiel pre heslo), **nikdy na PC so zálohami**. Bez neho sa záloha neobnoví — zahrnúť do krízového plánu.

## 3. Skutočný test obnovy (syntetické dáta)
`scripts/ops/esblu-backup-pglite-tests.ts` — 14/14:
zdrojová DB (všetky migrácie) + syntetické dáta (2 firmy, 1 500 vozidiel, stroj, sklad s diakritikou, úvodzovkami, `$$`
a `\`, 3 súbory Storage) → **skutočný kód zálohy** → nová prázdna DB zo schémy migrácií → `restore-public-data.sql`
(jedna transakcia) → **každá z 112 tabuliek zhodná (počet + MD5 všetkých riadkov)**, sekvencie pokračujú za maximom,
súbory bajt po bajte (SHA-256), väzba fotka → vozidlo → súbor, rovnaké počty RLS politík/funkcií/triggerov;
pri nesedí počtov sa obnova celá zruší (nič sa čiastočne nezapíše).
**Nájdená a opravená chyba:** nová DB obsahuje referenčné dáta z migrácií (plány, limity, právne dokumenty) → obnova
kolidovala na primárnych kľúčoch; SQL ich teraz najprv nahradí stavom zo zálohy.
**Opravené tiež:** dva behy v tej istej sekunde mali rovnaký názov súboru a zlyhaný beh mohol zmazať platnú zálohu
(názov má teraz milisekundy, súbor sa nikdy neprepíše); kurzy ECB sa zálohujú celé (historické kurzy prepočtov faktúr).

## 4. Úplnosť zálohy
| Časť | V dennej zálohe | Obnova | Stav |
|---|---|---|---|
| Dáta 106 public tabuliek (6 vylúčených, sekcia 6) | áno | `restore-public-data.sql` | overené |
| Schéma, RLS (127), funkcie, triggery, granty | nie | repo migrácie | produkcia vs. replay migrácií: **rovnaká množina 112 tabuliek, 127 politík**; telá funkcií/stĺpce porovnané nie sú → **riziko driftu** (história produkcie obsahuje migrácie aplikované mimo repa pred baseline) |
| Auth: id, e-mail, metadáta, identity | áno (Admin API) | Admin API s pôvodným `id` | overené v teste (SQL ekvivalent) |
| Auth: **heslá (hash), MFA** | **nie** | reset hesla / Google | chýba |
| Auth konfigurácia (SMTP Resend, Google, redirect URL, šablóny, limity) | nie | Dashboard | **chýba** — zdokumentovať |
| Súbory Storage (všetky súkromné buckety) | áno | Storage API | overené |
| Nastavenie bucketov (súkromný, limity, MIME), Storage politiky (14) | iba názvy | migrácie | v migráciách |
| `supabase_migrations` (120 záznamov) | nie | — | chýba |
| Vault (1 tajomstvo) | nie | správca hesiel | chýba (zaznamenať mimo DB) |
| Vercel env, crony, domény, Stripe/eFaktúra nastavenia | nie | runbook | mimo DB |

**Odporúčanie:** doplniť `pg_dump` cez rolu `esblu_backup` (schémy public, auth, storage, supabase_migrations; PostgreSQL 17
klient, zadarmo) do toho istého šifrovaného súboru → presná schéma vrátane funkcií a grantov, heslá Auth (bcrypt hash,
šifrované) a história migrácií. Konfiguráciu Auth a Vercel zdokumentovať raz mesačne (bez tajomstiev).

## 5. Druhá offline kópia (ochrana pred ransomvérom)
- 2 šifrované USB disky (BitLocker To Go) striedané týždenne; disk je pripojený iba počas kopírovania (air gap),
  jeden vždy mimo kancelárie/domu.
- Kopírujú sa iba už šifrované `.esblubk2` súbory + `last-manifest.json`; po kópii kontrola SHA-256 voči `backup-runs.jsonl`.
- Retencia na USB: 8 týždenných + 6 mesačných (najstaršia ≤ 6 mesiacov — **na schválenie s CLIA**, alebo 6 týždňov ako denné).
- 3-2-1: (1) Supabase 7 dní, (2) PC denné ≤ 6 týždňov, (3) offline USB. Cena: existujúci disk alebo ~30–60 € jednorazovo.

## 6. GDPR — návrh pravidiel na konzultáciu s CLIA
1. **Účel:** obnova dostupnosti a integrity služby po incidente (čl. 32 ods. 1 písm. c GDPR); nie archív zákazníka (VOP 1.2 čl. 19.4).
2. **Rozsah:** všetky údaje potrebné na obnovu; vylúčené: FCM tokeny, web push odbery, relácie, dočasné kontexty a potvrdenia
   asistenta, pokusy o aktiváciu eFaktúry. Heslá iba ako hash, ak sa schváli `pg_dump` auth.
3. **Retencia:** denné 14 dní + týždenné 4 týždne (≤ ~6 týždňov); offline podľa bodu 5. Potom automatické zmazanie.
4. **Výmaz:** žiadosť o výmaz / zrušenie firmy sa v produkcii vykoná hneď; v zálohách údaje zaniknú rotáciou (≤ 6 týždňov,
   offline ≤ dohodnutá lehota). Pri obnove zo zálohy sa vykonané výmazy **znovu aplikujú** podľa evidencie
   (`account_deletion_cleanup_jobs`, `company_terminations`) pred sprístupnením služby.
5. **Bezpečnosť:** šifrovanie verejným kľúčom, súkromný kľúč offline, prístup iba prevádzkovateľ, záznam o každej obnove.
6. **Umiestnenie:** SR, zariadenia prevádzkovateľa; žiadny nový sprostredkovateľ.
7. **Dokumenty na doplnenie:** Zásady (lehota uchovania záloh), DPA (TOMs: zálohy, šifrovanie, retencia, obnova),
   záznamy o spracúvaní. Otázky: je 6 týždňov primeraných? smú sa zálohovať heslá (hash)? lehota offline kópie?

## 7. Zistenie neúspešnej alebo neúplnej zálohy
| Situácia | Zistenie | Overené |
|---|---|---|
| chyba siete / HTTP / nesprávny kľúč | beh skončí chybou, `last-failure.json`, okno s upozornením | testy |
| počet riadkov ≠ server, súbor ≠ MD5/eTag, poškodenie po zápise | beh zlyhá, súbor sa zmaže | testy |
| zmiznutá tabuľka alebo bucket, prázdna DB/Storage oproti minulému behu | beh zlyhá, súbor sa nezachová | test |
| pokles riadkov/súborov o > 50 % | upozornenie v súhrne a okne | test |
| úloha vôbec nebežala (PC vypnutý, zrušená úloha) | kontrola pri prihlásení: záloha staršia ako 30 h → okno | syntax PS 5.1, nespustené |
| PC dlhodobo vypnutý | **nezistí nikto** | **otvorené** → heartbeat do produkcie + alert (vyžaduje migráciu, schválenie) |

## 8. Výsledky testov
| Test | Výsledok |
|---|---|
| `scripts/ops/esblu-daily-backup-tests.mjs` (mock Supabase) | 13/13 |
| `scripts/ops/esblu-backup-pglite-tests.ts` (celá schéma, rola + obnova) | 14/14 |
| PowerShell wrapper | syntax OK (tree-sitter); **nespustený** (žiadny PowerShell v prostredí agenta) |
| `pg_dump` cesta | navrhnutá, **neimplementovaná a neotestovaná** |
