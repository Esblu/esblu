# E-Faktúra — limiter partnerského kľúča, alerty, ACK karantény a produkčné blokátory (2026-11-23)

Vetva `fix/einvoice-inbound-pagination-quarantine`. Nič z tohto nie je nasadené ani aplikované na staging/produkciu.

## 1. Spoločný API limiter (implementované lokálne, migrácia 20261126100000 NEAPLIKOVANÁ)

Každé volanie pod partnerským kľúčom eFaktura.sk ide cez jeden limiter s pevnými kvótami tried (tabuľka
`einvoice_provider_rate_limits`, meniteľná bez deployu). Súčet = celkový strop 90/min (rezerva 10 pod limitom 100).

| Trieda | Metódy poskytovateľa | Kto | Kvóta/min | Pri zamietnutí |
| --- | --- | --- | --- | --- |
| interactive | provisionOrganization, getOrganization, enrollPeppol, verifyRecipient, preflight | používateľ | 10 | HTTP 429 „skúste o chvíľu“ (predtým 502); nič sa nezapíše |
| **outbound** (rezerva) | sendUbl, getSubmissionByDocumentId, findSubmissionByIdempotencyKey | cron odosielania | 25 | `RETRY_DEFINITE`: požiadavka sa neodoslala, žiadny „neznámy výsledok“, rovnaký Idempotency-Key pri ďalšom pokuse |
| reconcile | getOutboundStatus, getDeliveryEvidence | cron 5 min | 10 | ďalší beh |
| inbound_event / inbound_poll | zoznam, XML, ACK (podľa kontextu, `withInboundRateLimit`) | webhook+feed / cron | 15 / 25 | beh sa zastaví, udalosť → retry |
| background | listPartnerEvents, deactivatePeppol | feed, údržba | 5 | `LIST_FAILED` / retry jobu |

- **Atomicita a súbeh:** `esblu_einvoice_rate_acquire_class` rozhoduje pod `pg_advisory_xact_lock` (provider+prostredie).
- **Kĺzavé okno:** vážená predchádzajúca minúta + aktuálna → na hranici minúty nevznikne dvojnásobný nápor.
- **429 poskytovateľa:** `esblu_einvoice_rate_cooldown` → všetky triedy čakajú (Retry-After, inak 30 s, max 1 h); kratší
  Retry-After čakanie neskráti.
- **Jediný bod:** `getEinvoiceProvider()` obalí `EfakturaSkProvider` (Proxy, getter/metódy nad skutočným objektom,
  `instanceof` funguje). Nová sieťová metóda bez triedy = zlyhaný test `RL-map`.
- **Fail-open:** chyba limitera alebo chýbajúca migrácia → požiadavka pokračuje (posledná poistka = 429 poskytovateľa,
  ktoré je bezpečné vo všetkých tokoch).
- **Monitoring:** health `provider.rate_denied_1h` (+ outbound, interactive), `provider.cooldown_active`,
  `provider.provider_429_24h`; alerty `PROVIDER_RATE_COOLDOWN` (warning), `PROVIDER_429_REPEATED` (critical, ≥ 5/24 h),
  `OUTBOUND_RATE_LIMITED` (warning, ≥ 5/h).
- **Testy:** `npm run test:einvoice-rate-limit` 19/19 (mapovanie, kvóty, rezerva odosielania pri vyčerpaní všetkých
  ostatných tried, celkový strop, kĺzavé okno, cooldown, 30 súbežných, validácia a oprávnenia, Proxy nad skutočným
  poskytovateľom, zamietnuté odoslanie bez HTTP a bez neznámeho výsledku, 429 → cooldown, fail-open, 429 pre
  používateľa, runtime obal, triedy príjmu, health/alerty, rollback + opätovná aplikácia).
- Starší limiter príjmu (`esblu_einvoice_rate_acquire`, 20261125100000) ostáva ako záloha, kým nie je nová migrácia.

Otvorené: kvóty sú odhad (dokumentácia: ≥ 100 req/min na partnerský kľúč) — po nasadení upraviť podľa health.

## 2. Kritické alerty cez existujúce web push (návrh, neimplementované)

Dnes: alert sa **vytvorí** (riadok `MAINTENANCE_CRITICAL` v `einvoice_ops_alerts`, iba prvý kód) a zapíše do logu;
**doručenie človeku neexistuje** (drain 0, e-mail 0). Návrh bez novej platenej služby:

1. **Príjemca a autorizácia:** iba vlastník aktívneho interného grantu prevádzkovateľa (`internal_operator_grants`,
   firma + Auth UUID overené mimo aplikácie). Žiadny zoznam e-mailov v kóde; bez grantu iba log + HTTP 503.
2. **Odoslanie:** server (cron údržby, service role) cez `lib/push` `deliverToUsers` (web push VAPID / FCM / APNs —
   kľúče sú v produkcii). Nový druh `ops` v `notification_deliveries` (migrácia: rozšírenie CHECK), ktorý sa pre
   kritické alerty nedá vypnúť.
3. **Minimalizácia obsahu:** „Esblu prevádzka: kritický alert <KÓD> (<prostredie>), výskyt N“. Nikdy firma, IČO,
   doklad, suma. Klik → interná stránka stavu (iba operátor).
