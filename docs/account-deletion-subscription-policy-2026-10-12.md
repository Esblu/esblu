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
| `active` / `trialing` + `cancel_at_period_end` | **povolené** (`active_non_renewing`) + upozornenie „zostávajúce obdobie do X zanikne" | provider už neúčtuje |
| `active` / `trialing` bez zrušenia obnovy | **BLOKOVANÉ** `ACTIVE_SUBSCRIPTION_RENEWING` | budúca platba; `trialing` = trial providera, ktorý prejde na platbu |
| `pending`, `incomplete`, `grace_period`, `past_due`, `account_hold`, `unpaid`, `paused` | **BLOKOVANÉ** `SUBSCRIPTION_PAYMENT_IN_PROGRESS` (aj so zrušenou obnovou) | provider ešte strháva / môže obnoviť |
| otvorený checkout (`created`/`open`, neexpirovaný) | **BLOKOVANÉ** `CHECKOUT_IN_PROGRESS` | platba by prebehla po zmazaní firmy |
| neznámy stav/provider, chyba čítania | **BLOKOVANÉ** `SUBSCRIPTION_STATE_UNVERIFIED` (HTTP 503) | fail closed |
| billing tabuľky v DB neexistujú (prod pred migráciou) | povolené | predplatné nemôže existovať |

Člen: blokuje **iba** `STORE_SUBSCRIPTION_PURCHASER` — predplatné je Google Play/App Store, stále sa obnovuje
alebo čaká na platbu a člen je `created_by` posledného dokončeného store checkoutu. Stripe (firemná karta)
člena neblokuje.

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
    "current_period_end": "2026-11-12T00:00:00Z", "cancel_at_period_end": false
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

## 6. Testy

- `npm run test:account-deletion-subscription` — 18 unit/kontrakt testov (pravidlo, provider, člen, fail-closed čítanie, chýbajúca schéma, poradie v route, UI, i18n, migrácia) + PGlite suite `account-deletion` (10): parita TS↔DB, fake nákup → blokované a nič nezmazané (firma, členstvá, `billing_provider_links`), zrušenie obnovy → povolené (audit eventy ostanú s `company_id = null`), past_due/account_hold, ukončené stavy, trial/free/manual, Stripe/Google/Apple, otvorený/expirovaný checkout, člen, GUC výnimka, idempotencia a rollback migrácie.
- Celý repo: 53/53 testovacích sád, tsc 0, lint = baseline (37/26, 0 nových), web + mobile build PASS.

## 7. Zostávajúce riziká / rozhodnutia

1. **Súbeh** (nákup medzi precheckom a DB transakciou): DB poistka vráti DB, ale súbory zo Storage už môžu byť zmazané. Odstráni to až poradie DB-najprv (navrhnuté v readiness doc, mimo scope).
2. **Neobnovujúce sa predplatné** je povolené (provider neúčtuje); zostávajúce zaplatené obdobie zanikne. Ak CLIA/spotrebiteľské pravidlá vyžadujú inak (čakať do konca obdobia / refund), stačí v `classifySubscriptionForDeletion` + SQL predikáte zmeniť `active_non_renewing` na blokujúce.
3. Platiteľ člena sa určuje z `billing_checkout_sessions.created_by`; obnova nákupu (restore) bez checkoutu platiteľa nezaznamená → člen neblokovaný (firma a owner predplatné naďalej vidia a spravujú).
4. Store predplatné po zrušení **firmy** so zrušenou obnovou: neskoršie provider eventy (expirácia, refund) skončia ako `UNKNOWN_COMPANY` a sú auditované v `billing_events`.
5. Produkcia: migrácie subscriptions + táto poistka neaplikované. Kód je bez nich bezpečný (chýbajúca schéma = žiadne predplatné).

## 8. Rollout (iba po schválení)

1. Staging: aplikovať `20261008120000…20261012091000` + `20261012120000` → `npm run test:account-deletion-subscription` → staging smoke (fake nákup → zrušenie účtu zablokované → zrušiť obnovu → zrušenie prejde).
2. CLIA review nových UI textov + politika „neobnovujúce sa = povolené".
3. Produkcia: migrácie spolu s billing migráciami (pred zapnutím billingu), deploy, smoke.
