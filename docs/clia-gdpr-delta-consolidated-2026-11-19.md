# INTERNÝ PODKLAD — NEODOSIELAŤ BEZ SCHVÁLENIA PREVÁDZKOVATEĽA

# Esblu — konsolidovaná GDPR delta: produkcia vs. dokumentácia poskytnutá CLIA (stav 19. 11. 2026)

| | |
|---|---|
| Účel | Jeden aktuálny súhrn rozdielov medzi skutočným stavom produkcie a GDPR dokumentáciou, ktorú dostala / posúdila CLIA. Podklad pre rozhodnutie prevádzkovateľa, čo a kedy poslať CLIA. |
| Povaha | Technický podklad, **nie právne stanovisko**. Všetky navrhované znenia sú označené **DRAFT**. Nič sa neodoslalo ani nezverejnilo. |
| Produkcia (kód) | `origin/main` @ `12da726` (2026-11-18). Posledná produkčná migrácia `20261117213219 open_public_registration` (read-only záznam 19. 11.). |
| Nenasadený release | `release/esblu8` @ `f37ff20` (2026-11-19) — lokálny, nepushnutý, bez produkčných migrácií. |
| Platné právne texty | Zásady ochrany OÚ **1.4**, DPA **1.3**, Cookies 1.1, `/subprocessors` (kód `origin/main`). `legal/` a `/subprocessors` sú v `release/esblu8` **bez zmeny** voči produkcii. |
| VOP | **Mimo rozsahu tohto dokumentu** — riešia sa samostatne (vrátane predplatného, 48 h ochrannej lehoty, refundácií z draftu 24. 11.). |
| Vzťah k zdrojom | Konsoliduje (neopakuje doslovne): `docs/audits/clia-technical-delta-2026-11-19.md` (ďalej **TD**), `docs/clia-retention-nonconformity-2026-11-19.md` (**RN**), `docs/einvoice-mandate-and-safety-2026-11-19.md` (**EM**), `docs/billing-invoicing-architecture-2026-11-19.md` (**BA**), `docs/retention-archive-design-2026-11-19.md` (**RA**), `docs/release/esblu8-integrated-release-2026-11-19.md` (**REL**), `docs/ops/prod-cleanup-execution-2026-11-19.md` (**PC**), `docs/security/security-incident-onedrive-export-2026-11-19.md` (**SEC**), `docs/clia-delta-2026-11-24-draft.md` (**D24**, neodoslaný návrh), `docs/clia-gdpr-reconciliation-2026-11-10.md` (**REC**), `legal/privacy/1.4.md` (**PP**), `legal/dpa/1.3.md` (**DPA**). |

Legenda stavov: **(1) PROD** = overený produkčný stav (so zdrojom) · **(2) ESBLU8** = implementované na `release/esblu8`, nenasadené · **(3) PLÁN** = plánované / čaká na rozhodnutie. **[OVERIŤ]** = fakt, ktorý ešte musí potvrdiť prevádzkovateľ.

---

## 1. Čo sa považuje za uzavreté (neotvára sa)

| Oblasť | Stav | Zdroj |
|---|---|---|
| Q1 DPA elektronicky (DPA 1.3 + evidencia) | CLOSED | REC §18.1 |
| Q2 Anthropic ako sprostredkovateľ | CLOSED | REC §18.1 |
| Q3 dôkaz prijatia po zrušení účtu (`legal_acceptance_evidence`, ≤ 5 r.) | CLOSED | REC §18.1 |
| Q4 odkaz na cookies v PP · Q6 preferenčné localStorage, bez cookie lišty | CLOSED | REC §18.1 |
| Q5 EN/DE preklady | CLOSED | REC §18.1 |
| Q7 DPIA nie je blocker | CLOSED | REC §18.1 |
| Q8 AI intake pred potvrdením | CLOSED | REC §18.1 |
| Q9 trial/beta/AI telemetria (`trial_claims` ≤ 5 r. a ďalšie lehoty) | CLOSED | REC §18.1 |
| Q10 preklepy PP | CLOSED | REC §18.1 |
| Q11 SMTP/Gmail — *uzavreté pre stav k 10. 11.*; Resend je **nová skutočnosť** po uzavretí (pozri T1), nie znovuotvorenie Q11 | CLOSED (OWNER verify Gmail) | REC §18.1 |
| Q12 RPO/RÚZ · Q13 syntéza reči | CLOSED (doc) | REC §18.1 |
| Q14 Google login v mobile — uzavreté ako „doplniť pri revízii PP“; zostáva iba **textová úprava** PP/DPA (T2), nie nová právna otázka | CLOSED (doc) | REC §18.1 |
| eFaktúra — vyriešená časť: model API partnera, Esblu nie je Access Point ani sprostredkovateľ na PFS, klient volí eFaktura.sk na PFS a zadáva overovací kód (neukladá sa), eFaktura s. r. o. = ďalší sprostredkovateľ Esblu, prijatý doklad = koncept na kontrolu, doručenie ≠ úhrada, Esblu nie je zákonný archív | CLOSED | TD §2.4, §6 |

---

## 2. Prehľad — kde je rozdiel voči dokumentom CLIA