4. **Vytvorenie ≠ doručenie:** každý kritický kód samostatný riadok; `notified_at`, `delivery_result`
   (`sent` / `no_device` / `failed`), počet zariadení. Deduplikácia: `notification_deliveries (user_id, dedupe_key)` =
   alert + okno 6 h.
5. **Frekvencia:** cron údržby každých 15 min (dnes 1 h).
6. **Test doručenia:** Preview/staging nemá push kľúče → buď nový VAPID pár iba pre Preview (nový kľúč = súhlas), alebo
   po schválenom produkčnom nasadení syntetický `OPS_PUSH_TEST` vyžiadaný operátorom; overiť zvlášť príchod na zariadenie
   a `delivery_result = sent`.
7. **Záloha:** denná read-only kontrola (Cowork) otvorených kritických alertov bez `delivery_result = sent` > 1 h;
   HTTP 503 cronu ostáva.

## 3. ACK karantény — rozhodovací návrh (nezapínať)

ACK karantény = potvrdiť poskytovateľovi trvalo chybný doklad, aby neblokoval zoznam. Po ACK ho poskytovateľ už neponúka;
**jediný originál je v Esblu.** Audit dnešného kódu našiel medzery, ktoré treba opraviť pred zapnutím:

| Podmienka | Dnes | Potrebné |
| --- | --- | --- |
| Originál XML bezpečne uložený | karanténa vyžaduje cestu + SHA-256 | pred ACK znova načítať objekt zo Storage a overiť SHA-256 |
| Správna firma | vylúčený iba `RECIPIENT_MISMATCH`; **karanténa zahŕňa aj `INVALID_XML` a `STORAGE_FAILED`, kde príjemca nebol overený** | ACK iba pre chyby **po** overení príjemcu (mapovanie/koncept, trvalé `DRAFT_CREATE_FAILED`); `INVALID_XML`, `STORAGE_FAILED`, `RECIPIENT_*` nikdy |
| Zaznamenaná chyba | `last_error_code`, udalosti `failed→quarantined`, `quarantine_acknowledged` | bez zmeny |
| Neskoršie manuálne spracovanie | firma vidí doklad a stiahne XML (okrem R3); operátorský reprocess existuje | v UI výrazné upozornenie „doklad je iba v Esblu — spracujte ručne“ |
| Opakovanie neúspešného ACK | **chýba** (failed riadky sa znova neclaimujú; komentár v kóde to nesprávne sľubuje) | malý job v údržbe pre `quarantined_unacked` + test |
| Prepínač | `ESBLU_EINVOICE_INBOUND_QUARANTINE_ACK=enabled` | najprv iba sandbox/staging test |

Rozhodnutia vlastníka: (a) či ACK vôbec povoliť (alternatíva: ponechať u poskytovateľa a riešiť strop 991 operátorsky);
(b) retencia jediného originálu v Esblu (Esblu nie je zákonný archív) — **rozhodnutie CLIA/právne**; (c) informovanie
firmy. Odporúčanie: najprv opraviť 3 medzery (overenie SHA pred ACK, zúženie na chyby po overení príjemcu, retry job),
potom staging test, až potom rozhodnúť o zapnutí.

## 4. Zostávajúce produkčné blokátory eFaktúry

**Technické**

| Blokátor | Stav |
| --- | --- |
| Produkčné migrácie e-faktúry | v produkcii chýbajú 20261122100000 (mandáty), 20261122110000 (deregistrácie), 20261122120000 (ops alerty), 20261125100000 (karanténa/sken/limiter príjmu), 20261126100000 (spoločný limiter) — staging má všetky okrem 20261126100000 |
| Kód | opravná vetva nie je v `main`; poradie: kód (fail-open bez migrácií) → migrácie |
| Konfigurácia | v žiadnom prostredí nie sú `ESBLU_EINVOICE_*`, `ESBLU_EFAKTURA_API_KEY`, webhook tajomstvo; LIVE brána (`ESBLU_EINVOICE_LIVE_ENABLED` + production) |
| Doručovanie kritických alertov | chýba (bod 2) |
| ACK karantény | medzery (bod 3), vypnuté |
| Staging overenie limitera 20261126100000 | neaplikovaná, netestovaná proti sandboxu |
| Ďalšie riziká | lease 120 s po zastavení behu; poradie zoznamu overené iba v sandboxe; `OPENAI_API_KEY` v Preview čitateľný; cielená záloha stagingu |

**Obchodné a právne (rozhodnutia vlastníka / CLIA / poskytovateľa)**

| Bod | Stav |
| --- | --- |
| Zmluva s eFaktura.sk (LIVE partnerský účet, kredit, SLA, limity API) | mimo kódu, otvorené |
| Mandát zákazníka (splnomocnenie na odosielanie/príjem v mene firmy) | technicky pripravené (20261122100000, v produkcii chýba), znenie a proces — právne |
| Retencia originálov a dokladov po ukončení firmy (Esblu nie je zákonný archív) | rozhodnutie CLIA |
| ACK karantény (prenos zodpovednosti za originál) | rozhodnutie vlastníka + CLIA |
| Rollout (ktoré firmy, kedy) | `einvoice_rollout` po firmách — obchodné rozhodnutie |
