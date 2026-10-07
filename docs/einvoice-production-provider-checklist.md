# E-Faktúra — produkčný checklist poskytovateľa (eFaktura.sk Agent API)

**Stav:** 2026-10-02 · branch `einvoice-port` · nič nie je nasadené ani aktivované
**Zdroje (oficiálne, verejné):** OpenAPI `https://developers.efaktura.sk/agent-api.en.yaml`
(stiahnuté 2026-10-02) a stránky `developers.efaktura.sk/en/docs/*`: webhooks, connector,
receiving, sandbox, production-onboarding, going-live, access, changelog.
Nič v tomto dokumente nie je odhad. Čo dokumentácia neuvádza, je označené **PROVIDER QUESTION**.

---

## 1. Potvrdené fakty (s väzbou na náš kód)

### A. Odosielanie (outbound)

| Téma | Potvrdené v dokumentácii | Stav v Esblu |
| --- | --- | --- |
| Autentifikácia | Hlavička `X-API-Key` + `X-Organization-Id` (UUID organizácie). Partner kľúče `efk_pk_test_…` / `efk_pk_live_…`. Rovnaká base URL `https://api.efaktura.sk`, prostredie určuje prefix kľúča. Existuje aj OAuth (Bearer, viazaný na jednu firmu), ten nepoužívame. | `lib/einvoice/provider/efaktura-sk.ts` posiela `X-API-Key`, `X-Organization-Id` a `Idempotency-Key`. Prefix kľúča sa kontroluje voči prostrediu. **Phase 6:** live sa zapne iba s `ESBLU_EINVOICE_LIVE_ENABLED=true` a zároveň `VERCEL_ENV=production`. |
| Endpoint odoslania | `POST /v1/agent/peppol/connector/send` (scope `invoice:send`): validácia, rezervácia kreditu a zaradenie do frontu v jednom volaní. | Používa sa s `autoRepair:false`, `dispatch:"now"`. Poskytovateľ nesmie poslať iný dokument, než aký Esblu zahashovalo. |
| Idempotency-Key | **Povinný.** Bez neho príde 400. Rovnaký kľúč s iným telom vráti 409. Replay s rovnakým kľúčom a telom vráti **uloženú odpoveď a „never sends twice“**. Docs odporúčajú stabilný kľúč, nie náhodný pri každom retry. | Jeden kľúč na pokus (riadok `einvoice_outbound`). Retry po neistom výsledku posiela **ten istý kľúč a tie isté bajty**; telo je deterministické (UBL zo storage + SHA-256 + uložený príjemca). |
| Výsledok odoslania | Vždy `200`; výsledok je v poli `status` (`queued` / `rejected` / `validated` / `staged`). `reason`: validation, needs_repair, credit, prepayment_overdue, validator_unavailable, ingest. 4xx sú iba protokolové chyby (400, 401, 403, 409). | `mapEfakturaConnectorStatus()`. Neznámy `status` vedie na `EINVOICE_PROVIDER_UNKNOWN_STATE` a stav sa nemení. |
| Stav odoslania | `GET /v1/agent/peppol/status/{invoiceId}`: `not_sent`, `SCHEDULED`, `QUEUED`, `SENDING`, `SENT`, `DEFERRED`, `ERROR`. `ERROR` = trvalé zlyhanie, po oprave sa dá poslať znova. `DEFERRED` = poskytovateľ opakuje sám. `DELIVERED` príde iba cez webhook / evidence. | Reconciliation dopytuje stav. `ERROR` sa mapuje na `failed` (podľa docs je terminálne). `DEFERRED` sa mapuje na `deferred` a čaká sa. **Opravené po L2:** status `SENT` + dôkaz `delivery_status.state = delivered` (hash overený) vedie na `delivered`. Predtým sa `delivered` v produkcii nedal dosiahnuť. |
| Doručenie / dôkaz | `GET /v1/agent/peppol/sent/{invoiceId}/evidence`: `delivery_status` a vrstvy AS4 / MLS / business response, transakcie. 404 znamená, že prenos ešte neexistuje. Audit trail: `GET /v1/agent/peppol/events` (AS4 message id, SBDH InstanceIdentifier, UBL SHA-256). | Dôkaz sa ukladá iba cez allowlist (`sanitizeDeliveryEvidence`). Stav `delivered` sa nastaví iba vtedy, ak hash v dôkaze sedí s uloženým UBL. |
| Peppol identifikátory | Produkcia `0245:<DIČ>`, sandbox `9915:<DIČ>`. Surové UBL (connector) musí mať v sandboxe v `EndpointID` schému **9915**. Recipient lookup a preflight akceptujú v sandboxe alias `0245:`. | **Phase 6:** readiness blokuje live odberateľa so schémou 9915 a sandbox odberateľa bez 9915. DB nepovolí live organizáciu s participant `9915:`. |
| Dátum vyhotovenia | Changelog 2026-09-28: do 31. 12. 2026 živé odoslanie zlyhá (`INVOICE_ISSUE_DATE_TOO_OLD`), ak je faktúra staršia ako 10 dní. Changelog 2026-09-23: od 1. 1. 2027 zlyhá (`INVOICE_ISSUE_DATE_NOT_SEND_DATE`), ak sa BT-2 ≠ dnešok („per FS FAQ a § 85o zákona o DPH“). Testovacie odoslania sú vyňaté. | **Phase 6:** readiness tieto pravidlá vyhodnocuje (Europe/Bratislava). V live blokujú odoslanie, v sandboxe a pri koncepte iba upozornia. |
| Rate limit | Partner kľúče ≥ 100 req/min. Hlavičky `X-RateLimit-*`. Pri 429 treba rešpektovať `Retry-After`. | 429 vedie na retry s backoffom a známym výsledkom (neprijaté). `Retry-After` sa zapíše do chyby. |
| Kredit / platby | Pri nedostatku kreditu `402 INSUFFICIENT_CREDIT`. Sandbox je zadarmo. | Mapuje sa na `EINVOICE_PROVIDER_INSUFFICIENT_CREDIT` (terminálne). |

