# Zrušenie účtu × aktívne predplatné — audit a kanonické pravidlo (2026-10-12)

Branch `preprod-release-candidate`. Nič nenasadené do produkcie, žiadna produkčná migrácia, žiadne volanie
Stripe/Google/Apple API (ani test, ani live), žiadne zmeny CLIA/legal textov.

## 1. Audit pôvodného flow

| Vrstva | Stav pred zmenou |
|---|---|
| UI | Nastavenia → Zrušiť účet → modal načíta `GET /api/account/preflight` (rola, počet členov, archivačný blocker) → owner potvrdí frázou `ZRUŠIŤ FIRMU` → `POST /api/account/delete` |
| Precheck (owner) | prihlásenie → aktívne členstvo (zo servera, nie z klienta) → fráza → `findOwnerDeletionBlocker` (finalizované faktúry → 409) → `companies.owner_id` (RC) |
| Súbory | `collectOwnerStorageTargets` (cesty z DB riadkov) → `removeStorageTargets` — **pred** DB |
| Firma (DB) | `esblu_owner_delete_company` (SECURITY DEFINER, 1 transakcia): explicitne biznis tabuľky → `delete from companies` → **FK `ON DELETE CASCADE`** zmaže `subscription_accounts`, `billing_provider_links`, `billing_checkout_sessions`, `billing_reconciliation`, `company_entitlements`; `billing_events` a `billing_store_reports` ostanú s `company_id = null` |
| Používateľ | `auth.admin.deleteUser` ako posledný krok + post-verifikácia; klient sa odhlási (aj pri `partial`) |
| Člen (admin/employee/accountant) | vlastné súbory → `esblu_member_delete_self` → `deleteUser`; firma a jej predplatné ostávajú |
| Orphan | owner_id kontrola → `deleteUser` |
| Prevod vlastníctva | neexistuje (owner zruší celú firmu) |
| RLS | `authenticated` nemá priamy prístup k billing tabuľkám; mazanie iba service_role cez route/RPC |
| Background jobs | `billing-reconcile` a `billing-store-reports` čítajú iba existujúce riadky; po zmazaní firmy provider eventy skončia ako `UNKNOWN_COMPANY` |

**Kde vznikala medzera:** owner flow nikde nečítal stav predplatného. Pri aktívnom/obnovujúcom sa predplatnom
(alebo otvorenom checkoute) kaskáda zmazala `subscription_accounts` aj `billing_provider_links` →
Esblu účet zmazaný + provider ďalej účtuje + Esblu stratilo väzbu (customer/subscription/purchase token).
Druhý prípad: člen, ktorý predplatné kúpil cez **svoj** Apple ID / Google účet, zrušil účet → obchod
ďalej účtuje jemu, hoci už nie je v Esblu.

## 2. Kanonické pravidlo (fail closed)

Implementácia: `lib/billing/deletion-guard.ts` (čistá funkcia) + DB zrkadlo `public.esblu_billing_blocks_account_deletion`
(parita testovaná nad všetkými stavmi × providermi × `cancel_at_period_end`).

| Stav (`subscription_accounts`) | Owner (zrušenie firmy) | Dôvod |
|---|---|---|
| žiadny riadok / `none` | povolené (`none` / `trial`) | nič sa neúčtuje |
| provider `manual` (manuálny grant) | povolené (`manual`) | nie je externé účtovanie |
| `canceled`, `expired`, `refunded`, `revoked` | povolené (`ended`) | vzťah ukončený |
| `active` / `trialing` + `cancel_at_period_end` | **povolené aj pred `current_period_end`** (`active_non_renewing`); ak obdobie ešte beží → `forfeits_remaining_period` = výslovné upozornenie + serverom vyžadované potvrdenie `acknowledgeForfeit` | provider už neúčtuje; používateľ vedome stratí zvyšok obdobia, žiadny automatický refund |
| `active` / `trialing` bez zrušenia obnovy | **BLOKOVANÉ** `ACTIVE_SUBSCRIPTION_RENEWING` | budúca platba; `trialing` = trial providera, ktorý prejde na platbu |
| `pending`, `incomplete`, `grace_period`, `past_due`, `account_hold`, `unpaid`, `paused` | **BLOKOVANÉ** `SUBSCRIPTION_PAYMENT_IN_PROGRESS` (aj so zrušenou obnovou) | provider ešte strháva / môže obnoviť |
| otvorený checkout (`created`/`open`, neexpirovaný) | **BLOKOVANÉ** `CHECKOUT_IN_PROGRESS` | platba by prebehla po zmazaní firmy |
| neznámy stav/provider, chyba čítania | **BLOKOVANÉ** `SUBSCRIPTION_STATE_UNVERIFIED` (HTTP 503) | fail closed |
| billing tabuľky v DB neexistujú (prod pred migráciou) | povolené | predplatné nemôže existovať |

