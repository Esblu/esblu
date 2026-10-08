# E-Faktúra — prevádzkový runbook

**Stav:** 2026-10-02 · pripravené na branchi `einvoice-port`.
Produkčné migrácie **nie sú** aplikované, cron **nie je** aktivovaný, poskytovateľ **nie je** nakonfigurovaný.
**Pravidlo č. 1:** pri neistote **nikdy** nevytváraj nový pokus o odoslanie (nový Idempotency-Key).
Najprv **reconciliation**.

---

## 1. Komponenty

| Časť | Kde | Poznámka |
| --- | --- | --- |
| Požiadavka „Odoslať“ | `POST /api/einvoice/outbound` | Telo `{invoice_id, confirm_send:true}`. Nič neodošle, iba zaradí riadok `queued`. |
| Worker odosielania | `GET /api/cron/einvoice-outbound?mode=send` | Claim po 1 riadku, termín behu 50 s, odhad 25 s na riadok. |
| Reconciliation | `GET /api/cron/einvoice-outbound?mode=reconcile` | Iba dotaz na stav / dôkaz u poskytovateľa. Nikdy neodosiela. |
| Poll príjmu | `GET /api/cron/einvoice-inbound` | `received?acknowledged=false` → stiahnutie XML → koncept → ACK. |
| Webhook | `POST /api/einvoice/webhook` | HMAC `t=…,v1=…`, ±300 s, dedupe `X-Webhook-Id` + SHA-256 tela. Odpoveď 200 aj pri internej chybe (poll to dobehne). |
| Maintenance | `GET /api/cron/einvoice-maintenance` | Health, alert kandidáti, retencia webhook metadát (90 dní), kontrola storage. |
| Operátorské akcie | `POST /api/einvoice/outbound/[id]/{reconcile,retry}`, `POST /api/einvoice/inbound/[id]/{reprocess,ack-retry}` | Telo `{confirm_action:true}`, finance.manage, cooldown 60 s na riadok, audit udalosť. |
| Rollout brána | DB `einvoice_rollout` + `esblu_einvoice_rollout_allowed()` | Default DENY. Pozri §8. |

Všetky cron routes vyžadujú `Authorization: Bearer $CRON_SECRET` (≥ 16 znakov, porovnanie v konštantnom čase).
Bez secretu vrátia 401. Bez nakonfigurovaného poskytovateľa vrátia `{configured:false}` a nič nerobia.

## 2. Cron konfigurácia (vo `vercel.json` vetvy `einvoice-port`; aktívna až po zlúčení do `main`)

Vercel spúšťa crony iba pre produkčný deployment. Pridané (7. 10. 2026): `fx-rates` (`0 5,16 * * *`)
a `einvoice-events` (`*/5 * * * *`, partnerský feed). Úplný checklist:
`docs/einvoice-preproduction-readiness-2026-10-07.md` sekcia 5.

| Route | Interval | Prečo |
| --- | --- | --- |
| outbound `?mode=send` | každú minútu | Odoslanie do ~1 min od potvrdenia. Backoff 1, 2, 4 … min. |
| outbound `?mode=reconcile` | každých 5 min | Stav sa dopytuje až po 5 min od poslednej zmeny. Webhook urýchli. |
| inbound | každých 10 min | Webhook je primárny, poll je záchranná sieť. |
| maintenance | 1× za hodinu (`17 * * * *`) | Health, alerty, retencia. Kritický alert → HTTP 503. |

- **Vercel plán:** Hobby dovolí cron iba 1× denne, takže je potrebný Pro. Na Pro: `maxDuration` 60 s
  (nastavené v route), termín behu 50 s.
- **Prekrývanie behov:** bezpečné. Claim je `FOR UPDATE SKIP LOCKED` + lease (120 s), dva behy si
  riadok nezoberú.
- **Rate limit poskytovateľa:** partner ≥ 100 req/min. Jeden beh urobí najviac ~5 odoslaní + 1–2
  reconciliation. Pri 429 nasleduje backoff a výsledok je známy (neprijaté), takže nehrozí retry storm.
- **Batch:** `ESBLU_EINVOICE_WORKER_BATCH` (1–10, default 5). Termín behu má prednosť.

## 3. Stavy a čo znamenajú

### Odosielanie (`einvoice_outbound.state` + odvodená kategória)

