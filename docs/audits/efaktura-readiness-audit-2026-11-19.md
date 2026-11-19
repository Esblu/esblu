# eFaktura.sk / Peppol — audit pripravenosti na produkčné Agent API (2026-11-19)

**Typ:** read-only technický audit. Nič sa nemenilo (kód, DB, Vercel, eFaktura.sk portál). Nikto externý nebol kontaktovaný.
**Zdroj pravdy:** worktree `f8262b4` (vetva billing S15b + interný tarif, nadmnožina `origin/main` `12da726`); vetvy
`origin/einvoice-readiness-audit` (`0bc5c6b`), `einvoice-port` (`58d5a00`), `j10-clia-gdpr-reconciliation` (`e855664`) sú
v `f8262b4` celé obsiahnuté (ancestor). `einvoice-foundation` je historická (nie je v `main`, prekonaná `einvoice-port`).
**Produkcia** (podľa `docs/prod-cleanup-and-operator-plan-2026-11-19.md` a `docs/einvoice-production-gate-2026-11-12.md`):
eFaktúra **HARD OFF** — Vercel production bez `ESBLU_EINVOICE_*`/`ESBLU_EFAKTURA_*`, 0 riadkov vo všetkých `einvoice_*`,
webhook → `503 NOT_CONFIGURED`. Produkčnú DB som tentoraz nečítal (bez SQL nástroja) — stav je prevzatý z dokumentácie.
**Nie je to právne ani účtovné stanovisko.** Zmluvné rozhodnutia patria prevádzkovateľovi.

---

## 0. Zhrnutie (TL;DR)

| Oblasť | Stav | Verdikt |
|---|---|---|
| Sandbox integrácia (Agent API, A/B, webhook podpísaný poskytovateľom, SBDH) | živý A/B PASS 12.–13. 11.; offline 25/25; 115/115 testových sád | **pripravené** |
| Výber poskytovateľa klientom (PFS → eFaktura.sk), aktivačný kód (cesta B) | implementované, kód sa neukladá, limit pokusov | **pripravené**, chýba trvalý dôkaz poverenia |
| Elektronické poverenie (mandát) — dôkaz v Esblu | iba `einvoice_enroll_attempts` (30 dní, bez textu súhlasu) | **GAP (vysoké)** |
| Odosielanie (outbound) | nemenný UBL snapshot + SHA-256, explicitné „Odoslať“, idempotencia 3 vrstvy | **pripravené** |
| Príjem (inbound) + mapovanie na `company_id` | iba z `(provider, env, provider_org_id)`; BT-49 aj SBDH Receiver musia sedieť; fail closed | **pripravené** |
| Webhooky (HMAC, replay, idempotencia) | zhodné s docs; replay guard tela; WAF rate-limit chýba | **kód OK, WAF OPEN** |
| RLS / izolácia tenantov `einvoice_*` | SELECT iba finance + aktívna firma; zápisy iba service_role RPC | **pripravené** |
| Offboarding u poskytovateľa (deaktivácia Peppol) | **neimplementované** (`/peppol/deactivate` sa nevolá) | **GAP (vysoké)** |
| Dôkazy po ukončení firmy (príčinná súvislosť, nároky) | `einvoice_events`/outbound evidence sa pri termination mažú | **GAP (vysoké, rozhodnutie)** |
| Archivácia / nemennosť originálov | DB write-once + `upsert:false` + hash; nie WORM; Storage nie je v DB zálohe | **čiastočné** |
| Vlastná fakturácia Esblu (Stripe) vs. povinná e-faktúra | žiadny návrh, žiadna väzba Stripe invoice ↔ e-faktúra | **GAP (stredné, pred 2027)** |
| Brána G1–G12 | G7–G9 PASS; G1–G6, G10–G12 OPEN | **NO-GO** do splnenia |

---

## 1. Architektúra a stav integrácie (fakty z kódu)

- Model: **API partner** (nie white-label). Esblu nie je Peppol Access Point ani sprostredkovateľ zapísaný vo FS
  (`docs/einvoice-partner-sandbox-2026-10-05.md`, VOP 1.2 čl. 22.2).
- Adaptér `lib/einvoice/provider/efaktura-sk.ts` (763 r.): allowlist hostu `api.efaktura.sk`, bez redirectov, limit veľkosti,
  timeout, prefix kľúča ↔ prostredie (`efk_pk_test_` / `efk_pk_live_`), 402 → `EINVOICE_PROVIDER_INSUFFICIENT_CREDIT`.
- Výber providera `lib/einvoice/provider/index.ts` — **fail closed**: `live` iba ak súčasne `ESBLU_EINVOICE_ENVIRONMENT=live`,
  `ESBLU_EINVOICE_LIVE_ENABLED=true`, `VERCEL_ENV=production` a kľúč existuje; inak `null`. Ďalšie nezávislé brány:
  `einvoice_rollout` (firma + prostredie), `einvoice_organizations.environment` (live so schémou 9915 odmietnutá v DB).
