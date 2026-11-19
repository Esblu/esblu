# Billing — architektúra dokladov: jeden daňový doklad na platbu + účtovná kópia Esblu (2026-11-19)

**Stav:** návrh + technický základ implementovaný (vetva `ops/esblu8-p4`, migrácie `20261123100000`–`20261123120000`).
LIVE billing ostáva **vypnutý**. Daňové pravidlá (§ 7a, cezhraničný predaj) **nie sú rozhodnuté** — otázky pre
účtovníčku: `docs/accountant-questions-billing-2026-11-19.md`. Tento dokument nič z nich nepredpokladá.
Podklad: `docs/audits/stripe-live-audit-2026-11-19.md` § 4–5.

## 1. Požiadavky (záväzné)

1. Zákazník dostane k **každej platbe práve JEDEN** správny daňový doklad (a k refundácii práve jeden opravný doklad
   naviazaný na pôvodný).
2. Esblu má vlastnú **účtovnú kópiu** každého dokladu (čísla, sumy, daňové polia, PDF s hashom) nezávisle od Stripe účtu
   (archivácia 10 rokov — lehotu potvrdí účtovníčka).
3. Ani súbeh, retry, doťahovanie, ručný zásah, ani budúca e-faktúra (eFaktura.sk / Peppol) nesmie vytvoriť druhý doklad
   za to isté plnenie.
4. Mesačný podklad pre účtovníčku: doklady + hrubá suma, poplatok Stripe, čistá suma, výplata (payout).

## 2. Fakty o Stripe Billing (bez ohľadu na variant)

- Predplatné cez Checkout `mode=subscription` → Stripe pre každé obdobie **vždy** vytvorí, finalizuje a zaplatí objekt
  **Invoice** (číslo, PDF, hosted page). Vypnúť sa dá iba jeho *odoslanie* zákazníkovi a *viditeľnosť* v Portáli,
  nie jeho vznik.
- Refundácia cez *Payments → Refund* dobropis **nevytvorí**; *Invoice → Issue credit note* áno.
- Esblu dnes refundácie v kóde nevystavuje (iba operátor v Dashboarde).

## 3. Variant A — daňový doklad = Stripe faktúra

| | |
|---|---|
| Vystaviteľ | Stripe Billing v mene Esblu s. r. o. (náležitosti a číslovanie v Stripe Dashboarde) |
| Zákazník dostane | e-mail Stripe s faktúrou (PDF) po platbe; históriu v Billing Portáli |
| Refundácia | Stripe credit note (Invoice → Issue credit note + refund) = opravný doklad |
| Esblu | iba **účtovná kópia** (`billing_invoice_documents`, `legal_issuer='stripe'`) + archív PDF + export |
| E-faktúra (ak bude povinná) | Esblu vygeneruje zo **finalizovanej** Stripe faktúry jej štruktúrovanú reprezentáciu (UBL / Peppol BIS) **s tým istým číslom a sumami** — nie je to nový doklad. Väzba `billing_invoice_documents.einvoice_outbound_id` (unikátna) |
| Výhody | jeden číselný rad, jeden zdroj súm a DPH, minimum kódu, Stripe rieši PDF, e-mail, Portál; čo je už implementované, stačí |
| Riziká | náležitosti a text o DPH (§ 7a, reverse charge) musia ísť nastaviť v Stripe (Invoice template, footer, custom fields, Stripe Tax); číslovanie Stripe (per účet / per zákazník) musí účtovníčka akceptovať; generovanie UBL z cudzieho dokladu treba overiť s eFaktura.sk |

## 4. Variant B — daňový doklad = faktúra Esblu (vlastný rad, neskôr eFaktura.sk / Peppol), Stripe iba inkasuje

