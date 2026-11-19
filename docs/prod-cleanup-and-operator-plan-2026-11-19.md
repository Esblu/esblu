# Produkčné vyčistenie účtov + interný tarif prevádzkovateľa (2026-11-19)

Stav: **READ-ONLY audit hotový, v produkcii sa nič nezmenilo.** Vyčistenie aj nasadenie čakajú na výslovné schválenie.
Cieľ: Supabase `assetpilot` (`fkpgvgvsmbpieduoatrt`). Produkcia = `origin/main`.

**Posledná produkčná migrácia (read-only `supabase_migrations.schema_migrations`, 108 záznamov):** verzia `20261117213219`, názov `open_public_registration` = repo súbor `20261117100000_open_public_registration.sql`. Obe hodnoty sú správne: produkcia ukladá **čas aplikovania** (MCP `apply_migration`) ako verziu a názov súboru do `name` (rovnako všetky migrácie od 2026-10-04). Dôsledok: **nepoužívať `supabase db push`** (verzie nesedia s názvami súborov → pokúsil by sa aplikovať históriu znova); nasadzovať rovnako ako doteraz cez `apply_migration` s názvom = názov súboru, po jednej, v poradí z tabuľky nižšie. Stripe migrácie (20261118120000+) v produkcii nie sú (tabuľka `billing_live_purchase_allowlist` neexistuje).

## 0. Migračné závislosti

| Poradie | Migrácia | Vetva | V produkcii |
|---|---|---|---|
| … | `20261117100000_open_public_registration` | origin/main | áno |
| 1 | `20261118120000_billing_single_open_checkout` | `android-release-payments-ios-2026-11-18` (fb349db) | nie |
| 2 | `20261118130000_billing_terminal_precedence` | 〃 | nie |
| 3 | `20261118140000_billing_refund_audit` | 〃 | nie |
| 4 | `20261119100000_billing_post_period_protection` | 〃 | nie |
| 5 | `20261119110000_billing_scheduled_end` | 〃 | nie |
| 6 | `20261119120000_billing_event_catchup` | 〃 | nie |
| 7 | `20261119130000_billing_live_mode` | 〃 | nie |
| 8 | `20261119140000_billing_live_purchase_allowlist` | 〃 | nie |
| 9 | **`20261120100000_internal_operator_entitlement`** | `feat/internal-operator-plan` (z fb349db) | nie |

- Pôvodné ID `20261119100000` kolidovalo s `billing_post_period_protection` → zmenené na `20261120100000` (jedinečné vo všetkých lokálnych vetvách a worktree; žiadna iná vetva nemá migrácie po 20261117 okrem Stripe vetvy).
- Interný tarif sa nasadzuje **až po** Stripe migráciách (nie out-of-order).
- Kompatibilita: Stripe funkcie (`esblu_billing_sync_entitlements` v S12–S15b, `esblu_get_my_subscription`) menia/čítajú iba `source = 'subscription'`; interný tarif používa `source = 'manual'` so značkou `external_ref = internal_operator_grant:<id>` → navzájom sa neovplyvňujú. Live allowlist / sales pause sa nemení.

## 1. Inventár

### Používatelia (auth.users = 9)

