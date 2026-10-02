# E-Faktúra — sandbox E2E plán (Phase 1–6)

**Stav:** 2026-10-02.
Starší syntetický sandbox E2E (smoke, `scripts/einvoice-efaktura-sandbox-smoke.ts`) overil
iba adaptér. **Nepovažuje sa** za dôkaz aktuálnej architektúry.

## Úrovne

| Úroveň | Čo overuje | Infra | Stav |
| --- | --- | --- | --- |
| **L1 — lokálne** | Všetky moduly + všetky migrácie (PGlite) + scriptovaný poskytovateľ | žiadna | **PASS** (`npm run test:einvoice-*`) |
| **L2 — architektúra × reálny sandbox** | Rovnaké moduly ako produkcia (readiness, request, worker, reconcile, inbound processor, operátorské akcie, webhook handler) + PGlite so všetkými migráciami + **reálne** eFaktura.sk sandbox API | lokálny PC s prístupom na `api.efaktura.sk` + sandbox kľúč (mimo repa) | **PRIPRAVENÉ** (`scripts/einvoice-sandbox-e2e.ts`). Nespustené: Claude workspace nemá sieťový prístup na `api.efaktura.sk`. |
| **L3 — plný autentifikovaný E2E** | Skutočné Next.js routy (Vercel preview), Supabase PostgREST / Storage / RLS / Auth, cron, skutočné doručenie webhooku | **separátny staging Supabase** + Vercel preview s env (sandbox) + verejný webhook URL | **BLOCKED**: staging projekt neexistuje |

Produkčný Supabase (`fkpgvgvsmbpieduoatrt`) sa na sandbox test **nesmie** použiť. Projekty `esblu-test`
a `skitze-protokoly` sa automaticky nepoužívajú.

## L2 — spustenie (lokálne, PowerShell, z koreňa worktree)

```powershell
npm i --no-save @electric-sql/pglite@0.5.8   # iba ak PGlite nie je nainštalovaný
node --env-file=C:\Users\roiaj\Documents\efaktura-sandbox.env `
  --experimental-strip-types --no-warnings --import ./scripts/alias-loader.mjs `
  scripts/einvoice-sandbox-e2e.ts --confirm-sandbox --org=<UUID sandbox organizácie>
```

**Env súbor (mimo repa)** musí obsahovať:

- `ESBLU_EINVOICE_ENVIRONMENT=sandbox`
- `ESBLU_EFAKTURA_API_KEY=efk_pk_test_…`

**Organizácia:**

- Predvolene sa použije syntetická organizácia z predchádzajúceho smoke testu:
  IČO 87654326, DIČ 2099999999, participant `9915:2099999999`.
- Iné identity: `--ico=` / `--dic=`.
- Ak organizácia nemá aktívny Peppol účet (sandbox „ako produkcia“ od 1. 11. 2026, resp. pre nové účty od
  2. 10. 2026), treba `POST /v1/agent/peppol/enroll` s ľubovoľným hex tokenom. Robí sa to cez existujúci smoke
  skript alebo v portáli. **E2E skript organizácie nezakladá ani nemení** (fetch allowlist).

**Výstup:**

- konzola + `%TEMP%\esblu-einvoice-sandbox-e2e-report.json`,
- iba stavy, kódy, počty a prefixy hashov,
- žiadny kľúč, XML ani PII (iba syntetické údaje).

## Akceptačný tok a mapovanie na kroky skriptu

### Outbound

| # | Požiadavka | Krok | Dôkaz |
| --- | --- | --- | --- |
| 1 | test invoice draft | O1 | `document_status=draft` |
| 2 | canonical immutable snapshot | O2 | zmena položky po finalizácii je odmietnutá |
| 3 | readiness | O3 | `pre_send`, 0 issues |
| 4 | recipient verify | O4-O7 | volanie `GET /peppol/recipient` |
| 5 | provider preflight | O4-O7 | volanie `POST /peppol/preflight` |
| 6 | explicit send confirmation | O4-O7 | telo bez `confirm_send` = chyba |
| 7 | queue | O4-O7 | 202 `QUEUED`, `state=queued`, žiadny send |
| 8 | worker claim | O8-O9 | `claimed=1` |
| 9 | send | O8-O9 | `connector/send` |
| 10 | SENT | O10-O12 | reconciliation |
| 11 | delivery / rejection status | O10-O12 | `delivered` (sandbox doručuje hneď) alebo `sent` = PARTIAL |
| 12 | evidence | O10-O12 | iba allowlist kľúče |
| 13 | UBL hash / byte integrity | O13 | SHA-256 storage = riadok = dôkaz |
| 14 | retry | O14 | sieťová chyba pred odoslaním → backoff → ten istý kľúč → úspech |
| 15 | network / unknown outcome | O15 | stratená odpoveď po odoslaní → replay toho istého kľúča → v `/peppol/events` **jedno** `sent.queued` pre číslo dokladu (overenie P1 „never sends twice“) |
| 16 | reconciliation | O10, O16 | worker aj operátorská akcia, bez sendu |

### Inbound