| # | Téma | (1) PROD | (2) ESBLU8 | (3) PLÁN | Rozdiel voči platným dokumentom dnes? |
|---|---|---|---|---|---|
| T1 | Resend | **LIVE** (auth SMTP) | + voliteľné Resend REST ops alerty | doplniť do PP/DPA/`/subprocessors` | **ÁNO** — `/subprocessors` tvrdí opak, PP/DPA ho neuvádzajú |
| T2 | Google OAuth v Android appke | LIVE v internom teste Play | bez zmeny | verejné vydanie | **ÁNO (textovo)** — PP/DPA „vo webovom rozhraní“ |
| T3 | Stripe | **vypnutý** (`web_provider = none`) | kompletná billing pipeline, LIVE pripravený, vypnutý | aktivácia S3–S9 | nie dnes; **áno pred aktiváciou** |
| T4 | eFaktura.sk | vypnutá (0 riadkov, webhook 503) | mandát, deregistrácia, alerty | podpis zmluvy (rozhodnutie prevádzkovateľa), brána G1–G12 | nie dnes; áno pred aktiváciou |
| T5 | Elektronické mandáty klienta | neexistuje (iba 30-dňový log pokusov) | nová tabuľka `einvoice_mandates` (IP/UA hash) | retencia nerozhodnutá | nové spracúvanie pri nasadení |
| T6 | Zoznam sprostredkovateľov | neaktuálny (Resend, dátumy) | bez zmeny textov | DRAFT úpravy | **ÁNO** |
| T7 | Retencia účtovných dokladov | dokumenty CLIA: „nikdy sa nemaže“; realita: maže sa pri ukončení firmy | retenčný archív (vlna B) | lehoty PROPOSED 10 r. | **ÁNO — nesúlad** |
| T8 | Ukončenie firmy | od 12. 11. maže finalizované faktúry + XML e-faktúr | archivuje namiesto výmazu (vlna B, nenasadené) | nasadenie po rozhodnutí + CLIA | **ÁNO — kľúčová delta** |
| T9 | Archivácia a automatický výmaz | GDPR purge **vypnutá** | purge archívu (dry-run, legal hold), nenaplánovaná | zapnutie P3 | **ÁNO** — technická retencia dlhšia ako v PP |
| T10 | Účtovné exporty | export firmy + odovzdanie účtovníkovi (handoff) | + Stripe účtovný export / kópia dokladov | podľa voľby A/B dokladov | čiastočne (lehoty metadát) |
| T11 | Prenosy do tretích krajín | Resend (región [OVERIŤ]), Google (DPF) | Stripe (US/IE), Resend REST | eFaktura.sk + jej sub-processori v USA | **ÁNO** pre Resend |
| T12 | OneDrive test-export 19. 11. | interný záznam, bez oznámenia | — | uzavrieť otvorené kroky, rozhodnutie o čl. 33 | nie je to delta dokumentov; na vedomie |

---

## 3. Detail podľa tém

### T1 — Resend (SMTP pre auth e-maily; voliteľne REST ops alerty)

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | Supabase Auth používa vlastný SMTP `smtp.resend.com`, odosielateľ `noreply@mail.esblu.com` (potvrdenie registrácie, obnova hesla). DNS: DKIM `resend._domainkey.mail.esblu.com`, SPF `send.mail.esblu.com` → amazonses. Doložené doručenie na externú adresu 17. 11. 2026 22:55 UTC. Aplikačný kód Resend **nevolá** (žiadne SDK); pozvánky do firmy sa e-mailom neposielajú. | D24 §1.1, TD §2.2 |
| (1) PROD — dokumenty | `/subprocessors` (SK/EN/DE): „Resend nie je aplikáciou nikde použitý … výhradne vstavaný e-mailový systém Supabase Auth“ → **nepravdivé**. PP 1.4 (oznámenia, autentifikácia): príjemcovia iba Supabase, Vercel. DPA 1.3 príl. 3: Resend chýba. Interný `docs/gdpr-subprocessors.md` (18. 8.) zastaraný. | `lib/i18n/dictionaries/sk.ts` (`emailHistoryResendText`), PP riadok 102, 132 |
| **(2) ESBLU8** | `lib/billing/ops-alerts.ts` + `/api/cron/billing-ops-monitor`: **voliteľný** e-mail cez Resend REST API (`api.resend.com/emails`), iba ak sú nastavené `RESEND_API_KEY`, `ESBLU_OPS_ALERT_EMAIL_TO`, `ESBLU_OPS_ALERT_EMAIL_FROM`. Obsah: kód alertu, závažnosť, prostredie, počty, časy; príjemca = interný operátor. Bez premenných sa nič neposiela. | REL §6, BA §7 |
| (3) PLÁN | Doplniť Resend do PP, DPA príl. 3, `/subprocessors` (DRAFT-1/3 v TD §3). Pred tým: dátum prvého odoslania, región (EÚ/US), akceptácia DPA Resend. | TD §5 V1 |

**Interná nezrovnalosť na opravu pred odoslaním:** D24 §1.1 uvádza, že cez Resend idú aj „pozvánky“; TD §2.2 overil v kóde, že pozvánky sa e-mailom neposielajú. Pred odoslaním D24 zjednotiť (odporúčanie: podľa TD).

