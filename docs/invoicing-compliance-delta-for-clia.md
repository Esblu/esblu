# Esblu — Compliance delta pre CLIA review

**Dátum:** 2026-09-20
**Účel:** podklad pre externý právny / GDPR review (CLIA)
**Stav:** interný pracovný dokument

---

## ⚠️ Čo tento dokument NIE JE

- **Nie je** to právne stanovisko.
- **Nie je** to návrh zmien Privacy Policy, Terms, DPA, Cookies ani zoznamu subprocesorov.
- **Nie je** to schválenie čohokoľvek.

**Právne stránky sa v tejto fáze nemenia.** CLIA review ešte nie je finálne uzavretý. Tento dokument iba zaznamenáva, **čo v produkte pribudlo alebo pribudne od posledného právneho review**, aby mal právny tím úplný vstup.

---

## 1. Zhrnutie pre právny tím

Od posledného review Esblu pridalo alebo plánuje pridať funkcie, ktoré:

1. zavádzajú **nové kategórie osobných údajov tretích strán** (údaje o dodávateľoch a ich zamestnancoch z prijatých dokladov),
2. rozširujú **AI spracovanie** z evidenčných dokladov na **účtovné doklady**,
3. pripravujú **prenos údajov do externej siete (Peppol)** cez zatiaľ nevybraného poskytovateľa,
4. zavádzajú **nové identifikátory** (elektronické adresy, registračné a daňové identifikátory),
5. menia **retenčný profil** — účtovné doklady majú zákonnú retenciu, ktorá sa líši od ostatných dát v systéme.

Body 3 a 5 považujeme za tie, ktoré si vyžadujú najviac pozornosti.

---

## 2. Čo pribudlo od posledného review (už v produkcii)

### 2.1 Obchodní partneri (`business_partners`)

**Nová kategória:** kmeňové dáta o obchodných partneroch zákazníka.

Polia: `legal_name`, `ico`, `dic`, `ic_dph`, adresa, `email`, `phone`, `peppol_identifier`, platobné podmienky.

**Právne relevantné:**
- Pri partneroch, ktorí sú **fyzické osoby – podnikatelia (živnostníci)**, sú `legal_name`, adresa, `email` a `phone` **osobné údaje**.
- `dic` a `ic_dph` sú pri SZČO naviazané na rodné číslo — **citlivejší identifikátor**, než sa na prvý pohľad zdá.
- Esblu je voči týmto údajom **sprostredkovateľ**; prevádzkovateľom je zákazník (firma, ktorá Esblu používa).
- Dotknutá osoba (živnostník–dodávateľ) **nemá s Esblu žiadny vzťah** a pravdepodobne o existencii Esblu nevie.

**Otázka pre CLIA:** je súčasná DPA formulovaná tak, aby pokryla údaje tretích strán, ktoré do systému vkladá zákazník bez ich vedomia? Je transparentnosť voči dotknutým osobám dostatočne prenesená na zákazníka ako prevádzkovateľa?

### 2.2 Fakturačný profil firmy (`company_billing_profile`)

IČO, DIČ, IČ DPH, adresa, **IBAN**, BIC, kontaktný e-mail, logo.

**Právne relevantné:** IBAN je finančný údaj. Pri SZČO je to osobný finančný údaj.

### 2.3 Faktúry a ich snapshoty

**Nové tabuľky:** `invoices`, `invoice_items`, `invoice_parties`, `invoice_tax_breakdowns`, `invoice_payments`, `invoice_events`.

**Kľúčová vlastnosť z pohľadu GDPR:**

> `invoice_parties` je **nemenný snapshot** údajov o protistrane v okamihu finalizácie. Finalizovaná faktúra je **immutable** — chránená štyrmi DB triggermi.

**Dôsledok, ktorý musí CLIA posúdiť:**

**Právo na opravu (čl. 16) a právo na výmaz (čl. 17) sa na snapshot v finalizovanej faktúre technicky NEDAJÚ uplatniť bežným spôsobom.** A to je zámerné a správne — účtovný doklad, ktorý sa dá spätne zmeniť, nie je účtovný doklad.

Toto nie je nedostatok implementácie. Je to **stret dvoch právnych režimov**: GDPR práva dotknutej osoby verzus zákonná povinnosť uchovávať nemenné účtovné záznamy (zákon o účtovníctve, zákon o DPH).

