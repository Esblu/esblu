# E-Faktúra — Phase 6 readiness audit

**Dátum:** 2026-10-02
**Branch:** `einvoice-port` (base `main` = `origin/main` = `50526a7`). Phase 1–5 v 7 commitoch.
**Metóda:**

- vlastný audit,
- nezávislý read-only security review (subagent),
- porovnanie s oficiálnou dokumentáciou eFaktura.sk,
- read-only porovnanie s produkčnou DB (`fkpgvgvsmbpieduoatrt`, iba `select` nad katalógom).

**Legenda:**

- **PASS**
- **WARNING** (nie je blocker, je zdokumentovaný)
- **BLOCKER**
- **FIXED** = nájdené a opravené v Phase 6 (commit `fa6f2a1` + nasledujúci)

## 1. Stav repa a migrácie

| Oblasť | Verdikt | Dôkaz |
| --- | --- | --- |
| git status / HEAD / base | PASS | Worktree čistý, `einvoice-port` = 2e3a690 pred Phase 6, `merge-base` = `50526a7` = `main` = `origin/main`. |
| eInvoice migrácie (poradie) | PASS | `20261002100000_einvoice_foundation` → `110000_einvoice_en16931_fields` → `120000_einvoice_outbound_flow` → `130000_einvoice_inbound_flow` → `140000_einvoice_operations` → **`150000_einvoice_rollout_gate` (Phase 6)**. Všetky sú vyššie ako posledná prod migrácia `20261001130000_push_devices_session_binding`. |
| Konflikty s main / prod | PASS | Prod nemá žiadny `einvoice_*` objekt ani bucket. Závislé funkcie existujú. Telá funkcií, ktoré migrácie nahrádzajú alebo od nich závisia, sú v prod **sémanticky zhodné** s repom (normalizovaný MD5 zhodný): `esblu_save_invoice_draft`, `esblu_enforce_invoicing_entitlement`, `esblu_finalize_invoice`, `esblu_create_received_invoice_draft`, `esblu_my_finance_view/manage`, `esblu_get_my_company_entitlements`, `esblu_require_my_entitlement`. Stĺpce a constrainty dotknutých tabuliek (9 tabuliek, 163 stĺpcov, 99 constraintov) sú zhodné. Jediný rozdiel je PGlite stub `document_links` a ten je kompatibilný s INSERT v migrácii. |
| Testy migrácií vs. reálna prod schéma | WARNING | PGlite test používa podmnožinu migrácií + prod overlay. Pred produkčnou aplikáciou odporúčame dry-run na staging projekte s klonom prod schémy. |

## 2. Bezpečnosť a autorizácia

