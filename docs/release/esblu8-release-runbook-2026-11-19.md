# Esblu8 — produkčný release runbook (Stripe S12–S15b + interný tarif prevádzkovateľa), 2026-11-19

> Iba postup a výsledky overenia. **Nič z tohto dokumentu nebolo vykonané v produkcii** (žiadny push, deploy,
> migrácia ani zápis do DB). Každý krok označený ⛔ vyžaduje výslovný súhlas vlastníka.

## 0. Identifikátory a východiskový stav

| Položka | Hodnota |
| --- | --- |
| GitHub repo / production branch | `Esblu/esblu` / `main` |
| Produkcia (`origin/main`) | `12da726` |
| Stripe S15b vetva `android-release-payments-ios-2026-11-18` | `fb349db` (potomok `12da726`, 30 commitov) |
| Interný tarif `feat/internal-operator-plan` | `f8262b4` (priamy potomok `fb349db`) |
| Readiness vetva `ops/esblu8-readiness` | `f8262b4` + `e9c64a6` (ochrana auditu v rollbackoch) + commit s týmto runbookom |
| Vercel projekt / URL | `esblu` / https://www.esblu.com |
| Supabase produkcia | `assetpilot`, ref **`fkpgvgvsmbpieduoatrt`** (nikdy `esblu-test`, `skitze-protokoly`) |
| Posledná produkčná migrácia (read-only, 19. 11.) | verzia `20261117213219`, názov `open_public_registration` |

Celý rad je lineárny: `12da726 → … → fb349db → f8262b4 → e9c64a6 → (runbook)` ⇒ merge do `main` je **fast-forward**,
bez merge commitu a bez konfliktov.

## 1. Výsledky validácie (Linux kontajner, Node 22.23.4, npm 10.9.9, čistý `npm ci`, strom = `f8262b4`)

