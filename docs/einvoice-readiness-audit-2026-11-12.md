# eFaktúra / Peppol — readiness audit (2026-11-12)

Rozsah: technický, bezpečnostný, právny a účtovný audit eFaktúry nad `origin/main` 3c6c01d. STAGING / SANDBOX ONLY.
Produkcia eFaktúry **nezapnutá**, žiadny production key, žiadna reálna Peppol registrácia, žiadne reálne faktúry. Billing/Stripe/IAP OFF.
Brána: `docs/einvoice-production-gate-2026-11-12.md` (G1–G12).

## A. Architektúra

- Partner eFaktura.sk, Agent API (`POST /v1/agent/organizations`, `POST /v1/agent/peppol/enroll`, `GET /v1/agent/peppol/received`, `POST …/received/{id}/acknowledge`, `GET /v1/agent/events`). Esblu nie je Access Point ani sprostredkovateľ zapísaný vo FS.
- Adaptér `lib/einvoice/provider/efaktura-sk.ts` (host allowlist `api.efaktura.sk`, bez redirectov, limit veľkosti, timeout, prefix kľúča ↔ prostredie). Výber `provider/index.ts` (fail closed).
- Inbound: webhook / feed / poll → `syncInboundList` (zoznam IBA pre danú org) → `received → stored (XML + SHA-256) → parsed → draft_created|duplicate → acknowledged`; `failed` = trvalá chyba bez ACK.
- Outbound: finalizovaná faktúra → readiness → UBL (nemenný snapshot) → idempotentné `connector/send` → reconcile (stav iba dotazom u poskytovateľa).
- Cron (vercel.json): outbound send 1 min, reconcile 5 min, events feed 5 min, inbound poll 10 min, maintenance hodinovo — všetky `CRON_SECRET` a bez providera `configured:false`.
- API routes: 14 pod `app/api/einvoice/*` + `invoices/[id]/einvoice(-readiness)`; staging-e2e route s vlastnou poistkou (preview + allowlist vetvy + secret; `ESBLU_STAGING_E2E_ENABLED` OFF od 14. 10.).
- AI: v eInvoice ceste žiadne (deterministický UBL parser, bez DTD/entít). Výsledkom je **koncept** na kontrolu, nič sa nefinalizuje ani neúčtuje automaticky.

## B. DB / RLS (produkcia `fkpgvgvsmbpieduoatrt`, read-only overenie)

| Tabuľka | RLS | Klient | Riadky v prod |
|---|---|---|---|
| einvoice_organizations / outbound / inbound / events | on | SELECT iba `company_id = active AND esblu_my_finance_view()` | 0 |
| einvoice_webhook_events | on | SELECT ako vyššie + `company_id IS NOT NULL` | 0 |
| einvoice_rollout, _ops_audit, _enroll_attempts, _event_cursors, _webhook_rejections | on | žiadna politika, žiadny grant (iba service_role) | 0 |

- Storage `einvoice-documents`: private, 15 MB, xml/pdf, žiadna klientská politika (iba service_role cez serverové routes).
- Unikáty: `(provider, environment, provider_org_id)`, `(company_id, environment)`, `(provider, environment, provider_received_id)`, `(provider, environment, delivery_id)`, outbound `idempotency_key`.
- Write-once triggery: identita inbound/outbound/org, `xml_sha256` a cesta po zápise nemenné (`ESBLU_EINVOICE_INBOUND_IDENTITY_IMMUTABLE`).
- Service-role iba v `inbound/supabase-store.ts`, `outbound/supabase-store.ts`, `ops/supabase-store.ts`, `onboarding-supabase-store.ts`; RPC `esblu_einvoice_*` revoke od anon/authenticated.
- Env: Vercel **production nemá žiadnu** `ESBLU_EINVOICE_*` / `ESBLU_EFAKTURA_*`. Sandbox kľúč iba preview vetvy `preprod-release-candidate`; webhook secret iba preview `einvoice-port` (RC preview teda webhook vracia `NOT_CONFIGURED` — feed/poll fallback funguje).

## C. Sandbox A/B