| Stav / kategória | Význam | Kto koná |
| --- | --- | --- |
| `queued` | Zaradené, čaká na worker. | Nikto. Ak čaká > 60 min, pozri §4.1. |
| `sending` (retryable) | Worker odovzdáva. Pri chybe nasleduje backoff a **ten istý kľúč**. | Nikto. |
| `sending` + `send_outcome_unknown` | Timeout / 5xx / pád. Dokument **mohol** odísť. Opakuje sa iba ten istý kľúč (docs: replay „never sends twice“). | Nikto, kým neprebehne 8 pokusov. |
| `sending` + `EINVOICE_RETRY_EXHAUSTED_UNKNOWN` (`retry_exhausted_unknown`) | 8 pokusov s neistým výsledkom. | **Operátor: iba Reconcile.** Nikdy Retry. Pozri §5. |
| `sent` | Poskytovateľ prijal (`queued` u neho). | Reconciliation to dotiahne. |
| `deferred` | Poskytovateľ odložil a opakuje sám. | Čakať. Ak trvá > 24 h, eskalovať. |
| `delivered` | Dôkaz doručenia s rovnakým SHA-256. | — |
| `rejected` | Poskytovateľ odmietol (validácia, kredit, ingest). Výsledok je istý, nič neodišlo. | Opraviť príčinu, potom **Retry** (nový pokus). |
| `failed` | Trvalé zlyhanie (`ERROR` u poskytovateľa, 4xx, vyčerpané 429). | Opraviť príčinu, potom Retry. Výnimku pozri v §5. |

### Príjem (`einvoice_inbound.processing_status`)

`received` → `stored` (XML + SHA-256) → `parsed` → `draft_created` → `ack_pending` → `acknowledged`.
Vedľajšie stavy:

- `duplicate`: doklad už existuje. Tiež sa potvrdí (ACK).
- `failed`: dáta nevieme spracovať (napr. dobropis `UNSUPPORTED_PROFILE`). Vyžaduje manuálnu
  kontrolu a pôvodné XML ostáva uložené.

### Typy dokladov (UBL `InvoiceTypeCode` / `CreditNoteTypeCode`)

| Druh v Esblu | Odosielame | Prijímame |
| --- | --- | --- |
| bežná / konečná faktúra (`regular_invoice`) | 380 | 380 (iný kód → review `INVOICE_TYPE_CODE_UNUSUAL`) |
| faktúra k prijatej platbe (`payment_received_invoice`) | **388** (SK kanonický, FS FAQ eFaktúra tech. príklad 22) | **388 + 386** (386 = spätná kompatibilita), rovnaký tok a párovanie záloh |
| ťarchopis (`debit_note`) | 383 | 383 |
| dobropis (`credit_note`) | 381 | 381 / 81; 83 → review |
| proforma | nikdy (nie je daňový doklad) | — |

## 4. Incidenty

### 4.1 Odosielanie stojí (`OUTBOUND_STUCK`, queued/sending > 60 min)

1. `GET /api/cron/einvoice-maintenance` → `health.outbound` (iba čísla).
2. Bežné príčiny:
   - cron nebeží (Vercel Cron logs),
   - poskytovateľ nie je nakonfigurovaný (`configured:false`),
   - **rollout pozastavený** (`stage='paused'`, §8),
   - **firma stratila nárok `einvoice`**: zaradené riadky čakajú, nič sa neodošle, po obnovení nároku pokračujú,
   - výpadok poskytovateľa.
3. Nikdy neupravuj riadok ručne v DB (guardy to aj tak odmietnu).

### 4.2 Výpadok poskytovateľa (5xx / timeouty / 429)

- **Automatika:**
  - neistý výsledok (5xx, timeout): backoff a replay toho istého kľúča,
  - 429: backoff, výsledok je istý (neprijaté),
  - po 8 pokusoch: `retry_exhausted_unknown`, alert **critical**.
- **Postup:**
  1. Over status poskytovateľa (P13 v provider checkliste, `podpora@efaktura.sk`).
  2. Po obnove spusti **Reconcile** na dotknutých riadkoch.
- **Kill switch:** `update public.einvoice_rollout set stage='paused', changed_by='<ticket>' where …` →
  claimy nič nezoberú. Reconcile ide naďalej, lebo je iba čítanie.

### 4.3 Výpadok Supabase

- Routes vrátia 500 (`QUERY_FAILED`) a cron nespraví nič.
- Riziko: worker odoslal, ale nezapísal výsledok. Riadok ostane `send_in_flight` → ďalší claim ho označí
  ako neistý a zopakuje **ten istý kľúč**. Poskytovateľ vráti uloženú odpoveď, druhé odoslanie nevznikne.
- Webhooky počas výpadku dostanú chybu a poskytovateľ ich opakuje až ~2,7 dňa.

### 4.4 Výpadok Vercel

