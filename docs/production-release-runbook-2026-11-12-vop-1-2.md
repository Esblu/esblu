# Production release runbook — VOP 1.2 (2026-11-12)

Schválenie: ChatGPT FINAL RELEASE CHECK – GO (2026-11-12). Commit: `b35a534` (preprod-release-candidate).
Produkcia: Supabase `assetpilot` (`fkpgvgvsmbpieduoatrt`, eu-central-1), Vercel `esblu`.
Staging (overené): `esblu-test` (`cjbdijbbcujvmrzezusd`).

## Migrácie tohto releasu (presne v tomto poradí)

| # | Súbor | Obsah | Rollback |
|---|---|---|---|
| 1 | `20261112100000_b2b_terms_1_2_company_acceptance.sql` | legal_documents terms 1.2 (required=false, reaccept_notice_days=30, hash = sha256 `legal/terms/1.2.md`), company_terms_notices, company_dpa_acceptances (`terms`, `b2b_confirmed`), esblu_company_terms_requirement / esblu_record_company_terms_notice / esblu_accept_company_terms / esblu_get_my_company_terms_status, esblu_accept_company_dpa (VOP pred DPA iba pri povinnom prijatí), archivácia dôkazu (company_terms), esblu_get_my_pending_required_acceptances | `supabase/rollback/20261112100000_…_rollback.sql` (fail closed pri prijatiach / oznámeniach) |
| 2 | `20261112110000_company_termination_workflow.sql` | company_terminations, esblu_company_termination_in_progress, 7 ochranných trigger funkcií (DELETE iba počas termination), esblu_company_termination_commit / _record_failure (service_role) | `supabase/rollback/20261112110000_…_rollback.sql` (audit ostáva) |

Žiadne ďalšie migrácie k tomuto releasu nepatria (posledná produkčná: `20261111110000`).

## Predpoklady (stop, ak niečo neplatí)

1. Managed backup produkčnej DB overený vlastníkom (Supabase → Database → Backups, posledná denná záloha).
2. Fresh logický `pg_dump` mimo repozitára (vlastník, lokálne) — cesta, veľkosť, čas.
3. Read-only precheck bez BLOCKERa: migration history (posledná `20261111110000`), objekty releasu neexistujú, fingerprint
   nahrádzaných funkcií = repo, RLS na všetkých tabuľkách, anon iba `legal_documents:SELECT` + `esblu_get_invite_preview`,
   Storage buckety privátne, žiadna nová env premenná.
4. ESLint bez nových chýb oproti baseline (33 / 32), plná regresia, Vercel Preview READY.

## Postup

1. Aplikovať migráciu #1, potom #2 (presný obsah súborov z `b35a534`).
2. Validácia: terms 1.2 hash/required/notice days, nové tabuľky s RLS a grantmi podľa manifestu, fingerprint funkcií = staging,
   anon bez nových funkcií, `esblu_company_termination_in_progress()` = false, žiadna firma `required_now` (existujúce firmy
   čakajú na oznámenie), počty zákazníckych dát nezmenené.
3. `git merge --ff-only` / bežný merge `preprod-release-candidate` → `main` (bez force push), push.
4. Vercel production deploy z `main`; overiť READY a aliasy.
5. Smoke: verejné `/kontakt` (telefón, dostupnosť, rozsah), `/podmienky-pouzivania` (VOP 1.2 + predchádzajúce verzie, SK/EN/DE),
   `/api/company/export` a `/api/account/delete` bez autorizácie → 401, DB: notice/grace model, owner-only RPC (anon bez EXECUTE).
   **Žiadne** reálne ukončenie firmy ani demo účty v produkcii.
6. Zápis do `docs/ops/service-intervention-log.md` a `docs/MASTER-PRELAUNCH-CHECKLIST.md`.

## Rollback

- Aplikácia: Vercel instant rollback na predchádzajúci produkčný deployment (`7dbb386`).
- DB: najprv rollback #2, potom #1 (fail closed, ak už existujú prijatia/oznámenia — vtedy forward-fix).
- Krajná možnosť: obnova z managed backupu / logického dumpu (strata zmien po zálohe).

## Mimo rozsahu (nezapínať)

Stripe, live billing, IAP, eFaktúra, nový provider, GDPR purge, orphan cleanup, publikácia v App Store / Google Play.
Storage objekty nie sú v DB zálohách — **blocker pred platenou ostrou prevádzkou**, nie pred týmto releasom.