- Cron (`vercel.json`): outbound send 1 min, reconcile 5 min, events feed 5 min, inbound poll 10 min, maintenance hodinovo;
  bez providera vrátia `configured:false` a nič nevolajú.
- Routes: 14× `app/api/einvoice/*` + `invoices/[id]/einvoice(-readiness)`; `staging-e2e` má vlastnú poistku (OFF).

## 2. Poverenie klienta, výber poskytovateľa, aktivačné kódy

### 2.1 Tok (implementovaný)

1. Owner/oprávnený používateľ v Esblu → `POST /api/einvoice/reception/enroll`
   (`lib/einvoice/ui/reception-server.ts` `enrollReception`).
2. Server: JWT → aktívna firma zo servera (`esblu_my_active_company_id`) → `finance.view` **a** `finance.manage`
   → nárok `einvoice` → provider nakonfigurovaný → `einvoice_rollout` povolený.
3. Ak firma nemá org u poskytovateľa: `provisionCompany` → `POST /v1/agent/organizations` (idempotentné podľa IČO; vyžaduje
   obchodné meno, IČO 6–8 číslic, **DIČ 10 číslic** z `company_billing_profile`); mapovanie do `einvoice_organizations`
   s `onboarding_snapshot` (presne odoslané firemné údaje).
4. Klient si **sám na portáli FS (PFS) zvolí eFaktura.sk ako PDS** a overovací kód zadá v Esblu; UI text:
   „Potvrdzujem, že som v portáli Finančnej správy zvolil(a) eFaktura.sk ako poskytovateľa pre túto firmu.“
   Telo musí byť presne `{verification_code, confirm_enroll:true}` (`parseEnrollBody`), kód hex 2–128.
5. `POST /v1/agent/peppol/enroll` → `enrolled` / `send_only` (príjem drží iný PDS) / chyba; následne webhook
   `participant.activated|failed|deactivated` alebo feed `/v1/agent/events`.

### 2.2 Ochrany (PASS)

- Overovací kód FS sa **neukladá, nevracia ani neloguje** (ani hash); enroll sa automaticky neopakuje (nie je idempotentný).
- Limit pokusov (`einvoice_enroll_attempts`, runbook §11): firma 5/15 min a 20/24 h, používateľ 10/h → `429`.
- Neplatný kód nezhorší už aktívny príjem (DB pravidlo `esblu_einvoice_org_apply_enroll`).
- `send_only` sa nikdy nezobrazí ako aktívny príjem; poll ho vynecháva.
- DPA brána (J10.1): DB guard na `einvoice_organizations` → bez prijatej DPA firmy sa registrácia nezaloží.

### 2.3 Nálezy

| ID | Závažnosť | Nález | Odporúčanie (technické) |
|---|---|---|---|
| **D-M1** | **vysoká** | **Dôkaz poverenia sa trvalo neeviduje.** `confirm_enroll:true` sa iba overí, neuloží. `einvoice_enroll_attempts` drží firmu, používateľa, čas a výsledok **30 dní** a potom sa maže; nie je tam verzia/hash textu potvrdenia, rola, ani participant ID. Pri novej zmluve (výnimka z limitu pre „nezmenené údaje poskytnuté riadne povereným klientom“) bude Esblu musieť preukázať, **kto, kedy, v akej role a s akým vyhlásením** aktiváciu vykonal. | Nová append-only tabuľka (napr. `einvoice_authorizations`): `company_id`, `user_id`, rola, `statement_version` + `sha256` textu, `display_locale`, `provider_org_id`, `participant_id`, výsledok, `created_at` (DB čas); **nikdy kód**. Archivácia pri zrušení firmy podobne ako `legal_acceptance_evidence` (retencia = rozhodnutie prevádzkovateľa/CLIA). Rovnako pre deaktiváciu. |
| D-M2 | stredná | Kto smie aktivovať: `finance.manage` (owner, účtovník, admin s oprávnením). Oprávnenie „konať za firmu“ voči FS nie je v Esblu výslovne vyhlásené (na rozdiel od DPA brány: „Potvrdzujem, že som oprávnený/á konať za túto firmu“). Kód z PFS síce dokazuje prístup k PFS danej firmy, ale Esblu to nemá zaznamenané. | Rozšíriť vyhlásenie o oprávnenie (vzor DPA 1.3 `authority_confirmed`) alebo obmedziť enroll na ownera — **rozhodnutie prevádzkovateľa**. |
| D-M3 | stredná | Odvolanie mandátu klientom na PFS / zmena PDS: `participant.deactivated` sa spracuje (stav `deactivated`), ale v UI ani v alertoch nie je výslovná notifikácia ownerovi a v DB nie je trvalý záznam „mandát ukončil klient“. | Udalosť zapísať do evidencie z D-M1; owner notifikácia. |
| D-M4 | nízka | Zmena IČO/DIČ/obchodného mena po provision: `onboarding_snapshot` ostáva pôvodný; synchronizácia s poskytovateľom nie je implementovaná. | Pred live: pravidlo „zmena identity = nová registrácia / manuálny postup“, runbook. |