### T2 — Google OAuth v Android aplikácii

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | Android 1.0.1 (vc4) v internom testovaní Google Play: „Pokračovať cez Google“ — Capacitor Browser → Supabase `/authorize` (PKCE) → `com.esblu.app://auth/callback`. Rozsah údajov rovnaký ako na webe (meno, e-mail, avatar URL, Google ID); žiadne ďalšie Google SDK (FCM je samostatný, už v DPA). | TD §2.3, `docs/android-release-vc4-2026-11-17.md` |
| (1) PROD — dokumenty | PP 1.4: „prihlasovanie cez Google je dostupné **vo webovom rozhraní** Aplikácie“; DPA 1.3 príl.: „Vo webovom rozhraní je dostupné aj prihlásenie prostredníctvom účtu Google“. Prenos Google LLC (DPF/SCC) v PP už uvedený. | PP riadok 96, 104; DPA riadok 233 |
| **(2) ESBLU8** | Bez zmeny. | — |
| (3) PLÁN | Verejné vydanie appky (krok AN5) → rozdiel sa stáva reálnym pre verejnosť. Textová úprava DRAFT-2. | TD §2.3 |

### T3 — Stripe (predplatné)

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | **Nie je live.** `billing_runtime_config.web_provider = none`; Stripe migrácie nie sú v produkcii; žiadne Stripe dáta. Dokumenty CLIA Stripe neuvádzajú — **správne** pre dnešný stav. | TD §1, §2.1; REL §3 |
| **(2) ESBLU8** | 8 Stripe migrácií + `20261123100000–120000`: Checkout, webhooky (podpis, dedupe, oddelenie test/live), retry + dead-letter, pripnutá API verzia, **účtovná kópia dokladov** (`billing_invoice_documents`, PDF archív so SHA-256), refund observácie, ops alerty, mesačný účtovný CSV export. LIVE pripravený, vypnutý. | REL §1, §3; BA §5, §7 |
| (2) — dáta | Esblu → Stripe: ID ceny, interné checkout ID, customer ID, locale, `origin_context` (web/appka) — **nie** e-mail/meno/IČO. Používateľ → Stripe Checkout: e-mail, meno, fakturačná adresa, voliteľne IČ DPH, karta/SEPA. Stripe → Esblu: stav predplatného, sumy, krajina fakturačnej adresy, refundácie, spory. V DB Esblu **bez** čísla karty, adresy a e-mailu. Účtovný export: číslo dokladu, dátum, sumy, DPH polia, krajina + IČ DPH odberateľa „ako na doklade“, Stripe ID. | TD §2.1, `lib/billing/accounting-export.ts` |
| (2) — retencia | `subscription_accounts`, `billing_checkout_sessions` → kaskáda so zrušením firmy; `billing_events`, `billing_store_reports` (a nové `billing_invoice_documents`) → **prežijú** zrušenie firmy (SET NULL / bez väzby); **lehota v kóde nedefinovaná**. | TD §2.1, §2.6 |
| (3) PLÁN | Aktivácia S3–S9 po GDPR re-review (oznámenie podľa DPA čl. 9.3, 15 dní). Model dokladov: odporúčaný variant A (Stripe Invoice = jediný daňový doklad, Esblu drží kópiu) — rozhoduje účtovníčka/prevádzkovateľ. Stripe z Android appky cez webový Checkout pripravený; Google Play Billing v kóde, nie live. Entita Stripe [OVERIŤ — V3]. | BA §6, TD §2.1 |

### T4 — eFaktura.sk (Peppol)

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | **Vypnutá:** bez env premenných, 0 riadkov `einvoice_*` (aj po vyčistení 19. 11.), webhook vracia 503. Testované **iba v sandboxe**. Migrácie `20261113100000` (index `body_sha256`) a `20261113110000` (`company_export_runs`) sú v repozitári produkcie; `company_export_runs` v produkčnej DB existuje (5 riadkov po vyčistení 19. 11.). | TD §1, §2.4; PC §2 |
| (1) — zmluva | Poskytovateľ doručil **novú zmluvu s novým číslom** — **nepodpísaná**. Limit zodpovednosti 10 000 €/rok, kauzalita, výnimky (vrátane čl. 82 GDPR) = **obchodné rozhodnutie prevádzkovateľa**, nie otázka pre CLIA v tomto podklade. DPA poskytovateľa (verejné, `2026-11-25-v1`): ďalší sub-processori aj v USA (Railway, Vercel, Resend), Cloudflare R2, AI fallback; výmaz po ukončení + 30 dní; zálohy ≤ 4 mes.; 10 r. iba dôkaz doručenia. | TD §2.4 E6–E7 |
| **(2) ESBLU8** | P3: mandát (T5), brána odosielania (bez mandátu nič neodíde, 403 `MANDATE_REQUIRED`), deregistrácia u poskytovateľa pri ukončení firmy (`einvoice_deregistrations`), ops alerty (`einvoice_ops_alerts`). Migrácie `20261122100000–120000` = vlna A (bez dopadu, kým eFaktúra nie je aktívna). Sandbox E2E deregistrácie **neoverený**. | EM §1–§4, REL §3, §6 |
| (3) PLÁN | Aktivácia až po: podpise zmluvy (prevádzkovateľ), overení Prílohy 2 (DPA) zmluvy, zápise do PP/DPA/`/subprocessors` (DRAFT-6), oznámení zákazníkom podľa DPA 9.3 (D-15), bráne G1–G12. | TD §2.4 |

