# eFaktúra — cleanup + branch review `einvoice-readiness-audit` (2026-11-13)

Base `main` = `3c6c01d`, branch = `ae0a06a` (4 commity, 0 za `main`). Produkcia eFaktúry HARD OFF. Žiadny merge, žiadny production deploy, žiadne produkčné DB zápisy.

## Cleanup (vykonané po schválení)

- Vercel Preview: zmazaných 14 premenných — 9× `einvoice-port` (CRON_SECRET, ESBLU_ACTION_CONFIRMATION_SECRET, ESBLU_EFAKTURA_WEBHOOK_SECRETS, ESBLU_EINVOICE_ENVIRONMENT, ESBLU_EINVOICE_PROVIDER, ESBLU_STAGING_E2E_ENABLED, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY), 4× `preprod-release-candidate` (ESBLU_EINVOICE_PROVIDER, ESBLU_EINVOICE_ENVIRONMENT, ESBLU_EFAKTURA_API_KEY, ESBLU_STAGING_E2E_ENABLED), 1× spoločný `ESBLU_STAGING_E2E_SECRET`.
- Ponechané: `einvoice-readiness-audit` (4 eInvoice premenné, do konca review), `CRON_SECRET` na `preprod-release-candidate` a spoločný preview `CRON_SECRET`.
- Lokálne `.env.local`: 3 riadky `ESBLU_EINVOICE_*` / `ESBLU_EFAKTURA_*` zakomentované (bez hodnôt); `getEinvoiceProvider()` s týmto súborom = `null`. Súbor je gitignored, necommitnutý.
- Zmazané: `.env.staging-e2e-partner-b.local`, pracovné súbory relácie, dočasné sandbox secrets.
- Staging účet `e2e-partner-b@example.com`: heslo nahradené náhodným (nikde neuložené) — staré heslo nepoužiteľné.
- Staging dáta (E2E A/B/C/D, webhook/ops záznamy, L3) ponechané ako audit evidence. L3 Tatra Servis rollout `internal` ponechaný (príjem `deactivated`, žiadne pending riadky; L3 setup ho zámerne nastavuje).
- Protection Bypass: 0 aktívnych. eFaktura.sk portál: Preview aj `einvoice-port` endpoint vypnuté, produkčný neexistuje (potvrdené majiteľom).

## Review — nálezy

| ID | Oblasť | Závažnosť | Nález | Stav |
|---|---|---|---|---|
| S1 | Webhook | stredná (pred produkciou) | Bez rate limitu (WAF) | návrh 600/60 s, nezapnuté |
| S2 | Webhook | nízka | `webhookBodySeen` počíta aj `rejected` (UNKNOWN_ORG): portal replay po neskoršom vytvorení mapovania org vráti DUPLICATE. Doklady obnoví poll (unacked list), participant udalosti feed (samostatný dedupe) | zdokumentované |
| S3 | Webhook / výkon | nízka | Dotaz na `body_sha256` bez indexu (sekvenčný scan) | odporúčaný index v budúcej migrácii (nie teraz) |
| S4 | Race | info | Súbežné rovnaké telo pod 2 ID sa spracuje 2×; DB idempotencia → 1 riadok / 1 koncept / 1 ACK (overené živo) | OK |
| S5 | Race | info | Hash tela feedu (JSON.stringify) ≠ hash surového webhooku → guard nededupuje naprieč cestami; downstream idempotencia OK (overené živo) | OK |
| M1 | Tenant | nízka | `RECIPIENT_MISMATCH` je trvalé zlyhanie bez reprocess v UI; treba operátorský postup v runbooku | otvorené |
| G1 | GDPR (main) | stredná | Company export obsahuje `einvoice_inbound/outbound` + XML/UBL, ale nie `einvoice_events` (história stavov) ani webhook záznamy; termination ich maže. Rozhodnúť, či história doručenia patrí do exportu | otvorené (mimo branch) |
| G2 | GDPR | info | Termination je zablokovaná, kým je firma zapísaná u poskytovateľa (`ESBLU_EINVOICE_PROVIDER_ENROLLED`); mazanie je explicitné, po exporte, s počtami | OK |
| P1 | Produkcia | vysoká → vyriešené | `.env.local` = produkčná DB + sandbox eInvoice | vyriešené (zakomentované) |

Multi-tenant: firma iba z unikátneho `(provider, environment, provider_org_id)`; neznáma org → rejected; BT-49 aj SBDH `Receiver` musia sedieť s participantom org (case-insensitive) pred `parsed` aj pred konceptom; žiadny active-company fallback (test `production-gate`); RLS: owner A pod RLS vidí 0 dokladov B (staging).

Integrita: presné bajty poskytovateľa (SBDH + UBL) → SHA-256 → `<company>/…/<hash>.xml`, `upsert:false`; hash overený pri každom čítaní; `xml_sha256` + cesta write-once (trigger, aj pre `postgres`).

Outbound (bez zmeny na branchi): stabilný `idempotency_key` na pokus, 1 aktívny pokus na faktúru, reconcile podľa `provider_submission_id` / `document_id`, 409 in-progress = retry, lease proti double-send.

Role (bez zmeny): owner/accountant áno, admin iba s `finance.view/manage`, employee nie; server-side (DB funkcie + API).

Feature gating: production bez env → `null`; live vyžaduje provider + live kľúč + `ESBLU_EINVOICE_LIVE_ENABLED=true` + `VERCEL_ENV=production` + rollout riadok; brána G1–G12.

## Validácia

| Kontrola | Výsledok |
|---|---|
| 115 `test:*` sád (vrátane 15 eInvoice) | PASS (production-gate vyžaduje git repo — PASS v klone) |
| `tsc --noEmit` | PASS |
| eslint zmenených `.ts` súborov | PASS |
| `next build` lokálne | NOT RUN (sandbox blokuje Google Fonts) |
| Vercel Preview build `ae0a06a` | PASS (`dpl_wxUKEeZTtmmcwamjGz4BswvdmntT` READY) |
| Staging smoke Preview `/` | PASS (200) |
| Živý sandbox A/B + provider-signed webhook + E2E A→B | PASS (12.–13. 11.) |
| Produkcia | 0 riadkov vo všetkých `einvoice_*`, 0 XML, migrácia `20261112193351`, webhook 503 `NOT_CONFIGURED` |