## 3. Odosielanie (outbound)

- Iba explicitná akcia používateľa `confirm_send:true` (`lib/einvoice/outbound/request.ts`), `finance.manage`, nárok, readiness
  (EN 16931 + SK pravidlá), **nemenný snapshot** faktúry → kanonické UBL → SHA-256 → overenie príjemcu u poskytovateľa
  (`GET /recipient`, `found:false` → `422 RECIPIENT_NOT_FOUND`, `lookup_unavailable` → 503) → uloženie presných bajtov
  (content-addressed, nikdy neprepíše) → `queued`. Odosiela iba worker.
- `einvoice_outbound`: `requested_by`, `ubl_sha256`, `idempotency_key` (unikát), **max. 1 aktívny pokus na faktúru**
  (partial unique index), terminálne stavy sú v DB nemenné, `evidence` iba allowlist polí (vrátane `ubl_sha256` od poskytovateľa,
  `delivery_state`, `delivered_at`), transport ID (AS4 `messageId`, SBDH `transactionId`) write-once.
- Retry: max. 8 pokusov s backoffom (≤ 6 h cap), všetko v rámci 24 h TTL Idempotency-Key poskytovateľa; 409 „in progress“ =
  retry s tým istým kľúčom a telom; nový pokus po `failed/rejected` iba operátorskou akciou (cooldown, audit).
- Dedupe u poskytovateľa: SHA-256 UBL v organizácii + číslo dokladu + typ (P1–P18 CLOSED, `efaktura-provider-conformance-2026-10-08.md`).
- Typy: 380, 388 (SK faktúra k prijatej platbe), 381 dobropis, 383 ťarchopis; 384 (opravná) a CreditNote 396/532 → manuálne.

**Hodnotenie:** pre výnimku „nezmenené údaje dodané klientom“ je outbound dobre doložiteľný (kto odoslal, presný hash odoslaného
dokumentu, hash potvrdený poskytovateľom, časy, transport ID). Podmienka: tieto záznamy musia prežiť dostatočne dlho (pozri §8).

| ID | Závažnosť | Nález |
|---|---|---|
| D-O1 | stredná | `402 INSUFFICIENT_CREDIT` je v `FAIL` sade → pokus sa stane terminálne `failed` a ďalší pokus vyžaduje operátora. Webhook `usage.limit_exceeded` je klasifikovaný ako `other` → **ignorovaný**; `lib/einvoice/ops/alerts.ts` nemá alert na kredit. Pri vyčerpaní kreditu (prepaid program) by hromadne zlyhali odoslania bez skorého varovania. → alert na `usage.limit_exceeded` + počet `INSUFFICIENT_CREDIT` za hodinu. |
| D-O2 | nízka | Kolízia čísel dokladov s natívnou eFaktúra appkou tej istej organizácie (P18) → `rejected/ingest`. Postup je zdokumentovaný; v UI odporúčam zrozumiteľnú hlášku. |

## 4. Príjem (inbound) a mapovanie príjemcu na `company_id`

- Reťazec: webhook/feed/poll → `data.orgId` slúži **iba ako kľúč** → `GET received` v kontexte tejto org →
  `esblu_einvoice_org_company` (unikát `provider, environment, provider_org_id`) → `company_id` → RLS. `company_id` z tela sa
  ignoruje; **žiadny fallback na aktívnu firmu** (test `test:einvoice-production-gate`).
- `verifyInboundRecipient`: BT-49 (EndpointID príjemcu) **aj** SBDH `Receiver` musia sedieť s participantom organizácie
  (case-insensitive) pred `parsed` aj pred konceptom; inak `failed RECIPIENT_MISMATCH` (`RECIPIENT_UNVERIFIED|MISSING|ENDPOINT_MISMATCH`),
  **bez konceptu, bez ACK**, originál ostáva; operátorský postup runbook §12.
- Originál: presné bajty (SBDH obálka + UBL) → SHA-256 → `einvoice-documents/<company>/inbound/<provider>/<id>/<sha>.xml`,
  `upsert:false`; hash sa overuje pri každom čítaní (`STORAGE_INTEGRITY`); `xml_sha256` a cesta write-once triggerom
  (aj pre `postgres`). Výsledok = **koncept na kontrolu**, nič sa automaticky nefinalizuje ani neúčtuje; ACK až po koncepte.
- Dedupe: provider received ID (unikát), hash XML vo firme, transport ID, dodávateľ + číslo; ACK idempotentný.

**Hodnotenie:** PASS. Kritická chyba z 12. 11. (BT-49 iba review reason) a SBDH parsing sú opravené a pokryté testami.

## 5. Webhooky

