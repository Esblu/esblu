# eFaktúra / Peppol — PRODUCTION GATE (2026-11-12)

Stav: **ZATVORENÉ (OFF)**. Produkčný eInvoice sa nesmie aktivovať, kým nie sú splnené VŠETKY body nižšie.
Brána je kumulatívna — jeden nesplnený bod = žiadna aktivácia. Testom strážené: `npm run test:einvoice-production-gate`.

## Technické poistky (už v kóde, default OFF)

1. `getEinvoiceProvider()` vráti `null`, ak chýba `ESBLU_EINVOICE_PROVIDER` / `ESBLU_EINVOICE_ENVIRONMENT` / `ESBLU_EFAKTURA_API_KEY`.
2. `live` vyžaduje súčasne: `ESBLU_EINVOICE_ENVIRONMENT=live`, kľúč `efk_pk_live_…`, `ESBLU_EINVOICE_LIVE_ENABLED=true`, `VERCEL_ENV=production`. Inak `null` (fail closed); test kľúč v live / live kľúč v sandbox = chyba.
3. `einvoice_rollout` (firma + prostredie) — 0 riadkov v produkcii = žiadna firma nie je povolená.
4. `einvoice_organizations.environment` — live organizácia so schémou 9915 je v DB odmietnutá.
5. Webhook bez tajomstva → `503 NOT_CONFIGURED`; cron bez providera → `configured:false`, nič nevolá.
6. Overené 2026-11-12: Vercel `production` nemá žiadnu premennú `ESBLU_EINVOICE_*` ani `ESBLU_EFAKTURA_*`; produkčná DB má 0 riadkov vo všetkých `einvoice_*` tabuľkách.

## Podmienky aktivácie (všetky povinné)

| # | Podmienka | Dôkaz | Stav |
|---|-----------|-------|------|
| G1 | **Production partner contract/account** — podpísaná API partner zmluva s eFaktura.sk vrátane Prílohy 2 (DPA čl. 28), zvolený program (ročný/mesačný), uhradená zálohová faktúra | podpísaná zmluva, číslo účtu | OPEN |
| G2 | **Production API key** — `efk_pk_live_…` vydaný až po úhrade; uložený IBA ako Vercel *sensitive* env `production`; nikdy v repozitári, DB, logoch | Vercel env audit (iba názvy) | OPEN |
| G3 | **DPA/GDPR review** — eFaktura.sk zaradená ako sub-processor; aktualizácia DPA (zoznam), Privacy Policy, `/subprocessors`, internej smernice; posúdenie transferov (Railway/Vercel/Resend USA, Gemini fallback) | podpísané/zverejnené verzie | OPEN |
| G4 | **Subprocessor notice** — ak DPA Esblu vyžaduje 15-dňové oznámenie: oznámenie odoslať najneskôr **D-15** pred aktiváciou G12; bez námietky zákazníka alebo s vyriešenou námietkou | odoslané oznámenie + dátum | OPEN |
| G5 | **Webhook security** — HMAC-SHA256 (`X-Webhook-Signature`, okno 300 s, rotácia `v1=`), dedupe `X-Webhook-Id` + replay guard (rovnaké telo pod iným ID → 200 DUPLICATE, nespracuje sa), live `ESBLU_EFAKTURA_WEBHOOK_SECRETS` nastavené, Vercel WAF rate-limit pravidlo pre `/api/einvoice/webhook` | testy + WAF pravidlo | KÓD HOTOVÝ / WAF OPEN |
| G6 | **A/B sandbox tests** — živý beh `scripts/einvoice-partner-sandbox-e2e.ts --confirm-sandbox` so syntetickými firmami A/B (D–K = PASS, I3 aspoň PARTIAL), report uložený; reálne HTTP doručenie webhooku na Preview | `docs/einvoice-sandbox-ab-live-2026-11-12.report.json` | API PASS 26 + PARTIAL 1 (2026-11-12); HTTP webhook OPEN |
| G7 | **Dedupe/idempotency** — webhook delivery, provider received ID, XML hash vo firme, dodávateľ+číslo, outbound idempotency key | `test:einvoice-inbound`, `test:einvoice-outbound`, `test:einvoice-hardening` | PASS |
| G8 | **Recipient→company isolation** — firma iba z `provider_org_id`; BT-49 ≠ overený participant → `RECIPIENT_MISMATCH` (fail closed, bez konceptu, bez ACK); žiadny fallback na aktívnu firmu | `test:einvoice-inbound`, `test:einvoice-production-gate` | PASS |
| G9 | **Role tests** — owner/accountant áno; admin iba s `finance.view/manage`; employee nie; iný tenant nie | `test:einvoice-ui`, `test:einvoice-inbound`, `test:multi-company-einvoice-db` | PASS |
| G10 | **Accounting review** — účtovník/daňový poradca potvrdí: prijatý koncept ≠ zaúčtovanie, oddelenie doručenia a úhrady, archivácia mimo Esblu (VOP 21.3), dobropisy/zálohy | písomné stanovisko | OPEN |
| G11 | **Billing/entitlement decision** — finálny cenník (príjem zahrnutý pri inom platenom module?), nákladový model partnera (od 1. 12. 2026 platí sadzba/tx + min. 10 €/mes.) | rozhodnutie majiteľa | OPEN |
| G12 | **Explicitné schválenie majiteľa** — písomný pokyn „aktivuj produkčný eInvoice“ s dátumom, po splnení G1–G11 | správa majiteľa | OPEN |

## Poradie aktivácie (až po G1–G12)

1. Vercel `production` env: `ESBLU_EINVOICE_PROVIDER=efaktura_sk`, `ESBLU_EINVOICE_ENVIRONMENT=live`, `ESBLU_EFAKTURA_API_KEY` (sensitive), `ESBLU_EFAKTURA_WEBHOOK_SECRETS` (sensitive), `ESBLU_EINVOICE_LIVE_ENABLED=true`.
2. Redeploy; smoke: webhook bez podpisu → 401, cron → `configured:true`.
3. `einvoice_rollout` — IBA jedna interná pilotná firma (`stage = internal`), nie všetci.
4. Pilot: enroll vlastnej firmy reálnym kódom z FS (až teraz reálna Peppol registrácia).
5. Rozšírenie rolloutu po firmách, nikdy globálne.

Rollback: odstrániť `ESBLU_EINVOICE_LIVE_ENABLED` (alebo provider env) → `getEinvoiceProvider()` = `null` → všetko `NOT_CONFIGURED`; rollout riadky → `paused`.
