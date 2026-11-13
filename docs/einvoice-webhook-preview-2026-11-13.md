# eFaktúra — webhook Preview + staging audit (2026-11-13)

Vetva `einvoice-readiness-audit` (`8617dae`), Preview `dpl_8rngQpdpEXBG7oy7n785wAs2uequ` → alias
`esblu-git-einvoice-readiness-audit-esblu.vercel.app`, DB = staging `esblu-test`. Produkcia nedotknutá.
Žiadne secrets v tomto dokumente.

## A. Staging schema (read-only)

- Všetkých 15 eInvoice migrácií vetvy je v `esblu-test` aplikovaných; vetva nepridáva žiadnu migráciu.
- Odtlačok 98 objektov (10 tabuliek + stĺpce, RLS, 5 politík, granty anon/authenticated/service_role, 57 funkcií vrátane `secdef` a ACL, 13 triggerov, bucket `einvoice-documents`, storage politiky = žiadne) porovnaný so schémou produkcie (= repo):
  95 identických; 3 funkcie (`esblu_einvoice_enroll_attempt_begin`, `esblu_einvoice_inbound_create_correction`, `esblu_einvoice_org_upsert_provisioned`) sa líšia **iba SQL komentármi** (staging aplikovaný cez MCP bez komentárov) — po odstránení komentárov a whitespace md5 = repo. **Funkčný migration diff: žiadny.**
- Bucket `einvoice-documents`: private, 15 MB, application/xml + text/xml + application/pdf; žiadna klientská storage politika (iba service_role) — rovnako ako produkcia.
- Pozn.: b2b terms migrácie sú na stagingu pod staging menami (rev2/rev3) — mimo eInvoice.

## B. Preview konfigurácia (bez hodnôt)

| Premenná | Scope | Typ |
|---|---|---|
| `ESBLU_EINVOICE_PROVIDER=efaktura_sk` | preview, vetva `einvoice-readiness-audit` | encrypted |
| `ESBLU_EINVOICE_ENVIRONMENT=sandbox` | preview, vetva | encrypted |
| `ESBLU_EFAKTURA_API_KEY` (sandbox `efk_pk_test_…`, overené pred zápisom) | preview, vetva | sensitive |
| `ESBLU_EFAKTURA_WEBHOOK_SECRETS` (Esblu testovací secret pre podpísané HTTP testy) | preview, vetva | sensitive |
| `CRON_SECRET` (spoločný preview, rotovaný — pozri G) | preview (všetky vetvy bez vlastného) | sensitive |

Protection Bypass for Automation: vytvorený iba na čas testu a **zrušený** (0 aktívnych). Production: žiadna `ESBLU_EINVOICE_*` / `ESBLU_EFAKTURA_*`.

## C. Reálny HTTP webhook (Preview → staging DB, podpísané telá z reálneho sandbox feedu)

Telo = presné telo udalosti z eFaktura.sk feedu (`peppol.document.received` pre staging B po reálnom sandbox odoslaní A → B, doklad `WHMWEMEV0N`).

| Test | Výsledok |
|---|---|
| valid HMAC | 200 `PROCESSED` |
| invalid HMAC | 401 `INVALID_SIGNATURE` |
| expired timestamp (−3600 s) | 401 `REPLAYED_WEBHOOK` |
| duplicate X-Webhook-Id | 200 `DUPLICATE` |
| rovnaké telo, nové ID | 200 `DUPLICATE` |
| rovnaké ID, iné telo | 409 `REPLAYED_WEBHOOK` |
| neznámy orgId | 200 `UNKNOWN_ORG` (rejected, bez firmy) |
| `company_id` A v tele, orgId B | 200 `PROCESSED`, zapísané IBA k B |
| `peppol.document.delivered` (A) už spracované feedom | 200 `DUPLICATE` |

**Nevykonané:** doručenie podpísané samotným eFaktura.sk (vyžaduje registráciu endpointu v portáli prihlásenou session — pozri postup nižšie).

## D. Feed + webhook race

Súbežne: 2× webhook (to isté telo, rôzne ID), `GET /api/cron/einvoice-inbound` (poll), `GET /api/cron/einvoice-events` (feed 1204 → 3730).
Výsledok: **1 riadok** `einvoice_inbound` pre doklad (poll registered 1, webhooky aj feed našli existujúci), 0 duplicitných konceptov, 0 ACK navyše.
Koncept **nevznikol**: staging firma B nemá prijaté **DPA 1.3** → DB `ESBLU_COMPANY_DPA_NOT_ACCEPTED` → riadok ostáva `parsed` / `DRAFT_CREATE_FAILED` (retry), **bez ACK** (fail closed, správne). Plný draft + ACK na Preview vyžaduje prijatie DPA 1.3 syntetickým ownerom B v staging UI.

## E. Recipient / cross-company

- Reálny doklad: SBDH `Receiver` = BT-49 = `9915:2020147507` = participant B → prijatý do B; A: 0 inbound, 0 konceptov.
- Cross-company telo (company_id A, orgId B) → iba B. Neznáma org → rejected.
- RECIPIENT_MISMATCH: reálnym smerovaním poskytovateľa sa nedá vyvolať (Peppol doručí iba adresátovi); overené živým API testom J6 (reálne prijaté XML) a unit testami.

## F. XML / SBDH integrita (staging)

- Bajty od poskytovateľa: SHA-256 `5c144eda73d4…`, 5101 B, root `sh:StandardBusinessDocument`.
- Staging: `xml_sha256` = to isté, `xml_size_bytes` = 5101, storage objekt 5101 B pod `<company B>/…/<hash>.xml` (cesta obsahuje hash), `application/xml`.
- Vnorený UBL sa parsuje oddelene (číslo `WHMWEMEV0N`, envelope receiver = BT-49 = B).
- Zmena `xml_sha256` aj ako `postgres` → `ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE`.

## Staging dočasná zmena (vrátená)

`einvoice_rollout` syntetických E2E A/B: `paused → internal` na čas testu, potom späť `paused`.

## Manuálny postup — reálne doručenie z eFaktura.sk (sandbox)

1. Vercel → Project `esblu` → Settings → Deployment Protection → Protection Bypass for Automation → **Generate** (poznámka „eFaktura sandbox webhook“). Hodnotu nikam nekopírovať okrem kroku 2.
2. eFaktura.sk **sandbox** portál (prihlásený partner účet) → Webhooky → Pridať endpoint:
   `https://esblu-git-einvoice-readiness-audit-esblu.vercel.app/api/einvoice/webhook?x-vercel-protection-bypass=<BYPASS>`
   udalosti `peppol.document.*` + `participant.*`. **Žiadny production endpoint.**
3. Zobrazený `whsec_…` (iba raz) → Vercel env `ESBLU_EFAKTURA_WEBHOOK_SECRETS`, Preview, vetva `einvoice-readiness-audit`, typ Sensitive — **nahradiť** testovací secret hodnotou z portálu.
4. Redeploy Preview vetvy (env sa načíta iba pri builde).
5. Portál → „Send test“ (`webhook.test`) → očakávané 200 `UNKNOWN_ORG`/`IGNORED`; potom nové sandbox odoslanie A → B.
6. Po teste: endpoint v portáli vypnúť, bypass zrušiť.