### B. Príjem (inbound)

| Téma | Potvrdené | Stav v Esblu |
| --- | --- | --- |
| Formát webhooku | Telo je obálka `{ event, timestamp, data }`. `data.orgId` je **vždy** prítomné. Pri test odoslaniach je `data.mode = "test"`. Outbound udalosti majú v `data` `invoiceId`, `state`, `messageId` a `transactionId`; `received` má `senderName`, `senderParticipantId`, `documentNumber`, `documentType`, `total` a `currency`. | **Opravené v Phase 6:** predtým sa čítalo iba `organization_id` / `org_id` / `invoice_id`, takže reálne webhooky by skončili `UNKNOWN_ORG` / `IGNORED` (zachránil by to iba poll). Teraz sa číta `data.orgId` / `data.invoiceId`, snake_case je fallback. Udalosť z inej siete (`data.mode`) sa ignoruje. |
| Podpis | `X-Webhook-Signature: t=<unix>,v1=<hex>`, `v1 = HMAC-SHA256(secret, "<t>.<raw body>")` (lowercase hex). Počas rotácie prídu dva segmenty `v1=` (24 h). Staršie ako 5 min sa odmietne. | `verifyEfakturaWebhookSignature`: raw bajty, porovnanie v konštantnom čase, okno ±300 s, viac secretov. **Zhodné s docs.** |
| Hlavičky | `X-Webhook-Event`, `X-Webhook-Id` (UUID doručenia, idempotenčný kľúč; replay pošle **rovnaké** ID), `X-Webhook-Timestamp`. | Dedupe podľa `X-Webhook-Id` + SHA-256 tela (`einvoice_webhook_events`). Telo sa neukladá. |
| Opakovania | 2xx do ~10 s. Inak 10 opakovaní počas ~2,7 dňa (5 s … 24 h). Po 15 zlyhaniach po sebe sa endpoint vypne a príde e-mail. | Odpovedáme 200 aj pri internom zlyhaní spracovania (doručenie je zaznamenané, poll to dobehne). Endpoint teda neodpadne. |
| Pull fallback | `GET /v1/agent/peppol/received?acknowledged=false` (limit 1–100, offset; `from`/`to`; zoradenie od najnovších). Nový je aj partner feed `GET /v1/agent/events?after=<cursor>` (90 dní, dedupe podľa `event_id`). | Poll cron používa `received?acknowledged=false`. Feed `/v1/agent/events` zatiaľ nie je využitý (pozri §3). |
| Stiahnutie dokumentu | `GET /v1/agent/peppol/received/{id}/xml` vráti pôvodný UBL (404, ak nie je). Detail obsahuje `ubl_sha256`; receipt evidence má MLS. Archív poskytovateľa je **10 rokov**. | XML sa vždy stiahne znova od poskytovateľa, uloží byte-identicky so SHA-256 a z webhooku sa nepoužije nič okrem ID. |
| ACK | `POST /v1/agent/peppol/received/{id}/acknowledge`, **idempotentný** (`already_acknowledged:true`), nemení `status` v appke poskytovateľa. | ACK až po vytvorení konceptu. ACK retry je bezpečný. |
| Typy dokladov | `document_type` napr. `invoice`, `credit_note`. Dedupe poskytovateľa zahŕňa typ dokladu (changelog 2026-08-01). | Dobropis zatiaľ označíme na manuálnu kontrolu (Phase 5). |