**Toto považujeme za najdôležitejšiu otázku celého dokumentu.** Potrebujeme od CLIA:
1. potvrdenie, že immutabilita je v tomto kontexte obhájiteľná ako plnenie zákonnej povinnosti podľa čl. 17 ods. 3 písm. b) GDPR,
2. odporúčanie, ako to formulovať v Privacy Policy a DPA,
3. odporúčanie, ako má vyzerať postup, keď dotknutá osoba o výmaz požiada.

**Poznámka:** opravný mechanizmus existuje — `credit_note` / `debit_note` s väzbou `corrects_invoice_id`. Oprava teda vzniká ako **nový doklad**, nie prepísaním starého. To je účtovne správne a pravdepodobne aj právne obhájiteľnejšie než prepis.

### 2.4 AI Inbox — rozšírenie na účtovné doklady

**Existujúce:** `documents` s `ai_model`, `ai_raw_output` (jsonb), `extracted_fields` (jsonb), `field_confidence` (jsonb), `document_review_log`.

**Zmena oproti poslednému review:** AI spracovanie sa rozširuje z evidenčných dokladov (dodacie listy, vážne lístky) na **účtovné doklady tretích strán** — prijaté faktúry.

**Právne relevantné:**
- `ai_raw_output` môže obsahovať **kompletný prepis dokladu** — mená kontaktných osôb dodávateľa, adresy, telefónne čísla, IBAN, prípadne podpisy.
- Sú to údaje **o subjektoch, ktoré nie sú zákazníkmi Esblu** a ktoré nemajú dôvod očakávať, že ich faktúra prejde AI spracovaním.
- `document_review_log` obsahuje `old_value`/`new_value` a `document_snapshot` — teda aj hodnoty, ktoré používateľ opravil, čo môže zahŕňať chybne extrahované osobné údaje.

**Otázky pre CLIA:**
1. Má sa `ai_raw_output` uchovávať trvale, alebo má mať vlastnú kratšiu retenciu než samotný doklad?
2. Je potrebné explicitné AI transparency vyhlásenie? *(Poznámka z konkurenčného auditu: **nikto z porovnávaných konkurentov ho verejne nemá**, hoci traja AI aktívne používajú. Je to teda zároveň príležitosť odlíšiť sa, nie len povinnosť.)*
3. Vzťahuje sa na toto spracovanie AI Act? Ak áno, do ktorej rizikovej kategórie spadá extrakcia údajov z dokladov?

### 2.5 Secure assistant action confirmation

`assistant_action_confirmations` — canonical args, nonce, server proof, expirácia.

**Právne relevantné (pozitívne):** je to technické opatrenie podľa čl. 32 GDPR, ktoré bráni tomu, aby automatizovaný systém vykonal nezamýšľanú akciu nad osobnými údajmi.

**Zároveň:** `canonical_args` môžu obsahovať osobné údaje (meno partnera, suma, číslo faktúry). Retencia týchto záznamov by mala byť definovaná.

### 2.6 Firemný chat

`chat_conversations`, `chat_messages`, `chat_attachments`, `chat_message_references`.

**Právne relevantné:** obsah komunikácie medzi zamestnancami. Prílohy môžu obsahovať čokoľvek. Retencia a prístup zamestnávateľa k obsahu chatu je samostatná téma, ktorú tento dokument len zaznamenáva.

---

## 3. Čo pribudne (navrhnuté, zatiaľ neaplikované)

Migračné SQL je pripravené, **do produkcie sa neaplikovalo**.

### 3.1 Prijaté faktúry (`direction='received'`)

**Nová kategória:** účtovné doklady **tretích strán** uložené v systéme zákazníka.

Rozdiel oproti vydaným faktúram je podstatný: pri vydanej faktúre zákazník spracúva údaje svojho odberateľa, s ktorým má zmluvný vzťah. **Pri prijatej faktúre spracúva údaje dodávateľa a obsah dokumentu, ktorý mu niekto iný poslal.**

Nové polia: `supplier_business_partner_id`, `supplier_invoice_number`, `received_at`.

### 3.2 Dedupe

| Pole | Obsah | Právne relevantné |
|---|---|---|
| `documents.content_sha256` | SHA-256 binárneho obsahu súboru | Hash sám osebe nie je osobný údaj, ale je **jednoznačne spojiteľný** s konkrétnym dokumentom |
| `invoices.dedupe_fingerprint` | SHA-256 z identity dodávateľa + číslo + dátum + suma + mena | **Je odvodený z osobných údajov** (identita dodávateľa). Je to pseudonymizovaný, nie anonymizovaný údaj. |
| `invoices.transport_message_id` | ID správy z Peppol siete | Metadáta o komunikácii |