| | |
|---|---|
| Vystaviteľ | Esblu (modul faktúr / budúci outbound Peppol), vlastný číselný rad |
| Stripe | iba platba; Stripe Invoice vzniká technicky ďalej, ale **nie je daňový doklad**: vypnúť e-maily *Finalized invoices* / *Successful payments* s faktúrou, v Portáli skryť históriu faktúr, v pätičke Stripe dokladu text „nie je daňový doklad — potvrdenie platby“ (formuláciu schváli účtovníčka) |
| Zákazník dostane | faktúru Esblu (e-mail / Peppol) |
| Refundácia | opravný doklad Esblu naviazaný na faktúru Esblu; Stripe credit note iba technicky (alebo vôbec) |
| Esblu | `billing_invoice_documents` = väzbová tabuľka **Stripe invoice ↔ doklad Esblu** (`legal_issuer='esblu'`, `einvoice_outbound_id`), doklad Esblu sa vystaví **iba** z finalizovanej/zaplatenej Stripe faktúry, idempotentne podľa `(provider, environment, provider_document_id)` |
| Výhody | plná kontrola náležitostí, jeden rad pre všetky predaje Esblu, priama cesta na Peppol |
| Riziká | dvojitá fakturácia, ak niečo z vypnutia Stripe dokladov zlyhá (e-mail, Portál, ručné „Send invoice“); vlastné číslovanie, opravy, storno, kurzy, archív — výrazne viac kódu a testov; nesúlad súm (zaokrúhlenie, dátum dodania, obdobie) medzi Stripe a Esblu; zákazník vidí dva PDF (aj keď jeden „nie je daňový doklad“) |

## 5. Ochrana proti duplicite (spoločná pre A aj B) — implementované

- `billing_invoice_documents`: **unikát** `(provider, environment, provider_document_id)`; plnenie iba cez
  `esblu_billing_upsert_document` (service-only) z udalostí `invoice.finalized | paid | voided | marked_uncollectible`,
  `credit_note.created | updated | voided` — webhook, doťahovanie aj retry idú tou istou pipeline (dedupe podľa ID
  udalosti + upsert podľa ID dokladu). Stav sa posúva iba dopredu (staršia udalosť nič nezníži).
- `einvoice_outbound_id`: **unikátny** index → k jednému Stripe dokladu najviac jedna e-faktúra; po nastavení nemenný (trigger).
- `legal_issuer` (`stripe` | `esblu`) — kto je vystaviteľ daňového dokladu; default `stripe` (variant A), kým sa nerozhodne.
- Archív PDF: SHA-256 + cesta, po zápise nemenné (trigger), bucket bez prepisu.
- Refundácia: `billing_refund_observations` (podľa PaymentIntent) + ops alert `REFUND_WITHOUT_CREDIT_NOTE`, ak do 24 h
  nevznikne dobropis aspoň v sume refundácie.
- Zostáva pre variant B (neimplementované, až po rozhodnutí): guard v module faktúr / `einvoice-outbound`, ktorý odmietne
  ručnú faktúru za predplatné, ak už existuje riadok pre tú istú Stripe faktúru, a outbound pre predplatné vytvorí **iba**
  z riadku `billing_invoice_documents` (FK + unikát).

## 6. Odporúčanie

**Variant A** (Stripe faktúra = jediný daňový doklad; Esblu drží účtovnú kópiu a archív; prípadnú e-faktúru generuje z
tej istej Stripe faktúry s rovnakým číslom). Dôvody: jeden číselný rad a jeden zdroj súm eliminuje najväčšie riziko
(dva doklady / nesúlad súm), technický základ je hotový a otestovaný, Variant B by pred spustením vyžadoval vlastný
fakturačný rad pre predplatné, opravné doklady a spoľahlivé potlačenie Stripe dokladov.

**Podmienka:** účtovníčka potvrdí, že Stripe faktúra vie niesť všetky náležitosti pre Esblu s. r. o. (§ 7a) a pre zvolený
rozsah zákazníkov (otázky 1–11), a že generovanie štruktúrovanej e-faktúry z nej je prípustné (otázka 14). Ak nie → B.
Rozhodnutie urobiť **pred** prvým LIVE predajom; neskorá zmena = migrácia rozpracovaných období a riziko duplicity.

## 7. Implementovaný technický základ (P4)