| Kontrola | Výsledok | Poznámka |
| --- | --- | --- |
| `npm ci` | PASS | 40 s, registry.npmjs.org |
| `npx tsc --noEmit` | PASS | 0 chýb (aj po `e9c64a6`) |
| `npm run build` (Next 16.3.8, Turbopack) | PASS | 60 statických stránok. Kontajner nemá prístup na fonts.googleapis.com (proxy 403) → `next/font/google` mock cez `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` + lokálny súbor; build potrebuje pri „collect page data“ placeholder env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` (dummy hodnoty, nie reálne). Vercel má reálne env aj sieť → bez obmedzenia. |
| `npm run lint` | 36 errors / 31 warnings | **Bez nárastu oproti produkcii:** `origin/main` aj `fb349db` dávajú na tom istom stroji presne 36/31 a výstup je zhodný riadok po riadku (líši sa len zarovnanie). Baseline „36/30“ z Windows sa líši o 1 warning prostredím (nie kódom tejto vetvy). Existujúce chyby neopravované. |
| `test:internal-operator-db` | PASS 15/15 (po `e9c64a6` 16/16) | nový test: rollback s neprázdnym auditom → archív, re-apply |
| `test:grants-guard` | PASS 10/10 | |
| `test:grants-replay-db` | PASS 43/43 | replay všetkých migrácií, idempotencia, rollback → re-apply = rovnaké ACL/politiky (aj po `e9c64a6`) |
| `test:pricing-entitlements-db` | PASS 35/35 | |
| `test:billing-post-period-db` | PASS 16/16 | |
| `test:billing-live-mode-db` | PASS 13/13 (po `e9c64a6` 14/14) | nový test: neprázdny allowlist sa pri rollbacku archivuje |
| `test:subscriptions-lifecycle-db` | PASS 82/82 | |
| `test:subscriptions-db` | PASS 60/60 | |
| `test:company-termination-db` | PASS 20/20 | |
| `test:subscriptions-lifecycle` | PASS 60/60 | |
| `test:plan-entitlements` | PASS 47/47 | |

Žiadna nová regresia v kóde vetvy; jediná oprava sa týka rollback skriptov (kap. 3).

## 2. Secrets / PII sken `origin/main..f8262b4` (31 commitov, `git log -p`, iba pridané riadky)

| Nález | Commit / súbor | Hodnotenie |
| --- | --- | --- |
| Supabase JWT (`role: anon`) | `72766a9` `scripts/stripe-local-sandbox.ps1` | verejný anon kľúč **stagingu** (ref ≠ produkcia), v skripte explicitne označený ako verejný; nie service_role. OK |
| `rkcs_test_…`, `rkcs_live_…`, `whsec_…` | `c3c7522` `scripts/subscriptions-lifecycle-tests.ts` | zjavné fixtures (`A1b2C3…`), nie reálne kľúče. OK |
| `sk_live`/`sk_test`/`rk_`/`pk_live` | viac commitov, `lib/billing/*`, testy, docs | iba prefixy v kóde validácie / dokumentácii, žiadna hodnota kľúča. OK |
| service_role JWT, `sb_secret_`, `sbp_`, GitHub PAT, Vercel token, OpenAI kľúč, AWS kľúč, private key, heslo v URL / priradení | — | nenájdené |
| E-mail prevádzkovateľa (osobný gmail) nemaskovaný | `bac46e4` `docs/clia-delta-2026-11-24-draft.md` | odstránený neskôr v `6b46c94` (v strome `f8262b4` už nie je), **ostáva v histórii**. Ten istý e-mail je aj autor commitov a už je v `origin/main` (`release/play-submission/10-voice-qa.md`). Nízke riziko (vlastný e-mail prevádzkovateľa); prepis histórie sa **neodporúča** (force-push zakázaný). |
| E-maily testerov / pôvodného účtu | `f8262b4` `docs/prod-cleanup-and-operator-plan-2026-11-19.md` | maskované (`x***y@doména`). OK |
| Ostatné e-maily | testy (`*@example.invalid`), `noreply@mail.esblu.com`, `play-review@esblu.com`, `privacy@esblu.com` | firemné / fiktívne. OK |
| IBAN, telefónne čísla | — | nenájdené |

## 3. Migrácie a rollbacky

Pridané v `origin/main..f8262b4` (poradie overené, zoradenie podľa názvu = povinné poradie aplikácie):

| # | Súbor | Rollback `supabase/rollback/` | Audit dáta v rollbacku |
| --- | --- | --- | --- |
| 1 | `20261118120000_billing_single_open_checkout.sql` | ✓ | iba funkcie + index; nič nemaže |
| 2 | `20261118130000_billing_terminal_precedence.sql` | ✓ | iba funkcie |
| 3 | `20261118140000_billing_refund_audit.sql` | ✓ | iba funkcie; audit refundácie je v `billing_events` → nedotknutý |
| 4 | `20261119100000_billing_post_period_protection.sql` | ✓ | iba funkcie |
| 5 | `20261119110000_billing_scheduled_end.sql` | ✓ | stĺpec `scheduled_end_at` sa zámerne **ponecháva** |
| 6 | `20261119120000_billing_event_catchup.sql` | ✓ | `drop table billing_event_cursors` — technický kurzor bez osobných a auditných údajov (zdokumentované; ďalší beh = bootstrap, dedupe udalostí platí). Akceptované. |
| 7 | `20261119130000_billing_live_mode.sql` | ✓ | iba constrainty/funkcie; zámerne zlyhá, ak je prostredie `live` (guard) |
| 8 | `20261119140000_billing_live_purchase_allowlist.sql` | ✓ — **upravený v `e9c64a6`** | predtým bezpodmienečný `drop table billing_live_purchase_allowlist` (záznam schválení LIVE nákupu) → teraz: prázdna = drop, neprázdna = presun do `esblu_audit_archive.billing_live_purchase_allowlist_rb_<UTC>` |
| 9 | `20261120100000_internal_operator_entitlement.sql` | ✓ — **upravený v `e9c64a6`** | predtým bezpodmienečný `drop table internal_operator_grants` (auditná tabuľka, iba komentár „exportovať“) → teraz: prázdna = drop, neprázdna = presun do `esblu_audit_archive.internal_operator_grants_rb_<UTC>` |

Žiadny chýbajúci rollback. `billing_events`, `company_terminations` ani iné auditné tabuľky žiadny z týchto rollbackov nemaže.

Archívna schéma `esblu_audit_archive`: vytvorí sa až pri rollbacku s dátami; `revoke all` na schéme aj tabuľke pre
`public, anon, authenticated, service_role` (nie je v Data API); indexy sa presúvajú s tabuľkou, takže opätovná forward
migrácia vytvorí v `public` novú prázdnu tabuľku a index bez kolízie názvov (overené pglite testami). Zmazanie archívu je
samostatný ⛔ krok.

## 4. Predpoklady (pred oknom)

1. ⛔ Súhlas vlastníka s releasom a s migráciami 1–9.
2. Záloha produkcie overená (PITR / denná záloha Supabase `assetpilot`) — čas zálohy zapísať do `docs/ops/service-intervention-log.md`.
3. Billing v produkcii **vypnutý**: Vercel Production bez `ESBLU_BILLING_LIVE_APPROVED`, bez `STRIPE_*` (overiť cez Vercel
   REST API / MCP — iba názvy premenných, nie hodnoty). `billing_runtime_config` = `test / none` (read-only dotaz).
   Nové crony `/api/cron/billing-stripe-events` (*/15) a `/api/cron/billing-reconcile` (23 */6) vtedy vrátia `configured:false`.