### C. Overenie príjemcu

- `GET /v1/agent/peppol/recipient?peppolId=` vždy vráti `200`. `found:false` nie je chyba. `lookup_unavailable` treba riešiť ako nedostupnosť (503 u nás).
- Slovenský Peppol participant: `0245:<DIČ>` (10 číslic). V sandboxe `9915:<DIČ>`.
- **Rozlíšenie identifikátorov:** participant / EndpointID (BT-34/BT-49) je `0245:DIČ`. IČ DPH (`SK` + DIČ) je **VAT identifikátor** (BT-31/BT-48). IČO je právny registračný identifikátor (BT-30/BT-47, schéma 0158). Esblu ich drží oddelene (`electronic_address(_scheme_id)`, `vat_identifier`/`ic_dph`, `ico`).
- V testovacom režime (Agent API invoice send) sa príjemca odvodzuje iba z DIČ kupujúceho. Pre connector (raw UBL) platí `EndpointID` z dokumentu.

### D. Produkčný onboarding (partner)

1. **Partner prístup:** v portáli `developers.efaktura.sk` → „Request production access“ → zmluva (podpis e-mailovým kódom) → vygenerovanie `efk_pk_live_…` (zobrazí sa iba raz). Pri katalógových podmienkach sa schvaľuje automaticky.
2. **Klientska firma** (každá Esblu firma):
   - `POST /v1/agent/organizations` (scope `org:provision`, idempotentné podľa IČO).
   - Firma si na portáli FS (PFS) zvolí eFaktúru ako PDS.
   - Mandát príde webhookom (cesta A: potvrdzovací e-mail firme), alebo sa urobí `POST /v1/agent/peppol/enroll` s FS verifikačným tokenom (cesta B; pre live **povinný**).
   - Hotovo je pri `claim_status:"claimed"`, `peppol_eligible:true` a pridelenom `participant_id`.
   - Cesta C (white-label, potvrdenie cez naše UI) sa zapína v portáli.
3. **Partner webhook** sa registruje v **portáli** (session login, nie API kľúčom). Secret sa ukáže iba raz.
4. **Poplatky** (going-live, 2026-10-02):
   - Sandbox je zadarmo.
   - Do 30. 11. 2026 (partner promo): €0 do 1 000 tx/mesiac, nad limit podľa pásma, minimum €10 bez DPH mesačne (white-label: platformové minimum €99).
   - Od 1. 12. 2026 volume cenník €0,055–€0,0194/tx. Odoslaný doklad = 1 tx, prijatý = 0,5 tx. Bez setup fee, minimum €10 bez DPH. Ročný (×1,00, platený vopred) alebo mesačný (×1,20) program.
5. **Kontakt:** `podpora@efaktura.sk` (support), `sales@efaktura.sk` (org:provision scope / predaj).
6. **Sandbox mení správanie:**
   - Od 2. 10. 2026 pre nové účty, od 1. 11. 2026 pre všetky: `POST /organizations` už nezapíše firmu do TEST siete a treba `enroll` s tokenom (v sandboxe stačí ľubovoľný hex). Bez aktívneho Peppol účtu je odoslanie odmietnuté (`reason: ingest`).
   - Test tokeny `…dead` / `…beef` simulujú chyby.
7. **Offboarding:** `POST /v1/agent/organizations/{id}/peppol/deactivate` (409 pri rozbehnutých prenosoch). Prijaté doklady, UBL a dôkazy ostávajú dostupné cez API.

---

## 2. Neoverené / chýbajúce v dokumentácii — PROVIDER QUESTION