| # | Scenár | Výsledok |
|---|---|---|
| 1–2 | enroll A, B (`a1b2c3`) | PASS offline (fake sandbox podľa docs); RC staging 13. 10. PASS |
| 3 | invalid `…dead` → 400 `participant.failed` | PASS offline, RC PASS |
| 4 | send_only `…beef` | PASS offline (poll ho vynechá), RC PASS |
| 5 | outbound A → B | PASS offline; RC: `delivered` |
| 6–7 | inbound B + received endpoint | PASS offline; RC PASS |
| 8–9 | webhook received + opakovaný webhook | PASS (`DUPLICATE`, iné telo pod tým istým ID 409, **nové: to isté telo pod novým ID → 200 DUPLICATE**) |
| 10 | duplicitný received dokument | PASS (provider ID, hash vo firme, dodávateľ+číslo) |
| 11 | retry po dočasnej chybe | PASS (timeout fetch → retry → acknowledged; ACK retry; webhook retry max 5) |
| 12 | nesprávny recipient | **opravené → FAIL CLOSED** (pozri E) |
| 13 | cross-company isolation | PASS (PGlite RLS + multi-company suite) |
| 14 | idempotentný import | PASS |

**Živý sandbox beh dnes NEPREBEHOL**: sieť pracovného prostredia nepovoľuje `api.efaktura.sk` (`EINVOICE_PROVIDER_NETWORK`, 0 volaní). Treba spustiť lokálne (príkaz v O). Offline harness 25/25 PASS.

## D. Webhook security