| Stav | UUID | E-mail | Väzba | Identity / relácie / aktívne RT |
|---|---|---|---|---|
| **ZACHOVAŤ** | `e5677bf3-bc32-4d0d-8fdb-9fb36ae741e9` | info+playreview@esblu.com | owner `Esblu Demo s.r.o.` | 1 / 0 / 0 |
| **ZACHOVAŤ** | `53b6ed5c-a7d9-4b5b-82bb-2bad9223b515` | gdpresblu@zoznam.sk | owner `Moja firma` 8b20e5d7 | 1 / 0 / 0 |
| **ZACHOVAŤ** | `d3cc3714-5eea-43f4-a959-7a440f80dc2b` | zamestnanecesblu@zoznam.sk | employee `Moja firma` 8b20e5d7 | 1 / 1 / 1 |
| odstrániť | `9932bb02-926f-47d2-9490-7c8fd827e32a` | r***s@gmail.com (pôvodný účet prevádzkovateľa, „U-9932“) | owner Anchar Bau + Esblu s.r.o. | 2 / 1 / 1 |
| odstrániť | `ee712af5-b1ee-44db-950f-6840d0de2573` | s***r@gmail.com (tester „U-ee71“) | owner dc7552d3 | 1 / 4 / 4 |
| odstrániť | `e61c3329-5912-4a4f-9b9b-7774cb3a7f5b` | j***9@zoznam.sk (tester „U-e61c“) | employee Anchar Bau | 1 / 0 / 0 |
| odstrániť | `cdfec270-cb1d-4539-a117-b3d4a02458c3` | k***6@gmail.com (tester „U-cdfe“) | owner 88418366 | 1 / 1 / 1 |
| odstrániť | `bcdf1634-2af9-4cff-947e-f7ea6fc040b4` | esblu.office@gmail.com | owner 83bf5d52 | 1 / 0 / 0 |
| odstrániť | `46f33b5b-28b9-4a8c-9b1a-e8d606ab5731` | e***1@gmail.com (testovací účet „U-46f3“) | bez firmy | 1 / 0 / 0 |

E-maily testerov sú v repozitári zámerne maskované (GDPR — minimalizácia); presné hodnoty určuje UUID.

### Firmy (7 → 2)

| Stav | ID | Názov | Vlastník |
|---|---|---|---|
| **ZACHOVAŤ** | `8b20e5d7-48e7-45a4-9016-ef25e83ae959` | Moja firma | gdpresblu (+ zamestnanecesblu) |
| **ZACHOVAŤ** | `38f5f85a-1cfd-43df-8b74-c87d49f4782e` | Esblu Demo s.r.o. | playreview |
| odstrániť | `e520286d-e135-4d19-97be-b622bd9f06fb` | Anchar Bau | U-9932 |
| odstrániť | `110376c3-807c-4de7-8b91-c28a7edddb30` | Esblu s.r.o. (SK:57815941) | U-9932 |
| odstrániť | `dc7552d3-3268-463b-b796-eda0b117e065` | Moja firma | U-ee71 |
| odstrániť | `88418366-aad2-41e3-bf8f-8639c36d801b` | Moja firma | U-cdfe |
| odstrániť | `83bf5d52-0a59-4f2b-bc09-4510f4938752` | Moja firma | esblu.office |

Krížové väzby chránené ↔ odstraňované = **0** (členstvá, aktívna firma, chat, notifikácie, documents, review log, partneri, DPA, billing profil, pozvánky, foto).
Storage: 21 objektov → zachovať 9, odstrániť 12 (7 odkazovaných + 5 osirelých pod prefixami `9932bb02…`, `e61c3329…`).

## 2. Testovacie faktúry Anchar Bau — podklady a rozhodnutie

**Rozhodnutie prevádzkovateľa (2026-11-19):** FA20260001 a TEST-2026-002 sú výlučne testovacie záznamy z vývoja; nepredstavujú skutočné obchodné transakcie ani účtovné doklady → odstrániť s ostatnými dátami Anchar Bau.