| Kontrola | Implementácia | Stav |
|---|---|---|
| Podpis | `X-Webhook-Signature: t=…,v1=…`, HMAC-SHA256 nad `"<t>.<raw body>"`, raw bajty pred JSON, `timingSafeEqual`, viac `v1=` (rotácia 24 h), viac secretov v env | PASS |
| Okno / replay | ±300 s (`STALE`/`FUTURE` → 401 `REPLAYED_WEBHOOK`); to isté telo pod iným `X-Webhook-Id` → `200 DUPLICATE` (nič sa nespracuje); iné telo pod tým istým ID → 409 | PASS |
| Idempotencia | unikát `(provider, environment, delivery_id)`; `failed` spracovanie sa smie zopakovať (ohraničene); feed `feed:<event_id>` + kurzor s lease | PASS |
| Dôveryhodnosť obsahu | z tela iba ID; dokument/stav sa **vždy znova načíta** od poskytovateľa; `data.mode` ≠ prostredie → `IGNORED` | PASS |
| Minimalizácia | telo sa neukladá ani neloguje (iba SHA-256), odpoveď iba `{code}`, limit 256 kB (čítané po častiach) | PASS |
| Odolnosť | interné zlyhanie → `200 ACCEPTED_RETRY_LATER` (endpoint sa po 15 zlyhaniach nevypne), poll/feed dobehne | PASS |
| Rate limit | iba počítadlo odmietnutí v appke; **Vercel WAF pravidlo chýba** (návrh 600/60 s) | **OPEN (G5)** |
| Index `body_sha256` | migrácia `20261113100000` (staging overené); v produkcii **neoverené** v tomto audite (prod má 108 záznamov histórie, čo naznačuje aplikovanie `20261113*`, ale nie je to v `service-intervention-log`) | overiť read-only |
| Live secret | `ESBLU_EFAKTURA_WEBHOOK_SECRETS` v production neexistuje; partner webhook sa registruje v portáli (session login), secret sa zobrazí raz | OPEN (pri aktivácii) |

Drobnosti: (a) ak `data.mode` v live chýba, kontrola prostredia sa preskočí — oddelené kľúče/secrety pre sandbox a live to
kompenzujú; (b) S2 z 13. 11.: `webhookBodySeen` počíta aj `rejected UNKNOWN_ORG` — doklady obnoví poll (nízke riziko).

## 6. RLS a izolácia tenantov

| Tabuľka | RLS | Klient | Zápis |
|---|---|---|---|
| `einvoice_organizations`, `_outbound`, `_inbound`, `_events` | on | SELECT iba `company_id = esblu_my_active_company_id() AND esblu_my_finance_view()` | iba service_role RPC |
| `einvoice_webhook_events` | on | ako vyššie + `company_id IS NOT NULL` | service_role |
| `einvoice_rollout`, `_ops_audit`, `_enroll_attempts`, `_event_cursors`, `_webhook_rejections` | on | žiadna politika, žiadny grant | service_role |
| Storage `einvoice-documents` | private, 15 MB, xml/pdf | žiadna klientská politika | iba serverové routes |

- Service-role iba v 4 store moduloch; RPC `esblu_einvoice_*` revoke od `anon/authenticated`.
- Role: owner/accountant áno; admin iba s `finance.view/manage`; employee **nie** (hard false); iný tenant 404 + RLS (staging: owner A vidí 0 dokladov B).
- **Hodnotenie:** PASS. Odporúčanie: pred live zopakovať read-only kontrolu RLS/grantov v produkcii (grants manifest replay).

## 7. Chybové stavy, retry a redelivery

| Scenár | Správanie | Stav |
|---|---|---|
| Timeout pri odoslaní (výsledok neznámy) | retry s tým istým Idempotency-Key a telom (≤ 24 h TTL); `retry_exhausted_unknown` → operátor (`GET /submissions/{document_id}`) | PASS |
| 409 „práve sa spracúva“ | odložený retry, ten istý kľúč | PASS |
| `ERROR`/`failed` u poskytovateľa | terminálne; nový pokus iba operátor (cooldown, audit) | PASS |
| MLS `rejected` po AS4 | stav ostáva `sent` (P5b) — produktové rozhodnutie zdokumentované | info |
| Webhook nedoručený / endpoint vypnutý | feed `/v1/agent/events` (90 dní) s kurzorom + poll `received?acknowledged=false` | PASS |
| Feed udalosť opakovane zlyhá | po 5 pokusoch vyčerpaná + alert; requeue/rewind/resolve funkcie s auditom (runbook §10) | PASS |
| Zlyhanie ACK | ACK retry idempotentný | PASS |
| Výpadok > 90 dní (mimo feedu) | poll nepotvrdených dokladov ostáva | PASS |
| Kredit vyčerpaný | `failed` bez alertu (D-O1) | **GAP** |
| Redeploy počas behu | lease (`locked_until`) proti dvojitému odoslaniu | PASS |

## 8. GDPR, retencia, nemennosť, archivácia

### 8.1 Čo sa uchováva a ako dlho (technický stav)

