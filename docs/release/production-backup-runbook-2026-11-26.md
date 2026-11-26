# Esblu — čerstvá šifrovaná produkčná záloha pred release (runbook, 2026-11-26)

Spúšťa vlastník na svojom PC (Windows PowerShell 5.1+, Node.js ≥ 22). Produkcia sa nemení.
Automatická fyzická záloha Supabase z 26. 11. 2026 ~00:33 UTC overená vlastníkom (Dashboard, Restore dostupný).

## Krok 0 — pracovná kópia s nástrojmi (iba lokálne, bez zmeny hlavného checkoutu)

```powershell
git -C C:\Users\roiaj\assetpilot worktree add --detach C:\Users\roiaj\esblu-release-tools release/rc-2026-11-26
cd C:\Users\roiaj\esblu-release-tools
git log -1 --oneline            # očakávané: najnovší commit vetvy release/rc-2026-11-26 (runbook zálohy)
npm ci                          # iba pre krok 5 (PGlite); záloha samotná používa len vstavané moduly Node
```

## Krok 1 — kľúčový pár zálohy (raz; ak už existuje, preskoč)

1. Do USB kľúča (nie OneDrive, nie repo): `node scripts\ops\esblu-daily-backup.mjs --init-keys E:\esblu-backup-keys`
2. Skryto zadaj **heslo súkromného kľúča** (≥ 16 znakov; vygeneruj ho v správcovi hesiel a ulož tam). Nepíše sa na
   obrazovku, nikam sa neukladá.
3. Výstup: `esblu-backup-public.pem` (verejný), `esblu-backup-private.pem` (súkromný, šifrovaný heslom) a riadok
   `ESBLU_BACKUP_PUBKEY_SHA256=<64 hex>`. Verejný kľúč skopíruj na PC: `C:\Users\roiaj\esblu-backups\keys\esblu-backup-public.pem`.
   Súkromný kľúč ostáva iba na USB (+ druhá offline kópia).

## Krok 2 — serverový kľúč a nastavenie (bez plánovanej úlohy)

1. Supabase Dashboard → assetpilot → Project Settings → API Keys → Secret keys → **nový** secret kľúč s názvom `backup`.
2. Spusti:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\esblu-daily-backup.ps1 -Setup -NoSchedule `
  -PublicKey C:\Users\roiaj\esblu-backups\keys\esblu-backup-public.pem -Fingerprint <64 hex z kroku 1>
```
3. Na výzvu „Serverovy kluc pre zalohu“ vlož kľúč `sb_secret_…` (nezobrazí sa). Uloží sa iba šifrovane cez Windows DPAPI
   (`%LOCALAPPDATA%\Esblu\backup\server-key.dpapi`, len tvoj účet). Cieľ zálohy: `C:\Users\roiaj\esblu-backups\daily`.

