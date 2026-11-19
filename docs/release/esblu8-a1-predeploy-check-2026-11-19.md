# A1 — konečná predprodukčná kontrola (2026-11-19, 22:20 SEČ)

| # | Kontrola | Výsledok |
|---|---|---|
| 1 | Release | GitHub `release/esblu8` = `1c3e6a7`; `origin/main` = `12da726` je predok → fast-forward možný (54 commitov). Lokálne commity nad `1c3e6a7` sú iba dokumentácia. 12 migrácií A1 identických s overenými súbormi (MD5 = staging). |
| 2 | Stripe LIVE | Stripe klient vzniká iba v `getWebBillingProvider` / `getStripeReportingProvider`; v produkcii `getBillingServerMode` vráti `off`, ak nie je `ESBLU_BILLING_MODE=stripe_live` **a** `ESBLU_BILLING_LIVE_APPROVED=true` (+ platná live env schéma). Produkčné env neobsahuje žiadnu Stripe/billing premennú. DB: `environment=test`, `web_provider=none`, 0 checkoutov/predplatných. |
| 2 | eFaktúra LIVE | `getEinvoiceProvider` vyžaduje `ESBLU_EINVOICE_PROVIDER` + kľúč; live navyše `ESBLU_EINVOICE_LIVE_ENABLED=true`. V produkcii nič z toho → `null`. `staging-e2e` route odmieta mimo Preview/staging DB. 0 organizácií. |
| 3 | Crony | 4 nové (`billing-stripe-events`, `billing-reconcile`, `billing-ops-monitor`, `billing-documents`): bez `CRON_SECRET` 401, pri režime off `configured:false` bez volania Stripe a bez zápisu. eFaktura crony pri nenakonfigurovanom poskytovateľovi `configured:false`; údržbový cron volá alert RPC z A2 iba best-effort (chyba sa ignoruje). |
| 3 | RLS / granty | nové tabuľky A1 bez prístupu anon/authenticated (staging test a2, grants-replay 43, grants-guard 10). |
| 3 | Kompatibilita | starý kód `12da726` nad A1: 0 zaniknutých funkcií, 0 zmien návratových typov, 0 nových NOT NULL bez defaultu v existujúcich tabuľkách; produkcia bez driftu (11/11). Nový kód bez A2 migrácií: kód eFaktúry je neaktívny (poskytovateľ nenakonfigurovaný); ukončenie firmy deregistráciu preskočí. |
| 3 | Rollback | Vercel Instant Rollback na `dpl_7rkNSeF2…` (`12da726`) samostatne; DB rollback 12 → 1 iba pri chybe migrácie, po deployi vždy najprv Vercel. |
| 4 | Záloha | `C:\Users\roiaj\esblu-backups\2026-11-19-pre-a1\esblu-prod-pre-a1.esblubk` (AES-256-GCM, SHA-256 `64ef2746…e5ca`, kľúč v `esblu-backups\_keys\`): 113 tabuliek (md5 každej = server, súhrn `454da245…24fc`), 3 Auth používatelia, 9/9 Storage súborov (bajty z overenej zálohy 19. 11., znovu overené voči aktuálnej veľkosti a eTagu). Overené rozšifrovaním; zlý kľúč odmietnutý. Denná PHYSICAL záloha Supabase 19. 11. 00:33 UTC (ďalšia ~20. 11. 00:33). Nič v OneDrive/Downloads. |
| 5 | Chránené účty | 3 účty (nebanované), 2 firmy, 3 členstvá, 16 nárokov, 9 súborov, 3 settings. A1 nemení ich dáta (top-level DML iba `billing_checkout_sessions`, 0 riadkov). Baseline odtlačky pre porovnanie po nasadení: users `94adf9e292ba`, identities `c426f523fcf3`, companies `97336f10278c`, members `7222818c4349`, entitlements `24301cf29a7d`, settings `6230256da363`, objects `0d16a102e997`. |
| — | Upratanie | `staging.esblu.com` odstránená z projektu; bypass secret zrušený (Preview bez neho → 302). |

## Postup nasadenia (po schválení)
1. Preflight (read-only) + odtlačky z § 5 musia sedieť; ak medzitým vznikla registrácia `esblu.office@gmail.com`, je to očakávaná zmena users/companies.
2. Čerstvá záloha, ak od tejto uplynulo > 24 h alebo sa zmenili dáta.
3. `apply_migration` 1 → 12 (`20261118120000` … `20261123120000`), po každej `schema_migrations` + `get_advisors` (0 nových ERROR) + `billing_runtime_config` test/none.
4. GitHub: PR `release/esblu8` → `main`, **merge bez squash** (fast-forward/merge commit) — vykoná prevádzkovateľ (Cowork nemôže pushovať) alebo cez GitHub UI.
5. Vercel production READY pre presné SHA na `main`.
6. Smoke test: `/`, `/login` 200; prihlásenie 3 chránených účtov (prevádzkovateľ); odtlačky § 5 nezmenené; crony `configured:false`; runtime errors 30 min = 0 nových; advisors.
7. Záznam do `docs/ops/`. Chyba → Vercel Instant Rollback; DB rollback iba pri chybe migrácie.