| # | Oblasť | Verdikt | Poznámka |
| --- | --- | --- | --- |
| 5 | eInvoice API routes | PASS | Bearer → `verifyRequestUser` → user-scoped klient. Webhook: HMAC. Cron: `CRON_SECRET` (timingSafeEqual, fail-closed). |
| 6 | server / client boundary | PASS | Všetky serverové moduly majú `import "server-only"`. Klient importuje iba `ui/client`, `ui/types`, `ui/view-model`. |
| 7 | service_role | PASS / WARNING | Iba `lib/einvoice/{outbound,inbound,ops}/supabase-store.ts` (test to vynucuje). WARNING: `lib/supabase-admin.ts` (mimo E-Faktúry, pred-existujúci) nemá `import "server-only"`. Neopravené, mimo scope. |
| 8 | RLS / grant / revoke / SECURITY DEFINER | PASS | Všetky DEFINER funkcie: `search_path ''`, EXECUTE odobraté public/anon/authenticated, iba service_role. Výnimky: `esblu_einvoice_my_rollout` → authenticated, vlastná firma + finance.view. Tabuľky: iba SELECT pre finance.view v aktívnej firme. `einvoice_rollout` bez klientských grantov. |
| 9 | nárok `einvoice` | **FIXED** | Predtým sa overoval iba pri zaradení a operátorskom retry; zaradené riadky sa po strate nároku odoslali. Teraz claim send neodošle nič, čo ešte neodišlo (riadok s neistým výsledkom smie iba replay toho istého kľúča). |
| 10 | finance.manage | PASS | Readiness + DB RPC (`request_outbound`, `operator_begin`). |
| 11 | role owner / accountant / admin / employee | PASS | Employee nikdy. Admin iba s explicitným `finance.manage` / `view`. Overené v testoch a v E2E matici (A1–A8). |
| 12 | tenant isolation | PASS | Firma z webhooku iba cez mapovanie `provider_org_id` → `einvoice_organizations`. Storage cesty sú overené v DB. Cross-tenant vracia 404. |
| 13 | idempotencia | PASS | Advisory lock, jeden aktívny pokus na faktúru (unique index), deterministické UBL, content-addressed storage, SKIP LOCKED + lease. **FIXED:** `POST /outbound` po neúspechu už nevytvorí nový pokus mimo operátorskej akcie (`RETRY_REQUIRES_OPERATOR_ACTION`). |
| 14 | webhook replay | PASS / WARNING | HMAC nad raw telom, ±300 s, rotácia, dedupe `X-Webhook-Id` + SHA-256 tela. WARNING: `X-Webhook-Id` nie je podpísaný (docs ho odporúčajú ako dedupe kľúč). Replay s inou hlavičkou do 5 min spôsobí iba opätovné stiahnutie (P7). **FIXED:** tvar payloadu podľa docs (`data.orgId`, `data.invoiceId`); predtým by reálne webhooky skončili `UNKNOWN_ORG` / `IGNORED`. Pribudol filter `data.mode` vs. prostredie. |
| 15 | inbound dedupe | PASS / WARNING | Unique `(provider, environment, provider_received_id)`, transport message ID, hash / číslo. WARNING: dva rôzne provider dokumenty s identickým XML spracované súbežne môžu vytvoriť dva koncepty (bez advisory locku). Nízka pravdepodobnosť. |
| 16 | nemenné UBL / XML | PASS / WARNING | Hash a cesta sú v DB nemenné, SHA-256 sa overuje pri každom čítaní aj odoslaní. WARNING: service_role technicky môže zmazať alebo prepísať objekt v storage. Detekuje sa to (hash), ale nezabráni. Trigger na `storage.objects` neodporúčame (vlastníctvo tabuľky v Supabase). |
| 17 | hash / evidence / audit chain | PASS | `einvoice_events` append-only (UPDATE, DELETE, TRUNCATE blokované). Dôkaz iba cez allowlist. `delivered` iba pri zhode hashu. |
| 18 | retry / reconcile state machine | PASS / WARNING | WARNING (pôvodne BLOCKER v reviewe): automatický replay po neistom výsledku používa **ten istý** Idempotency-Key. Docs connectora garantujú „never sends twice“, ale TTL kľúča a správanie pri súbežnom in-flight nie sú zdokumentované (P1, P2). Sandbox E2E krok O15 to overí empiricky. Nový kľúč po neistom výsledku DB blokuje. **FIXED:** claim po jednom riadku s termínom behu (predtým batch označil všetky riadky ako in-flight a pri `maxDuration` vznikal falošne neistý výsledok). |
| 19 | historický read po zrušení predplatného | PASS | RLS, summary aj download nezávisia od nároku. Nové akcie sú zakázané. |
| 20 | retencia | PASS | Maže sa iba uzavretá webhook metadáta ≥ 30 dní (90 odporúčané) a agregáty. Nikdy faktúry, XML / UBL ani udalosti. Vymazanie firmy vs. archivácia je CLIA Q5. |
| 21 | PII / secrets v logoch | PASS | Žiadne `console.*` v module. Odpovede obsahujú iba strojové kódy. Text poskytovateľa je scrubbovaný. WARNING: finance.view používatelia vidia cez PostgREST všetky stĺpce (`idempotency_key`, `error_message`, `onboarding_snapshot`, `requested_by`). Iba v rámci tenantu, API odpovede sú allowlistované. |
| 22 | cron auth | PASS | `CRON_SECRET` ≥ 16 znakov, konštantný čas, 401. |
| 23 | UI authz | PASS | UI iba zobrazuje `allowed` zo servera. Každá akcia sa overí znova (route + DB). |
| 24 | mobile static export | PASS | `/faktury/efaktury` je statická. API cez `apiUrl`. CORS allowlist (`https://localhost`, `capacitor://localhost`). Mobile build PASS. |
| 25 | žiadne odoslanie bez potvrdenia | PASS | `confirm_send:true` je povinné + confirm dialóg. Worker spracuje iba riadky zaradené používateľom. Finalizácia nič neodosiela. |

## 3. Provider-contract nálezy (oficiálne docs, 2026-10-02)

| Nález | Verdikt |
| --- | --- |
| Webhook payload `data.orgId` / `data.invoiceId` (camelCase) | **FIXED** |
| Od 1. 1. 2027 musí byť dátum vyhotovenia = deň odoslania; do 31. 12. 2026 max 10 dní | **FIXED** (readiness: v live blokuje, v sandboxe upozorní) |
| Sandbox vyžaduje v `EndpointID` schému 9915 | **FIXED** (readiness, DB constraint pre live) |
| `ERROR` je podľa docs terminálne („fix and send again“) | PASS (P4 na potvrdenie) |
| Partner feed `GET /v1/agent/events` | WARNING (nevyužité, P9) |