Člen: firma a jej predplatné ostávajú → člen sa **neblokuje** (podrobne v časti 5c). `STORE_SUBSCRIPTION_PURCHASER`
je vyhradené iba pre OVERENÚ identitu platiteľa, ktorú dnešná architektúra nepozná; checkout heuristika bola
odstránená. Správca billingu (admin) pri firemnom Google Play / App Store predplatnom dostane upozornenie.

Esblu 14-dňový trial a free nikdy neblokujú. Esblu nikdy samo nevolá zrušenie u providera — používateľ
ukončí obnovu tam, kde predplatné vzniklo.

## 3. Inštrukcie podľa providera (UI)

Rovnaké texty ako obrazovka Predplatné (`subscription.managedVia.*`):

| Provider | Text |
|---|---|
| Stripe / web | „Predplatné spravujete cez web (www.esblu.com → Nastavenia → Predplatné)." |
| Google Play | „Predplatné spravujete cez Google Play." |
| App Store | „Predplatné spravujete cez App Store." |
| manuálne | „Predplatné spravuje podpora Esblu (info@esblu.com)." (nikdy neblokuje) |

Zablokovaný modal: dôvod (`settings.deleteModal.subscription.blocked*`), kde spravovať, „po zrušení obnovy sa
vráťte a účet zrušte", odkaz na Predplatné; **bez** potvrdzovacieho tlačidla. Nové texty (SK/EN/DE) sú UI
texty, nie CLIA dokumenty — odporúčam ich zaradiť do CLIA review.

## 4. Server precheck — kontrakt

`GET /api/account/preflight` (owner aj člen; orphan vždy povolené):

```json
{
  "role": "owner",
  "otherActiveMembersCount": 2,
  "orphan": false,
  "ownerDeletionBlocked": null,
  "can_delete": false,
  "blocking_reason": "ACTIVE_SUBSCRIPTION_RENEWING",
  "subscription_status": "active_renewing",
  "subscription": {
    "can_delete": false, "blocking_reason": "ACTIVE_SUBSCRIPTION_RENEWING",
    "subscription_status": "active_renewing", "provider": "google", "managed_via": "google_play",
    "current_period_end": "2026-11-12T00:00:00Z", "cancel_at_period_end": false,
    "forfeits_remaining_period": false, "store_subscription_notice": false
  }
}
```

`blocking_reason` na najvyššej úrovni = `FINALIZED_ACCOUNTING_DOCUMENTS` (archivácia má prednosť) alebo dôvod predplatného.

`POST /api/account/delete` overí to isté **znovu** (nikdy neverí preflightu) — owner po archivácii a `owner_id`,
**pred** zberom/mazaním súborov a pred DB; člen pred mazaním svojich súborov. Blokácia = `409` (`503` pri
neoverenom stave) s rovnakými poľami, **nič sa nezmaže**.

## 5. DB poistka (forward-only, NEaplikovaná na produkciu)

`supabase/migrations/20261012120000_account_deletion_subscription_guard.sql` (+ rollback):
`BEFORE DELETE` triggery na `subscription_accounts` a `billing_checkout_sessions` odmietnu zmazať
obnovujúce sa / platbu čakajúce predplatné alebo otvorený checkout → celá transakcia
`esblu_owner_delete_company` sa vráti (firma, členstvá, väzby na providera ostanú). Route chybu mapuje na 409.
Vedomá údržbová výnimka: `set_config('esblu.allow_subscription_delete', 'on', true)` (iba service_role, v transakcii).
Migrácia nemaže ani nemení dáta; predikát nie je volateľný klientom.

## 5b. Poradie mazania: DB NAJPRV, súbory AŽ PO COMMITE

Pôvodne route mazala Storage **pred** DB transakciou → pri odmietnutí DB (napr. poistka z časti 5 pri súbehu
s aktiváciou predplatného) firma ostala, ale bez súborov. Nový model (`lib/account-deletion-orchestrator.ts`,
migrácia `20261012130000_account_deletion_post_commit_cleanup.sql`, **neaplikovaná**):