### T5 — Elektronické poverenie (mandát) klienta pre eFaktúru

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | Neexistuje trvalý záznam poverenia. Iba `einvoice_enroll_attempts` (firma, používateľ, čas, výsledok; 30 dní); `confirm_enroll:true` sa len overí. (V produkcii 0 riadkov — eFaktúra vypnutá.) | EM §1, TD §2.4 E5 |
| **(2) ESBLU8** | Nová append-only tabuľka **`einvoice_mandates`**: firma, rozsah (`send`/`receive`), kto udelil + **snapshot mena, e-mailu a roly**, verzia/jazyk/SHA-256 textu vyhlásenia (vrátane vyhlásenia o oprávnení konať za firmu), kanál, Peppol/org ID, **`ip_sha256` (so soľou viazanou na firmu) a `user_agent_sha256`**, časy udelenia/účinnosti/odvolania, kto odvolal a prečo. Overovací kód FS sa **nikdy** neukladá (ani hash). DELETE/TRUNCATE zakázané aj pre service_role; **bez FK na firmu → prežije ukončenie firmy**. RLS: iba aktívna firma + `finance.manage`. Odvolanie: používateľ, operátor, udalosť poskytovateľa, deregistrácia. | EM §2, §5 |
| (2) — pozn. GDPR | Hash IP/UA = **pseudonymizovaný osobný údaj, nie anonymizácia** (EM §2). Snapshot e-mailu a mena udeľujúcej osoby ostáva aj po zrušení jej účtu. | EM §2 |
| (3) PLÁN | **Retencia nerozhodnutá** (EM §9 bod 3); text vyhlásenia schváliť s CLIA (zmena = nová verzia); kto smie udeliť (dnes `finance.manage`, alternatíva iba owner); UI odvolania. | EM §9 |

### T6 — Zoznam sprostredkovateľov

| Poskytovateľ | (1) PROD | Dokumenty (`/subprocessors` · DPA 1.3 príl. 3 · PP 1.4) | (2) ESBLU8 | (3) PLÁN |
|---|---|---|---|---|
| Supabase, Vercel, OpenAI, Google FCM, Anthropic, Namecheap | LIVE | uvedené (zhoda) | bez zmeny | — |
| **Resend** | **LIVE** (auth SMTP) | **nie — `/subprocessors` tvrdí opak** · nie · nie | + voliteľné REST ops alerty | doplniť (DRAFT-1/3) |
| Google (OAuth) | LIVE web + Android (interný test) | zdroj, nie sprostredkovateľ · „vo webovom rozhraní“ · „vo webovom rozhraní“ | bez zmeny | DRAFT-2 |
| Stripe | NOT LIVE | nie · nie · nie | pripravený | pred aktiváciou (DRAFT-4) |
| eFaktura s. r. o. | NOT LIVE | nie · nie · nie | P3 pripravené | pred aktiváciou (DRAFT-6) |
| Google Play Billing / Apple | NOT LIVE | — | Play Billing v kóde, nie live | pred aktiváciou |

Formálne: `/subprocessors` uvádza „Posledná aktualizácia 16. 8. 2026“ a zároveň „platí od 2026-09-09“ (`legalConfig.effectiveDate`) — zjednotiť. Interný `docs/gdpr-subprocessors.md` a `docs/gdpr-retention-policy.md` (august) uvádzajú prevádzkovateľa ako fyzickú osobu — zastarané (Esblu s.r.o.). Zdroj: TD §2.5.

### T7 — Retencia účtovných dokladov

| Stav | Fakty | Zdroj |
|---|---|---|
| Čo CLIA dostala (10.–11. 11.) | Účtovné záznamy 10 r.; finalizované faktúry nemenné; **zrušenie firmy s dokladmi blokované** (`ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION`); XML v `einvoice-documents` **sa nikdy nemaže**. | REC §5, RN §1 |
| **(1) PROD** | Mimo ukončenia firmy sú finalizované doklady chránené triggermi (aj voči service_role). **Pri ukončení firmy (T8) sa však mažú** vrátane XML. Esblu nie je zákonný archív (VOP 21.3, 22.6 — iba odkaz). Zálohy: Supabase denné 7 dní, PITR vypnuté; Storage (XML, skeny) nie je v DB zálohe. Doklady Esblu (vlastné predaje): žiadne (billing OFF). | RN §2, TD §2.7 |
| **(2) ESBLU8** | Retenčný archív `esblu_retention` (T8) — kategórie `accounting_document`, `accounting_document_source`, `einvoice_document`, `einvoice_delivery_evidence`, `accounting_handoff`; identita firmy ako snapshot. Billing: účtovná kópia Stripe dokladov + PDF archív (cieľ 10 r., lehotu potvrdí účtovníčka). | RA §3, §6; BA §1 |
| (3) PLÁN | Lehoty **PROPOSED**: 10 r. od konca roka dokladu pre všetky kategórie (alternatíva 5 r. pre handoff). Ostrá purge maže iba kategórie so stavom APPROVED. | RA §6 |