4. Read-only kontrola, že produkcia ešte nemá žiadnu z migrácií 1–9:
   ```sql
   select version, name from supabase_migrations.schema_migrations order by version desc limit 5;
   -- očakávané: najnovšia 20261117213219 / open_public_registration
   ```
5. Release robiť **v samostatnom worktree / klone**, nie v `C:\Users\roiaj\assetpilot` (má neuložené zmeny na `main`).

## 5. Rollout kódu (⛔)

```bash
git fetch origin
git worktree add ../esblu-release origin/main          # čistý strom, detached na 12da726
cd ../esblu-release
git switch -c release/esblu8 origin/main
git merge --ff-only fb349db                            # Stripe S15b
git merge --ff-only f8262b4                            # interný tarif prevádzkovateľa
git merge --ff-only ops/esblu8-readiness               # e9c64a6 rollback guard + runbook
git log --oneline -3                                   # over SHA
npx tsc --noEmit && npm run lint && npm run build      # lint: max 36 errors (žiadny nárast)
git push origin release/esblu8:main                    # fast-forward push, NIKDY --force
SHA=$(git rev-parse HEAD)
```

Vercel READY — párovať **presne podľa SHA** (REST API s `VERCEL_TOKEN`, nie CLI):

```bash
curl -s -H "Authorization: Bearer $VERCEL_TOKEN" \
  "https://api.vercel.com/v6/deployments?app=esblu&target=production&limit=20" \
| jq --arg sha "$SHA" '.deployments[] | select(.meta.githubCommitSha == $sha) | {uid, state: .readyState, url}'
```

Opakovať, kým pre tento SHA nie je `readyState: "READY"`; nikdy nereportovať iný (najnovší) deployment. Pri `ERROR`
→ build logy `GET /v3/deployments/{uid}/events`, migrácie **neaplikovať**. Smoke test https://www.esblu.com (login,
dashboard, `/nastavenia/predplatne` — billing UI vypnuté / „nedostupné“, `/api/cron/*` bez `CRON_SECRET` = 401).

Okno medzi deployom a migráciami: nový kód volá aj nové RPC (`esblu_billing_my_live_purchase_allowed`,
`esblu_billing_event_cursor_*`, stĺpec `scheduled_end_at`). Pri vypnutom billingu sú tieto cesty neaktívne alebo fail-closed
(purchase-options bez webových kanálov), preto je poradie „kód → migrácie“ bezpečné. Okno držať krátke.

## 6. Migrácie — po jednej (⛔), `apply_migration`

Pravidlá:

- **Nepoužívať `supabase db push`.** Produkcia ukladá ako `version` **čas aplikovania** (MCP `apply_migration`), nie
  timestamp zo súboru → `db push` by verzie nespároval a pokúsil by sa aplikovať históriu znova.
- Nástroj: Supabase MCP `apply_migration`, `project_id = fkpgvgvsmbpieduoatrt` (overiť pred každým volaním),
  `name` = názov súboru bez `.sql` (`supabase/MIGRATIONS.md` §9), `query` = presný obsah súboru z vydaného SHA.
- Po každej migrácii verifikačný dotaz + `get_advisors` (`security`, `performance`); pri chybe **zastaviť** (nepokračovať ďalšou), vyhodnotiť, prípadne rollback (kap. 7).

| # | `name` |
| --- | --- |
| 1 | `20261118120000_billing_single_open_checkout` |
| 2 | `20261118130000_billing_terminal_precedence` |
| 3 | `20261118140000_billing_refund_audit` |
| 4 | `20261119100000_billing_post_period_protection` |
| 5 | `20261119110000_billing_scheduled_end` |
| 6 | `20261119120000_billing_event_catchup` |
| 7 | `20261119130000_billing_live_mode` |
| 8 | `20261119140000_billing_live_purchase_allowlist` |
| 9 | `20261120100000_internal_operator_entitlement` |

Verifikácia po každom kroku (nahradiť `<name>`; akceptuje aj historický tvar bez timestamp prefixu):

```sql
select version, name
  from supabase_migrations.schema_migrations
 where name = '<name>' or name = regexp_replace('<name>', '^\d{14}_', '')
 order by version desc;
-- očakávaný presne 1 riadok, version = čas aplikovania (dnešný dátum), nie timestamp súboru
```

Doplnkové objektové kontroly (read-only):