| Krok | Čo | Pri zlyhaní |
|---|---|---|
| A | auth, archivácia, `owner_id`, predplatné, forfeit potvrdenie (route) | 4xx, nič sa nemení |
| B | `esblu_account_deletion_commit(kind, user)`: `FOR UPDATE` zámok firmy → zber Storage ciest z DB riadkov → `esblu_owner_delete_company` / `esblu_member_delete_self` → `account_deletion_cleanup_jobs` riadok (tombstone s cieľmi) | rollback celej transakcie; **Storage callback sa nezavolá** |
| C | commit | — |
| D | Storage `remove()` podľa jobu | job `storage_status = pending`, `last_error_code`, backoff; účet je zrušený |
| E | `auth.admin.deleteUser` + post-verifikácia (aj keď D zlyhal) | job `auth_status = pending`, klient dostane `partial` a odhlási sa |
| F | `GET /api/cron/account-deletion-cleanup` (CRON_SECRET, denne 03:30 UTC vo `vercel.json`) | opakuje D/E, backoff 15 min → 24 h, max 30 pokusov; idempotentné |

- Zámok riadku firmy: súbežné vloženie súboru, checkoutu alebo predplatného firmy (FK → companies) počká a po
  commite zlyhá → zoznam ciest v jobe je úplný a po zrušení nevznikne nový checkout.
- Po vyčistení sa cesty v jobe vymažú (`storage_targets = []`); ostane iba počet a stav. Job tabuľka: RLS,
  iba service_role; commit funkcia nie je volateľná klientom.
- `media_deletion_queue` (20261005090000) sa na zrušenie firmy nehodí — má `company_id … on delete cascade`,
  takže by záznamy zanikli spolu s firmou; preto samostatný job bez FK na firmu.
- Fallback, kým migrácia nie je v DB (`PGRST202`): TS zber ciest (read-only) → legacy RPC → **až potom** Storage.
  Invariant „žiadny Storage delete pred DB commitom" platí aj tu; chýba iba retry job.
- Zostáva (známe, mimo invariantu): ak zlyhá zápis stavu jobu po úspešnom vyčistení, cron ho zopakuje (idempotentné).

## 5c. Restore nákupu (Google / Apple) a identita platiteľa — audit

| Väzba | Čo identifikuje | Overené? |
|---|---|---|
| `billing_provider_links.account_token` (Apple `appAccountToken`, Google `obfuscatedAccountId`) | **firmu** — jeden token na firmu/provider/prostredie, vydaný ktorémukoľvek správcovi billingu (`esblu_billing_issue_account_token`) | áno (je v podpísanom JWS / Play nákupe) |
| `billing_provider_links` `subscription` / `customer` | provider predplatné / zákazníka **firmy** | áno |
| `billing_checkout_sessions.created_by` | kto **spustil zámer** v Esblu | nie je dôkaz platiteľa; restore (`/api/billing/mobile/confirm` bez `checkoutId`) checkout nemá |
| Apple ID / Google účet platiteľa | — | Esblu ho nemá a nemôže overiť |

Záver: architektúra **nepozná overenú osobu platiteľa**, iba overenú firmu. Preto:
- odstránená heuristika „posledný dokončený checkout = platiteľ" (nevymýšľa sa identita, nevzniká neoverená väzba),
- zrušenie **firmy** s obnovujúcim sa store predplatným je blokované (fail closed) bez ohľadu na to, kto platí,
- **člen** sa neblokuje; ak môže spravovať billing (admin), dostane upozornenie, že zrušenie Esblu účtu
  nezruší predplatné v obchode (firma ho naďalej používa a spravuje sa v obchode),
- `verifiedMemberPurchaser` ostáva v kontrakte pre budúcu overenú per-user väzbu (dnes sa nenastavuje).

Testy: restore Google aj Apple bez checkout záznamu → firma blokovaná (precheck aj DB poistka, žiadny Storage
callback, väzba `account_token` zachovaná), admin nie je blokovaný, dostane upozornenie, employee nie.

## 5d. UI texty pri zrušení pred koncom obdobia — LEGAL/CLIA REVIEW REQUIRED

Podmienka: `cancel_at_period_end = true` a `current_period_end` ešte nenastal (alebo nie je známy). Zrušenie je
povolené; modal zobrazí štyri body a tlačidlo je aktívne až po zaškrtnutí potvrdenia. Server bez
`acknowledgeForfeit: true` vráti `409 FORFEIT_ACKNOWLEDGEMENT_REQUIRED` a nič nezmaže. **Žiadny automatický refund**;
refund policy a presná právna formulácia = CLIA/legal review.