| Záznam | Retencia v kóde | Poznámka |
|---|---|---|
| `einvoice_inbound/outbound`, XML/UBL v Storage | počas existencie firmy; nikdy automaticky | mazanie iba v termination transakcii po exporte (alebo `waived`) |
| `einvoice_events` (append-only) | s firmou | DELETE iba v kaskáde/termination; TRUNCATE zakázaný |
| `einvoice_webhook_events`, `_rejections` | 90 dní (maintenance) | iba hash tela |
| `einvoice_enroll_attempts` | 30 dní | bez kódu |
| `einvoice_ops_audit` | bez definovanej purge | bez payloadu |
| `company_export_runs` | **bez retencie** (bez FK, prežije firmu) | iba metadáta + hash |
| `company_terminations` | „5 r.“ podľa dokumentácie, **nie je v purge** | agregované počty, bez obsahu |

### 8.2 Nálezy

| ID | Závažnosť | Nález | Technický návrh / otázka |
|---|---|---|---|
| **D-G1** | **vysoká (rozhodnutie)** | Pri ukončení firmy sa mažú aj `einvoice_events`, `einvoice_outbound.evidence`, transport ID a hash odoslaných/prijatých dokladov. Esblu potom **nemá dôkaz príčinnej súvislosti** (čo, kedy, s akým hashom bolo odovzdané poskytovateľovi), ak by nárok prišiel po ukončení — či už od zákazníka alebo v spore s poskytovateľom podľa novej zmluvy (limit 10 000 €/rok, pravidlá kauzality). | Zvážiť minimálny pseudonymizovaný „transmission ledger“ Esblu (IDs poskytovateľa, `ubl_sha256`/`xml_sha256`, smer, časy, stav, `requested_by` hash), **bez obsahu dokladu**, na vlastnom právnom základe Esblu (ochrana nárokov), s retenciou zosúladenou s premlčaním. Vyžaduje rozhodnutie prevádzkovateľa + CLIA (účel „ochrana právnych nárokov“ už v Zásadách 1.4 existuje — 5 r.). |
| **D-G2** | **vysoká** | **Offboarding u poskytovateľa nie je implementovaný.** Kód nevolá `POST /v1/agent/organizations/{id}/peppol/deactivate`. Termination je pri `EINVOICE_PROVIDER_ENROLLED` zablokovaná (správne fail closed), ale zákazník nemá samoobslužnú cestu von → ukončenie firmy/zmluvy si vyžiada manuálny zásah operátora; organizácia u poskytovateľa ostane registrovaná (Peppol adresát „žije“ ďalej). | Implementovať deaktiváciu (owner, potvrdenie, záznam v D-M1 evidencii, 409 pri rozbehnutých prenosoch → retry), potom odstránenie blokácie. Do vtedy runbook pre operátora. |
| D-G3 | stredná | Nemennosť je logická (DB triggery, `upsert:false`, hash pri čítaní), nie fyzická: service_role/operátor môže objekt v Storage zmazať; Supabase Storage **nie je** v DB zálohe (7 d); objekt lock/WORM nie je. VOP 21.3/22.6: Esblu nie je zákonný archív — zákazník archivuje 10 r. sám (export). | Pred live: (a) periodická kontrola konzistencie hash ↔ objekt (existuje `esblu_einvoice_storage_consistency` — overiť plánovanie), (b) zvážiť sekundárnu kópiu XML (iný bucket/región) alebo pravidelný export pripomienky zákazníkovi, (c) v zmluve s poskytovateľom vyjasniť, či jeho 10-ročná dostupnosť (developers docs) platí aj po ukončení org/zmluvy — DPA poskytovateľa hovorí „výmaz po ukončení + 30 dní, 10 r. iba dôkaz doručenia bez obsahu“ (rozpor zaznamenaný 12. 11.). |
| D-G4 | stredná | eFaktura.sk nie je v Zásadách 1.4, DPA 1.3 prílohe 3 ani `/subprocessors`; DPA 1.3 čl. 9.3 vyžaduje oznámenie ≥ 15 dní (námietka do 10 dní). | G3/G4 — po podpise zmluvy a overení jej Prílohy 2 (DPA). Pozri `clia-technical-delta-2026-11-19.md`. |
| D-G5 | nízka | Sub-processori poskytovateľa (podľa jeho verejného DPA `2026-11-25-v1`, stav 12. 11.): USA (Railway API/AP, Vercel, Resend), Cloudflare R2 global, AI (Vertex/Gemini, OpenAI, Anthropic). Nie je známe, či AI sub-processori spracúvajú dokumenty v Agent/Peppol toku. | Otázka do zmluvného procesu (nie technická zmena Esblu). |
| D-G6 | nízka | Company export obsahuje `einvoice_events` + `einvoice_lifecycle.{json,csv}` a originály; interné logy nie (manifest). Termination vyžaduje server-side dôkaz dokončeného exportu (`company_export_runs`, migrácia `20261113110000`) — v produkcii **overiť**, či je aplikovaná. | read-only overenie pri ďalšom release checku |

## 9. Technické dôsledky novej zmluvy (stav 19. 11. 2026) — iba fakty a otázky, nie právne posúdenie

