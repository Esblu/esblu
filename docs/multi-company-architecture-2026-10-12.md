# Esblu multi-company / workspace model (2026-10-12)

Branch `preprod-release-candidate`. Migrácie `20261012140000_multi_company_workspaces.sql` a
`20261012150000_session_company_context_and_legal_entity_trial.sql` (+ rollbacky) sú **pripravené, nikde
neaplikované** (produkcia, staging = bez zmeny). Overené iba v PGlite.

**Hardening pred stagingom (20261012150000) — finálne rozhodnutia:**
1. billing = **iba owner** (R), 2. trial = **právny subjekt** (krajina + IČO), nie workspace (S–U),
3. aktívna firma = **per zariadenie / auth session**, nie globálne na používateľa (V–W).
Sekcie E, F, G a Q nižšie sú aktualizované; 20261012140000 sa spätne nemenila.

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
- `user_active_company (user_id PK, company_id)` z 20261012140000 — **od 20261012150000 sa nepoužíva** na rozlíšenie
  (globálna voľba = DEPRECATED, ostáva iba kvôli rollbacku). Nová `session_active_company (session_id PK, user_id, company_id)`.

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

## E. Aktívna firma (per session — 20261012150000)

`esblu_my_active_company_id()`:
1. kontext **tejto auth session** (`session_active_company` pre `session_id` z JWT), **iba ak** v danej firme
   používateľ stále má aktívne členstvo;
2. inak jediné aktívne členstvo;
3. inak `NULL` (2+ firiem bez platného kontextu → appka ukáže výber). **Nikdy `LIMIT 1`, nikdy globálna voľba.**

Server (service role): `esblu_active_membership_for_user(user_id, session_id)` — route berie `session_id` z overeného
Bearer tokenu (`lib/request-session.ts`, `sub` musí sedieť s overeným používateľom). 1-arg verzia = bez session
(iba jediné členstvo). Klient: `esblu_my_active_membership()` / `lib/active-membership.ts`.
Kontext je **preferencia**, nie autorizácia: každý request znova overí členstvo (revoke / odchod / zrušená firma → okamžite neplatný).
Zariadenie si pamätá poslednú voľbu (`lib/company-preference.ts`, localStorage per používateľ, try/catch) iba ako
**návrh** pre ďalšie prihlásenie — pošle ho serveru cez `esblu_set_my_active_company`, ktorý ho overí; neplatný → výber firmy.

Všetkých 28 funkcií „môjho členstva" dostalo filter `and <alias>.company_id = public.esblu_my_active_company_id()`
(pôvodné telá z produkcie / repa, overené md5 zhodou s produkciou; jediná zmena = tento filter). Ručne upravené:
pozvánka, bootstrap, priama chat konverzácia, logo v Storage, zrušenie.

## F. Prepínanie

`esblu_set_my_active_company(company_id)` — iba vlastné aktívne členstvo (`ESBLU_NOT_A_MEMBER`), zapíše **iba
kontext aktuálnej session** (bez `session_id` → `ESBLU_SESSION_REQUIRED`; cudzia session → `ESBLU_SESSION_MISMATCH`). Klient
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
**Trial:** od 20261012150000 nová firma trial **automaticky nedostane** — trial patrí právnemu subjektu (S–U).
Formulár má voliteľné IČO a text „Trial aktivujeme po overení firemných údajov."

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
| cudzie `company_id` do `set_my_active_company` | `ESBLU_NOT_A_MEMBER` | priamy zápis do `user_active_company` / `session_active_company` zamietnutý | — | — |
| ten istý používateľ, zariadenie A v firme X, zariadenie B v firme Y (súčasne) | A iba X, B iba Y | podľa session | podľa session | podľa session |

Overené tabuľky: vehicles, documents, invoices, einvoice (mock), chat (prístupová funkcia + priama konverzácia),
dokumenty / súbory (`esblu_can_read_document`), AI kvóta, nároky, billing.

## O. Migrácie

- `20261012140000_multi_company_workspaces.sql` — forward-only, idempotentná, aditívna (nič sa nemaže), backfill
  `user_active_company` z existujúcich členstiev.
- Rollback `20261012140000_multi_company_workspaces_rollback.sql` — obnoví pôvodné definície (z produkcie / repa),
  **zablokovaný** (`ESBLU_MULTI_COMPANY_ROLLBACK_BLOCKED`), ak má niekto 2+ aktívne členstvá.