| Kľúč (`settings.deleteModal.subscription.*`) | SK | EN | DE |
|---|---|---|---|
| `forfeitTitle` | Predplatné je zrušené, ale zaplatené obdobie ešte beží | The subscription is cancelled, but the paid period is still running | Das Abonnement ist gekündigt, aber der bezahlte Zeitraum läuft noch |
| `forfeitNoRenewal` | Predplatné sa už nebude obnovovať a nebudú sa strhávať ďalšie platby. | The subscription will no longer renew and no further payments will be charged. | Das Abonnement verlängert sich nicht mehr und es werden keine weiteren Zahlungen abgebucht. |
| `forfeitAccessEnds` | Po zrušení účtu okamžite stratíte prístup k Esblu a ku všetkým jeho funkciám. | After deleting the account you immediately lose access to Esblu and all of its features. | Nach dem Löschen des Kontos verlieren Sie sofort den Zugang zu Esblu und allen Funktionen. |
| `forfeitRemaining` | Zvyšok predplateného obdobia (do {{date}}) prepadne. | The rest of the prepaid period (until {{date}}) is forfeited. | Der restliche vorausbezahlte Zeitraum (bis {{date}}) verfällt. |
| `forfeitNoRefund` | Za nevyčerpané obdobie sa automaticky nevracajú žiadne peniaze. | No money is refunded automatically for the unused period. | Für den nicht genutzten Zeitraum wird nichts automatisch erstattet. |
| `forfeitAcknowledge` (checkbox) | Rozumiem, že zrušením účtu prídem o zvyšok predplateného obdobia. | I understand that by deleting the account I lose the rest of the prepaid period. | Ich verstehe, dass ich mit dem Löschen des Kontos den restlichen vorausbezahlten Zeitraum verliere. |
| `storeNotice` (člen-admin) | Ak ste predplatné firmy kúpili cez svoj účet Google Play alebo App Store, zrušenie Esblu účtu ho nezruší — firma ho naďalej využíva a predplatné spravujete v obchode. | (EN/DE v slovníkoch) | |

LEGAL/CLIA REVIEW REQUIRED aj pre texty z časti 3 (`blocked*`, `afterCancel`) a chybové hlášky
`settings.errors.subscriptionBlocksDeletion`, `subscriptionStateUnverified`, `forfeitAcknowledgementRequired`.

## 6. Testy

- `npm run test:account-deletion-subscription` — 18 unit/kontrakt (pravidlo vrátane nezmenenej `cancel_at_period_end` politiky a forfeit, člen bez vymýšľania platiteľa, fail-closed čítanie, poradie v route, UI potvrdenie, i18n) + PGlite suite `account-deletion` (20).
- `npm run test:account-deletion-orchestration` — 12: guard / DB chyba → Storage ani auth sa nevolajú; commit → Storage → auth → job; Storage zlyhá → pending + backoff + auth aj tak; retry idempotentný; fallback bez migrácie (DB najprv); poistka vo fallbacku.
- PGlite `account-deletion`: parita TS↔DB, **aktivácia predplatného počas zrušenia → DB odmietne, Storage callback sa nezavolá, firma + súbory + auth ostanú**, otvorený checkout počas zrušenia, iná DB chyba, commit → job → Storage → auth, Storage výpadok → pending → retry → done, člen, prístupové práva, **restore Google aj Apple bez checkoutu**, idempotencia a rollback oboch migrácií.

## 7. Zostávajúce riziká / rozhodnutia

1. ~~Súbeh: súbory zmazané pri zablokovanom DB delete~~ → vyriešené (časť 5b).
2. **Neobnovujúce sa predplatné je povolené aj pred koncom obdobia** (rozhodnutie vlastníka 2026-10-12, nemenené). Texty a refund policy = **LEGAL/CLIA REVIEW REQUIRED**; žiadny automatický refund.
3. ~~Platiteľ člena z checkoutu~~ → odstránené; člen sa neblokuje, admin dostane upozornenie (časť 5c).
4. Store predplatné po zrušení firmy so zrušenou obnovou: neskoršie provider eventy skončia ako `UNKNOWN_COMPANY` (audit v `billing_events`).
5. Checkout, ktorý u providera prebehne tesne pred vlastnou expiráciou a webhook príde až po zrušení firmy: okno pokrýva `expires_at` (24 h) checkout riadku; po ňom by platba skončila ako `UNKNOWN_COMPANY` → manuálne riešenie (Stripe session expiruje rovnako po 24 h).
6. Produkcia: migrácie `20261012120000` + `20261012130000` neaplikované; kód má bezpečný fallback (DB najprv, bez retry jobu).

## 8. Rollout (iba po schválení)

1. Staging: aplikovať billing migrácie + `20261012120000` + `20261012130000` → `npm run test:account-deletion-subscription && npm run test:account-deletion-orchestration` → staging smoke (fake nákup → zrušenie zablokované → zrušiť obnovu → modal s 4 bodmi + potvrdenie → zrušenie prejde → job `done`).
2. CLIA review textov (časti 3 a 5d) + refund policy.
3. Produkcia: migrácie spolu s billing migráciami, deploy (cron `/api/cron/account-deletion-cleanup` sa aktivuje produkčným deployom; vyžaduje `CRON_SECRET`), smoke.