Kontext od prevádzkovateľa: poskytovateľ navrhol limit zodpovednosti **10 000 € / kalendárny rok**, pravidlá príčinnej
súvislosti, výnimku pre **nezmenené údaje dodané riadne povereným klientom**, vylúčenie zodpovednosti „v rozsahu zavinenia
poskytovateľa(?)“ a výnimky z limitu vrátane **čl. 82 GDPR**; doručená nová zmluva s novým číslom.

| # | Zmluvný prvok | Technický dôsledok pre Esblu | Stav v kóde | Otázka na rozhodnutie prevádzkovateľa |
|---|---|---|---|---|
| T1 | Výnimka „nezmenené údaje od povereného klienta“ | Esblu musí vedieť preukázať (a) poverenie klienta, (b) že odovzdané bajty = to, čo klient potvrdil. | (b) **áno** (snapshot, `ubl_sha256`, `requested_by`, hash od poskytovateľa v `evidence`); (a) **nie trvalo** (D-M1) | Akú formu dôkazu poverenia chce prevádzkovateľ evidovať a ako dlho? |
| T2 | Pravidlá kauzality / „v rozsahu zavinenia“ | Treba vedieť oddeliť chybu Esblu vs. poskytovateľa vs. siete: časová os, kódy chýb, transport ID, hash. | áno počas života firmy (`einvoice_events`, AS4/SBDH ID); po termination **nie** (D-G1) | Uchovávať minimálny ledger po ukončení? Ako dlho? |
| T3 | Limit 10 000 €/rok | Esblu VOP 1.2 čl. 36 limit voči zákazníkom nemá (náhrada podľa § 379 ObZ). Technicky: rollout po firmách (`einvoice_rollout`) umožňuje riadiť expozíciu (počet firiem/objem). | rollout allowlist existuje | Rollout tempo / strop objemu kým nie je zmluvný rámec voči zákazníkom zosúladený? (právne posúdenie mimo tohto auditu) |
| T4 | Výnimka čl. 82 GDPR z limitu | Technické opatrenia, ktoré znižujú riziko na strane Esblu: telo webhooku a XML sa nelogujú, signed URL ≤ 1 h, RLS, service_role izolácia. | PASS | — |
| T5 | Nová zmluva / nové číslo | Číslo zmluvy nie je v kóde ani konfigurácii (správne). Live kľúč sa vydá až po podpise a úhrade zálohovej faktúry; kľúč je viazaný na partnerský účet. | — | Zapísať číslo zmluvy a dátum do interného registra sprostredkovateľov (`gdpr-subprocessors.md` je zastaraný, pozri CLIA delta) a do `einvoice-production-gate` G1. |
| T6 | Cenník od 1. 12. 2026 | min. 10 €/mes. od produkčnej aktivácie aj bez transakcií; odoslaný = 1 tx, prijatý = 0,5 tx. | entitlement/účtovanie eFaktúry zákazníkom **neimplementované** (G11) | Aktivovať až s rozhodnutím o cene. |
| T7 | Uhradenie kreditu / prepaid | 402 bez alertu (D-O1). | GAP | — |

## 10. Vlastná fakturácia Esblu (predplatné cez Stripe) pri povinnej e-faktúre

### 10.1 Súčasný stav

- Stripe Checkout `mode=subscription` (`lib/billing/providers/stripe.ts`): `billing_address_collection: required`,
  `tax_id_collection.enabled: true`; **Stripe automaticky vytvára Stripe Invoice** pri každom cykle (číslovanie a PDF Stripe).
  Esblu Stripe invoice iba číta (`invoice.paid` → normalizovaná platba pre reporting, refund audit s ID faktúry a obdobím).
- Esblu **nevystavuje** vlastný daňový doklad za predplatné; v DB nie je tabuľka „predajné faktúry Esblu“ ani väzba
  Stripe invoice ↔ doklad Esblu. Párovanie je mesačný manuálny postup (`docs/finance/stripe-monthly-reconciliation-template.csv`).
- Údaje odberateľa v Stripe (adresa, tax ID) sa zbierajú v Checkoute **nezávisle** od `company_billing_profile` /
  `company_legal_identities` (IČO/DIČ overené cez RPO/RÚZ).
- Esblu s.r.o. je od 16. 11. 2026 registrovaná pre DPH podľa **§ 7a** (nie platiteľ § 4) — `payment-channels-economics-2026-11-18.md`.
  Či a odkedy sa na Esblu vzťahuje povinnosť vystavovať štruktúrované e-faktúry, je **otázka pre účtovníčku/daňového poradcu**
  (otázka č. 5 v § 6 toho dokumentu je otvorená).
- Stripe billing je v produkcii vypnutý; produkcia neobsahuje firmu „Esblu s.r.o.“ ako zákazníka Esblu (plán vyčistenia 19. 11.).

### 10.2 Riziko duplicít