- `20261012150000_session_company_context_and_legal_entity_trial.sql` — forward-only, idempotentná, nič nemaže;
  existujúce firmy `trial_policy = 'legacy'` (trial bez zmeny), backfill `trial_claims`.
- Rollback `20261012150000_…_rollback.sql` — vráti 140000 definície (globálna voľba) a pôvodný trial guard; poslednú
  voľbu každého používateľa prenesie do `user_active_company`; `trial_claims` / `company_legal_identities` **ponechá**
  (zmazanie histórie by umožnilo opakovaný trial). Poradie rollbacku: 150000 → 140000 → 130000 → 120000.
- Test-only: `scripts/sql/multi-company-local-stubs.sql` (ON DELETE zrkadlí produkciu; `auth.sessions`, `ico`, `country_code`).

## P. Rollout (nič nevykonané)

1. local / PGlite PASS ✅
2. staging migrácia (billing + `20261012120000` + `20261012130000` + `20261012140000` + `20261012150000`)
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

1. ~~Trial na každú novú firmu~~ — **vyriešené** (20261012150000): trial per právny subjekt (S–U).
2. ~~Billing authority admin+billing.manage~~ — **finálne rozhodnutie: iba owner** (R).
3. **GDPR/CLIA:** zrušenie loginu autora faktúr / DPA (K); zobrazovanie mena bývalého člena v histórii (dnes `SET NULL` → „neznámy autor").
4. **Push deep link z inej firmy:** payload nesie iba obrazovku + ID (bez firmy) → klik na notifikáciu firmy A v kontexte B otvorí cieľ, ktorý RLS nevráti (bezpečné, „nenájdené"). Automatické prepnutie do A po overení členstva = follow-up (payload + `public/sw.js`).
5. ~~Viac zariadení~~ — **vyriešené** (20261012150000): kontext per auth session (V–W).
8. **Trial história (GDPR/CLIA REVIEW REQUIRED):** `trial_claims` uchováva `sha256(krajina:IČO)` / `sha256(user_id)`
   aj po zrušení firmy / loginu (ochrana proti opakovanému trialu). Retencia a právny základ (oprávnený záujem) — CLIA.
   `company_legal_identities` (IČO v čitateľnej podobe) sa maže so zrušením firmy (FK cascade).
9. **Registrácia nového loginu = nový provizórny trial** (1× na login): proti zneužitiu cez nové e-maily chráni beta
   allowlist; pred verejným spustením zvážiť povinné IČO pri onboardingu (biznis rozhodnutie).
10. **Nová firma bez IČO nemá trial ani nároky** (iba manuálne granty / predplatné) — UX: „Trial aktivujeme po overení
   firemných údajov"; overenie IČO je aj v `/firmy/nova`. Overenie IČO pre existujúcu firmu v Nastaveniach = follow-up.
6. Ostatné PGlite sady (`m1-authz`, `push`, `storage-media`, `google-oauth`, …) bežia bez multi-company migrácie; multi-company izoláciu pokrýva `multi-company-pglite` + billing regres.
7. Texty zrušenia / odchodu (SK/EN/DE) — **LEGAL/CLIA REVIEW REQUIRED**.

## R. Billing authority — finálne rozhodnutie: iba owner

`esblu_billing_my_access.can_manage = (rola v aktívnej firme TEJTO session = 'owner')`. Checkout, zmena plánu,
cancel/resume, portál, account token (Apple/Google), payer = **iba owner**. `admin` (aj s `billing.manage`),
`accountant`, `employee` → `ESBLU_BILLING_FORBIDDEN` / 403. Serverová autorita: DB (`esblu_billing_authorize_manage`,
`esblu_billing_create_checkout_intent`, `esblu_billing_issue_account_token`) — UI iba zobrazuje. Audit: pole
`permissions.billing.manage` sa už nevyhodnocuje nikde v DB ani v app (contract test). Account preflight/delete
posielajú `memberCanManageBilling: false`. Prepnutie firmy na inom zariadení **neprenáša** owner práva
(PGlite `cross-device-owner-billing`).

## S. Trial — právny subjekt

- Subjekt = `krajina + normalizované registračné číslo` (SK/CZ IČO → 8 číslic, medzery preč, doplnené nulami).
  **Nie** názov, owner ani počet workspace-ov. Rovnaké číslo v inej krajine = iný subjekt.
- Identita sa **nevymýšľa**: `POST /api/company/legal-identity { ico }` — owner aktívnej firmy, server overí IČO v RPO
  (zdroj `rpo` VERIFIED, stav `active`), až potom service role zapíše `verification_status = 'verified'`.
  Register nedostupný → 503 a trial ostáva `pending_legal_identity`. Overená identita sa nedá zmeniť na inú
  (`ESBLU_LEGAL_IDENTITY_LOCKED`) — premenovanie firmy subjekt nemení.
- Stavy (`esblu_my_company_trial_eligibility`): `eligible`, `not_eligible_previous_trial`, `pending_legal_identity`,
  `manual_override`, `trial_active`, `trial_used`, `legacy_no_trial`.

## T. Trial claim — perzistencia

`trial_claims (claim_key PK, claim_kind, country_code, first_company_id, source, trial_*)`:
- `entity:sha256(SK:12345678)` — subjekt; `user:sha256(user_id)` — provizórny trial prvej firmy; `override:…` — operátor.
- **Bez FK na `companies`** → zrušenie / znovuvytvorenie workspace-u históriu nemaže. IČO sa v claime neukladá čitateľne.
- Súbeh: advisory lock na kľúč + PK → max 1 claim na subjekt (PGlite test serializuje volania; v Postgrese lock).
- Trigger `esblu_companies_trial_guard`: INSERT trial **nikdy** nenastaví; trial udelí iba serverová funkcia (GUC
  `esblu.trial_grant` v tej istej transakcii, NULL → `now()` / `+14 dní`, raz); reset / posun / zmena `trial_policy` = chyba.
- Provizórny model: prvá firma po registrácii (`esblu_ensure_my_owner_company`) dostane trial, ak login ešte žiadny
  nemal; neskôr overené IČO ho priradí subjektu (`provisional_upgrade`) → iný workspace toho subjektu trial nedostane.
- Backfill: firmy s trialom → claim subjektu (IČO v billing profile) alebo provizórny claim ownera; firmy bez trialu
  s IČO → `legacy` claim. **Žiadny reset ani predĺženie**; produkcia (read-only audit): 4 firmy, 1 s trialom, 0 s IČO.
- Manuálne granty (`company_entitlements`) a operátorská výnimka (`esblu_operator_override_company_trial`) fungujú
  nezávisle od histórie subjektu.

## U. Trial — abuse matica (PGlite)

| Scenár | Výsledok |
|---|---|
| zrušiť a znovu založiť firmu s tým istým IČO | `not_eligible_previous_trial` |
| ten istý owner, dva rôzne subjekty | každý vlastný trial |
| iný owner, ten istý subjekt | `not_eligible_previous_trial` |
| rovnaký názov, iné IČO | samostatné subjekty (trial) |
| premenovaná firma, rovnaké IČO | ten istý subjekt; zmena overeného IČO = `LOCKED` |
| neoverené IČO | `pending_legal_identity`, bez trialu |
| manuálny grant / override | funguje, nemení históriu |
| aktívny trial | opakovaný claim / override = `already_has_trial`; priamy UPDATE = `ESBLU_TRIAL_IMMUTABLE` |
| klient volá claim / record / override / číta `trial_claims` | `permission denied` |
| dva workspace-y, rovnaký nový subjekt naraz | práve 1 `granted` |

## V. Aktívna firma per zariadenie — model

- Kľúč = `session_id` z access tokenu (Supabase ho vydáva do každého JWT; refresh ho zachová; nové prihlásenie = nová
  session). Podpísaný token → klient ho nepodvrhne; navyše `set` overí `auth.sessions.user_id = auth.uid()`.
- Odhlásenie / zrušená session → riadok zaniká (FK `auth.sessions` on delete cascade). Zrušená firma → cascade.
- Fallback pri štarte: 0 firiem → onboarding, 1 → automaticky, 2+ → posledná voľba zariadenia (server overí) → inak výber.
- REST/RPC, Storage, Realtime aj push binding čítajú JWT claims → všetko je request-scoped bez ďalšieho kódu.

## W. Request-scoped autorizácia a cross-device izolácia

Autorizácia = členstvo (RLS + SECURITY DEFINER) v firme, ktorú rieši **daný request** (jeho session). Žiadny zápis
jednej session nemení inú: PGlite `cross-device-isolation` (súbežné prepínanie opačným smerom),
`cross-device-owner-billing`, `cross-device-voice-chat-files-einvoice` (nároky, AI kvóta, hlasový záznam, chat,
dokumenty, eFaktúra), `session-stale-revoked-logout-deleted` (revoke, obnovenie, odhlásenie, nové prihlásenie,
starý token bez `session_id`, podvrhnutá session, zrušená firma, 0 firiem).