- Cron nebeží → nič sa neodosiela, `queued` riadky čakajú.
- Webhooky sa opakujú (~2,7 dňa). Doklady ostávajú u poskytovateľa nepotvrdené a poll ich po obnove spracuje.
- Nič netreba robiť ručne.

### 4.5 Záplava webhookov / duplicity

- Dedupe podľa `X-Webhook-Id` + SHA-256 tela: rovnaké doručenie vráti `200 DUPLICATE`, rovnaké ID s iným
  telom vráti `409 REPLAYED_WEBHOOK`.
- Spracovanie vždy znova stiahne zoznam od poskytovateľa. Dáta z tela sa nepoužijú.
- Nekonečné opakovanie nehrozí.

### 4.6 Neplatné podpisy (`WEBHOOK_SIGNATURE_FAILURES`, ≥ 10/h, critical)

- Možné príčiny: rotácia secretu (poskytovateľ posiela 24 h dva `v1=`), zlý secret vo Vercel env, alebo
  útok / skenovanie.
- Postup:
  1. Over `ESBLU_EFAKTURA_WEBHOOK_SECRETS` (iba existenciu a dĺžku, **nikdy hodnotu**).
  2. Pri rotácii pridaj nový secret čiarkou, starý odober po 24 h.
- Počítadlo je agregát (dôvod + hodina), bez IP a tiel.

### 4.7 Neobvykle veľa odmietnutí (`OUTBOUND_REJECT_RATE_HIGH`, critical)

- Spúšťa sa pri ≥ 3 odmietnutých/zlyhaných za 24 h a podiele ≥ 20 %. `OUTBOUND_PERMANENT_FAILURES`
  (warning) sa spúšťa pri ≥ 1 za 24 h.
- Bežné príčiny:
  - zlý dátum vyhotovenia (do 31. 12. 2026 max 10 dní; od 1. 1. 2027 = deň odoslania),
  - schéma odberateľa (0245 vs 9915 v sandboxe),
  - kredit (`402`),
  - organizácia bez aktívneho Peppol účtu (`reason: ingest`).
- Zisti `last_error_code` / `reject_reason` (bez obsahu dokladu). Pri systémovej príčine zvaž kill
  switch (§8).

### 4.8 Príjem stojí / ACK čaká (`INBOUND_STUCK`, `INBOUND_ACK_PENDING_TOO_LONG`)

- ACK je idempotentný, **ACK retry je vždy bezpečný**. Reprocess je bezpečný pre
  `received` / `stored` / `parsed` a pre `failed` s XML bez konceptu.
- Dobropis (`UNSUPPORTED_PROFILE`) **nereprocessuj**: zmenou kódu sa nevyrieši. Spracuje sa manuálne.

## 5. Čo operátor smie / nesmie

| Situácia | Bezpečné | NIKDY |
| --- | --- | --- |
| `retry_exhausted_unknown` / `send_outcome_unknown` | **Reconcile** | Retry (nový kľúč). DB to aj tak odmietne, kým reconciliation nepotvrdí, že podanie u poskytovateľa neexistuje (`reconciled_absent_at`). Lookup podľa kľúča poskytovateľ zatiaľ nemá (P3), takže eskaluj na poskytovateľa s ID faktúry a časom. |
| `sent` / `deferred` | Reconcile | Retry |
| `rejected` | Oprava údajov, potom **Retry** (operátorská akcia) | Opakované „Odoslať“ v UI: server vráti `RETRY_REQUIRES_OPERATOR_ACTION`. |
| `failed` (istý výsledok) | Retry po oprave | Retry, ak bolo predtým `send_outcome_unknown` bez `reconciled_absent_at` (DB blokuje). |
| `failed` z `ERROR` u poskytovateľa | Retry podľa docs („fix and send again“) | Retry, ak poskytovateľ nepotvrdí, že `ERROR` je terminálne (P4). V pilote najprv eskaluj. |
| Inbound `ack_pending` | ACK retry | Ručný ACK mimo Esblu |
| Inbound `failed` | Reprocess (okrem dobropisu) | Ručná úprava XML v storage (sha256 guard) |

Operátorské akcie majú cooldown 60 s na riadok, vyžadujú finance.manage a zapisujú audit udalosť
(`source=user`, `metadata` = action / actor / reason_code).

## 6. Logy a bezpečné diagnostické údaje

- **Kde:**
  - Vercel → Logs (Functions / Cron),
  - Supabase → Logs (API / Postgres),
  - DB tabuľky `einvoice_events` (append-only audit), `einvoice_webhook_events`, `einvoice_webhook_rejections`.