Ak by Esblu posielalo e-faktúru cez Peppol **a zároveň** zákazník dostal Stripe Invoice (e-mail/PDF z Billing Portal) s iným
číslom alebo obsahom, vzniknú dva doklady k jednému plneniu (riziko dvojitého zaúčtovania/odpočtu u zákazníka, nesúlad
číselných radov). Rovnako refundácia v Stripe nevytvára dobropis — opravný doklad by chýbal alebo vznikol dvakrát.

### 10.3 Odporúčaný dizajn (návrh, nič neimplementované)

**Princíp: jeden daňový doklad na jednu Stripe Invoice; Stripe = platobný a zúčtovací systém, nie zdroj daňového dokladu.**

1. **Zdroj pravdy dokladu = Esblu.** Interná firma prevádzkovateľa v Esblu (vlastný číselný rad, napr. `ESB-2027-xxxxx`)
   vystaví faktúru z udalosti `invoice.paid` (pre platbu kartou ide o faktúru k prijatej platbe — typ dokladu potvrdí účtovníčka;
   SK kód 388 je už podporovaný).
2. **Väzbová tabuľka** (napr. `billing_own_invoices`): `stripe_invoice_id` **UNIQUE**, `invoice_id` (Esblu doklad) UNIQUE,
   `company_id` zákazníka, `kind` (invoice / credit_note), `stripe_credit_note_id|refund_id` UNIQUE, `einvoice_outbound_id`,
   stav doručenia. Vytvorenie cez idempotentné RPC (rovnaký vzor ako `billing_events` dedupe) → opakovaný webhook, catch-up
   (`/v1/events`) aj reconciliation vytvoria **najviac jeden** doklad.
3. **Stripe invoice nie je daňový doklad pre zákazníka:** v Stripe vypnúť zasielanie invoice e-mailov zákazníkovi, v
   Billing Portáli skryť históriu faktúr (alebo ich jasne označiť ako „potvrdenie platby“), a v Esblu sprístupniť vlastné doklady
   (Nastavenia → Predplatné → Doklady). Nastavenie Stripe je mimo kódu — **rozhodnutie prevádzkovateľa** + účtovníčka.
4. **Doručenie:** ak má zákazník aktívny Peppol participant (`0245:<DIČ>` z overenej identity, lookup `found:true`) →
   Esblu outbound cez **vlastnú** organizáciu Esblu u eFaktura.sk (pilot G12 stage 1 je práve interná firma); inak PDF e-mailom
   (Resend — doplniť do evidencie sprostredkovateľov) alebo stiahnutie v appke. Zákazník s eFaktúrou v Esblu dostane doklad
   do svojho inboundu ako **koncept** (žiadna automatická finalizácia — duplicitu u zákazníka rieši existujúci inbound dedupe).
5. **Identita odberateľa** pre doklad brať z `company_legal_identities`/`company_billing_profile` (overené IČO/DIČ), nie z
   Stripe Checkout polí; Stripe `customer` aktualizovať z Esblu (jeden smer), nie naopak.
6. **Refundácie/spory:** `charge.refunded` (už auditované s ID faktúry, obdobím a rozsahom) → dobropis 381 s väzbou na pôvodný
   doklad, idempotentne podľa `refund_id`; čiastočná refundácia = dobropis na sumu.
7. **Účtovanie poplatkov Stripe** zostáva mimo (daňová faktúra Stripe za poplatky; § 7a samozdanenie) — nesúvisí s dokladmi zákazníkom.
8. **Alternatíva B** (Stripe Invoice = daňový doklad, konvertovaný na UBL s rovnakým číslom): menej kódu, ale Esblu nekontroluje
   náležitosti (§ 74 ZDPH), číselný rad ani nemennosť; opravy cez Stripe credit notes. Neodporúčam bez stanoviska účtovníčky.
9. Testy pred live: dvojitý `invoice.paid`, catch-up po výpadku, refund pred/po doručení e-faktúry, zlyhanie Peppol → PDF fallback
   bez druhého čísla dokladu.

## 11. Brána G1–G12 — aktualizovaný stav

| # | Podmienka | Stav 19. 11. |
|---|---|---|
| G1 | Partnerská zmluva + Príloha 2 (DPA), program, úhrada | **OPEN** — nová zmluva doručená, rozhoduje prevádzkovateľ |
| G2 | Live kľúč iba ako Vercel sensitive env production | OPEN (vydáva sa po úhrade) |
| G3 | DPA/GDPR (Zásady, DPA príloha 3, `/subprocessors`, smernica, transfery) | OPEN |
| G4 | Oznámenie sprostredkovateľa D-15 (odporúčané D-20) | OPEN |
| G5 | Webhook security + **Vercel WAF** | kód PASS / WAF OPEN |
| G6 | A/B sandbox + reálne HTTP doručenie webhooku | API PASS 26 + PARTIAL 1; Preview HTTP PASS 13. 11. — uzavrieť dokumentačne |
| G7 | Dedupe/idempotencia | PASS |
| G8 | Izolácia príjemca → firma | PASS |
| G9 | Role | PASS |
| G10 | Písomné stanovisko účtovníčky | OPEN |
| G11 | Cenník/entitlement | OPEN |
| G12 | Písomný pokyn prevádzkovateľa | OPEN |

