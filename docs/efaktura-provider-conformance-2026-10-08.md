# eFaktura.sk — provider-conformance audit (8. 10. 2026)

**Zdroj pravidiel:** posledná odpoveď eFaktura.sk (8. 10. 2026), ktorú Esblu dostalo e-mailom. Doplnkovo verejná OpenAPI
`https://developers.efaktura.sk/agent-api.en.yaml` (stiahnutá 8. 10. 2026).

**Rozsah:** retry, idempotencia a korelácia odoslaného podania. Žiadne nové funkcie.

**Výsledok:** pred auditom tri odchýlky (body 1c, 4, 5/6). Všetky sú opravené na vetve `einvoice-port`, migrácia iba na staging.

| # | Pravidlo poskytovateľa | Stav pred auditom | Teraz | Dôkaz (test) |
| --- | --- | --- | --- | --- |
| 1a | Retry po timeoute / neurčitom výsledku použije **ten istý Idempotency-Key** | ✅ kľúč = `einvoice_outbound.idempotency_key`, v DB nemenný | ✅ | outbound: „timeout → NIE failed … ten istý kľúč“, „retry s tým istým kľúčom“; adapter: „sendUbl retry po timeoute“ |
| 1b | Retry použije **byte-identické telo** | ✅ telo sa skladá iba z nemenných vstupov: uložené bajty UBL (SHA-256 overený pred každým odoslaním), nemenný príjemca, konštantné `options`; poradie kľúčov je deterministické | ✅ + nový dôkaz | adapter: porovnanie surového tela 1. a 2. volania (`raw[0].body === raw[1].body`); outbound: „409 … byte-identický“ |
| 1c | 409 „Požiadavka s týmto Idempotency-Key sa práve spracúva“ **nie je finálne zlyhanie** → odložený retry | ❌ každý 409 bol `EINVOICE_PROVIDER_CONFLICT` → `hold` bez ďalšieho pokusu (čakalo sa na operátora) | ✅ nový kód `EINVOICE_PROVIDER_IDEMPOTENCY_IN_PROGRESS` (retryable, neistý výsledok) → retry s backoffom, ten istý kľúč a bajty | adapter: 409 „práve sa spracúva“ / kód `*IN_PROGRESS*` → `IDEMPOTENCY_IN_PROGRESS`; outbound: „409 … odložený retry … potom úspech“; politika |
| 1d | Ten istý kľúč + **iné telo** nesmie byť retry | ✅ v DB sa to nedá vytvoriť (kľúč, hash UBL a príjemca sú `IDENTITY_IMMUTABLE`); 409 „different request body“ → `hold` | ✅ | adapter: 409 „already used with a different request body“ → `CONFLICT`, not retryable; outbound: „ten istý kľúč + iné telo → hold, NIE retry“ |
| 2 | Idempotency-Key drží poskytovateľ **24 h** | ✅ všetky automatické opakovania jedného pokusu: max 8 odoslaní za ~127 min (backoff 1–64 min) | ✅ zdokumentované + test (`PROVIDER_IDEMPOTENCY_TTL_MS`) | outbound: „všetky automatické opakovania … do 24 h TTL“ |
| 3 | Trvalá deduplikácia poskytovateľa (SHA-256 UBL v organizácii; zmenené UBL → blok rovnakého čísla + typu) | ✅ Esblu na ňu nespolieha, je to druhá vrstva. Nový pokus (nový kľúč) vzniká iba ručne po termináli. Duplicitné číslo vráti `rejected/ingest`, iný 409 = `hold`. | ✅ bez zmeny | outbound: hash mismatch, nový pokus iba po termináli; L2 sandbox (2b checklistu) |
| 4 | Definitívny identifikátor = `document_id` z connector/send; stav cez `GET /submissions/{document_id}`; z neho `invoice_id`; dôkaz cez `GET /sent/{invoice_id}/evidence` | ❌ `document_id` zo send sa neukladal. Korelácia stála iba na `invoice_id`, ak chýbal → `BAD_RESPONSE`. `document_id` sa neskôr prepisoval hodnotou zo statusu. `/submissions` nebol implementovaný. | ✅ `document_id` zo send sa uloží hneď a už sa neprepíše. Ak chýba `invoice_id`, dohľadá sa cez `GET /v1/agent/peppol/submissions/{document_id}`. Zatiaľ neistý retry (`EINVOICE_PROVIDER_SUBMISSION_PENDING`, uloží sa iba `document_id`). Reconciliation aj operátorský „reconcile“ dohľadávajú podľa `document_id`, nič neodosielajú. Status a dôkaz idú cez `invoice_id`. | adapter: „queued iba s document_id“, „getSubmissionByDocumentId … URL-enkódované, 404/nejasné → null“; outbound: „iba document_id → invoice_id cez /submissions“, „document_id bez invoice_id → … reconciliation ho dohľadá; status document_id neprepíše“ |
| 5 | Webhook `peppol.document.sent/delivered`: `invoiceId`, `messageId`, `transactionId` (= SBDH InstanceIdentifier) | ⚠️ korelácia podľa `invoiceId` ✅; `messageId` / `transactionId` sa zahadzovali | ✅ Uložia sa write-once k podaniu firmy (`as4_message_id`, `sbdh_instance_identifier`), aj k už ukončenému podaniu. Iná firma = nič. Stav sa z webhooku nepreberá, iba spustí reconciliation. | inbound: „korelácia … write-once, bez obsahu“ |
| 6 | Incident: dohľadateľné company/org, `document_id`, `invoice_id`, SBDH InstanceIdentifier, bez citlivého UBL | ⚠️ SBDH nebol nikde uložený | ✅ všetko na riadku `einvoice_outbound` (+ org cez `einvoice_organizations`), index podľa `document_id` a SBDH. Webhook log drží iba `body_sha256`, nie telo. Adaptér nepoužíva `console.*`. | inbound: dohľadanie podľa ľubovoľného ID v rámci firmy; kontrola stĺpcov webhook logu |
| 7 | DPA / dokumentácia | — | ✅ zapísané (sekcia 3) | — |