Oficiálne (developers.efaktura.sk/en/docs/webhooks): `X-Webhook-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 nad `"<t>.<raw body>"`, viac `v1=` pri rotácii (staré tajomstvo platí 24 h), okno 300 s, `X-Webhook-Id` = idempotency key, 10 opakovaní ~2,7 dňa, deaktivácia po 15 zlyhaniach. IP allowlist / mTLS: **nezdokumentované** → nepoužité.

Implementácia: zhoduje sa (raw body pred JSON, constant-time, rotácia, 300 s, limit 256 kB, telo sa neukladá ani neloguje — iba SHA-256, odpoveď iba `{code}`, dáta sa vždy znova načítajú od poskytovateľa, `data.mode` ≠ prostredie → IGNORED).

Nález + oprava: `X-Webhook-Id` nie je podpísaný → zachytený request sa dal v 300 s okne prehrať s novým ID (nový dedupe riadok, zbytočné volania poskytovateľa). **Pridané**: rovnaké podpísané telo pod iným ID → `200 DUPLICATE`, nič sa nezaznamená ani nevolá. (Pôvodne 409 — zmenené po živom teste: udalosť už spracovaná feed fallbackom by inak u poskytovateľa vyvolala retry a po 15 zlyhaniach deaktiváciu endpointu.)

Rate limit: v aplikácii iba počítadlo odmietnutí; per-instance limit na serverless nemá zmysel → **production blocker G5: Vercel WAF pravidlo** pre `/api/einvoice/webhook` (nastaviť pri aktivácii, nie teraz).

## E. Recipient → company mapping

Reťazec: webhook `data.orgId` slúži iba ako kľúč → `GET received` s kontextom tejto org → `esblu_einvoice_org_company` (unikát provider+env+org) → `company_id` → RLS. Neznáma org = `UNKNOWN_ORG` (rejected, nič sa nevytvorí). `company_id` z tela sa ignoruje. Žiadny fallback na aktívnu firmu (overené aj testom).

**Nález (kritický, opravený)**: BT-49 (príjemca v XML) ≠ participant organizácie bol iba *review reason* — koncept vznikol a ACK sa odoslal. Existujúci test dokonca očakával, že XML adresované A vytvorí koncept v B.
**Oprava**: `verifyInboundRecipient` (case-insensitive Peppol ID) pred `parsed` aj pred konceptom; chýbajúci participant org / chýbajúci BT-49 / iný príjemca → `failed RECIPIENT_MISMATCH` (detail `RECIPIENT_UNVERIFIED|RECIPIENT_MISSING|RECIPIENT_ENDPOINT_MISMATCH`), **bez konceptu, bez ACK**, reprocess sa neponúka, originál ostáva uložený. Explicitný cross-tenant test pridaný.

## F. Idempotency / dedupe

Webhook: delivery ID + hash tela (+ nový replay guard); feed: `feed:<event_id>` + kurzor s lease. Inbound: unikát provider ID, hash XML vo firme, transport ID, dodávateľ+číslo; ACK idempotentný u poskytovateľa. Outbound: idempotency key, 1 aktívny pokus na faktúru, 409 in-progress = retryable, lease proti timeoutom.

## G. Role matrix (DB `esblu_my_finance_view/manage` + API + UI)

| Rola | Zobraziť eFaktúry | Akcie (send/retry/reprocess/enroll) |
|---|---|---|
| owner | áno | áno (+ nárok, rollout, provider) |
| accountant | áno | podľa `finance.manage` |
| admin | iba s `permissions.finance.view/manage` | iba s `finance.manage` |
| employee | **nie** (hard false) | nie |
| iný tenant | nie (RLS + 404) | nie |

Všetky routes overujú JWT → aktívna firma → finance flag; UI iba vykresľuje povolené akcie zo servera.

## H. Originál XML

Presné bajty od poskytovateľa → SHA-256 → `einvoice-documents/<company>/inbound/<provider>/<id>/<sha>.xml`, `upsert:false`; pri každom čítaní sa hash prepočíta (`STORAGE_INTEGRITY`). `xml_sha256`/cesta write-once v DB. Odvodené dáta (koncept, parsed fields, `xml_totals`, review reasons) sú oddelené v `invoices`; finalizácia overí zhodu so súčtami XML. Stiahnutie „originálne XML“ = uložený objekt. Súlad s VOP 1.2 čl. 22.4.

## I. GDPR / DPA impact (nič nemenené)

- Tok: Esblu (sprostredkovateľ zákazníka) posiela cez **vlastnú** partner zmluvu dáta faktúr zákazníka eFaktura.sk; zákazník s eFaktura.sk nepodpisuje (pri „Potvrdenie príjmu cez vaše API“ mu eFaktura nepíše). ⇒ **eFaktura s. r. o. = ďalší sprostredkovateľ Esblu**. Prijímajúci AP a FS = samostatní prevádzkovatelia.
- Údaje: identifikácia a kontakty FO-podnikateľov a kontaktných osôb, IBAN, platobné a transakčné údaje, obsah dokladov.
- eFaktura (efaktura.sk/dpa 2026-11-25-v1, /privacy): prevažne EHP, DB Frankfurt (Neon AWS eu-central-1); sub-processors aj USA (Railway — API/AP, Vercel, Resend 30 dní), Cloudflare R2 global, Google Vertex/Gemini fallback mimo EÚ, OpenAI, Anthropic, Stripe…; DPF/SCC; oznámenie zmien 14 dní; výmaz po ukončení + 30 dní; zálohy ≤ 4 mesiace; 10 r. iba dôkaz doručenia bez obsahu; ISO 27001 „v príprave“; bez DPO. Partner zmluva + Príloha 2 (DPA) — text zatiaľ nemáme.
- Gap: DPA 1.3 Príloha 3, Privacy 1.4 a `/subprocessors` eFaktura.sk **neuvádzajú**.
- **DPA 1.3 čl. 9.3: oznámenie ≥ 15 dní pred zapojením; 9.4: námietka do 10 dní.** Spustiť oznámenie najneskôr **D-15 pred prvým produkčným prenosom** (odporúčané D-20 kvôli doručeniu) a až po podpise partner zmluvy a overení jej DPA (aby oznámenie obsahovalo presné miesto/transfery). Do vyriešenia námietky sa daná firma nezapojí.
- Otvorené: rozpor archivácia (developers docs „10 rokov dostupné“ vs. DPA „výmaz po ukončení“) → v zmluve; či AI sub-processors eFaktúry spracúvajú dokumenty v Agent/Peppol toku.

## J. Účtovné / právne hranice

VOP 1.2 čl. 22.2 (nie AP), 22.3 (doručenie ≠ úhrada; stav doručenia a úhrady oddelene), 22.4 (nemenný originál), 21.3 (nie zákonný archív), 23.3 (AI nie je poradenstvo) — **zhodné s implementáciou**. UI texty: export „nie je zákonný archív“, prijatý doklad = koncept „na kontrolu“, ACK = potvrdenie prevzatia poskytovateľovi, nie účtovné schválenie. Nenájdené tvrdenie, že Esblu je AP/archív alebo že doručenie = úhrada.

## K. Partner pricing / cost model (verejné zdroje 12. 11. 2026, bez DPH — overiť voči zmluve)

- do 30. 11. 2026 promo: 0 € do 1 000 tx/mes. pre API partnerov; min. 10 € iba v mesiaci s tx.
- od 1. 12. 2026 sadzba/tx podľa mesačného objemu (celý objem jednou sadzbou): ≤1k 0,055 €; 5k 0,039; 25k 0,029; 50k 0,0235; 100k 0,0215; 200k 0,0199; nad 0,0194.
- odoslaný doklad / dobropis = 1 tx, **prijatý = 0,5 tx** (≈ 0,0275 € pri ≤1k).
- **minimum 10 €/mes. od produkčnej aktivácie** (aj bez tx); ročný program ×1,00 vopred, mesačný ×1,20; bez setup fee; API volania sa neúčtujú (100 req/min).
- registrácia / organizácia / enroll: samostatný poplatok **nezdokumentovaný** (neuvádza sa); LIVE kľúč až po úhrade zálohovej faktúry (splatnosť 14 dní); bez kreditu live send → 402.
- White-label 99 €/mes. (2 500 tx) — nie náš model.
- Dopad na „príjem zdarma pri inom platenom module“: náklad Esblu ≈ 0,0275 €/prijatý doklad + fixných 10 €/mes. Rozhodnutie G11; žiadny entitlement ani účtovanie neimplementované.

## L. Production gate

`docs/einvoice-production-gate-2026-11-12.md` — G1 zmluva, G2 live key, G3 DPA/GDPR, G4 oznámenie D-15, G5 webhook + WAF, G6 živý A/B sandbox, G7 dedupe, G8 izolácia, G9 roly, G10 účtovné stanovisko, G11 billing, G12 explicitné schválenie majiteľa. Feature flag default OFF (4 nezávislé podmienky + rollout allowlist). Strážené `test:einvoice-production-gate`.

## M. Testy

Nové / upravené: `test:einvoice-production-gate` (8: flag OFF, live len pri 4 podmienkach, žiadny kľúč/.env v repo, cron/webhook fail closed, žiadny active-company fallback, reprocess, i18n, gate doc); `test:einvoice-inbound` 48 → 52 (recipient verify, wrong recipient, org bez participanta, webhook replay s novým ID; cross-tenant test teraz očakáva fail closed).
Regresia: **115/115 `test:*` PASS**, `tsc --noEmit` čisté, eslint dotknutých súborov čisté. Lokálny `next build` nemožný (sieť blokuje Google Fonts) — build overí Vercel.

## N. Zostávajúce blokery

1. Živý A/B sandbox beh (sieť prostredia) — spustiť lokálne.
2. Webhook secret pre sandbox preview, kde beží sandbox kľúč (RC vetva má kľúč, nemá secret) — a reálne overenie podpisu na sandbox doručení.
3. Partner zmluva + Príloha 2 DPA; vyjasnenie archivácie a AI sub-processors eFaktúry.
4. DPA/Privacy/`/subprocessors` aktualizácia + 15-dňové oznámenie.
5. Vercel WAF rate-limit pre webhook.
6. Účtovné stanovisko; billing rozhodnutie (od 1. 12. platí min. 10 €/mes. po aktivácii).
7. Peppol kredit v sandbox portáli 0 — ak sandbox odoslanie vyžaduje kredit, outbound A→B bude 402 (potvrdiť živým behom).
8. Nesúvisiace: lokálny `main` je pozadu za `origin/main` a má 41 necommitnutých zmien z iných relácií (nedotknuté).

## Doplnok — živý sandbox A/B (2026-11-12, vetva `einvoice-readiness-audit`)

Pozri `docs/einvoice-sandbox-ab-live-2026-11-12.md`. Živý beh našiel ďalšiu produkčnú chybu: eFaktura.sk
`GET /received/:id/xml` vracia **Peppol SBDH obálku** (`sh:StandardBusinessDocument` + vnorený UBL) → parser
odmietol každý prijatý doklad (`INVALID_XML / UBL_UNSUPPORTED_ROOT`). Opravené: originál (obálka + UBL) sa ukladá
nezmenený, parsuje sa vnorený UBL; SBDH `Receiver` musí tiež sedieť s participantom organizácie (fail closed).