## Krok 3 — záloha

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ops\esblu-daily-backup.ps1
Get-Content C:\Users\roiaj\esblu-backups\daily\last-success.json
```
Očakávané v `last-success.json` (bez osobných údajov): `"status": "OK"`, `project_ref` `fkpgvgvsmbpieduoatrt`,
`auth_users` 5, `tables` 106 (+ 6 zámerne vylúčených dočasných tabuliek), `storage_buckets` 9, **`storage_objects` 9**,
`storage_bytes` 1114838 (= 1 114 838 B ≈ 1,1 MB; overené 26. 11. read-only), `file_sha256`. (Počty sa zmenia, ak medzitým pribudne registrácia — vtedy zopakujem inventúru.)
Skript sám pred aj po zápise dešifruje súbor dátovým kľúčom a overí počty, SHA-256 tabuliek a súborov.

## Krok 4 — kontrola integrity súkromným kľúčom

```powershell
node scripts\ops\esblu-daily-backup.mjs --verify C:\Users\roiaj\esblu-backups\daily\<esblu-prod-…esblubk2> E:\esblu-backup-keys\esblu-backup-private.pem
```
Heslo kľúča zadaj skryto. Očakávané: `OVERENÉ: 106 tabuliek, 5 Auth, 9 súborov, SHA-256 …` (SHA-256 = `file_sha256`).

## Krok 5 — izolovaný test obnovy (bez siete, bez Supabase)

```powershell
node scripts\ops\esblu-daily-backup.mjs --extract C:\Users\roiaj\esblu-backups\daily\<súbor> E:\esblu-backup-keys\esblu-backup-private.pem C:\Users\roiaj\esblu-restore-test
node --experimental-strip-types --no-warnings scripts\ops\esblu-restore-verify.ts C:\Users\roiaj\esblu-restore-test docs\release\prod-inventory-2026-11-26.json --max-version 20261123120000
```
Očakávané: `RESTORE_VERIFY_OK` (počty všetkých tabuliek, 5 Auth používateľov, 9 súborov po bucketoch a bajtoch zhodné
s inventúrou; vylúčené tabuľky iba ako `info`). Potom **zmaž** iba tento dočasný priečinok (nešifrované údaje), s poistkou, že ide o rozbalenú zálohu:
`if (Test-Path -LiteralPath C:\Users\roiaj\esblu-restore-test\restore-public-data.sql) { Remove-Item -LiteralPath C:\Users\roiaj\esblu-restore-test -Recurse -Force }`. Ak je výsledok FAIL kvôli počtom, pošli mi iba výpis
riadkov `FAIL` (bez údajov) — zopakujem inventúru.

## Krok 6 — upratanie

- Supabase → API Keys: secret kľúč `backup` **zruš** (záloha je hotová; pre denné zálohy neskôr nový kľúč).
- `%LOCALAPPDATA%\Esblu\backup\server-key.dpapi` zmaž, ak nechceš denné zálohy.
- Súkromný kľúč vráť na USB / do trezoru; na PC nesmie ostať.
- Worktree môže ostať (potrebný pri nasadení) alebo `git -C C:\Users\roiaj\assetpilot worktree remove C:\Users\roiaj\esblu-release-tools`.

## Bezpečnosť (overené v kóde)

| Riziko | Ochrana |
| --- | --- |
| Zápis do produkcie | iba GET (PostgREST, Auth Admin `/admin/users`, Storage objekt) a POST `/storage/v1/object/list` (výpis); žiadny iný HTTP príkaz v skripte |
| Kľúč v súbore / logu | kľúč iba v DPAPI a v premennej procesu (po behu zmazaná); log `backup.log` obsahuje iba výstup skriptu (počty), navyše maskuje `sb_secret_…`/JWT |
| Nešifrované údaje na disku | záloha sa zapisuje iba zašifrovaná (`.tmp` → premenovanie); `last-success.json`, `last-manifest.json` iba počty; rozbalenie iba v kroku 5 a hneď zmazať |
| Git | cieľ zálohy aj rozbalenia v repozitári skriptu alebo v **akomkoľvek** priečinku s `.git` v ceste (aj iný worktree / hlavný checkout) = skript odmietne (`assertSafeOutDir`, test 13/13) |
| OneDrive / Dropbox / Google Drive / iCloud | skript aj `-Setup` odmietnu taký cieľ |
| Práva k priečinku | `icacls` — iba aktuálny používateľ |
| Heslá Auth | logická záloha ich neobsahuje (Admin API ich nevracia); obsahuje ich fyzická záloha Supabase (26. 11. 00:33 UTC) |

## Variant bez USB (2026-11-26)

Súkromný kľúč je vždy zašifrovaný heslom (PKCS#8, AES-256-CBC). Bez USB sa dočasne uloží do
`C:\Users\roiaj\esblu-keys-private` — mimo Gitu, OneDrive a `C:\Users\roiaj\esblu-backups`; `--init-keys` iný cieľ
odmietne (repo / `.git` v ceste / OneDrive / priečinok záloh) a nastaví ACL iba pre aktuálneho používateľa.
Oddelená kópia: zašifrovaný `esblu-backup-private.pem` ako príloha v správcovi hesiel (heslo kľúča v inej položke).
Presun na offline médium: po získaní USB skopírovať, overiť `--verify` z USB, lokálnu kópiu zmazať a prepísať voľné miesto.
Heslo sa zadáva iba skrytou výzvou Node (nie je v histórii PowerShellu ani v logu); schránku vyčistiť.