### T8 — Ukončenie firmy (výmaz finalizovaných dokladov)

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** (od 12. 11. 2026, migrácia `20261112110000`) | Owner → Zrušiť firmu → export (alebo **`waived` = bez exportu**) → potvrdenie frázou. `esblu_company_termination_commit` v jednej transakcii **zmaže** finalizované faktúry, dobropisy, položky, strany, DPH rozpis, úhrady, históriu, zálohy, stav zaúčtovania, e-faktúry (odoslané aj prijaté), históriu doručenia (`einvoice_events`), záznamy o odovzdaní účtovníkovi a sken prijatej faktúry; cleanup job potom zmaže zo Storage **XML e-faktúr** a skeny. Ostáva iba `company_terminations` (bez obsahu dokladov) a pri `exported` `company_export_runs`. Pri `waived` nemusí existovať žiadna kópia dokladov. Blokuje: aktívne predplatné, registrácia u poskytovateľa eFaktúry. | RN §2, TD §2.6 |
| (1) — skutočné použitie | Na **reálne doklady zákazníka** nepoužité (podľa read-only záznamov do 19. 11.) **[OVERIŤ R-V1]**. Dňa 19. 11. 2026 (19:11–19:24) použité 5× v režime `waived` na **testovacie firmy** pri schválenom vyčistení produkcie; v jednej boli 2 testovacie „faktúry“ (FA20260001, TEST-2026-002), ktoré prevádzkovateľ 19. 11. vyhlásil za neúčtovné. V produkcii teraz `company_terminations` = 5, `company_export_runs` = 5, `invoices` = 0. | PC §1–§2, TD §2.7 |
| **(2) ESBLU8** (vlna B, migrácia `20261121100000`) | Ukončenie (`exported` aj `waived`) **archivuje** doklady a dôkazy do `esblu_retention` v tej istej transakcii, až potom maže firmu; XML a skeny **ostávajú** v Storage. Minimalizácia: archív bez ID používateľov, AI výstupov, e-mailu/IBAN firmy; ostáva obsah dokladu (vrátane údajov fyzických osôb na doklade). Prístup: žiadny pre zákazníka ani aplikáciu; iba operátor cez funkcie s povinnou referenciou a účelom, **append-only access log**. Výnimka: výmaz bez archívu iba pre syntetické testovacie dáta (iba `postgres`, povinná referencia + odôvodnenie). Rollback archív nemaže. | RA §2–§4, §8; RN §3 |
| (3) PLÁN | Nasadenie vlny B **až po rozhodnutí prevádzkovateľa + stanovisku CLIA** (vrátane GDPR čl. 28 ods. 3 písm. g) a spolu s úpravou UI textov `/zrusenie-uctu` (inak UI sľubuje výmaz). Technicky odložiteľné nezávisle od vlny A. Technické odporúčanie (RN R-V3): archív je bezpečnejší default — výmaz archívu je možný neskôr, obnova zmazaného nie. eFaktúra: deregistrácia u poskytovateľa pred výmazom (ESBLU8, T4). | REL §3, RN §3, §7 |

Nezávisle od CLIA: dokumenty CLIA (REC) dnes popisujú stav, ktorý od 12. 11. **neplatí** („zrušenie blokované“, „XML sa nikdy nemaže“) — túto informáciu treba CLIA opraviť bez ohľadu na voľbu riešenia.

### T9 — Archivácia a automatický výmaz (purge)

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | GDPR retenčná purge (`esblu_gdpr_retention_purge`, flag `ESBLU_GDPR_RETENTION_PURGE_ENABLED`) je implementovaná, ale **vypnutá** — prvý beh čaká na súhlas (krok P3); precheck 11. 11.: 36 technických riadkov. Dôsledok: pri push/pozvánkach/technických logoch je skutočná retencia **dlhšia** ako 30/90 dní uvedených v PP 1.4. Bez purge sú aj: `company_terminations` (dokument. 5 r., nevynútené), `company_export_runs` (nedefinované), `legal_acceptance_evidence`, `trial_claims` (v purge, ale purge vypnutá). Zrušenie účtu: transakcia → Storage → `deleteUser` (retry cron) — bez zmeny voči CLIA. Po vyčistení 19. 11. zámerne ponechané auditné záznamy (`legal_acceptance_evidence`, `company_terminations`, `account_deletion_cleanup_jobs`, `trial_claims`, `esblu_intake_attestations_used`). | TD §1, §2.6; PC §2–§3; `lib/retention/gdpr-purge-flag.ts` |
| **(2) ESBLU8** | `esblu_retention.purge_expired` pre archív: dry-run default, maže iba APPROVED lehoty, legal hold, každý beh auditovaný — **nenaplánovaná**. Nové dôkazové tabuľky (`einvoice_mandates`, `einvoice_deregistrations`, `einvoice_ops_alerts`, billing tabuľky) **bez definovanej retencie**; DELETE zakázaný → fyzický výmaz bude vyžadovať ďalšiu migráciu. Rollbacky nemažú auditné tabuľky (presun do `esblu_audit_archive`). | RA §7, EM §5, REL §4 |
| (3) PLÁN | Zapnutie GDPR purge (P3, rozhodnutie prevádzkovateľa); schválenie lehôt archívu; manuálny ročný beh alebo cron s flagom `ESBLU_RETENTION_ARCHIVE_PURGE_ENABLED` (default OFF). | RA §7, TD §5 V6 |

### T10 — Účtovné exporty

| Stav | Fakty | Zdroj |
|---|---|---|
| **(1) PROD** | (a) **Export firmy** pre zákazníka (JSON + CSV + súbory po dávkach, SHA-256), od 13. 11. so server-side dôkazom `company_export_runs` (metadáta, hashe, `requested_by`; lehota nedefinovaná). Obsahuje aj históriu stavov e-faktúr. (b) **Odovzdanie účtovníkovi** (handoff, od 23. 9.): `accounting_handoff_exports` + položky (kto, kedy, obdobie, druh, počet, SHA-256), nemenné; denník stavu zaúčtovania. Pri ukončení firmy sa tieto metadáta dnes mažú (kaskáda). | TD §2.4 E4, §2.6; `docs/retention-handoff-compliance-delta-for-clia.md`; RN §2 |
| **(2) ESBLU8** | (a) Handoff metadáta sa pri ukončení **archivujú** (kategória `accounting_handoff`). (b) **Stripe účtovný export** (admin, mesačný CSV): doklady, hrubá suma, poplatok Stripe, čistá suma, výplata; import z `balance_transactions`/`payouts` samostatným read-only kľúčom; bez mena, e-mailu, adresy — iba údaje z dokladu (vrátane IČ DPH odberateľa) a Stripe ID. Vlastné údaje Esblu ako prevádzkovateľa. | RA §3, BA §7, `lib/billing/accounting-export.ts` |
| (3) PLÁN | Voľba variantu dokladov A/B, lehota archívu billing dokladov (účtovníčka), prípadná e-faktúra pre predplatné. | BA §6, §8 |