| | FA20260001 | TEST-2026-002 |
|---|---|---|
| ID | `ba8f284f-553f-46f0-8af7-a023481fe238` | `939c0463-c31c-4aa4-a74f-39f2c1d38fc4` |
| Smer / zdroj | vystavená / ručne | prijatá / AI inbox (sken `58f1d765…`) |
| Dátum vystavenia | 2026-09-16 | 2026-09-20 |
| Dodávateľ | „Esblu s.r.o“ — **bez IČO, DIČ, adresy** | „Test Supplier Alpha s.r.o.“, Testovacia 123, 010 01 Testovo, IČO 12345678, IČ DPH SK2026123456 |
| Odberateľ | „Tester1“, IČO 4678922778 (10 číslic — neplatné SK IČO) | „Esblu s.r.o“ bez identifikátorov |
| Položka | „Kopanie“, 1 deň × 300 € + 23 % DPH = 369 € | „Testovacia sluzba A“, 1 ks × 100 € + 23 % = 123 € |
| Stav | finalized, „paid“ (platby 100 € + 269 €, jedna zrušená a znovu zadaná) | finalized, unpaid |
| eFaktúra | žiadna | žiadna |
| Export | v 3 accounting-handoff exportoch (23. 9. 2026, ZIP `esblu-accounting-handoff-2026-09-23-1956.zip`) | tiež |

Znaky testu: fiktívne identifikátory, chýbajúce povinné náležitosti dodávateľa (§ 74 zákona o DPH), testovacie názvy, rýchle opakované testovanie platieb.

**Účtovné exporty z 23. 9. 2026 — označené ako TESTOVACIE (rozhodnutie prevádzkovateľa 2026-11-19):**

| Export | Druh | Vytvoril | Faktúry |
|---|---|---|---|
| `07ea8a22-996b-45d0-9bfc-5eb5abd032cc` (12:11) | metadata_xlsx | U-9932 (owner) | 3 položky |
| `91633ab8-c3b2-4f65-90d9-2b37a2620c2a` (19:56) | complete_package `esblu-accounting-handoff-2026-09-23-1956.zip`, SHA-256 `7c7ff7d6…4d32` | U-9932 | 2 |
| `2509cd06-d7c5-49e4-8b62-41c7442b49d6` (19:59) | metadata_xlsx | U-9932 | 2 |

Overenie odovzdania v Esblu: firma nemá rolu účtovník (iba owner + employee); všetkých 12 `document_download_events` (24. 9. 2026) stiahol iba owner. **V Esblu teda nič neprevzal žiadny účtovník.** Či bol súbor odovzdaný mimo aplikácie (e-mail, USB), DB nevie preukázať — prevádzkovateľ potvrdí písomne v zázname o vyčistení. Exporty sa v DB neupravujú (tabuľka je nemenná); označenie „testovací“ = tento záznam + `company_terminations.export_mode = 'waived'`. Exporty zaniknú s firmou.

### Auditovateľný postup (bez obchádzania ochrán)

Ochrany: `esblu_invoices_immutability_delete_guard`, `esblu_invoice_items_immutability_guard`, `esblu_invoice_events_append_only`, `esblu_company_deletion_retention_blocker`. **Nič z toho sa nevypína ani neupravuje.**
Použije sa existujúci workflow `esblu_company_termination_commit(p_user_id, p_company_id, p_delete_account, p_export_mode)` (migrácia 20261112110000, VOP 20.6 / DPA):

- v JEDNEJ transakcii založí auditný záznam `company_terminations` (status executing → completed, `export_mode = 'waived'`, agregované počty, bez obsahu, retencia 5 rokov),
- ochranné triggery povolia DELETE **iba** počas tejto transakcie (GUC + necommitnutý riadok — zvonka sa nedá odomknúť), INSERT/UPDATE finalizovaných dokladov ostáva zakázaný,
- zmaže e-faktúry/doklady v poradí FK, potom `esblu_account_deletion_commit('owner', …)` (firma, Storage ciele, cleanup job),
- chyba = rollback celku; opakované volanie = `already_completed`.

Doplnkový audit mimo DB: toto rozhodnutie + šifrovaný dump pred vyčistením (kap. 3).

## 3. Záloha a obnova (pred akoukoľvek zmenou)