**Otázka pre CLIA:** ak je dokument vymazaný, má sa vymazať aj jeho hash a fingerprint? Z pohľadu dedupe by ich zachovanie malo zmysel (zabránilo by opätovnému nahratiu), z pohľadu GDPR je to sporné, pretože ide o údaj odvodený z osobných údajov.

**Náš návrh na posúdenie:** pri výmaze dokumentu hash **vymazať**. Dedupe nie je dôvod uchovávať odvodený údaj po výmaze zdroja.

### 3.3 EN16931 P1 — nové identifikátory

Na `invoice_parties`, `business_partners` a `company_billing_profile`:

| Pole | Poznámka |
|---|---|
| `electronic_address` + `_scheme_id` | **Nová kategória: elektronická adresa v Peppol sieti.** Verejne dohľadateľná v Peppol SMP registri. |
| `legal_registration_id` + `_scheme_id` | Registračný identifikátor |
| `vat_identifier` | Daňový identifikátor — **pri SZČO naviazaný na rodné číslo** |
| `generic_identifier` + `_scheme_id` | Generický identifikátor |

Na `invoices`: `buyer_reference`, `purchase_order_reference`, `payment_means_code`, `payment_reference`.

**Poznámka k elektronickým adresám:** Peppol Participant ID je zapísané vo verejnom SMP/SML registri. To znamená, že ide o údaj, ktorý je **už verejný** — ale jeho uloženie v Esblu a spájanie s ostatnými údajmi o partnerovi je samostatné spracovanie.

### 3.4 Štruktúrovaná eFaktúra — outbound a inbound

**Toto je najvýznamnejšia zmena z pohľadu prenosu údajov.**

**Outbound:** canonical faktúra → UBL 2.1 XML → **externá sieť (Peppol)** → poskytovateľ (Access Point) → dodávateľ/odberateľ.

**Inbound:** externý XML → parsovanie → canonical received invoice.

**Právne relevantné:**

1. **Nový príjemca údajov.** Peppol Access Point provider bude **ďalší sprostredkovateľ** (sub-processor). Bude ho treba doplniť do zoznamu subprocesorov a uzavrieť s ním zmluvu podľa čl. 28.

2. **Provider zatiaľ nie je vybraný — a to je zámerné.** Zadanie správne hovorí nevyberať ho teraz. Z konkurenčného auditu: KROS použil **eConnect International B.V.** (ISO 27001), STORMWARE si postavil vlastný akreditovaný AP.

3. **Otázka pre CLIA:** aké požiadavky má mať provider z pohľadu GDPR? Konkrétne:
   - umiestnenie spracovania (EÚ/EHP)
   - certifikácie (ISO 27001 ako minimum?)
   - podmienky pre sub-sub-processing
   - retencia správ na strane providera

   **Toto potrebujeme vedieť PRED výberom providera, nie po ňom.**

4. **Prenos mimo EÚ.** Peppol je medzinárodná sieť. Ak zákazník fakturuje do tretej krajiny, údaje opustia EÚ. **Právny základ pre taký prenos musí byť posúdený.**

5. **Uchovávanie originálneho XML.** Prijatý XML sa zachová ako `document_attachments`. Je to originálny doklad od tretej strany.

### 3.5 Väzba dokument ↔ faktúra

`document_links.invoice_id`. Metadáta o vzťahu, nie nový osobný údaj.

---

## 4. Retencia — samostatná a dôležitá téma

Fakturačné dáta majú **iný retenčný režim než zvyšok systému.**

| Kategória | Poznámka |
|---|---|
| Finalizované faktúry | **Zákonná retenčná povinnosť** (zákon o účtovníctve, zákon o DPH). Nemôžu sa mazať na žiadosť dotknutej osoby. |
| `invoice_parties` snapshoty | Neoddeliteľná súčasť účtovného dokladu — rovnaká retencia |
| `invoice_events` | Audit stopa. Retencia? |
| `invoice_payments` | Súčasť účtovnej evidencie |
| Prijaté faktúry a ich originály | Rovnaká zákonná retencia ako vydané |
| `documents.ai_raw_output` | **NIE je účtovný doklad.** Môže mať kratšiu retenciu. |
| `document_review_log` | Audit stopa AI opráv. Retencia? |
| `content_sha256`, `dedupe_fingerprint` | Odvodené údaje. Viazať na retenciu zdroja? |
| `assistant_action_confirmations` | Krátkodobé, majú expiráciu |
| Prepisy hlasu (budúce) | Retencia musí byť definovaná pred spustením |

