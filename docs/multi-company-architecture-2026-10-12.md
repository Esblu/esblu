# Esblu multi-company / workspace model (2026-10-12)

Branch `preprod-release-candidate`. Migrácia `20261012140000_multi_company_workspaces.sql` (+ rollback) je
**pripravená, nikde neaplikovaná** (produkcia, staging = bez zmeny). Overené iba v PGlite.

## A. Kanonický model

**USER ≠ COMPANY.** Jeden človek = jeden auth login (`auth.users`). Login môže byť aktívnym členom N firiem
(`company_members`), v každej s inou rolou. Medzi firmami sa **prepína** (bez odhlásenia). Všetky firemné dáta
(faktúry, eFaktúra, partneri, dokumenty, súbory, vozidlá, stroje, sklad, chat, predplatné, nároky, nastavenia
firmy, audit) patria **firme** (`company_id`), nie používateľovi.

### Audit pôvodného stavu (read-only produkčné metadáta, žiadne riadky dát)

| Zistenie | Dopad |
|---|---|
| unikátny index `company_members_one_active_per_user_idx (user_id) where status='active'` | DB povoľovala **max 1 firmu** na používateľa |
| `esblu_my_active_company_id()` = `… where user_id = auth.uid() and status='active' limit 1` | „aktívna firma" bola implicitná (deterministická iba vďaka indexu) |
| 39 SECURITY DEFINER funkcií číta `company_members`, ~30 z nich `limit 1` bez firmy | pri 2+ členstvách by vyberali náhodnú firmu (roly, finance, nároky, kvóty, pozvánky, DPA, billing) |
| RLS politiky | takmer všetky už používajú `company_id = esblu_my_active_company_id()` → zmena centrálnej funkcie ich prepne |
| TS: 6 miest `from("company_members")…eq(user_id)…eq(status,'active').maybeSingle()` | pri 2 riadkoch chyba (lib/company, nastavenia, hlas intent/execute, zrušenie účtu) |
| `esblu_accept_company_invite` | odmietala existujúceho používateľa (`ESBLU_ALREADY_HAS_ACTIVE_MEMBERSHIP`) |
| `esblu_owner_delete_company` / `esblu_member_delete_self` | firma cez `limit 1`; mazali aj user-scoped `settings` / právne súhlasy |
| produkcia: 4 firmy, 0 bez ownera, 0 s 2+ ownermi, 0 nesúlad `owner_id`, 0 používateľov s 2+ členstvami | backfill je triviálny a bezpečný |
| FK na `auth.users`: firemné dáta `SET NULL`; `invoices.*_by`, `invoice_payments.recorded_by`, `invoice_events.actor_user_id` **NO ACTION**; `companies.owner_id`, `company_dpa_acceptances.accepted_by` **RESTRICT** | zmazanie loginu nikdy nezmaže firemné dáta, ale autor faktúr / DPA sa zmazať nedá (pozri K) |

## B. Membership model

- `company_members (company_id, user_id, role, status, permissions)` — bez zmeny stĺpcov; `unique (company_id, user_id)` ostáva.
- Odstránený index „1 aktívne členstvo na používateľa"; pridaný `company_members_user_active_idx`.
- Nová tabuľka `user_active_company (user_id PK, company_id)` = voľba aktívnej firmy (RLS: čítať iba vlastnú; zapisujú iba RPC).

## C. Role (bez zmeny modelu)

`owner`, `admin`, `accountant`, `employee` + existujúce `permissions` (finance.view/manage). Rola sa vždy vyhodnocuje
**v aktívnej firme** (`esblu_my_active_role`, `esblu_my_finance_view/manage`, `esblu_role_can_operate`,
`esblu_has_finance_*_in_company`).

## D. Owner pravidlá

- **Presne jeden aktívny owner na firmu**: unikátny index `company_members_one_owner_per_company_idx` + trigger
  `company_members_owner_guard` (posledného ownera nemožno zmeniť na inú rolu ani deaktivovať; prevod vlastníctva
  zatiaľ neexistuje — `ESBLU_COMPANY_MUST_KEEP_OWNER`).
- Owner = **billing authority**: `esblu_billing_my_access.can_manage = role = 'owner'` (aktívnej firmy).
- Iba owner zruší firmu (`esblu_account_deletion_commit('owner', …)` overí owner rolu v danej firme).
- Owner firmu neopúšťa (`ESBLU_OWNER_CANNOT_LEAVE`).
- **Konflikt so staršou politikou (explicitne zmenené, nie potichu):** predtým smel kupovať / spravovať predplatné aj
  `admin` s `permissions.billing.manage = true`. Po migrácii nie. Testy (`subscriptions-pglite`, `multi-company-pglite`)
  to overujú. Ak by sa malo vrátiť, je to jeden riadok v `esblu_billing_my_access`.

## E. Aktívna firma