1. Overiť denné zálohy / PITR (Dashboard → Database → Backups), zapísať posledný bod obnovy.
2. `supabase db dump --linked -f esblu-prod-schema.sql`; `supabase db dump --linked --data-only --schema public,auth,storage -f esblu-prod-data.sql` — mimo repo, šifrovane, retencia 30 dní.
3. Stiahnuť 21 Storage objektov + manifest SHA-256.
4. Uložiť výstup inventárových dotazov (počty).
5. Obnova: PITR do nového projektu + selektívny prenos, alebo `psql` z dumpu pre konkrétne tabuľky + reupload objektov.

## 4. Poradie vyčistenia (po schválení)

0. Freeze: 0 aktívnych checkoutov / predplatných / e-faktúr (overené 0), časová pečiatka.
1. Zneplatnenie prístupu 6 účtov: `ban_duration` (Admin API) + zmazanie ich `auth.sessions` → refresh tokeny neplatné; počkať max. životnosť JWT (1 h). Chránené účty sa nedotknú.
2. Firmy cez `esblu_company_termination_commit` (service_role / postgres), každá samostatne, `export_mode = 'waived'`:
   1. `83bf5d52` (esblu.office, delete_account = true)
   2. `88418366` (U-cdfe, true)
   3. `dc7552d3` (U-ee71, true)
   4. `110376c3` Esblu s.r.o. (U-9932, **false**)
   5. `e520286d` Anchar Bau s testovacími faktúrami (U-9932, true)
3. `esblu_account_deletion_commit('global', …, true)` pre U-e61c (po kroku 2.5 už bez členstva) a U-46f3.
4. Cron `/api/cron/account-deletion-cleanup` dokončí Storage ciele a `auth.admin.deleteUser` (kaskáda identities, sessions, refresh_tokens, mfa). 5 osirelých objektov zmazať cez Storage API.
5. `beta_allowlist`: zmazať 3 riadky testerov (`j***9@centrum.sk`, `e***u@gmail.com`, `k***6@gmail.com`; ponechať gdpresblu a playreview).
5a. `public.settings` (legacy per-user, **bez FK** na auth.users — account deletion ich nemaže): 6 riadkov odstraňovaných používateľov + 9 už dnes osirelých riadkov (užívatelia zmazaní skôr) → `delete from public.settings s where not exists (select 1 from auth.users u where u.id = s.user_id)` až PO výmaze Auth (zostanú 3 riadky chránených účtov). Neblokuje novú registráciu (nový UUID; trigger `esblu_create_settings_after_auth_user_insert` založí nový riadok).
6. Po každom kroku kontrola počtov; pri odchýlke stop.

Ponechať: `trial_claims` (anti-abuse; nová Esblu s. r. o. nedostane trial), `legal_acceptance_evidence` (archív súhlasov), `company_terminations`, `account_deletion_cleanup_jobs`, `esblu_intake_attestations_used`, systémové tabuľky.

## 5. Kontrolný zoznam po vyčistení

- auth.users = 3 (presné UUID), identities = 3, companies = 2, company_members = 3, invoices = 0, settings = 3.
- 0 osirelých riadkov pre každú FK do `auth.users` a `companies`; `company_terminations` = 5 × completed.
- storage.objects = 9; cleanup joby `done`.
- `company_legal_identities` pre `SK:57815941` = 0.
- Smoke test troch účtov na https://www.esblu.com (prihlásenie, dashboard, moduly, foto, AI, Play review demo).
- `get_advisors` bez nových nálezov.

## 6. Nová registrácia prevádzkovateľa

1. Overiť, že `esblu.office@gmail.com` v auth.users neexistuje (identita google sa zmaže s používateľom).
2. Registrácia na https://www.esblu.com, potvrdenie e-mailu, prijatie VOP/GDPR.
3. Firma **Esblu s. r. o.**, IČO 57815941 → overenie RPO (`verified`). Trial sa neudelí (`trial_claims` má `entity:` claim tohto subjektu → `esblu_try_claim_company_trial` vráti `not_eligible_previous_trial`, bez chyby, firma sa vytvorí) — očakávané. **Interný grant trial vôbec nekontroluje** (ani `trial_claims`, ani `trial_*` stĺpce) → vyčerpaný trial ho neblokuje.
   Registrácia: `registration_policy.mode = open`, jediný trigger na `auth.users` iba zakladá `settings`; žiadna „tombstone“ kontrola e-mailu (archív `legal_acceptance_evidence` s user_email registráciu neblokuje).
