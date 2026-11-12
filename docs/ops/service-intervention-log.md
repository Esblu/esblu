# Evidencia servisných zásahov (produkcia)

Účel: preukázateľnosť zásahov do produkčných systémov podľa odporúčania CLIA (11.11.2026), Smernice čl. 6.3.2 a
9.2.2 a `docs/ai-dev-tool-access-policy.md`. **Do záznamu sa nepíšu osobné údaje** (ani e-maily, mená, obsah) —
iba systém, rozsah, účel a výsledok. Záznam je append-only (git história). Uchovávanie: najviac 12 mesiacov od
zásahu (Smernica 11.3 — administrátorské prístupy a zásahy); staršie riadky presunie vlastník do internej
GDPR zložky alebo odstráni.

Polia: dátum a čas (UTC) · osoba / nástroj · systém · dôvod · rozsah (čítanie/zápis, objekty) · prístup k osobným
údajom (nie / agregáty / riadky) · výsledok · súhlas vlastníka.

| dátum a čas (UTC) | osoba / nástroj | systém | dôvod | rozsah | prístup k OÚ | výsledok | súhlas |
|---|---|---|---|---|---|---|---|
| 2026-10-25 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | J9 produkčný precheck migrácií | read-only transakcia, schéma + počty | nie (iba metadáta/počty) | precheck PASS | áno (J9) |
| 2026-11-10 17:4x | Claude (Cowork) pre vlastníka | Supabase org (zoznam projektov), Vercel `esblu` (projekt) | J10 audit regiónov | read-only metadáta (región, konfigurácia) | nie | eu-central-1 / fra1 potvrdené | áno (J10 zadanie) |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | J10.1 GDPR retention precheck (`scripts/sql/prod-gdpr-retention-precheck.sql`) | read-only transakcia, iba agregáty (počty, min/max čas) | agregáty, žiadne riadky | pozri J10.1 v checkliste | áno (J10.1 zadanie) |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | release preflight: `prod-migration-precheck.sql` | read-only transakcia, schéma/granty/politiky + počty | nie (agregáty) | 0 STOP / 0 WARN | áno (release zadanie) |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | uloženie definícií funkcií pred oknom (runbook #15) | read-only, 2 definície funkcií (schéma) | nie | uložené mimo repa (`release-backups/`) | áno |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Vercel `esblu` (prod env) | kontrola prítomnosti env | iba názvy premenných, bez hodnôt | nie | eFaktúra/billing/purge flag neprítomné | áno |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` REST (service role) | pokus o logický export pred oknom | žiadne dáta neprenesené (sieť sandboxu nepovolila spojenie) | nie | neúspešné → dump vykoná vlastník | áno |
| 2026-11-11 | Claude (Cowork) + subagenti pre vlastníka | Supabase `assetpilot` (prod) | produkčné migračné okno — 47 RC migrácií (#1–#47) cez `apply_migration`, po každej kontrola histórie | **zápis schémy** (migrácie zo súborov repa), seed `legal_documents`; bez mazania dát | nie (iba schéma; dáta nečítané) | 56 → 103 history, 0 chýb | áno (release zadanie + backup vlastníka) |
| 2026-11-11 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | post-migration validácia: fingerprint vs. súbory/staging, granty, RLS, advisors, izolácia firiem (simulácia JWT, iba počty) | read-only transakcie, agregáty | nie (počty, UUID prefixy firiem) | PASS | áno |
| 2026-11-11 | Claude (Cowork) pre vlastníka | GitHub `main` + Vercel prod | fast-forward `main` 901c46c → 7dbb386, deploy `dpl_2xX7bkncbQ3J38m4KEsta3ZgphsX` | kód | nie | READY | áno |
| 2026-11-12 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | VOP 1.2 release precheck: história migrácií, fingerprint 15 funkcií, RLS, granty, buckety, počty | read-only, schéma + agregáty | nie (počty) | 0 BLOCKER | áno (FINAL RELEASE CHECK – GO) |
| 2026-11-12 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | migrácie `20261112100000`, `20261112110000` cez `apply_migration` (managed backup 2026-11-12 00:33 UTC + logický dump vlastníka 20:29) | **zápis schémy** + seed `legal_documents` terms 1.2; bez mazania dát | nie | 103 → 105 history, fingerprint 12/12 = staging | áno |
| 2026-11-12 | Claude (Cowork) pre vlastníka | Supabase `assetpilot` (prod) | post-release smoke: simulácia JWT nečlena / nevlastníka v transakcii s rollbackom (owner-only accept a notice odmietnuté) | read-only výsledok, rollback | nie (iba kódy chýb) | PASS, žiadny zápis | áno |
| 2026-11-12 | Claude (Cowork) pre vlastníka | GitHub `main` + Vercel prod | fast-forward `main` 7dbb386 → 360128c, deploy `dpl_5qVws56uodUn7fxM4HtArJaXtTNY` | kód | nie | READY | áno |