- **E-Faktúra kód nepoužíva `console.*`.** Odpovede obsahujú iba strojové kódy a počty.
- **Bezpečné na zdieľanie (aj s poskytovateľom):**
  - interné UUID riadkov, `provider_submission_id` (invoice_id poskytovateľa), `idempotency_key`,
  - `document_id` (definitívny identifikátor podania zo send), `sbdh_instance_identifier` (SBDH InstanceIdentifier,
    z webhooku `transactionId`), `as4_message_id` (`messageId`) — dohľadávací SQL v
    `docs/efaktura-provider-conformance-2026-10-08.md`, sekcia 4,
  - stav, chybový kód, časy, SHA-256 dokumentu,
  - `X-Webhook-Id`.
- **Nikdy nezdieľať:**
  - API kľúče, webhook secrety, `CRON_SECRET`, service_role,
  - obsah UBL/XML, IČO/DIČ/IBAN mimo nevyhnutnosti,
  - mená a e-maily používateľov.

Diagnostický SQL (iba čítanie, bez osobných údajov):

```sql
select state, last_error_code, count(*) from public.einvoice_outbound group by 1, 2 order by 3 desc;
select processing_status, last_error_code, count(*) from public.einvoice_inbound group by 1, 2 order by 3 desc;
select public.esblu_einvoice_health(60, 60);          -- service_role
select public.esblu_einvoice_outcomes_24h();          -- service_role
```

## 7. Eskalácia na poskytovateľa

- `podpora@efaktura.sk` (alebo partner portál). Uveď:
  - `X-Organization-Id` (org ID u poskytovateľa),
  - `invoice_id` poskytovateľa alebo `Idempotency-Key`,
  - čas (UTC), HTTP kód a `X-Webhook-Id`.
- **Bez** dokladu, bez kľúča.
- Priority:
  1. neistý výsledok po vyčerpaní pokusov (možné dvojité / nulové doručenie),
  2. `ERROR` po AS4,
  3. vypnutý webhook endpoint (15 zlyhaní).

## 8. Rollout (Stage 0 → 4) a allowlist

Brány, ktoré **všetky** musia platiť pre odoslanie v produkcii:

1. env: `ESBLU_EINVOICE_PROVIDER`, `ESBLU_EINVOICE_ENVIRONMENT`, kľúč so správnym prefixom; pre live
   navyše `ESBLU_EINVOICE_LIVE_ENABLED=true` a `VERCEL_ENV=production`,
2. `einvoice_organizations` pre (firma, prostredie), `peppol_eligible`; live nikdy so schémou 9915,
3. `einvoice_rollout` pre (firma, prostredie), stage ≠ `paused`,
4. nárok `einvoice`, finance.manage a explicitné potvrdenie používateľa.

| Stage | Kto | Prostredie | Podmienka prechodu |
| --- | --- | --- | --- |
| 0 | vývoj | sandbox, staging Supabase | Sandbox E2E PASS (`docs/einvoice-sandbox-e2e-plan.md`) |
| 1 | Esblu interná firma | live | Zmluva + live kľúč, CLIA stanovisko, prod migrácie, PFS mandát, 1 týždeň bez critical alertu |
| 2 | 1–3 pilotné firmy | live | Stage 1 OK, alert doručenie (nie iba JSON), runbook overený |
| 3 | limited beta | live | Bez incidentu s neistým výsledkom, reject rate < 5 % |
| 4 | GA | live | Rozhodnutie produktu, cenník, aktualizované právne dokumenty |

Allowlist (iba operátor, service_role / SQL editor; **nie** cez appku):

```sql
-- povolenie (Stage 1: interná firma)
insert into public.einvoice_rollout (company_id, environment, stage, note, changed_by)
values ('<company-uuid>', 'live', 'internal', 'Stage 1', '<meno / ticket>')
on conflict (company_id, environment) do update set stage = excluded.stage, note = excluded.note,
  changed_by = excluded.changed_by, updated_at = now();

-- kill switch (nič nové sa neodošle ani nespracuje; reconcile a história ostávajú)
update public.einvoice_rollout set stage = 'paused', changed_by = '<ticket>', updated_at = now()
where company_id = '<company-uuid>' and environment = 'live';
```

Stage 1+ sa **nevykonáva** bez explicitného súhlasu vlastníka (produkčná mutácia).

## 9. Známe obmedzenia

- **Alerty sa nikam nedoručujú.** Maintenance vracia kandidátov iba v JSON odpovedi. Pre Stage 2+ treba
  napojiť notifikáciu (e-mail / Slack / monitoring).