**Otázky pre CLIA:**
1. Aká je presná zákonná retenčná lehota pre účtovné doklady v našom kontexte a ako ju formulovať v Privacy Policy?
2. Čo sa deje s účtovnými dokladmi **po ukončení predplatného Esblu**? Zákazník má zákonnú povinnosť ich uchovávať — má Esblu povinnosť mu ich sprístupniť, exportovať, alebo uchovávať?
3. Ako sa retencia účtovných dokladov zosúlaďuje s právom na výmaz?

*(Poznámka z konkurenčného auditu: iDoklad vo svojich podmienkach uvádza, že zmazanie účtu znamená trvalé zmazanie dát; FLOWii uvádza, že po skúšobnej dobe a 30 dňoch neaktivity sa dáta vymažú. Ani jeden verejne nerieši kolíziu so zákonnou retenciou účtovných dokladov. Nie je to tvrdenie o ich súlade — je to len pozorovanie, že tento problém nie je na trhu štandardne vyriešený.)*

---

## 5. Prístupové oprávnenia

Implementované a relevantné pre GDPR ako opatrenie podľa čl. 32:

- `finance.view` / `finance.manage` — oddelené od admin role
- **Admin nemá automaticky prístup k financiám** — to je vedomé rozhodnutie a z pohľadu minimalizácie prístupu k osobným údajom správne
- Owner má implicitný finance prístup
- Company-scoped RLS na všetkých 39 tabuľkách
- Fail-closed prístup k tabuľkám bez policies

**Pre CLIA relevantné:** zamestnanec bez `finance.view` **nevidí** údaje o dodávateľoch v kontexte faktúr. To je uplatnenie zásady minimalizácie.

### 5.1 Rozšírenie na OBSAH finančných dokladov (migrácie 20260921120000, 20260921140000)

Pôvodné `finance.view` / `finance.manage` chránili **fakturačné dáta**, nie **obrázok dokladu**. Zamestnanec ani admin bez finance nevideli faktúru v module Faktúry, ale jej fotografiu v Inboxe si otvorili — a cez podpísanú URL aj stiahli. Bolo to opravené:

| Vrstva | Pred | Po |
|---|---|---|
| `documents` / `document_links` / `document_attachments` SELECT | iba company scope | + `finance.view` pre finančné doklady |
| `documents` UPDATE/DELETE | owner/admin | + `finance.manage` pre finančné doklady |
| `document_links` / `document_attachments` INSERT/UPDATE/DELETE | owner/admin | + `finance.manage` pre finančné doklady |
| Storage `ai-inbox-documents` SELECT/DELETE | iba členstvo vo firme | + `finance.view` / `finance.manage` |

**Finančný doklad** = `document_type` `invoice` alebo `receipt`, plus **každý ešte neklasifikovaný doklad** (`status` `uploaded`/`processing`) — fail-closed, keďže stĺpec má DEFAULT `'other'`.

**Nefinančné prevádzkové doklady** (PZP, technický preukaz, servisné doklady, vážne lístky, dodacie listy) majú **nezmenený** prístup. Zamestnanec, ktorý ich potreboval, ich má naďalej.

**Pre CLIA relevantné:** minimalizácia sa teraz uplatňuje aj na samotný obsah dokladu tretej strany, nie len na odvodené dáta. Zároveň platí, že zamestnanec **smie doklad nahrať** (aby sa dostal k účtovníčke), ale po uložení ho už nevidí.

### 5.2 `ai_scan_usage` — nové technické počítadlo (migrácia 20260921120000)

Nová tabuľka, ktorá nie je funkciou produktu, ale **bezpečnostným opatrením podľa čl. 32** (ochrana pred zneužitím drahého AI endpointu).

**Účel spracúvania:** technická ochrana pred zneužitím a rate-limiting AI scan endpointov. Nie účtovanie, nie produktový/cenový limit, nie profilovanie, nie analytika správania.

**Uložené údaje — úplný zoznam:**

| Stĺpec | Obsah | Osobný údaj |
|---|---|---|
| `id` | technický kľúč | nie |
| `company_id` | firma, ktorej sa volanie započítalo | nie (údaj o zákazníkovi) |
| `user_id` | člen, ktorý volanie vykonal | **áno** (identifikátor používateľa) |
| `endpoint` | konštanta z allowlistu, dnes iba `scan-document` | nie |
| `created_at` | čas volania | nepriamo |