| # | Požiadavka | Krok | Dôkaz |
| --- | --- | --- | --- |
| 1 | sandbox inbound invoice | I1-I4 | self-send (rovnaký DIČ) vytvorí prijatý doklad |
| 2 | webhook alebo polling | I1-I4 (poll), I12 (webhook offline) | skutočné doručenie webhooku iba v L3 |
| 3 | raw event verification | I12 | HMAC `t=,v1=`, zlý podpis = 401 |
| 4 | provider refetch | I1-I4 | `GET /received/:id/xml` |
| 5 | immutable XML store | I1-I4 | uložené bajty |
| 6 | hash | I5 | prijaté XML = odoslané UBL (byte-identické) |
| 7 | parse | I6-I9 | — |
| 8 | draft creation | I6-I9 | koncept `received` / `draft` / `efaktura_peppol` |
| 9 | duplicate | I8b | opätovný poll nevytvorí nový koncept |
| 10 | ACK | I6-I9 | `acknowledged_at` |
| 11 | ACK retry | I10 | opakovaný ACK bez chyby (idempotentný) |
| 12 | unsupported document type | I11 | dobropis vedie na `failed` / `UNSUPPORTED_PROFILE`, XML ostáva uložené |
| 13 | tenant isolation | I13 | firma B vidí 0, request vráti 404 bez volaní |

### Authz matrix

| Rola / stav | Krok | Očakávanie |
| --- | --- | --- |
| owner + nárok | A1 | 202 |
| accountant (finance.manage) + nárok | A2 | 202 |
| admin bez finance.manage | A3 | 403, bez volania poskytovateľa |
| admin s explicitným finance.manage | A4 | 202 |
| employee (aj s finance flagom) | A5 | 403 |
| bez nároku / expirovaný nárok | A6 | 403 `EINVOICE_ENTITLEMENT_REQUIRED` |
| cross-company | A7 / I13 | 404 |
| rollout pozastavený | A8 | 403 `ROLLOUT_NOT_ENABLED` |

Lokálne (L1) sú všetky tieto prípady pokryté aj v `scripts/einvoice-{outbound,inbound,ops,ui}-tests.ts`.
Výsledky sú PASS.

## L3 — čo musí vytvoriť používateľ (BLOCKER)

1. **Nový** Supabase projekt (napr. `esblu-staging`, región `eu-central-1`) — nie produkcia, nie
   `esblu-test` / `skitze-protokoly`. Do tohto projektu sa aplikujú všetky repo migrácie vrátane E-Faktúry.
2. Vercel **preview** prostredie (alebo samostatný projekt) s env:
   - Supabase staging URL a kľúče,
   - `ESBLU_EINVOICE_PROVIDER=efaktura_sk`, `ESBLU_EINVOICE_ENVIRONMENT=sandbox`,
     `ESBLU_EFAKTURA_API_KEY` (sandbox), `ESBLU_EFAKTURA_WEBHOOK_SECRETS`, `CRON_SECRET`.
   - **Nikdy** `ESBLU_EINVOICE_LIVE_ENABLED`.
3. Sandbox partner webhook v portáli eFaktura.sk na preview URL `/api/einvoice/webhook`.
4. Testovacie účty (owner, accountant, admin s finance a bez finance, employee) v staging Auth +
   riadky `einvoice_rollout` / `einvoice_organizations` / nárok `einvoice`.

Potom sa L3 vykoná rovnakými krokmi cez UI / API (Bearer JWT jednotlivých rolí).

## Výsledok prvého L2 behu (2026-10-02) a root causes

Prvý beh u používateľa: **13 PASS / 11 FAIL / 3 PARTIAL**. Authz matica A1–A8 bola PASS.
Forenzná analýza je v `docs/einvoice-phase6-readiness-audit.md` §7. Zhrnutie:

| Skupina | Root cause | Kategória |
| --- | --- | --- |
| O2 | Test čakal výnimku, RLS však zmení 0 riadkov bez chyby. Invariant platí. | chybný test |
| O4 | `parseOutboundRequestBody` vracia `{ok:false}` (neháže). Harness obchádzal route. | chyba harnessu |
| O8–O13, O16 (UUID `""`) | kaskáda O4 (`OUT1 = ""`) | kaskáda |
| I1–I10, I11 | stuby `listOrganizations` / `companyForOrg` v harnesse (poll nevidel organizáciu) + kaskáda O13 | chyba harnessu |
| O10–O12 | `delivered` iba zo statusu, ktorý ho pri eFaktura.sk nikdy nevráti | **produkčný bug, opravený** |
| O15 | slabé párovanie udalostí (formát `document_id`) | dôkaz v harnesse zlepšený |
| I12 | iba offline časť (podľa návrhu) | obmedzenie prostredia |

Harness teraz:

- volá produkčný route handler,
- má explicitné predpoklady krokov (kaskáda = `SKIP BLOCKED_BY`, nie FAIL),
- zaznamenáva diagnostiku príjmu,
- dá sa overiť offline cez `npm run test:einvoice-e2e-selftest` (27 PASS, 1 PARTIAL = I12).

**Rerun L2 je potrebný** (rovnaký príkaz ako vyššie, s `--org=<UUID>`).
Očakávanie: PASS okrem I12 (PARTIAL, offline). O10–O12 môže byť PARTIAL, ak sandbox ešte nevrátil
`delivery_status = delivered`.