| Časť | Súbor |
|---|---|
| Pripnutá API verzia `2025-03-31.basil` (každý request, override iba overená verzia) | `lib/billing/stripe-api-version.ts`, `lib/billing/providers/stripe.ts` |
| Účtovná kópia z udalostí (pipeline pred zmenou stavu; chyba = retry) | `lib/billing/pipeline.ts`, `StripeProvider.captureDocuments` |
| Retry zlyhaných udalostí (backoff, max. 8, dead-letter), oprava hashu v doťahovaní | `lib/billing/event-retry.ts`, `lib/billing/event-catchup.ts` (cez `eventFromApi`), migrácia `20261123100000` |
| Archív PDF (iba *.stripe.com, SHA-256, bez prepisu) | `lib/billing/document-archive.ts`, `app/api/cron/billing-documents` |
| Ledger + mesačný CSV export (admin) | `lib/billing/accounting-export.ts`, `app/api/billing/admin/accounting-export`, migrácia `20261123110000` |
| Ops alerty (DB, dedupe, e-mail Resend voliteľne, 503) | `lib/billing/ops-alerts.ts`, `app/api/cron/billing-ops-monitor`, migrácia `20261123120000` |
| Testy | `scripts/billing-ops-pglite-tests.ts` (`npm run test:billing-ops-db`), `scripts/subscriptions-lifecycle-tests.ts` |

### 7.1 Overenie esblu8 (2026-11-19) — väzby, prístup zákazníka, `web_provider='none'`

- **Väzby dokladu** (`billing_invoice_documents`): `provider_document_id` (Stripe `in_…` / `cn_…`) ↔ `company_id`
  (cez `billing_provider_links`; **`on delete set null`** — po ukončení firmy ostane doklad bez väzby na firmu, väzba
  ostáva cez `provider_subscription_id` / `payment_intent_id`) ↔ `provider_subscription_id` ↔ `status` + `paid_at`
  (stav iba dopredu) ↔ `service_period_start` / `service_period_end`. Unikát `(provider, environment,
  provider_document_id)` zabráni duplicitnému riadku aj mimo RPC. Dobropis: `related_invoice_id` (+ číslo v exporte).
  Export: `gross` / `stripe_fee` / `net` / refundácie (`bt_type`, `reporting_category`) / `payout_ids` /
  `payout_arrival_date`; výplaty v `billing_balance_transactions.payout_id` + `payout_arrival_date`. Testy:
  `test:billing-ops-db` (doklady, export, unikát, obdobie).
- **Prístup zákazníka k histórii faktúr:** v aplikácii **nie je** vlastný zoznam dokladov. Zákazník (iba **owner**
  aktívnej firmy — `esblu_billing_authorize_manage`) otvorí Stripe Customer Portal cez `POST /api/billing/manage
  {action:"portal"}` (návrat na `/nastavenia/predplatne`); históriu faktúr v Portáli zobrazí Stripe podľa nastavenia
  Portálu v Dashboarde (pri variante B ju treba skryť — § 4). `hosted_url` / `pdf_url` sa ukladajú iba do účtovnej
  kópie Esblu (tabuľka bez prístupu klientov, RLS bez politík). **Gap (vedome neriešený v esblu8):** účtovník
  (finance.view/manage bez role owner) históriu nevidí; zoznam v aplikácii by vyžadoval nové RPC s overením
  aktívnej firmy + finance oprávnenia a rozhodnutie variant A/B (pri B je daňový doklad faktúra Esblu, nie Stripe).
- **`billing_runtime_config.web_provider = 'none'`** = pozastavený PREDAJ, nie synchronizácia: cron
  `/api/cron/billing-stripe-events` doťahovanie aj retry **beží** (existujúce predplatné, refundácie, spory);
  `configured:false` (žiadne volanie Stripe) iba pri režime servera mimo `stripe_test`/`stripe_live` alebo
  `web_provider='fake'`. Testy: `billing-ops-pglite-tests` (retry + doťahovanie pri `none` → spracované práve raz,
  podvrh rovnakého ID s iným telom odmietnutý), `billing-live-mode-pglite-tests` S15b, statický test v
  `subscriptions-lifecycle-tests`.

## 8. Otvorené (rozhodne prevádzkovateľ / účtovníčka)

Variant A/B; náležitosti a text o DPH; Stripe Tax áno/nie; rozsah predaja pri spustení (SK B2B / EÚ / B2C); číslovanie;
postup pri spore; retencia archívu; povinnosť e-faktúry a jej forma. Pozri dokument otázok.