**Čo sa NEUKLADÁ — dôležité:** žiadny obsah dokladu, žiadny súbor, žiadny výsledok extrakcie, žiadne meno dodávateľa, žiadna suma, žiadny `document_id`, žiadna IP adresa, žiadny user agent. Z riadku sa nedá zistiť, čo bolo na doklade ani ktorého dokladu sa volanie týkalo.

**Prístup:** tabuľka má zapnuté RLS a **zámerne žiadnu politiku** — klient (anon aj prihlásený) ju nevie čítať ani zapisovať. Zapisuje výhradne `esblu_consume_ai_scan_quota()` (SECURITY DEFINER). Overené testom.

**Navrhovaná retencia:** **30 dní.** Guard sám potrebuje len posledných 24 hodín; zvyšok je rezerva na vyšetrenie incidentu zneužitia. Dlhšie uchovávanie nemá účel a bolo by v rozpore s minimalizáciou.

**Navrhovaná stratégia mazania:** jednoduchý periodický prune
`delete from public.ai_scan_usage where created_at < now() - interval '30 days';`
**Zatiaľ NEIMPLEMENTOVANÉ.** Projekt dnes nemá auditovanú cron/scheduler infraštruktúru (`pg_cron` nie je nainštalovaný) a zavádzať ju bez samostatného auditu by bolo unáhlené. Pri súčasnom objeme (jednotky riadkov) nejde o tlak na termín — treba to však uzavrieť skôr, než sa AI Inbox otvorí širšiemu okruhu zákazníkov.

**Otázka pre CLIA — data minimization:** guard počíta **per firma**, takže `user_id` preň nie je potrebný. Drží sa výhradne pre prípad vyšetrenia zneužitia ("ktorý člen vyčerpal kvótu"). Ak CLIA vyhodnotí, že tento účel neobstojí, stĺpec sa dá zahodiť bez akéhokoľvek dopadu na funkciu ochrany.

---

## 6. Nové subprocesory

| Kategória | Stav |
|---|---|
| **Peppol Access Point provider** | ⚠️ **ZATIAĽ NEVYBRANÝ.** Bude to nový sprostredkovateľ. Výber musí prebehnúť **po** stanovení GDPR požiadaviek zo strany CLIA, nie pred ním. |
| **AI provider pre extrakciu z dokladov** | Rozsah spracovania sa rozširuje na účtovné doklady tretích strán. Treba overiť, či existujúca zmluva a existujúci zápis v zozname subprocesorov toto rozšírenie pokrývajú. |
| Infraštruktúra (Supabase, `eu-central-1`) | Bez zmeny |

---

## 7. Otvorené otázky — zhrnutie pre CLIA

**Prioritné:**

1. **Immutabilita finalizovanej faktúry vs. čl. 16 a 17 GDPR.** Ako to formulovať? Aký je postup pri žiadosti o výmaz?
2. **GDPR požiadavky na Peppol providera** — potrebujeme ich **pred** výberom.
3. **Prenos údajov mimo EÚ cez Peppol** — právny základ.
4. **Retencia účtovných dokladov po ukončení predplatného.**
5. **Rozsah AI spracovania** — pokrýva existujúca dokumentácia rozšírenie na účtovné doklady tretích strán?

**Ďalšie:**

6. Retencia `ai_raw_output` — rovnaká ako doklad, alebo kratšia?
7. Osud `content_sha256` a `dedupe_fingerprint` po výmaze dokumentu.
8. Potreba a forma AI transparency vyhlásenia.
9. Aplikovateľnosť AI Act na extrakciu údajov z dokladov.
10. Transparentnosť voči dotknutým osobám, ktoré nie sú zákazníkmi Esblu (dodávatelia–SZČO).
11. Retencia `invoice_events`, `document_review_log`, `assistant_action_confirmations`.
12. Retencia prepisov hlasu (pred spustením hlasových funkcií).
13. **`ai_scan_usage`** (§5.2): potvrdenie 30-dňovej retencie a stanovisko, či `user_id` obstojí pre účel vyšetrenia zneužitia, alebo sa má zahodiť.

---

## 8. Odporúčané poradie

1. CLIA review tohto dokumentu
2. Rozhodnutie o formulácii immutability v Privacy Policy a DPA
3. **Stanovenie GDPR požiadaviek na Peppol providera** → až potom výber providera
4. Aktualizácia Privacy Policy, DPA a zoznamu subprocesorov — **v jednom kroku, nie po častiach**
5. Prípadné AI transparency vyhlásenie
6. Až potom spustenie eFaktúry pre zákazníkov

**Do dokončenia kroku 4 sa právne stránky nemenia.**