**Navrhované doplnky do brány (nové, z tohto auditu):** G13 trvalý dôkaz poverenia (D-M1); G14 offboarding u poskytovateľa
(D-G2) alebo podpísaný manuálny runbook; G15 rozhodnutie o dôkazovom ledgeri po termination (D-G1); G16 alert na kredit (D-O1);
G17 read-only overenie, že `20261113100000` a `20261113110000` sú v produkcii.

## 12. Gapy zoradené podľa rizika

| Poradie | ID | Riziko | Typ | Blokuje live? |
|---|---|---|---|---|
| 1 | G1/G3/G4 | Bez podpísanej zmluvy/DPA a oznámenia sprostredkovateľa nesmie ísť žiadny produkčný prenos | zmluva/GDPR | áno |
| 2 | D-M1 | Chýba trvalý dôkaz poverenia — oslabuje výnimku „riadne poverený klient“ | tech + rozhodnutie | odporúčam áno |
| 3 | D-G1 | Strata dôkazov kauzality po ukončení firmy | rozhodnutie + tech | odporúčam rozhodnúť pred live |
| 4 | D-G2 | Bez offboardingu u poskytovateľa nie je samoobslužné ukončenie; zákazník „uviaznutý“ | tech | áno pre verejný rollout (pilot môže ísť s runbookom) |
| 5 | G5 WAF | DoS/náklady na webhook endpoint | infra | áno |
| 6 | §10 | Duplicita Stripe faktúry vs. e-faktúry Esblu; chýbajúci dobropis pri refunde | návrh + účtovníctvo | nie pre eFaktúru zákazníkov; áno pre vlastnú povinnú e-fakturáciu |
| 7 | D-O1 | Vyčerpaný kredit bez alertu | monitoring | odporúčam áno |
| 8 | D-G3 | Archív nie je WORM; Storage mimo DB záloh; rozpor retencie poskytovateľa | tech/zmluva | nie (VOP 21.3), ale vyjasniť |
| 9 | D-M2/D-M3 | Oprávnenie konať za firmu; notifikácia pri odvolaní mandátu | UX/tech | nie |
| 10 | G10/G11 | Účtovné stanovisko, cenník | účtovníctvo/biznis | áno |

## 13. Rozhodnutia, ktoré môže urobiť iba prevádzkovateľ

1. Podpis novej zmluvy s eFaktura.sk (limit 10 000 €/rok, kauzalita, výnimky) — vrátane prípadných otázok CLIA/advokátovi.
2. Forma a retencia dôkazu poverenia klienta (D-M1) a kto smie aktiváciu vykonať (owner vs. `finance.manage`) (D-M2).
3. Či uchovávať minimálny pseudonymizovaný dôkazový ledger prenosov po ukončení firmy a ako dlho (D-G1).
4. Pilot bez samoobslužného offboardingu (iba interná firma + runbook) vs. najprv implementácia deaktivácie (D-G2).
5. Program poskytovateľa (ročný/mesačný), cena eFaktúry pre zákazníkov, strop rolloutu (G11, T3).
6. Model vlastných dokladov Esblu za predplatné (Esblu doklad + Stripe ako platba vs. Stripe Invoice ako doklad) a nastavenie
   Stripe e-mailov/portálu (§10) — po stanovisku účtovníčky k § 7a a povinnej e-fakturácii.
7. Termín oznámenia sprostredkovateľa (D-15/D-20) a obsah oznámenia (G4).
8. Písomný pokyn G12.

## 14. Overené súbory (výber)

`lib/einvoice/provider/{index,efaktura-sk,efaktura-sk-webhook}.ts`, `lib/einvoice/inbound/{webhook,processor,mapping}.ts`,
`lib/einvoice/onboarding.ts`, `lib/einvoice/ui/{reception-server,reception-routes}.ts`, `lib/einvoice/outbound/{request,policy}.ts`,
`app/api/einvoice/webhook/route.ts`, `app/api/einvoice/reception/enroll/route.ts`, `lib/billing/providers/stripe.ts`,
`supabase/migrations/20261002100000_einvoice_foundation.sql`, `…20261007100000_einvoice_event_ops_enroll_limit.sql`,
`…20261013100000_einvoice_company_deletion_guard.sql`, `…20261112110000_company_termination_workflow.sql`,
`…20261113110000_company_export_evidence.sql`, `docs/einvoice-production-gate-2026-11-12.md`,
`docs/einvoice-readiness-audit-2026-11-12.md`, `docs/einvoice-branch-review-2026-11-13.md`,
`docs/einvoice-production-provider-checklist.md`, `docs/einvoice-operations-runbook.md`,
`docs/payment-channels-economics-2026-11-18.md`, `docs/launch-remaining-steps-2026-11-19.md`, `legal/terms/1.2.md` (čl. 21–22, 36).
