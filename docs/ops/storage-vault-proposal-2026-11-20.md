# Esblu — ochrana súborov v existujúcej infraštruktúre Supabase (návrh 2026-11-20)

Bez nového poskytovateľa, bez osobného počítača, bez nového predplatného. Nič nie je nasadené ani aplikované;
produkcia iba read-only katalóg. Vetva `ops/storage-vault-proposal-2026-11-20`.

## 1. Čo Supabase (plán Pro) skutočne ponúka
| Možnosť | Stav v Supabase | Zdroj |
|---|---|---|
| Obnova zmazaného súboru | **neexistuje** — zmazanie cez Storage je trvalé | docs „Delete Objects“ |
| Verziovanie objektov | **nepodporované** („S3 versioning is not supported“) | docs „S3 Compatibility“ |
| Object Lock / lifecycle pravidlá | nepodporované | tamže |
| Denné zálohy DB (Pro) | 7 dní, **bez obsahu súborov** (iba metadáta), zmažú sa so projektom | docs „Database Backups“ |
| PITR | iba DB, ~100 USD/mes. | mimo požiadavky |
| Kópia medzi bucketmi | **áno**, na serveri (bez sťahovania), do 5 GB/súbor | docs „Copy Objects“ |
| Úložisko | 100 GB v pláne Pro (celá organizácia), potom 0,0213 USD/GB/mes. | docs „Storage pricing“ |
| Plánovač | crony Vercel už bežia (13 úloh) — existujúci plán | `vercel.json` |

## 2. Návrh: „Trezor súborov“ (jediné praktické riešenie v existujúcej infraštruktúre)
- **Súkromný bucket `esblu-file-vault`** bez jedinej RLS politiky + evidencia `public.storage_vault_entries` (RLS, bez politík, bez grantov pre klientov).
- **Cron vo Verceli každú hodinu** (bez PC): (1) nové/zmenené súbory → serverová kópia `<bucket>/<verzia>/<cesta>` (Storage copy, bez prenosu dát mimo Supabase); (2) zmazané originály → spustí sa lehota; (3) prepísané verzie → spustí sa lehota; (4) po lehote kópie zmaže (najviac 200 naraz, nikdy aktuálnu verziu existujúceho súboru).
- **Lehota 8 dní** po zmazaní/prepísaní: ≥ 7 dní denných záloh DB → ku každej obnoviteľnej verzii databázy existujú aj súbory.
- **Rozsah:** fotky vozidiel, strojov, skladu, logá, AI doklady (inbox, evidencia), prílohy chatu. eFaktúra a billing PDF nie (`DELETION_PROTECTED_BUCKETS` — aplikácia ich nemaže; rozhodnutie môže doplniť).
- **Ochrana trezora v kóde:** pridať `esblu-file-vault` do `DELETION_PROTECTED_BUCKETS`; výmazové joby čítajú cesty iba z DB riadkov a trezor nikdy nemajú v zozname (overené v `lib/account-deletion-storage.ts`).

SQL návrh: `supabase/proposals/storage_vault_proposal.sql` (bucket, tabuľka, 6 RPC iba pre `service_role`). Cron route a obnovovací skript: po schválení.

## 3. Dôkaz izolácie (PGlite, celá schéma Esblu + skutočné Storage politiky) — `scripts/ops/storage-vault-pglite-tests.ts` 11/11
- vlastník firmy A, používateľ firmy B, anon: **0 riadkov** v trezore; INSERT odmietnutý (RLS); UPDATE/DELETE nezasiahnu nič;
- kontrola testu: RLS je zapnuté a klientske roly majú tabuľkové oprávnenia → 0 riadkov je naozaj RLS, nie chýbajúci grant;
- evidencia a všetky vault RPC: `permission denied` pre anon/authenticated;
- **existujúce politiky (všetky schémy) bajt po bajte rovnaké** — návrh nerozširuje prístup ani tenant izoláciu;
- logika: kópia, prepísanie (stará verzia ostáva 8 dní), hromadné zmazanie (kópie ostávajú, purge pred lehotou nič), obnova všetkých verzií, purge iba po lehote, limit na beh.

**Produkcia (read-only):** RLS na `storage.objects` zapnuté; **každá permisívna Storage politika filtruje `bucket_id`** (0 bez filtra); 3 politiky bez filtra sú RESTRICTIVE (iba zužujú) → nový bucket je pre klientov nedostupný už existujúcimi pravidlami. Bucket `esblu-file-vault` zatiaľ neexistuje.