| # | Otázka pre eFaktura.sk | Prečo je to dôležité |
| --- | --- | --- |
| P1 | **Ako dlho sa drží `Idempotency-Key`** na `connector/send` (TTL)? Je rozsah per organizácia, alebo per API kľúč? | Náš worker opakuje ten istý kľúč najviac 8× počas ~2 h. Ak by TTL bolo kratšie, replay by mohol odoslať druhý raz. |
| P2 | Ako sa správa replay s rovnakým kľúčom, kým **prvý request ešte beží** (súbežnosť / in-flight)? 409, čakanie, alebo dve spracovania? | Timeout na našej strane a potom retry, kým prvý request ešte beží. |
| P3 | Existuje **lookup podania podľa `Idempotency-Key`** alebo externej referencie (bez opätovného odoslania)? Môžeme na tento účel bezpečne použiť replay toho istého kľúča po vypršaní pokusov? | Teraz `findSubmissionByIdempotencyKey` vracia vždy „unknown“, takže `retry_exhausted_unknown` vyžaduje manuálny zásah. |
| P4 | Môže `ERROR` v `/peppol/status` nastať aj po tom, čo AS4 už doručil (napr. chyba MLS)? Je `ERROR` po prijatí sieťou možný? | `ERROR` berieme ako terminálne a povoľujeme nový pokus (nový kľúč). Ak nie je terminálne, hrozí dvojité doručenie. |
| P5 | Môže `peppol.document.delivered` prísť **pred** stavom `SENT` v `/status`? Aký je garantovaný vzťah `status` ↔ `evidence.delivery_status`? Je `evidence.delivery_status.state = delivered` autoritatívny dôkaz doručenia (MLS)? | Reconciliation teraz berie `delivered` z dôkazu pri statuse SENT. |
| P5b | `evidence.delivery_status.state = rejected` (MLS rejected po AS4): je to konečné? Má integrátor povoliť nový pokus? | Stav sa zatiaľ nemení (`sent`). Treba produktové rozhodnutie a migráciu guardu. |
| P5c | Obsahuje export `GET /peppol/events` vždy `invoice_id` pri `sent.*` udalostiach, a aký je formát `document_id` v sandboxe? | L2 krok O15 páruje podania podľa `invoice_id`. |
| P6 | Presná hodnota `data.mode` pre live (`"live"`), alebo je pri live pole vynechané? | Filter prostredia na webhooku. |
| P7 | Obsahuje payload webhooku vždy nejaké **podpísané** ID doručenia (v tele), alebo iba hlavičku `X-Webhook-Id`? | Hlavička nie je súčasťou podpisu. Replay s inou hlavičkou v rámci 5 min prejde dedupe (dopad je iba opätovné stiahnutie). |
| P8 | Stránkovanie `GET /peppol/received`: docs uvádzajú `limit/offset`, OpenAPI `page/per_page`. Ktoré platí? | Poll fallback. |
| P9 | Odporúčajú pre partnera `GET /v1/agent/events` (cursor) namiesto `received?acknowledged=false` ako primárny fallback? Platí 90-dňová retencia aj pre sandbox? | Návrh zmeny poll mechanizmu. |
| P10 | **Zmluva / DPA:** je eFaktura.sk voči Esblu sprostredkovateľ (čl. 28 GDPR), alebo samostatný prevádzkovateľ / PDS s vlastným vzťahom k FS? Názov právnickej osoby, IČO, sídlo. | Zoznam subprocesorov, DPA (pozri `docs/einvoice-clia-change-request.md`). |
| P11 | Kde sú dáta fyzicky hostované (krajina / cloud, zálohy)? Sú nejaké prenosy mimo EHP (vrátane sub-sprostredkovateľov a Access Pointu)? | Medzinárodné prenosy. |
| P12 | Retencia: 10-ročný archív poskytovateľa platí aj pre **odoslané** doklady? Čo sa stane s dátami po ukončení zmluvy partnera alebo klientskej firmy? | Retencia a ukončenie služby. |
| P13 | SLA, dostupnosť, technický kontakt pre incidenty, status page, plánované odstávky. | Runbook a eskalácia. |
| P14 | Je potrebné NDA? Sú v zmluve obmedzenia white-label / API integrátor (Esblu = API integrator, nie white-label)? | Onboarding. |
| P15 | Scope partnerského live kľúča: má `org:provision`, `invoice:send`, `invoice:read`? Je možné vydať kľúč s minimálnymi scope? | Least privilege. |
| P16 | Plánujú zmenu pravidla `INVOICE_ISSUE_DATE_*` (výnimky pre dobropisy, opravné faktúry, tolerancia polnoci)? | Readiness pravidlo v Esblu. |

---

## 2b. Empirické správanie sandboxu (L2, 2026-10-02)