## 4. Prevádzka

| Oblasť | Verdikt |
| --- | --- |
| Cron konfigurácia | Pripravená (`docs/einvoice-vercel-cron.example.json`), neaktivovaná. Vyžaduje Vercel Pro. |
| Overlap / lease / batching / timeout | **FIXED** (termín behu, `?mode=`) |
| Alerty | **FIXED:** reject rate za 24 h (`OUTBOUND_REJECT_RATE_HIGH`); predtým kumulatívny počet alertoval navždy. WARNING: alerty sa nikam nedoručujú (iba JSON). Pre Stage 2+ treba notifikačný kanál. |
| Kill switch / rollout | **NEW:** `einvoice_rollout` (default DENY, `paused`), live brána v env (`ESBLU_EINVOICE_LIVE_ENABLED` + `VERCEL_ENV=production`) |

## 5. npm audit (12: 1 critical, 6 high, 5 moderate) — nič nebolo zmenené

`npm audit fix` ani `--force` **neboli** spustené. Analýza vychádza z lockfile vetvy:

| Balík | Inštalovaná verzia | Advisories (výber) | Runtime / dev | Dosiahnuteľné v Esblu? | Odporúčanie |
| --- | --- | --- | --- | --- | --- |
| **next** (priamy, root + mobile) | 16.2.9 | GHSA-p293-qw3h-jr36 (RCE, iba Windows hosting), GHSA-2xp9-vwfh-vxw4 (RCE v Image Optimization, AVIF), GHSA-vcvr-r3jv-pc5j (RCE `next/og`), GHSA-6gpp-xcg3-4w24 (proxy bypass, Turbopack + single locale), GHSA-p9j2-gv94-2wf4 (SSRF v rewrites), cache confusion, DoS server actions / SVG | runtime | `next/og` sa nepoužíva. Server Actions ani rewrites sa nepoužívajú. `next/image` sa používa v 2 súboroch, takže Image Optimization je dosiahnuteľná. `proxy.ts` rieši iba CORS, authz je v routes + RLS. Hosting na Vercel (Linux). | **Najvyššia priorita.** Samostatný PR mimo E-Faktúry: `next` (+ `eslint-config-next`) na ≥ 16.3.8 v root aj `mobile/`. Potom build, testy, preview a smoke. |
| postcss (cez next) | 8.4.31 / 8.5.28 | arbitrary file read / path traversal cez sourceMappingURL, XSS v stringify | build-time | Iba build (vlastné CSS). Nie runtime. | Vyrieši upgrade `next`. |
| sharp (cez next) | 0.34.5 | libvips / libheif CVE | runtime (image optimization) | Áno, ak Vercel Image Optimization používa sharp z bundlu. | Vyrieši upgrade `next` (≥ 0.35.4). |
| js-yaml, nanoid, browserslist, brace-expansion, baseline-browser-mapping | rôzne | DoS / CPU / OOM | dev / build tooling (eslint, postcss, capacitor cli) | Nie (neparsuje vstup používateľa) | `npm update` týchto tranzitívnych balíkov v samostatnom PR (bez major zmien). Overiť lockfile diff. |
| exceljs → uuid | exceljs 4.4.0, uuid 8.3.2 | GHSA-w5hq-g745-h8pq (bounds check pri `buf`) | runtime (exporty XLSX) | Nízka: exceljs nevolá v3 / v5 / v6 s `buf` od používateľa | Sledovať. „Fix“ je downgrade exceljs na 3.4.0 (major), neodporúčame. Prípadne `overrides` `uuid@^11` po overení exportov. |
| @capacitor/cli → xcode → uuid | 8.5.x | uuid (moderate) | dev (iOS tooling, Esblu iOS nemá) | Nie | Neriešiť. Navrhovaný „fix“ je downgrade CLI. |

## 6. Nesúvisiace nálezy (iba nahlásené)

- `lib/supabase-admin.ts` bez `import "server-only"`.
- `ESLint` pred-existujúce chyby v `app/faktury/page.tsx` a `InvoiceDetailView.tsx` (`react-hooks/immutability`), rovnaké aj na `main`.
- Zoznam subprocesorov neobsahuje Firebase / FCM (push notifikácie): mimo E-Faktúry, na posúdenie CLIA.
