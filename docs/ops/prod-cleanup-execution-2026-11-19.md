# Záznam o vykonaní produkčného vyčistenia (2026-11-19)

Projekt `assetpilot` / `fkpgvgvsmbpieduoatrt`. Schválené prevádzkovateľom podľa `docs/prod-cleanup-and-operator-plan-2026-11-19.md`. E-maily testerov maskované (GDPR); identifikácia podľa UUID.

## 0. Záloha (podmienka)
- Šifrovaná záloha `C:\Users\roiaj\esblu-backups\2026-11-19-prod-cleanup\esblu-prod-2026-11-19.esblubk`, SHA-256 `c676c9b9…3fc2`, AES-256-GCM; kľúč oddelene v `C:\Users\roiaj\esblu-backups\_keys\`.
- Obsah: 113 tabuliek (`public` 102 s riadkami, `fx_reference_rates` iba počet+md5; `auth.users` bez heslových hashov a tokenov, `auth.identities`, `storage.objects/buckets`, zoznam migrácií) — každá tabuľka overená md5 voči serveru; 21/21 Storage objektov overených MD5 = eTag z DB.
- Overenie: rozšifrovanie z cieľového disku + rozbalenie (135 súborov) + test nesprávneho kľúča.
- Doplnkovo: platformová PHYSICAL záloha Supabase 2026-11-19 00:33:26 UTC (obsahuje aj heslové hashe; neobsahuje Storage).

## 1. Priebeh (19:11–19:24 SEČ)
| Krok | Výsledok |
|---|---|
| Preflight | 9 users / 7 firiem / 21 objektov; md5 `companies`, `invoices`, `company_members`, `storage.objects` = stav zálohy |
| Blokovanie | 6 účtov `banned_until` +100 r., relácie a refresh tokeny zmazané; chránené účty nedotknuté |
| Ukončenie firiem (`esblu_company_termination_commit`, `waived`) | 83bf5d52 → 88418366 → dc7552d3 → 110376c3 (bez výmazu účtu) → e520286d Anchar Bau (posledná); 5× `completed` |
| `esblu_account_deletion_commit('global')` | e61c3329, 46f33b5b |
| Storage (Storage API cez Dashboard) | zmazané priečinky 9932bb02 (company-logos, inventory-photos, ai-inbox-documents), e61c3329 (vehicle/machine/inventory-photos, ai-inbox-documents), e520286d (chat-attachments) = 12 objektov |
| Auth (Admin API cez Dashboard) | 6 používateľov zmazaných (výber overený podľa UUID pred potvrdením) |
| `beta_allowlist` | 3 riadky testerov zmazané |
| `public.settings` | 9 osirelých riadkov zmazaných |

## 2. Cieľová kontrola (overené SQL po vykonaní)
| Kontrola | Cieľ | Výsledok |
|---|---|---|
| auth.users / identities | 3 / 3 | 3 / 3 (playreview, gdpresblu, zamestnanec; nebanované, potvrdené) |
| companies / company_members | 2 / 3 | 2 / 3 (owner, employee, owner) |
| storage.objects | 9 | 9 (iba prefixy chránených účtov) |
| public.settings | 3 | 3 |
| invoices / invoice_items / einvoice_outbound | 0 | 0 / 0 / 0 |
| neplatné firemné/používateľské väzby | 0 | 0 v aktívnych tabuľkách; zámerne ponechané iba v auditných: `legal_acceptance_evidence`, `company_terminations` (5), `company_export_runs` (5), `account_deletion_cleanup_jobs` |
| IČO 57815941 | uvoľnené | `company_legal_identities` = 0, žiadna firma s IČO |
| `esblu.office@gmail.com` | registrovateľný | v auth.users neexistuje |
| chránené účty | funkčné | členstvá, nároky (7/9/7), súbory a settings zachované; www.esblu.com `/` a `/login` 200 |
| advisors (security) | bez nových | iba existujúce WARN/INFO (SECURITY DEFINER exec, RLS bez policy) |

## 3. Zostáva automaticky
- 7 cleanup jobov z dnešného dňa má `auth_status/storage_status = pending` (objekty aj Auth identity sú už zmazané). Cron `/api/cron/account-deletion-cleanup` (denne 03:30 UTC) ich idempotentne uzavrie na `done` (remove/deleteUser chýbajúceho objektu nie je chyba). Overiť 20. 11. po 03:30 UTC.
- Ponechané podľa plánu: `trial_claims`, `legal_acceptance_evidence`, `company_terminations`, `account_deletion_cleanup_jobs`, `esblu_intake_attestations_used`.

## 4. Prevádzkový log — kontrola 2026-11-19 19:09 UTC (read-only)
- Cron `/api/cron/account-deletion-cleanup` ešte nebežal (najbližší beh 2026-11-20 03:30 UTC).
- 6 jobov `pending` (5× iba `auth_status`, 1× Anchar Bau `storage+auth` so 7 cieľmi). Job s `delete_account=false` (110376c3) je `done/done`.
- Ciele jobov sú už fyzicky odstránené: 0 z 7 Storage cieľov existuje, 0 používateľov jobov existuje v `auth.users`. Žiadny job neobsahuje chránené účty ani ich prefixy (e5677bf3, 53b6ed5c, d3cc3714, firmy 8b20e5d7, 38f5f85a).
- Cron je idempotentný: `deleteUser` s 404/„not found“ = úspech (`lib/account-deletion-deps.ts:112–113`), `remove()` chýbajúcej cesty nie je chyba → joby prejdú na `done` bez ďalšieho zásahu. Ručná úprava stavov sa nerobí.
- Naplánovaná read-only kontrola: 2026-11-20 06:20 SEČ (úloha `esblu-cleanup-jobs-check-2026-11-20`), výsledok do `release-backups/2026-11-19-cleanup/cleanup-jobs-check-2026-11-20.md`.
- Overené ukončenia firiem v produkcii: od nasadenia workflowu (12. 11.) existuje iba 5 záznamov `company_terminations`, všetky z 19. 11. (schválené syntetické dáta) → žiadne reálne zákaznícke doklady neboli zmazané (bod R-V1 pre CLIA).
- Záloha: SHA-256 `c676c9b9…3fc2` nezmenený, opätovne rozšifrovaná a overená 19:09 UTC; nie je v Gite ani v OneDrive. Platformové denné zálohy Supabase (PHYSICAL) 12.–19. 11., posledná 19. 11. 00:33:26 UTC — obsahuje heslové hashe zmazaných účtov; pri 7-dňovej retencii Pro plánu zanikne približne 26. 11. 2026 (potom obnova Auth hesiel zmazaných účtov už nebude možná; reset hesla/opätovná registrácia).