| Pozorovanie | Zdroj | Vyvodenie |
| --- | --- | --- |
| Odoslanie čísla dokladu, ktoré už v tej istej organizácii existuje (z predošlého L2 behu), skončí `200` + `data.status = "rejected"`, `reason = "ingest"`. | L2 beh po `070ddef`: O14, O15 a I11. Reprodukované offline (`--offline-selftest --selftest-legacy-numbering`). Docs connectora: `ingest` = „the document number already exists as a native invoice“. | Číslo dokladu je u poskytovateľa unikátne v rámci organizácie. Odmietnutie je **istý výsledok** (nič neodišlo). Nevytvorilo sa žiadne podanie. |
| Replay toho istého Idempotency-Key po „stratenej“ odpovedi vrátil **rovnakú** odpoveď ako prvé volanie (rovnaký `status`/`reason`). Nové podanie nevzniklo (0 nových `invoice_id` v `/peppol/events`). | L2 O15 (beh po `070ddef`, odmietnutý variant). Happy-path variant (queued → rovnaké `invoice_id`) overí ďalší beh s unikátnym číslovaním. | Zhodné s docs („stored response, never sends twice“). **Nevyvodzuje sa** z toho retenčná doba kľúča (P1) ani správanie pri súbežnom in-flight (P2). |
| `/peppol/status` končí pri `SENT`. Doručenie nesie `evidence.delivery_status = delivered`. | L2 O10–O12 PASS po `070ddef` | Opravené v reconciliation. |

| # | Nová otázka | Prečo |
| --- | --- | --- |
| P17 | Po `ERROR` (trvalé zlyhanie **po** prijatí dokladu) je číslo dokladu u poskytovateľa už „obsadené“? Nové `connector/send` s tým istým `cbc:ID` (nový Idempotency-Key) potom skončí `rejected/ingest`? Je správna cesta `POST /v1/agent/peppol/send/{invoiceId}` („retrying after a failure (error) is allowed“)? | Operátorský retry po `failed` posiela nový connector pokus s tým istým číslom. Ak to poskytovateľ odmietne ako duplicitu, retry po `ERROR` cez connector nefunguje. |
| P18 | Čísla dokladov vystavených natívne v eFaktúra appke tej istej organizácie kolidujú s číslami z Esblu? (Esblu = zdroj pravdy číslovania.) | Prvé odoslanie Esblu faktúry s číslom, ktoré firma už v eFaktúre použila, skončí `rejected/ingest`. |

## 3. Čo blokuje produkčné spustenie

> **Aktualizované 7. 10. 2026:** sandbox E2E aktuálnej architektúry je hotový (staging, reálny sandbox);
> aktuálny checklist a rollout: `docs/einvoice-preproduction-readiness-2026-10-07.md` (sekcie 6 a 10).

| Blocker | Kto | Poznámka |
| --- | --- | --- |
| Partnerská zmluva + live kľúč (`efk_pk_live_…`) | používateľ (Esblu s. r. o.) | Portál, 3 kroky. |
| Odpovede na P1, P2, P4 (bezpečnosť opakovania) | eFaktura.sk | Bez nich nemáme garanciu „žiadne dvojité odoslanie“ mimo docs. |
| P10–P12 (DPA, lokalita, retencia) a CLIA stanovisko | eFaktura.sk + CLIA | Pozri CLIA change request. |
| Aktuálny sandbox E2E aktuálnej architektúry (Phase 1–6) so staging Supabase | používateľ + Claude | Pozri `docs/einvoice-sandbox-e2e-plan.md`. |
| Registrácia partner webhooku v portáli + `ESBLU_EFAKTURA_WEBHOOK_SECRETS` | používateľ | Secret iba do Vercel env (production), nikdy do repa. |
| Onboarding Esblu internej firmy (PFS → PDS, mandát) + riadok `einvoice_organizations` + `einvoice_rollout` | používateľ / operátor | Stage 1 rolloutu. |
| Vercel plán s cronmi častejšími ako raz denne | používateľ | Hobby plán dovolí cron iba 1× denne. |

## 4. Čo produkčné spustenie neblokuje

- `GET /v1/agent/events` ako fallback: zlepšenie, poll cez `received` stačí.
- Automatické spracovanie dobropisov: označené na manuálnu kontrolu.
- Lookup podľa Idempotency-Key (P3): bez neho `retry_exhausted_unknown` rieši operátor.
- OAuth „Connect with eFaktúra“, SAPI-SK, scheduled sending a CSV: nepoužívame.
- Prijaté prílohy (`/attachments`) a PDF poskytovateľa: pôvodné XML sa ukladá a prílohy ostávajú v ňom.