### T11 — Možné nové prenosy do tretích krajín

| Príjemca | (1) PROD | (2) ESBLU8 | (3) PLÁN | Stav v dokumentoch |
|---|---|---|---|---|
| Resend | LIVE (auth e-maily: adresa, obsah s odkazom/tokenom, metadáta doručenia); **región a mechanizmus prenosu [OVERIŤ]** (Resend = USA, ponúka aj EÚ región) | + REST alerty operátorovi (bez údajov zákazníkov) | doplniť do PP | **chýba** |
| Google LLC (OAuth) | LIVE web + Android; DPF/SCC | — | — | PP už uvádza (DPF) |
| Stripe | — | pripravené; Checkout údaje platiteľa idú priamo Stripe; entita (Stripe Payments Europe Ltd. / Stripe, Inc.) **[OVERIŤ V3]**; rola sprostredkovateľ vs. samostatný prevádzkovateľ otvorená | pred aktiváciou | chýba (správne, nie live) |
| eFaktura s. r. o. (SK) + jej sub-processori (Railway, Vercel, Resend — USA; Cloudflare R2; AI fallback) | — | pripravené | pred aktiváciou | chýba (správne, nie live) |
| Microsoft OneDrive (osobný účet) | jednorazová udalosť 19. 11. — **nie je** zmluvný sprostredkovateľ, nejde o plánovaný prenos (T12) | — | — | n/a |

### T12 — Udalosť 19. 11. 2026: test-export produkčnej DB v osobnom OneDrive

