# Osirelé súbory médií — read-only report (produkcia, 4. 10. 2026)

**Typ:** interný prevádzkový podklad. Nič nebolo zmazané.

**Zdroj:** read-only SQL nad `storage.objects` a všetkými tabuľkami, ktoré môžu referencovať cestu súboru:

- `vehicle_photos`, `machine_photos`, `inventory_photos`;
- `company_billing_profile.logo_path`, `settings.logo_path`;
- `documents`, `document_attachments`, `ai_evidence`.

**Kritérium „orphan“:** objekt v bucketoch `vehicle-photos`, `machine-photos`, `inventory-photos` a `company-logos`, na ktorý neodkazuje žiadny riadok v žiadnej z uvedených tabuliek (počet referencií 0).

| # | Bucket | Cesta | Vytvorené (UTC) | Nahrávateľ | Entita z cesty | Referencie | Orphan |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | company-logos | `9932bb02-…-7c8fd827e32a/1783967328946-company-logo.webp` | 2026-07-13 18:28 | owner firmy `e520286d…` (aktívny) | — | 0 | **áno** (staré logo; aktuálne žiadne logo nie je nastavené) |
| 2 | vehicle-photos | `e61c3329-…/af334d58-…/1787947202360-…-20260828_125220.webp` | 2026-08-28 20:00 | employee tej istej firmy (aktívny) | vozidlo existuje | 0 | **áno** |
| 3 | inventory-photos | `9932bb02-…/ad53ee49-…/1787947925414.webp` | 2026-08-28 20:12 | owner (aktívny) | položka **neexistuje** | 0 | **áno** |
| 4 | machine-photos | `e61c3329-…/2b0cde11-…/1788123029975-….webp` | 2026-08-30 20:50 | employee (aktívny) | stroj existuje | 0 | **áno** |
| 5 | inventory-photos | `e61c3329-…/89cf9510-…/1788123064033.webp` | 2026-08-30 20:51 | employee (aktívny) | položka **neexistuje** | 0 | **áno** |

Plné cesty sú v `scripts/ops/media-orphan-cleanup.mjs` (konštanta `ORPHANS`). Všetky súbory sú webp s veľkosťou 51–192 kB a ich vlastník v Storage sa zhoduje s priečinkom nahrávateľa. Všetky patria jednej firme (interné testovacie dáta vlastníka).

**Pravdepodobné príčiny:**

- **2, 4:** záznam zmazal owner/admin a súbor nahral employee. Starý model dovoľoval zmazať nereferencovaný súbor iba nahrávateľovi.
- **4, 5:** employee mohol nahrať súbor do machine- a inventory-photos (slabá upload politika), ale DB záznam mu RLS nedovolila.
- **3, 5:** položka bola zmazaná a súbor ostal.

Oba mechanizmy uzatvárajú migrácie `20261005090000` + `20261005091000`:

- upload podľa roly a firmy;
- fronta mazania, cez ktorú owner/admin dokončí zmazanie súboru po zmazaní záznamu.

## Cleanup postup (samostatné schválenie, NESPUSTENÉ)

1. Až po nasadení migrácií `20261005090000` + `20261005091000` (aby nevznikali nové orphany).
2. Read-only kontrola: zopakovať SQL z tohto reportu. Musí vrátiť presne týchto 5 objektov a 0 referencií.
3. Dry-run (Windows PowerShell, z koreňa repa, s `SUPABASE_SERVICE_ROLE_KEY` iba v aktuálnej relácii):
   ```
   node scripts/ops/media-orphan-cleanup.mjs
   ```
4. Ostrý beh so zálohou:
   ```
   node scripts/ops/media-orphan-cleanup.mjs --backup-dir=.\orphan-backup --execute --confirm=5
   ```
5. Overenie: zopakovaný report vráti 0 orphanov. Zálohu uchovať 30 dní a potom zmazať.

Skript pri behu znova overí, že súbor nie je referencovaný a stále existuje. Inak ho preskočí. Maže výhradne cez Storage API a iba cesty z pevného zoznamu.