`esblu_my_active_company_id()`:
1. uložená voľba (`user_active_company`), **iba ak** v nej používateľ stále má aktívne členstvo;
2. inak jediné aktívne členstvo;
3. inak `NULL` (2+ firiem bez platnej voľby → appka ukáže výber). **Nikdy `LIMIT 1`.**

Server (service role): `esblu_active_membership_for_user(user_id)` — rovnaké pravidlo + počet členstiev.
Klient: `esblu_my_active_membership()` / `lib/active-membership.ts`; server routes `lib/active-membership-server.ts`.
Voľba je **preferencia**, nie autorizácia: každý request znova overí členstvo (revoke / odchod / zrušená firma → okamžite neplatná).
Klient voľbu neukladá (žiadny localStorage).

Všetkých 28 funkcií „môjho členstva" dostalo filter `and <alias>.company_id = public.esblu_my_active_company_id()`
(pôvodné telá z produkcie / repa, overené md5 zhodou s produkciou; jediná zmena = tento filter). Ručne upravené:
pozvánka, bootstrap, priama chat konverzácia, logo v Storage, zrušenie.

## F. Prepínanie

`esblu_set_my_active_company(company_id)` — iba vlastné aktívne členstvo (`ESBLU_NOT_A_MEMBER`). Klient
(`lib/company-workspaces.ts`): RPC → reset klientskych cache (nároky, členstvo) → **plný reload** na `/`.
Dôvod: istota, že nezostane žiadny obsah, realtime listener ani cache predchádzajúcej firmy (correctness > micro-opt;
v natívnej appke je reload lokálneho bundlu rýchly). UI: `CompanySwitcher` (Nastavenia, panel „Viac" v appke) —
názov firmy + rola, zoznam firiem, „+ Pridať vlastnú firmu". Štart: 0 firiem → onboarding, 1 → automaticky,
2+ bez platnej voľby → `CompanyPicker`.

## G. Vytvorenie ďalšej firmy

`/firmy/nova` → `esblu_create_my_company(name)`: existujúca identita (žiadny e-mail / heslo / Google), owner
členstvo, `company_billing_profile`, nová firma aktívna. Ochrany: názov 2–200 znakov, duplicitný názov u toho istého
ownera, max 10 vlastných firiem (ochrana proti zneužitiu, **nie** pricing), advisory lock. Prvá firma ide naďalej
cez onboarding (`esblu_ensure_my_owner_company`: beta allowlist, čakajúce pozvánky).
**Trial:** nová firma dostane 14-dňový trial existujúcou logikou (trigger) — pozri Q (biznis rozhodnutie).

## H. Pozvánky

`esblu_accept_company_invite`: existujúci používateľ (aj owner inej firmy) dostane **ďalšie** členstvo; roly v iných
firmách sa nemenia; duplicitné členstvo v tej istej firme → `ESBLU_INVITE_ALREADY_MEMBER`; neaktívny riadok v tej
firme sa znovu aktivuje. Prvé členstvo → firma sa stane aktívnou; inak sa aktívna firma nemení a appka ponúkne
„Boli ste pridaný do X" + „Prepnúť do firmy".

## I. Vlastníctvo dát

Firemné tabuľky majú `company_id`; RLS = `company_id = esblu_my_active_company_id()` + rola. eFaktúra (referencia
`einvoice-port`) má rovnaký vzor (`einvoice_organizations`, `einvoice_inbound/outbound/events`).

## J. Odchod člena

`esblu_member_leave_company(user, company)`: zmaže **iba** prístup (členstvo, členstvo v konverzáciách firmy, voľbu
aktívnej firmy). Faktúry, dokumenty, fotky, vozidlá, stroje, sklad, partneri, chat správy a audit ostávajú firme
(FK na používateľa sú `SET NULL` / bez kaskády). Predplatné firmy odchod člena **neblokuje**. Settings a právne
súhlasy používateľa (globálne) ostávajú, kým nezruší celý login.

## K. Globálne zrušenie loginu

Tri rôzne akcie (`POST /api/account/delete`):

| Akcia | Kedy | Login |
|---|---|---|
| opustiť aktívnu firmu (`member`) | ne-owner | zruší sa iba ak to bola **posledná** firma (pôvodné „Zrušiť účet") |
| zrušiť aktívnu firmu (`owner`) | owner, archivácia + predplatné + potvrdenia | zruší sa iba ak to bola posledná firma |
| zrušiť celý login (`scope: global`) | **nevlastní žiadnu firmu** | áno; opustí všetky zostávajúce firmy |

`esblu_user_global_cleanup` fail-closed: vlastní firmu → `ESBLU_USER_OWNS_COMPANY`; je autorom uchovávaných
záznamov (faktúry, platby, udalosti faktúr, DPA súhlas — FK bez kaskády) → `ESBLU_RETAINED_RECORDS_AUTHOR`
(**GDPR/CLIA otázka**: pseudonymizácia autora vs. zákonná archivácia; dovtedy môže iba opustiť firmu).
Poradie ostáva z RC: DB commit → Storage → auth, retry job (`account_deletion_cleanup_jobs.kind` + `global`).

## L. Predplatné

Predplatné, nároky a billing mapovania patria **firme**. Pozvaný člen nič neplatí; jeho vlastná firma má vlastné
predplatné / trial. Nároky sa rozlišujú vždy pre aktívnu firmu (žiadny globálny nárok používateľa). Hardening z RC
(blokácia zrušenia firmy pri obnovujúcom sa predplatnom, otvorený checkout, `cancel_at_period_end` s potvrdením,
DB najprv, retry) zostáva; celý billing regres (60 testov) beží nad multi-company migráciou.

## M. eFaktúra readiness

Bez implementácie providera: kontraktný test s tabuľkami/RLS podľa referencie `einvoice-port` — identita
(`participant_id`) a inbox firmy A sú v kontexte B nedostupné, aj keď je používateľ členom oboch; employee bez
finance.view nevidí nič. **Integračná poznámka:** `einvoice-port` obsahuje `20261008100002_finance_helpers_bind_active_company.sql`
— rovnaký filter ako táto migrácia (kompatibilné); pri integrácii treba eFaktúra migrácie zoradiť **pred**
`20261012140000` alebo ich zosúladiť (iné `create or replace` tých istých funkcií by inak prepísali multi-company verziu).

## N. RLS — izolačná matica (PGlite, `npm run test:multi-company-db`)

| Scenár | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| člen A+B, aktívna A | iba A | do B zamietnuté | B 0 riadkov | B 0 riadkov |
| člen A+B, aktívna B | iba B | trigger priradí B | — | — |
| firma C bez členstva | nič | zamietnuté | 0 | 0 |
| revoke členstva počas session | ďalší request bez dát / fallback | — | — | — |
| cudzie `company_id` do `set_my_active_company` | `ESBLU_NOT_A_MEMBER` | priamy zápis do `user_active_company` zamietnutý | — | — |

Overené tabuľky: vehicles, documents, invoices, einvoice (mock), chat (prístupová funkcia + priama konverzácia),
dokumenty / súbory (`esblu_can_read_document`), AI kvóta, nároky, billing.

## O. Migrácie

- `20261012140000_multi_company_workspaces.sql` — forward-only, idempotentná, aditívna (nič sa nemaže), backfill
  `user_active_company` z existujúcich členstiev.
- Rollback `20261012140000_multi_company_workspaces_rollback.sql` — obnoví pôvodné definície (z produkcie / repa),
  **zablokovaný** (`ESBLU_MULTI_COMPANY_ROLLBACK_BLOCKED`), ak má niekto 2+ aktívne členstvá.
- Test-only: `scripts/sql/multi-company-local-stubs.sql` (ON DELETE zrkadlí produkciu).

## P. Rollout (nič nevykonané)

1. local / PGlite PASS ✅
2. staging migrácia (billing + `20261012120000` + `20261012130000` + `20261012140000`)
3. staging multi-company QA (QA firmy s jasným prefixom, cleanup; existujúce staging dáta nemazať)
4. eFaktúra integrácia (zoradenie migrácií, M)
5. finálny RC
6. real-device + web smoke
7. legal / CLIA (texty zrušenia, autor záznamov, trial na firmu)
8. produkčný precheck (read-only: owner invariant, 0 multi-membership)
9. záloha DB
10. explicitný súhlas
11. produkčná migrácia + deploy

## Q. Známe blokery / otvorené rozhodnutia

1. **Trial na každú novú firmu** (existujúca logika) — jeden používateľ môže zakladať firmy a dostávať trial opakovane (max 10 vlastných). Biznis rozhodnutie (napr. trial iba pre prvú firmu používateľa).
2. **Billing authority admin+billing.manage** odstránená (D) — potvrdiť.
3. **GDPR/CLIA:** zrušenie loginu autora faktúr / DPA (K); zobrazovanie mena bývalého člena v histórii (dnes `SET NULL` → „neznámy autor").
4. **Push deep link z inej firmy:** payload nesie iba obrazovku + ID (bez firmy) → klik na notifikáciu firmy A v kontexte B otvorí cieľ, ktorý RLS nevráti (bezpečné, „nenájdené"). Automatické prepnutie do A po overení členstva = follow-up (payload + `public/sw.js`).
5. **Viac zariadení:** voľba aktívnej firmy je per používateľ (server), nie per zariadenie — prepnutie na jednom zariadení sa prejaví aj na druhom po ďalšom načítaní.
6. Ostatné PGlite sady (`m1-authz`, `push`, `storage-media`, `google-oauth`, …) bežia bez multi-company migrácie; multi-company izoláciu pokrýva `multi-company-pglite` + billing regres.
7. Texty zrušenia / odchodu (SK/EN/DE) — **LEGAL/CLIA REVIEW REQUIRED**.