| Stav | Fakty | Zdroj |
|---|---|---|
| Čo sa stalo | 19:06–19:07 SEČ pri tvorbe zálohy pred vyčistením sa CSV export (113 tabuliek, 270 849 B; bez heslových hashov, tokenov, API kľúčov, obsahu Storage) uložil do `OneDrive\` a **synchronizoval do osobného OneDrive** prevádzkovateľa. Lokálna kópia zmazaná 19:10:45 (~4 min); položka prešla do online koša OneDrive. Šifrovaná záloha mimo OneDrive je bajtovo zhodná. Žiadny iný export Esblu v OneDrive. | SEC §1–§3 |
| Dotknuté údaje | Prevažne **testovacie/interné účty vytvorené prevádzkovateľom** (3 chránené účty, testovacie účty testerov), ale aj **reálne osoby**: 14 rôznych e-mailov vrátane 2–3 adries z beta zoznamu a obchodných partnerov, mená, metadáta Auth/Google identít, chat testovacích firiem, záznamy súhlasov, 1 IBAN (testovacia faktúra), 1 FCM token, 2 web-push odbery. Žiadni platiaci zákazníci. | SEC §2 |
| Pozn. | **Testovací pôvod účtov automaticky neznamená, že údaje sú anonymné** — e-maily, mená, identifikátory zariadení a Google identity sú osobné údaje aj v testovacom účte; časť adries patrí tretím osobám (beta, partneri). | SEC §2, §5 |
| Stav | **Interný záznam**; **žiadne oznámenie** ÚOOÚ ani dotknutým osobám nebolo odoslané. Technický návrh (SEC §5): zápis do internej evidencie porušení (čl. 33 ods. 5); oznámenie podľa čl. 33 ods. 1 sa javí ako nepotrebné, **ak sa potvrdí**, že súbor nebol zdieľaný a bol odstránený aj z online koša. Otvorené: vyprázdnenie položky z online koša, overenie zdieľania (vyžaduje prihlásenie prevádzkovateľa). Lehota 72 h od zistenia uplynie **22. 11. 2026 ~19:08**. Konečné rozhodnutie a zdôvodnenie = prevádzkovateľ (prípadne CLIA). | SEC §4–§5 |
| (2)/(3) | Prevencia: produkčné exporty iba šifrovane do `esblu-backups` mimo OneDrive; predvolený priečinok sťahovania mimo OneDrive. | SEC §3–§4 |

---

## 4. Otvorené otázky pre CLIA (iba nové / neuzavreté)

> Formulácie sú pracovné; poradie = priorita. Otázky k VOP sa sem nezaraďujú.

**A. Ukončenie firmy a retencia dokladov (priorita 1 — blokuje vlnu B)**

1. **Právny základ archívu po ukončení služby (GDPR čl. 28 ods. 3 písm. g), DPA 6.3.9 a 10.4).** Pri dokladoch zákazníka je Esblu sprostredkovateľ; povinnosť uchovávať (z. 431/2002 § 35, z. 222/2004 § 76) má zákazník. Smie / musí Esblu po ukončení držať archív dokladov, a ak áno, na základe (a) pokynu zákazníka v DPA (archív ako súčasť služby), (b) vlastného oprávneného záujmu Esblu (preukázanie plnenia, právne nároky — najmä dôkazy doručenia e-faktúr), alebo (c) zákonnej povinnosti? Ak nie, je správny dnešný stav (výmaz po exporte) a nesúlad je iba v informáciách poskytnutých CLIA?
2. **Režim `waived`:** ak archív áno — má mať zákazník možnosť žiadať okamžitý výmaz aj dokladov (napr. ak ich preukázateľne uchováva inde), alebo archív platí vždy? Ak archív nie — postačuje potvrdenie ownera o výmaze bez exportu ako pokyn prevádzkovateľa, alebo vyžadovať export / ďalšie upozornenie?
3. **Lehoty archívu:** 10 r. od konca roka dokladu pre všetky kategórie (vrátane histórie doručenia e-faktúr a záznamov o odovzdaní účtovníkovi), alebo pre časť 5 r.?
4. **Fyzické osoby na dokladoch** (SZČO, kontakty strán): postačuje odstrániť väzby na používateľov Esblu, alebo je potrebná ďalšia pseudonymizácia?
5. **Výdaj z archívu:** komu (bývalý zákazník, jeho účtovník, správca dane, likvidátor, súd) a s akým overením totožnosti/oprávnenia?
6. **Informovanie:** v akom rozsahu uviesť uchovanie dokladov po ukončení v PP / DPA / UI ukončenia (DRAFT-R1–R4)?
7. **Historické ukončenia:** k 19. 11. existuje 5 ukončení — všetky testovacie firmy pri schválenom vyčistení (2 doklady vyhlásené prevádzkovateľom za neúčtovné). Treba ich akokoľvek riešiť alebo evidovať (napr. aby „testovacia“ povaha bola doložená), alebo postačuje interný záznam (PC)?

**B. Vlastné technické záznamy Esblu bez definovanej lehoty**

8. Potvrdiť účel a lehotu pre `company_terminations` (doc. 5 r., nevynútené), `company_export_runs`, `billing_events` / `billing_store_reports` / `billing_invoice_documents` mimo účtovných dokladov Esblu, a nové `einvoice_deregistrations` / `einvoice_ops_alerts`.

**C. eFaktúra — iba nové body (vyriešená časť sa neotvára)**

9. **Mandát (`einvoice_mandates`):** je evidencia poverenia (kto, kedy, text vyhlásenia, snapshot mena/e-mailu/roly, SHA-256 IP so soľou a User-Agentu) údajom Esblu ako prevádzkovateľa (účel „Správa zmluvného vzťahu“, 5 r.) alebo údajom spracúvaným v mene zákazníka? Je uchovávanie hashov IP/UA primerané a aká lehota (tabuľka prežije ukončenie firmy)? Treba to uviesť v PP?
10. **Text vyhlásenia mandátu** (`efaktura-mandate-2026-11-19`, sk/en/de) — posúdiť znenie vyhlásenia o oprávnení konať za firmu a o poverení Esblu.
11. **Dôkazy prenosov po ukončení firmy:** je prípustné ponechať minimálny pseudonymizovaný záznam (ID u poskytovateľa, hash dokladu, časy, stav, bez obsahu) na ochranu právnych nárokov Esblu (5 r.) — najmä vzhľadom na kauzalitu v novej zmluve poskytovateľa? Ak áno, uviesť v PP/DPA? (Súvisí s otázkou 1.)
12. **Zaradenie eFaktura s. r. o. pri aktivácii:** stačí oznámenie nového ďalšieho sprostredkovateľa podľa DPA 9.3 (15 dní), alebo treba novú verziu DPA — vrátane jej ďalších sub-processorov v USA? (Obchodné podmienky zmluvy — limit 10 000 €/rok, kauzalita, výnimky — sú rozhodnutím prevádzkovateľa a **nie sú** predmetom otázky.)

**D. Resend, Google, Stripe**

13. **Resend:** zaradenie ako ďalšieho sprostredkovateľa (DPA príl. 3) aj ako príjemcu pri vlastných účtoch (PP); keďže je **už v prevádzke** bez predchádzajúceho oznámenia podľa DPA 9.3 — aký nápravný postup voči zákazníkom (dodatočné oznámenie, lehota na námietku)? Mechanizmus prenosu (DPF/SCC) podľa regiónu, ktorý doplní prevádzkovateľ.
14. **Resend REST ops alerty (ESBLU8):** keďže obsahujú iba kódy/počty a idú internému operátorovi, postačuje to zahrnúť pod existujúci záznam Resend, bez samostatného účelu?
15. **Google prihlásenie v appke:** potvrdiť, že stačí textová úprava PP a DPA (DRAFT-2) bez oznámenia podľa DPA 9.3 (príjemca a rozsah údajov sa nemenia).
16. **Stripe (pred aktiváciou):** rola Stripe (sprostredkovateľ vs. samostatný prevádzkovateľ pre podvody/AML); nový účel v PP (DRAFT-4) a lehota pre platobné záznamy Esblu; treba rozlišovať platbu na webe a v Android appke (webový Checkout v in-app prehliadači), ak je príjemca ten istý?

**E. Ostatné**

17. **Technická retencia dlhšia ako v PP**, kým je GDPR purge vypnutá: je potrebné informovať / upraviť text, alebo postačuje bezodkladné zapnutie purge (rozhodnutie P3)?
18. **OneDrive udalosť 19. 11. (iba ak prevádzkovateľ chce stanovisko CLIA):** je posúdenie „interná evidencia podľa čl. 33 ods. 5, bez oznámenia ÚOOÚ a dotknutým osobám“ udržateľné, ak sa potvrdí, že súbor nebol zdieľaný a bol odstránený aj z online koša — s ohľadom na to, že súbor obsahoval aj e-maily tretích osôb (beta, partneri)? Rozhodnutie treba urobiť do **22. 11. 2026 ~19:08**.

---

## 5. Návrhy znení — **všetky DRAFT, na kontrolu prevádzkovateľom, neodoslané, nezverejnené**

| ID | Kde | Obsah (skrátene) | Plné znenie |
|---|---|---|---|
| **DRAFT-1** | PP — oznámenia/autentifikácia, príjemcovia | doplniť Resend (entita, krajina doplní prevádzkovateľ), doména `mail.esblu.com` | TD §3 |
| **DRAFT-2** | PP + DPA 1.3 — Google | „… dostupné vo webovom rozhraní aj v mobilnej aplikácii Esblu.“ | TD §3 |
| **DRAFT-3** | `/subprocessors` | nahradiť historickú poznámku o Resend riadkom Resend + zjednotiť dátumy | TD §3 |
| **DRAFT-4** | PP — nový účel „Platby a správa predplatného“ | iba ak sa Stripe aktivuje | TD §3 |
| ~~DRAFT-5~~ | `/zrusenie-uctu` | **nahradený DRAFT-R1** (po náprave by „doklady sa zmažú“ nebolo pravdivé) | RN §5 |
| **DRAFT-6** | DPA príl. 3 + PP + `/subprocessors` — eFaktura s. r. o. | až po podpise zmluvy a overení Prílohy 2 | TD §3 |
| **DRAFT-7** | interné registre | aktualizovať `gdpr-subprocessors.md`, `gdpr-retention-policy.md` (Esblu s.r.o., Resend, lehoty nových tabuliek) | TD §3 |
| **DRAFT-R1** | `/zrusenie-uctu` — čo sa stane s dokladmi | archív s lehotou [doplní prevádzkovateľ] | RN §5 |
| **DRAFT-R2** | UI ukončenia firmy (SK; EN/DE po schválení) | archív, „Esblu nie je zákonný archív“ | RN §5 |
| **DRAFT-R3** | PP — účel „Uchovávanie účtovných dokladov po ukončení služby“ | právny základ podľa stanoviska CLIA | RN §5 |
| **DRAFT-R4** | DPA — článok o skončení spracúvania | uchovanie v oddelenom archíve počas [lehota] | RN §5 |

DRAFT-R1–R4 platia iba ak CLIA potvrdí otázku 1 v prospech archívu. Text vyhlásenia mandátu (otázka 10) je v kóde (`lib/einvoice/mandate-statement.ts`) — **DRAFT** do schválenia.

Krátke ilustračné znenie (**DRAFT — nepublikovať**), DRAFT-2:
> „… pričom prihlasovanie cez Google je dostupné vo webovom rozhraní aj v mobilnej aplikácii Esblu.“

---

## 6. Overenia prevádzkovateľa pred odoslaním čohokoľvek CLIA

| # | Overenie | Pre tému |
|---|---|---|
| V1 | Resend: dátum prvého odoslania, región (EÚ/US), akceptácia DPA Resend | T1, T11, otázka 13 |
| V2 | Read-only `schema_migrations`: potvrdiť `20261113100000` a `20261113110000` v produkcii (`company_export_runs` existuje podľa PC — iba formálne potvrdiť) | T4, T10 |
| V3 | Stripe entita z účtu/dokladu | T3, T11 |
| V4 | Číslo/dátum novej zmluvy eFaktura.sk, text Prílohy 2 (DPA); rozhodnutie o podpise | T4 |
| V5 | `info@` / `privacy@` nie sú presmerované na Gmail | Q11 (owner verify) |
| V6 | Rozhodnutie o zapnutí GDPR purge (P3) | T9 |
| R-V1 | Read-only `company_terminations` podľa `export_mode`/`status` — potvrdiť, že všetkých 5 je testovacích | T8 |
| R-V2 | Zápis vyčistenia 19. 11. v `docs/ops/service-intervention-log.md` s referenciou rozhodnutia | T8 |
| S1 | OneDrive: odstrániť položku z online koša (aj druhej úrovne), overiť nezdieľanie, zapísať rozhodnutie čl. 33 do evidencie — **do 22. 11. ~19:08** | T12 |
| D1 | Zjednotiť D24 §1.1 („pozvánky“) s TD §2.2 | T1 |
| D2 | Rozhodnúť, či D24 (termín 24. 11.) doplniť o tento súhrn, alebo poslať RN samostatne; VOP časť D24 oddeliť | všetky |

---

## 7. Mimo rozsahu

- **VOP** (vrátane predplatného, 48 h ochrannej lehoty, refundácií, spotrebiteľov — D24 §3.2 body 4–6 a Príloha A) — riešia sa **samostatne**, nie v tomto GDPR podklade.
- Obchodné podmienky zmluvy s eFaktura.sk (limit zodpovednosti 10 000 €/rok, kauzalita, výnimky) — rozhodnutie prevádzkovateľa.
- Daňové otázky dokladov za predplatné (§ 7a, variant A/B) — účtovníčka (`docs/accountant-questions-billing-2026-11-19.md`).
- Apple prihlásenie / iOS (D24 §3.1) — budúca funkcia, nie delta produkcie.