## 4. Čo to je a čo nie
| Udalosť | Trezor súborov | Denná záloha DB Supabase |
|---|---|---|
| Omylné zmazanie / prepísanie súboru používateľom | **obnoviteľné 8 dní** | — |
| Chyba aplikácie, hromadné zmazanie, kompromitovaný používateľský účet | **obnoviteľné 8 dní** | DB 7 dní (celý projekt naraz) |
| Ukončenie firmy / výmaz účtu (zámer) | kópie ešte 8 dní, potom zmazané | 7 dní |
| Súbor nahraný a zmazaný do 1 hodiny | nie (cron interval) | — |
| **Zmazanie projektu, strata/kompromitácia Supabase účtu alebo service_role kľúča** | **NIE — stratí sa všetko** | **NIE** |
| Chyba / výpadok platformy Supabase Storage | NIE | NIE |

**Je to prevádzková redundancia (ochrana pred omylom a chybou), NIE nezávislá obnoviteľná záloha.**
Nezávislá záloha bez nového poskytovateľa a bez PC v existujúcej infraštruktúre **neexistuje**. Zvyškové riziko
(strata celého projektu) sa dá iba znížiť: MFA pre všetkých členov Supabase/Vercel/GitHub, minimum vlastníkov,
odstránenie produkčného service_role kľúča z `C:\Users\roiaj\assetpilot\.env.local`, voliteľne občasná ručná šifrovaná
záloha existujúcim nástrojom (rozhodnutie prevádzkovateľa, neautomatizované).

## 5. Limity a náklady
- Náklady: **0 €** — dnes 1,1 MB súborov; kópie (aj starých verzií 8 dní) spadajú do 100 GB plánu Pro. Napr. 40 GB originálov
  + ~10 % zmien = ~44 GB kópií → stále v rámci 100 GB. Nad 100 GB spolu: 0,0213 USD/GB/mes. (napr. +20 GB ≈ 0,43 USD).
  Kópia je na serveri → žiadny egress. Cron: existujúci plán Vercel.
- RPO súborov ≤ 1 h (alebo 15 min pri častejšom crone), RTO: ručná obnova operátorom (skript, minúty).
- Obnova súboru predpokladá, že DB riadok existuje (inak najprv obnova DB zo zálohy ≤ 7 dní).
- Copy API do 5 GB/súbor (limity bucketov Esblu sú ≤ 20 MB).

## 6. GDPR a informácie pre CLIA (bez rozširovania zmluvy)
- Rovnaký sprostredkovateľ (Supabase), rovnaký projekt a región (eu-central-1), rovnaké šifrovanie Supabase → **žiadny nový
  sprostredkovateľ ani prenos**.
- Minimalizácia: iba súbory potrebné na obnovu; bez nových údajov; evidencia obsahuje iba technické údaje (bucket, cesta, verzia, veľkosť, časy).
- Uchovanie: kópia zmazaného/prepísaného súboru najviac **8 dní**, potom automatický výmaz (rovnaký princíp ako 7-dňové zálohy DB).
- Na posúdenie CLIA: (1) uviesť v Zásadách / DPA (TOMs), že zmazané súbory môžu byť ešte najviac 8 dní v ochranných kópiách
  (a DB v zálohách 7 dní); (2) súlad s VOP 1.2 čl. 20.1 („vymazanie Firmy je nevratné a odstraňuje … súbory“) — dočasné
  ochranné kópie po dobu 8 dní; (3) či má mať výmaz na žiadosť (čl. 17) okamžitý výmaz aj z trezoru (technicky možné).

## 7. Rozhodnutie
**Áno, má zmysel nasadiť** pred komerčným spustením: najčastejšie riziká (omyl, chyba aplikácie, hromadné zmazanie cez účet)
dnes nemajú žiadnu obnovu súborov; riešenie stojí 0 €, nezávisí od PC a nemení prístup používateľov. **Nesmie sa však
prezentovať ako záloha** — riziko straty celého projektu ostáva a treba ho výslovne prijať (alebo neskôr riešiť).
Postup po schválení: (1) CLIA: lehota 8 dní; (2) migrácia (bucket + tabuľka + RPC) — produkčná migrácia;
(3) cron route + `DELETION_PROTECTED_BUCKETS` + obnovovací skript + testy; (4) deploy; (5) prvý beh skopíruje existujúcich 10 súborov.