| Po # | Dotaz | Očakávané |
| --- | --- | --- |
| 1 | `select to_regclass('public.billing_checkout_sessions_one_open_web_idx')` | nie null |
| 5 | `select count(*) from information_schema.columns where table_schema='public' and table_name='subscription_accounts' and column_name='scheduled_end_at'` | 1 |
| 6 | `select relrowsecurity from pg_class where oid='public.billing_event_cursors'::regclass` | true |
| 7 | `select conname from pg_constraint where conname in ('billing_runtime_config_env_check','billing_runtime_config_live_guard')` | 2 riadky |
| 8 | `select live_purchase_scope from public.billing_runtime_config`; `select relrowsecurity from pg_class where oid='public.billing_live_purchase_allowlist'::regclass` | `allowlist`; true |
| 9 | `select relrowsecurity from pg_class where oid='public.internal_operator_grants'::regclass`; `select has_function_privilege('authenticated','public.esblu_operator_grant_internal_plan(uuid,uuid,text,text)','execute')` | true; false |
| 1–8 | md5 tiel nahradených funkcií = repo (postup z `docs/billing-live-rollout-2026-11-19.md` §7) | zhoda |

`get_advisors` (`security` aj `performance`) pre `fkpgvgvsmbpieduoatrt` po každej migrácii a záverečne po #9 — žiadny nový ERROR;
porovnať s posledným záznamom v `docs/ops/service-intervention-log.md`. Access matrix (owner / admin / employee / iný tenant /
anon) na nových RPC v transakcii s `rollback` (bez zápisu). Zápis výsledkov do `docs/ops/service-intervention-log.md`.

Grant interného tarifu (`esblu_operator_grant_internal_plan`) je **samostatný ⛔ krok** po release podľa
`docs/prod-cleanup-and-operator-plan-2026-11-19.md` §6 — nie súčasť tohto okna.

## 7. Rollback

Kill switch (bez DB zmien): billing ostáva vypnutý; v prípade chyby kódu Vercel „Instant Rollback“ na predchádzajúci
production deployment `12da726` (⛔), alebo `git revert` (nie force-push).

DB rollback — **opačné poradie**, každý súbor zo `supabase/rollback/` samostatne cez `execute_sql` (⛔), po každom kroku
kontrola objektov. Rollbacky sú idempotentné. **Pozor:** rollback nemaže záznam v `supabase_migrations.schema_migrations`;
riadok odstrániť iba samostatne a vedome (⛔), inak by opätovné nasadenie vyzeralo ako už aplikované.

| Poradie | Rollback súbor | Pred spustením |
| --- | --- | --- |
| 1 | `20261120100000_internal_operator_entitlement_rollback.sql` | export `internal_operator_grants`; ak má riadky, tabuľka sa archivuje (`esblu_audit_archive`), nemaže sa; nároky → `revoked`, `plan admin → free` |
| 2 | `20261119140000_billing_live_purchase_allowlist_rollback.sql` | `web_provider = 'none'`; neprázdny allowlist → archív |
| 3 | `20261119130000_billing_live_mode_rollback.sql` | `environment = 'test'`, žiadny kurzor `live` (inak zámerne zlyhá) |
| 4 | `20261119120000_billing_event_catchup_rollback.sql` | vypnúť cron `billing-stripe-events` (vercel.json) |
| 5 | `20261119110000_billing_scheduled_end_rollback.sql` | stĺpec ostáva |
| 6 | `20261119100000_billing_post_period_protection_rollback.sql` | — |
| 7 | `20261118140000_billing_refund_audit_rollback.sql` | — |
| 8 | `20261118130000_billing_terminal_precedence_rollback.sql` | — |
| 9 | `20261118120000_billing_single_open_checkout_rollback.sql` | — |

DB rollback robiť **až po** rollbacku kódu (starý kód nové objekty nepotrebuje; nový kód bez nich degraduje fail-closed).

## 8. Zostávajúce riziká

- Build v CI/Vercel závisí od dostupnosti Google Fonts (`next/font/google`); lokálne offline buildy potrebujú mock.
- Lint baseline: 36 errors / 31 warnings (Linux) vs. 36/30 (Windows) — prostredím podmienený rozdiel 1 warningu; technický dluh mimo tohto release.
- Osobný e-mail prevádzkovateľa v histórii (`bac46e4`) — ostáva, prepis histórie sa nerobí.
- Rollback nemaže `schema_migrations` riadky — vedome riešiť pri re-apply.
- `billing_event_cursors` rollback zmaže technický kurzor (akceptované, zdokumentované).
- Lokálne stale `.lock` súbory v `C:\Users\roiaj\assetpilot\.git` (napr. `index.lock`, viacero `worktrees/*/HEAD.lock`) z predchádzajúcich sandbox relácií — pred prácou v hlavnom repe skontrolovať, či nebeží git proces, a odstrániť.