## 1. Zmeny

| Oblasť | Súbor |
| --- | --- |
| 409 in-progress vs. konflikt; `document_id` zo send; `getSubmissionByDocumentId` | `lib/einvoice/provider/efaktura-sk.ts`, `lib/einvoice/provider/types.ts` (voliteľné polia, existujúce fake providery bez zmeny) |
| Politika: `IDEMPOTENCY_IN_PROGRESS` = retry (neistý výsledok); `PROVIDER_IDEMPOTENCY_TTL_MS` | `lib/einvoice/outbound/policy.ts` |
| Worker: uloženie `document_id`, dohľadanie `invoice_id`, neprepísanie `document_id` statusom/dôkazom | `lib/einvoice/outbound/worker.ts`, `lib/einvoice/outbound/store.ts` (typ) |
| Operátorský reconcile: najprv `document_id` → `/submissions`, potom lookup podľa kľúča | `lib/einvoice/ops/actions.ts` |
| Webhook / feed: `messageId` + `transactionId` → RPC | `lib/einvoice/inbound/webhook.ts`, `store.ts`, `supabase-store.ts` |
| DB (staging): `einvoice_outbound.sbdh_instance_identifier`, `as4_message_id`, indexy, RPC `esblu_einvoice_outbound_record_transport` (iba service_role, write-once) | `supabase/migrations/20261008100011_einvoice_outbound_transport_ids.sql` + rollback |

## 2. Overiť v sandboxe (nie blocker kódu)

- **Tvar odpovede `GET /v1/agent/peppol/submissions/{document_id}`** — endpoint nie je vo verejnej OpenAPI a z vývojového prostredia sa sandbox nedá zavolať (sieťové obmedzenie).
  - Implementácia číta iba `invoice_id`/`invoiceId` a `state`/`status`. Čokoľvek iné = `null`, takže nič sa nerozhodne a riadok ostane v neistom retry / na reconciliation. Cesta je fail-closed.
  - V doterajšom reálnom sandbox E2E connector/send vždy vrátil `invoice_id`, takže dohľadávacia cesta sa ešte nespustila.
- **Presné telo 409 „práve sa spracúva“.** Rozpoznáva sa podľa kódu (`*IN_PROGRESS*`, `*PROCESSING*`) alebo textu (sk/en). Neznámy 409 ostáva `CONFLICT` → `hold`, teda bezpečná strana.
- Formát `document_id` v sandboxe je `<uuid>@phase4.phoss-ap` (v dôkaze aj statuse), v OpenAPI príklade `0245:…#OF…`. Oba prejdú validáciou.

## 3. Poskytovateľ — zmluva, DPA, technické otázky

- **API zmluva s eFaktura.sk obsahuje DPA podľa čl. 28 GDPR ako Prílohu č. 2** (podľa odpovede poskytovateľa).
- **Informácie o lokalite spracúvania a o retencii platia aj pre API model** (podľa odpovede poskytovateľa).
- **Technické otázky na poskytovateľa (P1–P18, `docs/einvoice-production-provider-checklist.md`) sú CLOSED.**
- Toto nie je právne stanovisko ani schválenie CLIA. Posúdenie DPA a zmluvy pred podpisom ostáva na vlastníkovi / CLIA (LEGAL dimenzia).

## 4. Podpora — dohľadanie podania (read-only, bez obsahu UBL)

```sql
-- podľa ľubovoľného identifikátora (invoice_id, document_id, SBDH InstanceIdentifier, AS4 message id)
select o.id, o.company_id, g.provider_org_id, o.state, o.provider_submission_id as invoice_id, o.document_id,
       o.sbdh_instance_identifier, o.as4_message_id, o.idempotency_key, o.ubl_sha256, o.last_error_code,
       o.sent_at, o.delivered_at
from public.einvoice_outbound o
left join public.einvoice_organizations g on g.company_id = o.company_id and g.environment = o.environment
where :id in (o.provider_submission_id, o.document_id, o.sbdh_instance_identifier, o.as4_message_id);
```