4. Operátor overí v Supabase: UUID používateľa, ID firmy, vlastníka, jedinečnosť subjektu.
5. Nasadenie (osobitný súhlas): zelené testy + commit → merge Stripe vetvy a `feat/internal-operator-plan` do `main` → push → Vercel READY pre presné SHA → migrácie cez `apply_migration` po jednej v poradí z kap. 0 (Stripe 1–8, potom 9), po každej `get_advisors` + kontrola `schema_migrations`. Až potom v SQL editore:

   ```sql
   select public.esblu_operator_grant_internal_plan(
     '<company_id>'::uuid, '<owner_user_id>'::uuid, 'SK:57815941', 'OPS-2026-11-xx interny tarif prevadzkovatela');
   ```
6. Overenie modulov, limitov (`null`), `valid_until = null`, ostatných firiem bez zmeny.

## 7. Interný tarif

- `internal_operator_grants` (audit, RLS, Data API iba SELECT pre service_role).
- `esblu_operator_grant_internal_plan` / `esblu_operator_revoke_internal_plan`: execute odobratý PUBLIC, anon, authenticated, service_role; odmietne aj JWT kontext. Overuje vlastníka, owner členstvo, potvrdený e-mail, registrovo overenú identitu (nie `manual`), zhodu a **jedinečnosť** subjektu; najviac 1 aktívny grant v DB.
- Všetky moduly bez limitu a vypršania; nový modul v katalógu sa pridelí automaticky; značku nevie sfalšovať nikto.
- Bez zmeny: trial, Free/Paid, RLS, roly, `ai_scan_limits`, eFaktúra brány, Stripe live allowlist. Poplatky eFaktura.sk znáša Esblu.
- Otvorené: hlasové minúty nemajú DB nákladový strop — odporúčaný aplikačný rate limit.

## 8. Validácia (lokálne, Windows, 2026-11-19)

| Kontrola | Výsledok |
|---|---|
| `test:internal-operator-db` | 15/15 PASS |
| `test:grants-guard` | 10/10 PASS |
| `test:grants-replay-db` (vrátane rollback → re-apply) | 43/43 PASS |
| `test:pricing-entitlements-db` | 35/35 PASS |
| `npx tsc --noEmit` | PASS |
| `npm run lint` | 36 errors / 30 warnings — **všetky mimo súborov tejto zmeny** (pozri technický dlh) |

### Technický dlh — ESLint (samostatná úloha, nie súčasť tejto zmeny)

- Východisko `fb349db` (Stripe S15b). Táto vetva mení oproti nemu iba 6 súborov (migrácia, rollback, pglite test, `package.json`, grants manifest, tento dokument); `eslint.config.mjs` ani žiadny súbor aplikácie sa nemenil → 36 chýb a 30 varovaní je v súboroch bajtovo zhodných s `fb349db`, teda existovali už predtým.
- Jediný lintovaný súbor zmeny (`scripts/internal-operator-entitlement-pglite-tests.ts`; `scripts/` nie je v ignore) sa vo výstupe celého `npm run lint` nevyskytuje → 0 nových chýb. SQL, JSON a MD ESLint nespracúva.
- Odporúčanie: samostatná vetva `chore/eslint-baseline`, opraviť chyby po moduloch (stránky aplikácie), CI krok `npm run lint` až po vyčistení; dovtedy pri každej zmene porovnávať počet chýb s baseline 36 / 30.
