# E-Faktúra — API partner sandbox (eFaktura.sk), stav k 5. 10. 2026

Interný technický podklad. Neobsahuje kľúče, tokeny ani secrets. Produkcia eFaktúry nie je aktívna.

## 1. Model

- API zmluva s eFaktura.sk (Agent API, partnerský kľúč). White-label sa nepoužíva.
- Esblu nie je na portáli Finančnej správy sprostredkovateľ. Klient si zvolí eFaktura.sk a overovací kód FS zadá v Esblu.
- Nový partner účet = „Sandbox ako produkcia": `POST /v1/agent/organizations` už firmu nezapíše do Peppolu; treba `POST /v1/agent/peppol/enroll` s tokenom (v sandboxe ľubovoľný hex).

## 2. Čo sa zmenilo oproti starému sandboxu (white-label / mäkký sandbox)

| Starý predpoklad | Nový stav |
| --- | --- |
| Org sa automaticky zapíše do TEST Peppolu (auto-enroll) | Enroll je povinný; implementovaný `enrollPeppol` + `enrollCompany` |
| Self-send v jednej org („Tatra Servis", 9915:2099999999) | Dve syntetické firmy A → B (harness `scripts/einvoice-partner-sandbox-e2e.ts`) |
| Stav príjmu = `peppol_eligible` | Samostatný `reception_status` (pending / active / send_only / failed / deactivated) |
| `participant.failed` sa klasifikoval ako outbound (slovo „failed") | `participant.*` má vlastnú vetvu a RPC `esblu_einvoice_org_participant_event` |
| Feed `/v1/agent/events` nevyužitý | Adaptér `listPartnerEvents` + `processPartnerEventPage` (rovnaké spracovanie ako webhook) |
| Mapovanie firma ↔ org iba seedom | RPC `esblu_einvoice_org_upsert_provisioned` + `provisionCompany` |

Staré skripty `einvoice-efaktura-sandbox-smoke.ts` a `einvoice-sandbox-e2e.ts` sú označené DEPRECATED (viazané na starý účet).

## 3. Lokálne premenné (iba `.env.local` vo worktree, nikdy commit)

| Premenná | Hodnota | Poznámka |
| --- | --- | --- |
| `ESBLU_EINVOICE_PROVIDER` | `efaktura_sk` | |
| `ESBLU_EINVOICE_ENVIRONMENT` | `sandbox` | |
| `ESBLU_EFAKTURA_API_KEY` | nový partner sandbox kľúč (`efk_pk_test_…`) | live kľúč harness odmietne |
| `ESBLU_EFAKTURA_BASE_URL` | nenastavovať | default `https://api.efaktura.sk` |
| `ESBLU_EFAKTURA_WEBHOOK_SECRETS` | až po registrácii webhooku v portáli | vyžaduje verejnú HTTPS URL |
| `ESBLU_EINVOICE_LIVE_ENABLED` | **nenastavovať** | harness pri nastavení skončí |

SAPI-SK client ID/secret Esblu nepoužíva (Agent API). Nepatria do repo ani do env.

## 4. Dátový tok (podklad pre CLIA — fakty, nie právne závery)

**Onboarding firmy:** Esblu → eFaktura.sk: názov, IČO, DIČ, IČ DPH, adresa firmy. Späť: ID organizácie, stav.
**Aktivácia príjmu:** Esblu → eFaktura.sk: FS overovací kód (iba v požiadavke; Esblu ho neukladá ani neloguje). Späť: `enrolled` / `send_only` (+ AP host a názov iného poskytovateľa) / chyba; webhook `participant.activated` / `participant.failed`.
**Odoslanie:** Esblu vygeneruje UBL (EN 16931, Peppol BIS 3.0) z nemenného snapshotu → eFaktura.sk (connector/send) → Peppol → príjemca. Obsah: údaje dodávateľa a odberateľa (názov, adresa, IČO/DIČ/IČ DPH, prípadne kontakt), bankové údaje, položky, sumy, DPH, poznámky. Späť: ID podania, stav, dôkaz doručenia (allowlist polí), webhooky `peppol.document.sent` / `delivered` / `failed`.
**Príjem:** Peppol → eFaktura.sk → webhook `peppol.document.received` / `GET /v1/agent/peppol/received` → Esblu stiahne pôvodné XML, uloží ho nemenne (SHA-256), vytvorí **koncept** prijatej faktúry na kontrolu, potvrdí prevzatie (acknowledge). Neznámy dodávateľ sa založí ako obchodný partner (môže ísť o SZČO). Žiadny automatický finálny účtovný zápis.

**Čo ukladá Esblu:** mapovanie firma ↔ organizácia, stav príjmu, odoslané/prijaté UBL XML (privátne úložisko), stavy a dôkazy doručenia, hash tela webhooku (nie telo).
**Čo zostáva u eFaktura.sk:** organizácie klientov, doklady (podľa docs archív 10 rokov), prenosové záznamy, feed udalostí (90 dní).
**Nedá sa potvrdiť bez finálnej zmluvy/DPA:** rola eFaktura.sk (sprostredkovateľ / ďalší sprostredkovateľ), lokalita a subdodávatelia, retencia po skončení zmluvy, presný rozsah Prílohy č. 2.

## 5. Webhooky

- Endpoint `POST /api/einvoice/webhook` (HMAC `t=…,v1=…`, okno 300 s, konštantný čas, dedupe `X-Webhook-Id` + SHA-256 tela, iné telo pod rovnakým ID = 409, telo sa neukladá ani neloguje).
- **Reálne doručenie z eFaktura.sk overené (5. 10. 2026):** partner endpoint v portáli → preview → staging DB.
  `webhook.test` (200, bez mapovania org → `UNKNOWN_ORG`, nič sa nezmenilo); nové sandbox odoslanie A → B
  → `peppol.document.delivered` (A, outbound `delivered`) a `peppol.document.received` (B, XML rovnaký
  SHA-256 ako odoslané, koncept, ACK) spracované priamo z webhooku; replay z portálu (nové `X-Webhook-Id`,
  rovnaké telo) bez duplicitného inboundu, konceptu ani partnera. Starý testovací secret po prepnutí
  odmietnutý (401). Endpoint je zaregistrovaný bez `participant.*` udalostí (tie overené iba cez feed
  a syntetický podpis). Po teste: endpoint v portáli **vypnutý**, Protection Bypass **zrušený**.
- Endpoint na preview (`esblu-git-einvoice-port-esblu.vercel.app/api/einvoice/webhook`) beží proti staging DB. Podpis, okno, duplicita, konflikt tela, rotácia, neznáma org, cudzí tenant a limit veľkosti overené cez HTTP (5. 10. 2026). Registrácia partner endpointu v portáli vyžaduje prihlásenú session portálu (`POST /v1/partner/webhooks`, nie API kľúč); URL musí niesť `x-vercel-protection-bypass` (Vercel Authentication).
- Kým webhook nie je registrovaný, udalosti sa overujú cez partnerský feed `GET /v1/agent/events` (telo = presne telo webhooku).

## 6. Otvorené

- Migrácie `20261005100000_einvoice_partner_onboarding.sql` a `20261005110000_einvoice_enroll_error_code_active.sql` (oprava z E2E: neplatný FS kód pri aktívnom príjme už nezapíše chybový kód) sú aplikované IBA na staging `esblu-test` (5. 10. 2026). Produkcia: neaplikované.
- UI pre zadanie FS overovacieho kódu a zobrazenie stavu príjmu ešte nie je (serverová logika `enrollCompany` / `receptionView` pripravená).

## 7. Staging E2E (Vercel Preview × esblu-test × partner sandbox)

Prostredie (bez hodnôt):

| Časť | Stav |
| --- | --- |
| Vercel Preview | vetva `einvoice-port`, alias `esblu-git-einvoice-port-esblu.vercel.app`, chránené Vercel Authentication |
| Branch env (Preview, iba `einvoice-port`) | `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (staging), `CRON_SECRET`, `ESBLU_ACTION_CONFIRMATION_SECRET` (nové staging), `ESBLU_EINVOICE_PROVIDER/ENVIRONMENT`, `ESBLU_EFAKTURA_API_KEY` (partner `efk_pk_test_`), `ESBLU_EFAKTURA_WEBHOOK_SECRETS`, `ESBLU_STAGING_E2E_ENABLED/SECRET` |
| Protection Bypass for Automation | po teste zrušený (5. 10. 2026); nový test vyžaduje nový bypass + aktualizáciu URL v portáli |
| Driver E2E | `ESBLU_STAGING_E2E_ENABLED=false` (route vracia 404); rollout firiem A/B `paused`, allowlist syntetických e-mailov revoked |
| Lokálne hodnoty | iba mimo repa (`Documents\esblu-l3-staging.env`, `Documents\esblu-einvoice-staging-e2e.env`) |

Driver `POST /api/einvoice/staging-e2e` (`lib/einvoice/staging-e2e/guard.ts`): mimo preview vetvy
`einvoice-port` so staging DB, sandbox kľúčom a zapnutým prepínačom vracia 404. Akcie: `status`,
`ensure-users`, `provision`, `enroll` (iba sandbox kódy `ok` / `invalid` / `sendOnly`), `reception`,
`feed`, `feed-process` (iba udalosti firiem A–D), `outbound` (skutočná route s JWT syntetického ownera),
`isolation` (RLS matica cez user JWT). Seed / cleanup: `scripts/einvoice-staging-e2e-seed.sql`,
`scripts/einvoice-staging-e2e-cleanup.sql`.

Rollback stagingu: `supabase/rollback/20261005100000_einvoice_partner_onboarding_rollback.sql`
(ručne v SQL editore stagingu); legacy L3 organizácia (starý sandbox účet) bola vyradená z pollingu
`reception_status = 'deactivated'` — vrátenie: `reception_status = null`. Vypnutie drivera:
`ESBLU_STAGING_E2E_ENABLED` ≠ `true` (redeploy) alebo zmazanie branch env.
- Kurzor feedu sa zatiaľ neukladá v DB (cron fallback na feed je ďalší krok).
- Otázka na eFaktura.sk: čo presne znamená „Peppol kredit 0" v portáli.