- `retry_exhausted_unknown` vyžaduje eskaláciu, kým poskytovateľ nemá lookup podľa kľúča (P3).
- Partner feed `GET /v1/agent/events` sa číta cez `/api/cron/einvoice-events` s kurzorom v DB (sekcia 10); plánovanie cronu zatiaľ nie je vo `vercel.json`.
- Storage objekty sa pri zmazaní firmy nemažú automaticky (CLIA Q5).

## 10. Udalosti webhook / feed — vyčerpané pokusy, manuálny retry (20261007100000)

Stav udalosti (`einvoice_webhook_events`, bez payloadu — iba hash tela, typ, firma z mapovania):

| Stav | Význam | Čo robí systém |
| --- | --- | --- |
| `failed`, `exhausted_at` NULL | zlyhalo, ďalší pokus povolený | rovnaké doručenie (webhook retry poskytovateľa alebo feed) sa spracuje znova; max 5 pokusov |
| `failed`, `exhausted_at` vyplnené | 5 pokusov vyčerpaných | **alert `EVENTS_EXHAUSTED` (critical)** v `/api/cron/einvoice-maintenance`; retencia ho NEMAŽE |
| `failed`, `resolved_at` vyplnené | operátor uzavrel | bez alertu; po 90 dňoch retencia zmaže |

Monitoring (bez payloadu): `select public.esblu_einvoice_event_ops();` alebo pole `events` /
`eventAlerts` v maintenance odpovedi — počty vyčerpaných podľa typu udalosti, zaseknuté `received`,
stav kurzora feedu (vek posledného behu, posledná chyba). Alerty: `EVENTS_EXHAUSTED`,
`EVENTS_STUCK_RECEIVED`, `EVENT_FEED_STALE` (> 2 h bez behu), `EVENT_FEED_ERROR`.

Manuálny postup (SQL editor, service_role; `actor` = e-mail/označenie operátora, `reason` = KÓD):
1. Odstrániť príčinu (DB, mapovanie, kód). Zoznam: `select id, event, error, attempts, exhausted_at,
   case when delivery_id like 'feed:%' then 'feed' else 'webhook' end source from public.einvoice_webhook_events
   where exhausted_at is not null and resolved_at is null order by exhausted_at;`
2. `select public.esblu_einvoice_event_requeue('<id>', '<actor>', 'CAUSE_FIXED');` — reset pokusov, audit.
3. Znovu doručiť udalosť: **feed** → `select public.esblu_einvoice_event_cursor_rewind('efaktura_sk', '<env>',
   <id_pred_udalosťou>, '<actor>', 'REPROCESS_AFTER_FIX');` a spustiť `/api/cron/einvoice-events`
   (už spracované udalosti = `DUPLICATE`, bez vedľajších účinkov); **webhook** → v portáli eFaktura.sk
   „Znova“ pri doručení (nové ID doručenia) alebo nechať dobehnúť feed.
4. Ak udalosť nie je potrebné spracovať (napr. neplatná org): `select public.esblu_einvoice_event_resolve('<id>',
   '<actor>', 'NOT_APPLICABLE');`
Všetky zásahy sú v `einvoice_ops_audit` (actor, akcia, cieľ, kód, bez payloadu).

Prečo sa nič potichu nestratí: každá udalosť je aj vo feede (90 dní) — webhook zlyhanie dobehne feed
s vlastným kurzorom; feed sa zastaví PRED zlyhanou udalosťou, po 5 pokusoch ju označí ako vyčerpanú
(alert) a pokračuje; vyčerpané neuzavreté udalosti retencia nemaže.

## 11. Limit aktivácie príjmu (FS kód)

Esblu obmedzuje pokusy o aktiváciu (`/api/einvoice/reception/enroll`) nad rámec poskytovateľa:
firma 5 / 15 min a 20 / 24 h, používateľ 10 / h naprieč firmami → `429 TOO_MANY_ATTEMPTS`
s `retry_after_seconds`. Dôvody: (a) partnerský kľúč má spoločný rate limit (≥ 100 req/min) pre všetky
firmy — jeden tenant by inak mohol vyčerpať kapacitu ostatným, (b) Esblu nesmie byť nástroj na
skúšanie overovacích kódov, (c) poskytovateľ môže pri opakovaných chybách zablokovať organizáciu.
Ukladá sa iba firma, používateľ, čas a výsledok (`einvoice_enroll_attempts`, 30 dní) — nikdy kód ani hash.
Uvoľnenie pre konkrétnu firmu (iba po overení): `delete from public.einvoice_enroll_attempts where company_id = '<id>';`
