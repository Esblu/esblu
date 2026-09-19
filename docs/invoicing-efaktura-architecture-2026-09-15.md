# Esblu — Fakturačný modul a slovenská eFaktúra: AUDIT + ARCHITEKTÚRA (Fáza 0)

**Dátum:** 15. september 2026 (revízia 1 — korekcie zapracované v ten istý deň po podmienečnom schválení)
**Status:** **Podmienečne schválené používateľom, s 13 záväznými korekciami, ktoré sú nižšie zapracované priamo do textu (označené "korekcia N").** Žiadny kód, žiadna migrácia, žiadna zmena produkčnej DB/Vercelu/právnych dokumentov nebola v rámci tejto úlohy vykonaná — ani v pôvodnej verzii, ani v tejto revízii. Ďalší všeobecný právny/provider research sa na pokyn používateľa už nerobil — korekcie 1-13 vychádzajú z priamej pripomienky používateľa, nie z nového web-researchu (kde je to relevantné, je to pri danej korekcii poznamenané).
**Cieľ:** Nie "spraviť faktúry v Esblu", ale spraviť fakturačný základ tak, aby sa o pár mesiacov nemusel prerábať kvôli slovenskej eFaktúre/Peppolu.

## Log revízií
- **15.9.2026, revízia 0:** Pôvodný 40-bodový dokument.
- **15.9.2026, revízia 1:** Zapracovaných 13 korekcií používateľa (PDS nie je jediný spôsob doručenia; syntax-neutrálny model; immutable `invoice_parties` snapshot namiesto mutable FK; vyššia presnosť `quantity`/`unit_price`; `invoice_tax_breakdowns` ako normalizovaná tabuľka namiesto jsonb; atomická finalizácia cez jednu RPC; `invoice_events` bez plného snapshotu; sprísnená terminológia dokladov; finalizovaná faktúra sa nikdy neprepína na cancelled; sprísnená dedup hierarchia; oprava tvrdenia o DIČ/IČ DPH; explicitne neuzavretý výber providera + doplnená chýbajúca sekcia s kandidátmi). Pridaná FÁZA 1A (nižšie, na konci dokumentu).

---

## Ako číslo tohto dokumentu čítať

Každé tvrdenie o práve/regulácii je označené:
- **(A) POTVRDENÉ PRÁVO/ŠPECIFIKÁCIA** — priamo zo zákona alebo oficiálnej technickej špecifikácie.
- **(B) IMPLEMENTAČNÝ DETAIL** — ako to má podľa oficiálnych zdrojov v praxi fungovať, ale nejde o záväzný text zákona.
- **(C) PODLIEHA BUDÚCEJ ZMENE** — návrh, nedokončené, alebo metodicky sa ešte môže spresniť.

Všetky právne zistenia pochádzajú z web-research vykonaného 15. septembra 2026 výhradne z primárnych/oficiálnych zdrojov (financnasprava.sk, slov-lex.sk, OpenPeppol, Európska komisia). Pri niekoľkých detailoch (presné sumy pokút, presné znenie §69/§85o) research explicitne odporúča manuálne overenie priamo v texte zákona pred záväzným citovaním — je to vyznačené pri danom bode. Toto NIE JE právne stanovisko — finálne právne posúdenie patrí CLIA (bod 32).

---

## 1. Aktuálny právny/technický stav slovenskej eFaktúry

**(A)** Zákon č. **385/2025 Z. z.**, ktorým sa mení a dopĺňa zákon č. 222/2004 Z. z. o DPH, bol schválený NR SR **9. decembra 2025** a zavádza povinnú elektronickú fakturáciu (eFaktúra). Kľúčové ustanovenie: **§ 85o** (nová eFaktúra/eReporting povinnosť), **§ 76a** (certifikácia poskytovateľov doručovacej služby — PDS), **§ 71 ods. 1 písm. b)** (povinnosť príjemcu vedieť prijať eFaktúru).

**(A) Účinnosť:** **1. január 2027** pre povinnú domácu B2B/B2G eFaktúru. Dobrovoľné/pilotné obdobie beží približne od Q2 2026 do 31.12.2026. Dátum sa v žiadnom skúmanom zdroji neposunul (nezistený odklad ani zrýchlenie).

**(A) Druhý, samostatný medzník: 1. júl 2030** — zrušenie kontrolného výkazu a súhrnného výkazu na Slovensku, súbežne s celoeurópskym nábehom cezhraničného DRR (Digital Reporting Requirements) podľa ViDA (bod 32/EU rámec nižšie).

**(A) Technický štandard:** Peppol BIS Billing (UBL 2.1), EN 16931-kompatibilný. **Dôležitá korekcia oproti bežnému očakávaniu:** Slovensko **NEPOUŽÍVA** klasický 4-corner Peppol model, ale **5-corner Peppol CTC model** — piaty "corner" (C5) je Finančná správa, ktorá popri doručení faktúry (C2→C3) dostáva paralelne aj **SK TDD (Slovak Tax Data Document)** na daňové reportovanie. Toto je architektonicky dôležité: eReporting nie je len "kópia faktúry", je to štrukturálne samostatný dátový tok.

**(A) Kto MUSÍ VYSTAVOVAŤ:** platitelia DPH (§4, §4b, §4c zákona o DPH) pri domácich B2B/B2G dodávkach.
**(A) Kto MUSÍ VEDIEŤ PRIJAŤ:** širšie — každá právnická osoba a každá zdaniteľná osoba (podnikateľ), **vrátane neplatiteľov DPH**. Príjemcov je teda viac než vystaviteľov (nie je to o skoršom termíne, ale o širšej množine povinných subjektov).

**(A) B2C je explicitne VYLÚČENÉ** z povinnosti ("na vzťah B2C sa povinnosť elektronickej fakturácie od 1.1.2027 nevzťahuje" — oficiálna tlačová správa FS).

**(A) Výnimky:** oslobodené plnenia (§28–§43/§47 zákona o DPH), hranica €400 viazaná na eKasa zjednodušené doklady. **Nezistená žiadna plošná výnimka podľa obratu/veľkosti firmy** — povinnosť sa netýka len veľkých firiem.

**(A) OPRAVA (14.9.2026 → 15.9.2026, na základe pripomienky používateľa):** PDS/Peppol **NIE JE jediný prípustný spôsob doručenia eFaktúry.** §85o umožňuje aj iný spôsob doručenia elektronickej faktúry v EN16931-kompatibilnom formáte, **ak s tým príjemca súhlasí** — PDS/Peppol je teda primárny/predvolený kanál (a jediný, pre ktorý dnes existuje hotová technická infraštruktúra a certifikačný register), nie však jediný právne prípustný. **Dôsledok pre architektúru (bod 9/14 nižšie): kanonický model aj provider abstrakcia nesmú predpokladať, že "odoslanie eFaktúry" = "odoslanie cez PDS/Peppol" — musia mať priestor pre alternatívny, priamy EN16931 delivery kanál so súhlasom príjemcu**, aj keď sa v praxi Fázy 6-7 s najväčšou pravdepodobnosťou implementuje najprv PDS/Peppol cesta (je dnes jediná s certifikačnou infraštruktúrou). Táto korekcia nebola nezávisle re-verifikovaná novým web-researchom (podľa pokynu používateľa žiadny ďalší všeobecný research) — odporúčam ju pred finálnym publikovaním overiť priamo v texte §85o.
Oficiálny register certifikovaných PDS: **https://vpds.financnasprava.sk/** (vyžaduje prihlásenie cez portál FS — nebolo možné anonymne prehliadať v rámci tohto researchu, viď bod 15).

**(A) eReporting** je pri type 1.1.2027–30.6.2030 v tranzitnom režime: dodávateľ aj príjemca musia reportovať dáta faktúry FS do **5 dní**, ale táto povinnosť sa **automaticky považuje za splnenú doručením cez PDS** (§85o ods. 11) — t.j. certifikovaný PDS to zabezpečí automaticky, firma nemusí reportovať manuálne zvlášť. Od 1.7.2030 sa mení na takmer reálny čas a kontrolný/súhrnný výkaz sa ruší.

**(A) Opravné doklady** (dobropis/ťarchopis/storno) zostávajú v režime eFaktúry — musia odkazovať na číslo pôvodnej faktúry (§85o ods. 5; v EN16931/Peppol termínoch pole **BT-25**, Preceding Invoice Reference).

**(A) Faktúra k prijatej platbe (zálohová faktúra) JE daňový doklad a PODLIEHA eFaktúre.** **Proforma faktúra / výzva na úhradu NIE JE faktúrou** podľa §74 ods. 1 zákona o DPH a **eFaktúre nepodlieha vôbec** — toto rozlíšenie sa novým zákonom nemení, len sa naň nabaľuje elektronický formát pre dokumenty, ktoré už dnes spĺňajú náležitosti faktúry.

**(C) Nepotvrdené — reverse charge v stavebníctve (§69 ods. 12):** Napriek cielenému hľadaniu sa nenašiel žiadny primárny zdroj, ktorý by explicitne riešil interakciu prenesenia daňovej povinnosti v stavebníctve s eFaktúrou. Silný, ale NEPOTVRDENÝ predpoklad: keďže faktúra s prenesenou daňovou povinnosťou stále spĺňa definíciu "faktúra" podľa §74, pravdepodobne podlieha rovnakej povinnosti (s EN16931 VAT category kódom **AE** pre reverse charge) — **toto musí byť pred implementáciou stavebno-špecifickej logiky overené priamo (metodické usmernenia FS 1/DPH/2026/I, 7/DPH/2025/I, alebo dopyt na efaktura@financnasprava.sk).**

## 2. Zdroje a dátum overenia

Všetky nižšie odkazy boli overené web-researchom **15. septembra 2026**:

| Zdroj | Typ | Posledná aktualizácia |
|---|---|---|
| [financnasprava.sk/.../e-faktura](https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/e-faktura) | Oficiálna hlavná stránka FS | 14.9.2026 |
| [FS tlačová správa 7.4.2026 (PDF)](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Pre_media/Tlacove_spravy/Rok_2026/2026.04.07_TS_eFaktura.pdf) | Oficiálna TS | 7.4.2026 |
| [FS FAQ 9/DPH/2025/IM](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Podnikatelia/Dan_z_pridanej_hodnoty/efaktura/2026/2026.09.11_FAQ_eFaktura.pdf) | Priebežne aktualizovaný oficiálny FAQ | 11.9.2026 (revidovaný ~11×) |
| [Slov-Lex — 385/2025 Z. z., konsolidované znenie k 1.1.2027](https://static.slov-lex.sk/static/SK/ZZ/2025/385/20270101.html) | Primárny právny text | — |
| [Slov-Lex — register 385/2025](https://www.slov-lex.sk/ezbierky/pravne-predpisy/SK/ZZ/2025/385) | Register | — |
| [OpenPeppol — Slovakia country profile](https://peppol.org/learn-more/country-profiles/slovakia/) | Oficiálna technická špecifikácia | 24.4.2026 |
| [Peppol Testbed — SK Billing eInvoicing and Tax Reporting Environment Description v1.1](https://www.testbed.peppol.org/assets/documentation/SK-Billing-eInvoicing-and-Tax-Reporting-Environment-Description-v1.1.pdf) | Technická špecifikácia | 5.3.2026 |
| [European Commission — VAT in the Digital Age (ViDA)](https://taxation-customs.ec.europa.eu/taxation/vat/vat-digital-age-vida_en) | Oficiálny EÚ zdroj | 28.7.2026 |
| [vpds.financnasprava.sk](https://vpds.financnasprava.sk/) | Oficiálny register PDS (login-gated) | — |
| [SKDP — Schválená novela](https://www.skdp.sk/clanky/schvalena-novela-zakona-o-dph-ktorou-sa-zavadza-e-faktura) | Odborná komora (sekundárny, na krížovú kontrolu) | — |

**Metodologická výhrada:** Citácie z PDF/HTML zdrojov boli získané cez AI-sumarizačný fetch nástroj, nie ručným čítaním riadok po riadku. Pri právne najcitlivejších detailoch (presné sumy pokút v §85o ods. 12–13, presné znenie §69/§85o k reverse charge) research explicitne odporúča nezávislé manuálne overenie priamo v [konsolidovanom texte](https://static.slov-lex.sk/static/SK/ZZ/2025/385/20270101.html) predtým, než sa citujú ako záväzné v akomkoľvek externom dokumente (napr. zmluvných podmienkach).

## 3. Rozsah k 1.1.2027 — čo presne bude Esblu musieť podporovať

K 1.1.2027 musí firma používajúca Esblu (ako platiteľ DPH vystavujúci domáce B2B/B2G faktúry) vedieť:
1. **Prijímať** eFaktúry (Peppol/EN16931 XML cez certifikovaný PDS) — povinnosť sa týka prakticky každej firmy, aj neplatiteľa DPH.
2. **Vystavovať** eFaktúry, ak je platiteľom DPH fakturujúcim inému podnikateľovi/orgánu domácky.
3. B2C zostáva mimo — Esblu môže naďalej fakturovať fyzickým osobám bez eFaktúry (klasická faktúra/PDF postačuje).
4. Zálohové faktúry (faktúra k prijatej platbe) patria do režimu; proforma/výzva na úhradu nie.
5. Opravné doklady musia odkazovať na pôvodnú faktúru a ísť tým istým kanálom.

**Dôsledok pre architektúru:** Esblu potrebuje jasné oddelenie "faktúra" (daňový doklad, podlieha vyššie uvedenému) od "proforma/výzva na úhradu" (nepodlieha) už na úrovni dátového modelu — nie iba UI textu (bod 9, 13).

## 4. Čo musí Esblu vedieť (zhrnutie požiadaviek z bodu 1–3 pre návrh)

- Rozlišovať vystavené vs. prijaté faktúry, a v rámci vystavených platiteľa DPH vs. neplatiteľa.
- Podporovať draft → finalizácia → (voliteľne) odoslanie cez eFaktúru, s immutabilitou po finalizácii.
- Podporovať opravné doklady s referenciou na pôvodný doklad (nie editáciu finalizovanej faktúry).
- Vedieť rozlíšiť faktúru od proformy/výzvy na úhradu (proforma nikdy nejde do eFaktúra flow).
- Byť pripravené na to, že firma bude môcť/musieť vybrať certifikovaného PDS a cez neho posielať/prijímať.
- Sledovať stav doručenia/eReportingu (bod 6 pri eReportingu vyššie — v praxi to za firmu z veľkej časti robí PDS, ale Esblu musí vedieť stav zobraziť a auditovať).

---

## 5. Audit existujúceho Esblu — čo reálne existuje v produkcii

Vykonané priamym auditom produkčnej DB (`fkpgvgvsmbpieduoatrt`, iba READ dopyty cez Supabase MCP) a kódovej základne (`/home/claude/esblu-check`, zrkadlo `C:\Users\roiaj\assetpilot`), **15.9.2026**.

### 5.1 Tabuľky v produkcii (29 tabuliek v `public` schéme)

`ai_evidence`, `assistant_action_confirmations`, `beta_allowlist`, `chat_attachments`, `chat_conversation_members`, `chat_conversations`, `chat_message_references`, `chat_messages`, `companies`, `company_dpa_acceptances`, `company_invites`, `company_members`, `custom_document_categories`, `document_attachments`, `document_links`, `document_review_log`, `documents`, `inventory_items`, `inventory_photos`, `legal_documents`, `machine_photos`, `machine_services`, `machines`, `plan_limits`, `settings`, `user_legal_acceptances`, `vehicle_photos`, `vehicle_services`, `vehicle_vignettes`, `vehicles`.

**Kľúčové zistenie: v produkcii NEEXISTUJE žiadna tabuľka `invoices`, `customers`, `suppliers`, `business_partners`, `invoice_items`, `invoice_number_sequences` ani žiadne pole typu IČO/DIČ/IČ DPH/IBAN/VAT rate na existujúcich tabuľkách.** Fakturačný modul sa musí navrhnúť od nuly — nič sa "nedomýšľa", nič také už nie je.

### 5.2 Čo existuje a je relevantné/znovupoužiteľné

| Tabuľka/modul | Relevantné stĺpce/vlastnosti | Využiteľnosť pre fakturáciu |
|---|---|---|
| `documents` | `id, company_id, document_type ('invoice'\|'receipt'\|'weigh_ticket'\|'delivery_note'\|'insurance'\|'service_document'\|'other'), status, extracted_fields (jsonb), field_confidence (jsonb), custom_category_id, storage_bucket/path, archived_from_inbox_at` | **Priamo nosný pre "prijaté faktúry cez AI Inbox" cestu (bod 10).** `document_type='invoice'` už existuje ako AI-rozpoznávaná kategória. |
| `app/api/scan-document/route.ts` | Už extrahuje pre `invoice` typ presne: `supplier, customer, invoiceNumber, issueDate, dueDate, totalAmount, currency, vatAmount` (+ `fieldConfidence` per pole) | **Hotová AI extrakcia pre skenované/odfotené faktúry** — presne pokrýva časť kanonického modelu (bod 9). Čísla sú JS `number`, NIE decimal — pre AI-extrahované dáta z fotky je to OK (viď bod 24 prečo pre vlastné vystavené faktúry nie). |
| `document_links` | `document_id, vehicle_id, machine_id, inventory_item_id, vehicle_service_id, machine_service_id, link_type, confidence, confirmed_by_user, company_id` | **Presne vzor na znovupoužitie pre napojenie prijatej faktúry na vozidlo/stroj/náklad (bod 27)** — pridať `invoice_id` do rovnakej tabuľky (alebo analogickú `invoice_links`) namiesto vymýšľania nového systému. |
| `custom_document_categories` | `company_id, name, canonical_slug, description, created_by`, RLS: SELECT všetci členovia, INSERT/UPDATE/DELETE owner/admin | **Architektonický vzor pre "Obchodní partneri" (business partners) modul (bod 21)** — rovnaký company-scoped, RLS-per-role vzor sa dá replikovať. |
| `vehicle_services` / `machine_services` | `cost (numeric), service_date, title, description, technician` | Cieľový bod napojenia nákladov z prijatej faktúry (bod 27) — už majú `numeric` typ pre sumy, čo je správny vzor pre budúce fakturačné sumy. |
| `companies` | `id, owner_id, name, created_at, updated_at` | **ŽIADNE fakturačné/billing polia** (IČO/DIČ/IBAN/adresa). Musí sa rozšíriť (bod 22). |
| `settings` | `id, company_name, logo_path, plan, locale, user_id` | Zdanlivo paralelná/staršia tabuľka ku `companies` — obsahuje `logo_path` (užitočné pre PDF hlavičku, bod 25), ale je viazaná na `user_id`, nie `company_id`. **Vyžaduje vyjasnenie vzťahu `companies` ↔ `settings` predtým, než sa do niektorej z nich pridá billing profil** — inak hrozí duplicita zdroja pravdy. |
| `legal_documents`, `user_legal_acceptances`, `company_dpa_acceptances` | Verziované právne dokumenty + acceptance tracking (`document_type, version, accepted_at, acceptance_method`) | **Priamo využiteľný vzor pre budúci DPA s eInvoice providerom** (bod 32) — netreba nový mechanizmus, len nový `document_type`. |
| `lib/legal-config.ts` (`legalConfig`) | `controllerName: "Esblu s. r. o.", businessId (IČO): "57 815 941", taxId (DIČ): null, vatId (IČ DPH): null` | **Zistenie (opravené — korekcia 12):** `taxId`/`vatId` sú v `legalConfig` nastavené na `null` s komentárom "nie sú aktuálne potrebné" (pre GDPR/legal texty). **Toto je iba stav KONFIGURAČNÉHO SÚBORU, nie dôkaz skutočného právneho/daňového stavu firmy Esblu s.r.o.** — `null` tu znamená "táto hodnota nie je v `legalConfig` vyplnená", nie "firma nemá DIČ/IČ DPH pridelené". Skutočný stav registrácie Esblu s.r.o. na daňovom úrade (má/nemá DIČ, je/nie je platiteľom DPH) je fakt mimo tohto repozitára a **musí sa overiť priamo (napr. účtovníctvom firmy), nie odvodzovať z kódu.** Ak/keď firma DIČ/IČ DPH má, ale `legalConfig` ich jednoducho nikdy nepotreboval vyplniť na dnešné právne texty, treba pred Fázou 7 doplniť `company_billing_profile` (bod 22) správnymi hodnotami nezávisle od stavu `legalConfig` — tieto dva zdroje netreba zamieňať ani synchronizovať automaticky. |
| `lib/intents/*` (Intent Engine) | 6-súborová architektúra, `IntentArgs`, `action_preview` + HMAC server-proof confirmation flow (`assistant_action_confirmations`) | **Priamo pripravený mechanizmus pre "vysoko rizikové" hlasové/AI akcie** (bod 28) — odoslanie eFaktúry musí ísť presne cez tento už existujúci, auditovaný confirmation flow, nie cez nový. |
| `app/ai-evidencia/page.tsx` (Inbox UI) | Folder-tile vzor, `custom_category_id` awareness, sekcia "Vlastné zložky" | Vzor pre budúcu sekciu "Faktúry" v tom istom Inbox rozložení (bod 8) — nie paralelný modul. |
| Role model | `company_members.role ∈ {owner, admin, employee}`, `permissions (jsonb)` | Základ pre fakturačné oprávnenia (bod 29) — `permissions` jsonb už existuje, čo umožňuje granulárne fakturačné práva bez schema migrácie na `company_members` (len nové kľúče v jsonb). |
| i18n | `sk/en/de` dictionaries, `translate()`, `tCount()` | Priamo rozšíriteľné o fakturačné texty. |
| `package.json` | `exceljs` (XLSX export existuje), **žiadna PDF knižnica, žiadna decimal knižnica** (`decimal.js`/`big.js` a pod. chýba) | Pre PDF generovanie (bod 25) a decimal aritmetiku (bod 24) treba doplniť závislosti — v Fáze 0 sa nerobí, len sa eviduje ako budúca potreba. |
| Mobile (`mobile/`) | Next.js static export build (`IS_MOBILE_BUILD`), zdieľané route helpery (`entity-links.ts`) | Fakturačné stránky musia rešpektovať rovnaký web/mobile dual-route vzor (`/faktury/[id]` web vs. `/faktury/detail?id=` mobile), presne ako `vehicleDetailHref`/`machineDetailHref`. |

### 5.3 Čo chýba úplne (potvrdené, nie odhadnuté)

- Žiadna tabuľka pre faktúry, položky faktúry, zákazníkov/dodávateľov, číselné rady, VAT sadzby ako štruktúrované dáta.
- Žiadny PDF generátor v repozitári.
- Žiadna decimal/aritmetická knižnica pre peniaze.
- Žiadna podpora PDF príloh v AI scan flow — `scan-document` explicitne prijíma **iba obrázky** (`image/jpeg|png|webp`), PDF je zámerne vylúčené (komentár v kóde: "Dnešný AI flow ... pracuje výhradne s input_image, nikde nie je otestovaná bezpečná PDF cesta").
- Žiadny email-intake mechanizmus (prijatie faktúry emailom).
- Žiadna XML/Peppol/EN16931 logika kdekoľvek v repozitári.
- Žiadny provider-abstraction vzor (Esblu dnes nemá žiadnu obdobu "externý platobný/doručovací provider", takže tento vzor sa musí navrhnúť úplne nový — nie je čo znovupoužiť, len sa dá riadiť rovnakými bezpečnostnými princípmi ako HMAC action-confirmation systém).

---

## 6. Čo sa dá znovupoužiť (zhrnutie)

1. **Multi-tenant `company_id` + RLS-per-rola vzor** — replikovať 1:1 pre všetky nové tabuľky.
2. **`documents` + `document_links` + AI Inbox extrakcia** — priama nosná konštrukcia pre prijaté faktúry, cesta A (foto/PDF → AI → review).
3. **`custom_document_categories` vzor** (company-scoped CRUD s owner/admin oprávneniami cez RLS) — kostra pre "Obchodní partneri".
4. **HMAC action-confirmation systém** (Intent Engine) — pre vysoko rizikové akcie (odoslanie eFaktúry).
5. **`legal_documents`/`user_legal_acceptances` verziovací vzor** — pre nový DPA s eInvoice providerom.
6. **i18n (sk/en/de) infraštruktúra.**
7. **Mobile dual-route vzor.**
8. **`permissions` jsonb na `company_members`** — netreba novú tabuľku pre fakturačné role, len nové kľúče.

## 7. Čo chýba (zhrnutie, mapované na návrh nižšie)

1. Kanonický fakturačný dátový model (bod 9).
2. Obchodní partneri / customers-suppliers model (bod 21).
3. Company billing profile (bod 22, + vyjasnenie `companies` vs `settings`).
4. Číselné rady (bod 11).
5. State machine (bod 7 nižšie v štruktúre = bod 12 zadania).
6. PDF generátor + decimal knižnica.
7. EN16931/Peppol XML generovanie/parsovanie/validácia.
8. Provider abstrakcia + webhook infraštruktúra.
9. eReporting/DPS integrácia.

---

## 8. Odporúčaný modul/UI

Nový, samostatný top-level modul **"Faktúry"** (`/faktury`), rovnaká UX filozofia ako `/ai-evidencia` (Inbox) a `/vozidla`/`/stroje` (entity CRUD) — nie paralelná appka, ale konzistentné rozšírenie.

**Navigačná štruktúra (minimum pre malú stavebnú/servisnú firmu):**
- **Vystavené** (Koncepty / Po splatnosti / Uhradené / Odoslané ako eFaktúra)
- **Prijaté** (z AI Inbox aj budúcej eFaktúry, s rovnakým review flow ako dnešný Inbox)
- **Opravné doklady** (dobropisy/ťarchopisy, viazané na pôvodnú faktúru)
- **Obchodní partneri** (customers/suppliers — spoločný zoznam)

**Schopnosti používateľa (Fáza 1-3, bez eFaktúry):**
Manuálne vytvorenie faktúry, výber/vytvorenie zákazníka, riadkové položky s množstvom/cenou/DPH sadzbou, dátum splatnosti, IBAN/variabilný symbol, poznámka, uloženie ako koncept, finalizácia (pridelenie čísla, uzamknutie), export PDF, ručné označenie "uhradené". Neskôr (Fáza 6-7): odoslanie ako eFaktúra.

**Prečo nie paralelný modul:** existujúci Inbox už má vzor "zložka dokumentov s detailom", existujúci `document_links` vzor už rieši prepojenie na entity — nová "Faktúry" sekcia sa má správať ako sesterský modul k Inboxu (vlastné vystavené faktúry sú nová prvotriedna entita, prijaté faktúry sú rozšírenie existujúceho Inboxu, nie duplicitná cesta).

---

## 9. Kanonický fakturačný model (najdôležitejšia časť — koncepčný, BEZ migrácie)

Návrh entít drží konvencie existujúcej DB (`snake_case`, `company_id` všade, `numeric` pre peniaze, `text` CHECK enumy namiesto natívnych Postgres enum typov — presne ako `documents.document_type`). Toto je **koncepčný náčrt na diskusiu**, nie SQL DDL, a nie je určený na priame skopírovanie do migrácie.

**REVÍZIA 15.9.2026 (na základe podmienečného schválenia používateľa) — model musí byť:**
- **Syntax-neutrálny** (korekcia 2): kanonický model opisuje EN16931 *sémantiku* (business terms), nie konkrétnu XML syntax. Peppol BIS Billing dnes používa UBL, ale EN16931 ako norma pripúšťa aj CII — model nesmie nič predpokladať o UBL špecificky (viď aj bod 18 nižšie, kde bola pôvodná formulácia "UBL, nie CII" opravená).
- **So skutočnou immutable históriou strán** (korekcia 3+4): finalizovaná faktúra sa **nikdy** neopiera len o mutable FK na `business_partners`/`company_billing_profile` — tieto sú master data (menia sa v čase: zmena adresy, IBAN, IČ DPH), zatiaľ čo faktúra je právny dokument, ktorý musí navždy zobrazovať údaje strán také, aké boli **v okamihu vystavenia**. Preto pribúda `invoice_parties` (bod nižšie).

### `invoices`
Identita a stav:
`id, company_id, direction ('issued'|'received'), kind (bod 14 — presné, neambiguózne hodnoty, NIE "zálohová faktúra"), status (document_status — bod 12, iba 'draft'|'finalized', bez 'cancelled'/'corrected' — korekcia 10), invoice_number (nullable do finalizácie), invoice_number_sequence_id (FK, nullable do finalizácie)`

Dátumy: `issue_date, due_date, delivery_date, tax_point_date`

Sumy: `currency, subtotal_amount, vat_total_amount, total_amount, rounding_amount` — peňažné súčty `numeric(14,2)` (nikdy float, bod 24; pre `quantity`/`unit_price` na riadkoch pozri opravenú presnosť nižšie pri `invoice_items`).

VAT: agregovaný súhrn per faktúra ide do **normalizovanej `invoice_tax_breakdowns` tabuľky** (korekcia 6, nižšie) — `invoices` sama žiadne jsonb VAT pole nedrží, iba `vat_total_amount` ako súčet.

Platba: `payment_status (samostatná dimenzia — bod 12), iban, variable_symbol, payment_terms_days`

Referencie: `corrects_invoice_id (FK → invoices, self, pre credit/debit note — bod 14), original_document_hash` (pre eFaktúru/dedup — bod 21).

Zdroj: `source ('manual'|'ai_inbox'|'efaktura_peppol'), source_document_id (FK → documents, pre AI Inbox cestu)`.

**DÔLEŽITÉ (korekcia 3+4):** `invoices` **NEMÁ** priamy FK `supplier_party_id`/`customer_party_id` na `business_partners`/`company_billing_profile` ako zdroj právne záväzných údajov strán. Namiesto toho: `invoices.customer_business_partner_id` (FK → `business_partners`, **iba na účely UI pohodlia** — "ukáž mi všetky faktúry pre firmu X", predvyplnenie pri novej faktúre — nikdy ako zdroj pravdy pre vytlačené/odoslané meno, adresu, IČO na finalizovanej faktúre) a skutočné právne údaje strán idú cez `invoice_parties` (nižšie).

### `invoice_parties` (NOVÉ — korekcia 3+4, snapshot strán)
`id, invoice_id, role ('seller'|'buyer'), legal_name, ico, dic, ic_dph, address_line1, address_line2, city, postal_code, country_code, iban (ak relevantné pre danú stranu), peppol_identifier, source_business_partner_id (FK → business_partners, nullable, iba pre spätnú dohľadateľnosť "z akého master-data záznamu to bolo predvyplnené"), snapshotted_at`.

Vzniká **presne raz, atomicky s finalizáciou** (korekcia 7 — pozri bod 13): pri `FINALIZE` sa aktuálny stav `business_partners` (pre `buyer`, ak `direction='issued'`) a aktuálny stav `company_billing_profile` (pre `seller`, ak `direction='issued'`; obrátene pri `direction='received'`) **skopíruje** do dvoch `invoice_parties` riadkov. Po finalizácii je `invoice_parties` immutable rovnako ako zvyšok faktúry — aj keby si zákazník neskôr zmenil IČ DPH alebo firma zmenila IBAN, historická faktúra naďalej zobrazuje presne to, čo platilo v okamihu vystavenia. Toto je priamy dôsledok korekcie používateľa: *"Nenaviaž historické právne údaje faktúry iba na mutable FK business_partner/company profile."*

### `invoice_items`
`id, invoice_id, position, description, quantity, unit, unit_price, vat_rate, vat_category_code (EN16931 kód per riadok — S/Z/E/AE/..., korekcia 6), line_net_amount, line_vat_amount, line_gross_amount`.

**Presnosť (korekcia 5):** `quantity` a `unit_price` **NIE SÚ** `numeric(14,2)` — pri stavebnom materiáli/službách bežne vznikajú množstvá a jednotkové ceny s viac než 2 desatinnými miestami (napr. cena za kg/m² na 3-4 desatinné miesta, aby sa pri prenásobení veľkým množstvom nestrácala presnosť). Návrh: `quantity numeric(14,4)`, `unit_price numeric(14,4)` — vyššia precision/scale než peňažné súčty. **Peňažné súčty (`line_net_amount`, `line_vat_amount`, `line_gross_amount`, aj všetko na `invoices`) ostávajú `numeric(14,2)`** — presné rozhodnutie o scale pre quantity/unit_price (4 desatinné miesta vs. iná hodnota) nechávam na potvrdenie v implementačnej fáze/s účtovníkom, princíp "vyššia presnosť pre množstvo/cenu, 2 desatinné miesta pre finálne sumy" je to podstatné.

### `business_partners` (nahrádza customers/suppliers — jedna entita môže byť oboje, bod 21; MASTER DATA, nie zdroj pravdy pre finalizovanú faktúru — pozri `invoice_parties` vyššie)
`id, company_id, kind ('customer'|'supplier'|'both'), legal_name, ico, dic, ic_dph, address_*, country_code, email, phone, peppol_identifier (nullable), default_payment_terms_days, default_currency, created_by, created_at`

### `company_billing_profile` (1:1 s `companies`, bod 22; MASTER DATA, nie zdroj pravdy pre finalizovanú faktúru — pozri `invoice_parties` vyššie)
`company_id (PK/FK), legal_name, address_*, ico, dic, ic_dph, iban, bic, default_vat_rate, invoice_numbering_prefix, default_due_days, logo_path (možno znovupoužiť `settings.logo_path`), contact_email, einvoice_provider_id (FK → nová `einvoice_provider_accounts`, nullable)`

### `invoice_tax_breakdowns` (korekcia 6 — NORMALIZOVANÁ TABUĽKA, nie jsonb)
`id, invoice_id, vat_rate, vat_category_code, taxable_amount, vat_amount` — jeden riadok per (sadzba × kategória) na faktúre, agregovaný z `invoice_items`. **Pôvodný návrh preferoval jsonb pole na `invoices` s tabuľkou ako voliteľnou alternatívou — používateľ toto obrátil: normalizovaná tabuľka je teraz predvolený návrh**, keďže umožňuje priame SQL agregovanie/reportovanie (napr. súhrn DPH podľa sadzby za obdobie) bez nutnosti parsovať jsonb, a je konzistentnejšia s tým, že `invoice_items.vat_category_code`/`vat_rate` sú tiež už normalizované stĺpce (nie jsonb).

### `invoice_payments`
`id, invoice_id, paid_amount, paid_at, payment_method, note, recorded_by` — Fáza 1 iba ručné záznamy (bod 26).

### `invoice_events` (audit trail, bod 30 — korekcia 8: BEZ plného snapshotu)
`id, invoice_id, event_type ('created'|'draft_edited'|'finalized'|'sent'|'delivery_accepted'|'delivery_rejected'|'corrected'|'payment_recorded'|'provider_callback'), actor_user_id (nullable pre systémové/provider eventy), actor_source ('user'|'ai_intent'|'provider_webhook'|'system'), payload (jsonb, **iba malé, event-špecifické metadáta — napr. `{"old_status":"draft","new_status":"finalized"}`, nikdy kompletný obsah faktúry/strán**, a nikdy secrets), created_at`. **Korekcia:** pôvodný návrh (bod 13 pôvodného textu) hovoril o "`finalized` evente so snapshotom" — to je opravené: `invoice_events` je čistý, ľahký log udalostí (kto/čo/kedy), **nie** úložisko duplicitných kópií osobných/finančných údajov. Samotný nemenný snapshot faktúry (pre PDF/XML archív, bod 21) žije výhradne v `invoice_attachments`, nie duplicovaný aj tam aj v event logu — zníženie zbytočnej duplikácie PII naprieč tabuľkami.

### `invoice_attachments`
Analogické k `document_attachments` — PDF snapshot, raw XML, provider správa. **Toto je jediné miesto s plným, nemenným snapshotom faktúry** (spolu so samotnými immutable `invoices`/`invoice_items`/`invoice_parties` riadkami po finalizácii — pozri korekciu 8 vyššie).

### `invoice_number_sequences` (bod 11)
`company_id, year, prefix, suffix, next_number, updated_at` — s `SELECT ... FOR UPDATE` alebo `UPDATE ... RETURNING` vzorom pre concurrency-safe pridelenie (implementačný detail, nie teraz).

---

## 10. Mapovanie EN16931/Peppol (kľúčová tabuľka)

| Esblu pole | EN16931 Business Term | Peppol BIS prvok | Povinnosť | Validačné pravidlo |
|---|---|---|---|---|
| `company_billing_profile.legal_name` | BT-27 Seller name | `cac:AccountingSupplierParty` | Povinné | Musí zodpovedať registru |
| `company_billing_profile.ico` | BT-30/31 Seller legal registration ID | `cbc:CompanyID` | Povinné pre SK | Formát IČO |
| `company_billing_profile.ic_dph` | BT-31 Seller VAT identifier | `cbc:CompanyID` (scheme VAT) | Povinné ak platiteľ | SK + 10 číslic |
| `business_partners.legal_name` (customer) | BT-44 Buyer name | `cac:AccountingCustomerParty` | Povinné | — |
| `invoices.invoice_number` | BT-1 Invoice number | `cbc:ID` | Povinné, až po finalizácii | Unikátne per firma |
| `invoices.issue_date` | BT-2 Issue date | `cbc:IssueDate` | Povinné | ISO 8601 |
| `invoices.currency` | BT-5 Invoice currency code | `cbc:DocumentCurrencyCode` | Povinné | ISO 4217 |
| `invoices.total_amount` | BT-112 Invoice total with VAT | `cbc:TaxInclusiveAmount` | Povinné | = subtotal + VAT − zaokrúhlenie |
| `invoices.vat_breakdown[]` | BG-23 VAT breakdown | `cac:TaxSubtotal` | Povinné | Súčet musí sedieť s `vat_total_amount` |
| `invoices.iban` | BT-84 Payment account identifier | `cac:PaymentMeans/cac:PayeeFinancialAccount` | Podmienené (ak bankový prevod) | IBAN formát |
| `invoices.due_date` | BT-9 Payment due date | `cbc:PaymentDueDate` | Podmienené | — |
| `invoice_items[].description` | BT-153 Item name | `cac:InvoiceLine/cac:Item` | Povinné per riadok | — |
| `invoice_items[].quantity` | BT-129 Invoiced quantity | `cbc:InvoicedQuantity` | Povinné | > 0 |
| `invoice_items[].line_net_amount` | BT-131 Invoice line net amount | `cbc:LineExtensionAmount` | Povinné | = quantity × unit_price |
| `invoices.corrects_invoice_id` | BT-25 Preceding Invoice Reference | `cac:BillingReference` | Povinné pre dobropis/ťarchopis | Musí existovať a byť finalizovaná |
| `invoices.vat_category_code` | BT-118/95 VAT category code | `cbc:TaxCategory/cbc:ID` | Povinné per riadok/breakdown | S/Z/E/AE/... kódová sada |

Toto je **koncepčná mapovacia tabuľka na účel architektonického rozhodnutia**, nie kompletná EN16931 business-term matica (tá má ~150 termov) — kompletná mapovacia špecifikácia je súčasť Fázy 5 (bod 34), kedy sa bude generovať/parsovať skutočné XML.

---

## 11. Číslovanie faktúr

Company-scoped, concurrency-safe cez `invoice_number_sequences` (bod 9). Koncept: pri finalizácii sa v jednej transakcii spraví `UPDATE invoice_number_sequences SET next_number = next_number + 1 WHERE company_id=... AND year=... RETURNING next_number`, výsledné číslo sa zloží ako `{prefix}{year}{padded_number}{suffix}` a zapíše na `invoices.invoice_number` + `invoices.status='finalized'` v tej istej transakcii. **Draft nemá pridelené číslo** (`invoice_number IS NULL` kým `status='draft'`) — číslo sa prideľuje výhradne pri finalizácii, nikdy skôr, a po pridelení je **immutable** (vynucuje sa DB triggerom brániacim UPDATE `invoice_number` po finalizácii — implementačný detail Fázy 2). Audit: `invoice_events` eviduje presný okamih a aktéra finalizácie.

## 12. State machine — tri oddelené dimenzie

Namiesto jedného zmiešaného enumu (ako to odporúča bod 7 zadania) tri nezávislé stĺpce:

**`document_status`**: **iba `draft → finalized`** (korekcia 10, opravené z pôvodného `draft → finalized → (cancelled | corrected)`). Finalizovaná faktúra **sa nikdy nemaže ani neprepína na `cancelled`/`corrected`** — jej vlastný `document_status` zostáva navždy `finalized`. "Je táto faktúra stornovaná/opravená?" je **odvodená (derived), nie uložená** informácia — zisťuje sa dotazom "existuje `invoices` riadok s `corrects_invoice_id = táto_faktúra.id`?" (bod 14). Dôvod: uloženie "cancelled"/"corrected" priamo na pôvodnom riadku by znamenalo mutáciu právne finalizovaného dokumentu po jeho vystavení — presne to, čomu sa má tento model vyhnúť.
**`payment_status`**: `unpaid → partially_paid → paid` (+ `overdue` odvodené z `due_date < today AND payment_status != 'paid'`, nie samostatný uložený stav — vyhne sa nekonzistencii z toho, že "overdue" by inak vyžadovalo periodický batch update)
**`delivery_status`** (relevantné iba pre eFaktúru, Fáza 6+): `not_sent → sent → delivered → rejected`

Dôvod oddelenia: faktúra môže byť súčasne `finalized` + `overdue` + `delivered` — miešanie do jedného enumu by nutne viedlo buď ku kombinatorickej explózii hodnôt, alebo k strate informácie (presne problém, ktorý bod 7 zadania identifikuje). Voliteľná UI-vrstva (nie DB stĺpec) môže z `document_status='finalized'` + existencie korekcie odvodiť zobrazovaný "efektívny stav" (napr. badge "Stornovaná") — to je otázka prezentácie, nie dátového modelu.

## 13. Finalizácia a immutabilita

`DRAFT → FINALIZE` je jednosmerný prechod (žiadny `FINALIZE → DRAFT`). Po finalizácii: `invoice_number`, všetky sumy, `invoice_items`, strany (`invoice_parties`) — **immutable** (DB-level, nie len UI-level — presne princíp, ktorý sa už dnes používa pri `custom_document_categories.canonical_slug` normalizácii a HMAC confirmation systéme: appka nikdy nespolieha len na to, že UI "nedovolí" editáciu). Akákoľvek zmena po finalizácii ide výhradne cez opravný doklad (bod 14).

**Atomicita (korekcia 7 — explicitne spresnené):** pridelenie čísla (`invoice_number_sequences` update), vytvorenie `invoice_parties` snapshotov (bod 9), zápis `invoice_events` `finalized` eventu a nastavenie `document_status='finalized'` **musia prebehnúť v JEDNEJ atomickej DB transakcii** — najprirodzenejšie ako jedna `SECURITY DEFINER` RPC (`esblu_finalize_invoice(invoice_id)`), rovnaký vzor ako dnešné RPC-centrické písanie (`esblu_ensure_my_owner_company`, `esblu_accept_company_invite`). Nikdy sekvencia samostatných klientskych `UPDATE`/`INSERT` volaní — pri zlyhaní na polceste (napr. výpadok siete medzi pridelením čísla a zápisom snapshotu strán) by inak mohlo vzniknúť nekonzistentné, čiastočne finalizované torzo (faktúra s číslom, ale bez immutable snapshotu strán, alebo naopak). Toto je implementačný detail budúcej fázy (RPC sa teraz nepíše), ale je to záväzná požiadavka na návrh tej RPC.

## 14. Terminológia a typy dokladov (korekcia 9 — sprísnené, bez nejednoznačného "zálohová faktúra")

Používateľ explicitne žiadal odstrániť nejednoznačný pojem "zálohová faktúra" ako jeden typ a nahradiť ho štyrmi presne odlíšenými pojmami, ktoré zodpovedajú aj právnemu rozlíšeniu z bodu 1 (Q9):

| `invoices.kind` hodnota | Slovenský pojem | Daňový doklad? | Podlieha eFaktúre? |
|---|---|---|---|
| `regular_invoice` | Riadna faktúra | Áno | Áno (ak spĺňa podmienky bodu 3) |
| `payment_received_invoice` | Faktúra k prijatej platbe (za prijatú zálohovú platbu pred dodaním) | **Áno** — je to plnohodnotný daňový doklad podľa §74 | Áno |
| `credit_note` | Dobropis (opravný doklad, znižuje pôvodnú sumu) | Áno | Áno, s povinnou referenciou na pôvodnú faktúru (BT-25) |
| `debit_note` | Ťarchopis (opravný doklad, zvyšuje pôvodnú sumu) | Áno | Áno, s povinnou referenciou na pôvodnú faktúru |
| — (mimo `invoices` modelu úplne, pozri nižšie) | Proforma faktúra / výzva na úhradu | **NIE** | **NIE — nikdy nejde do eFaktúra/VAT flow** |

**Kľúčové architektonické rozhodnutie:** Proforma/výzva na úhradu sa **nemodeluje ako `invoices` záznam vôbec** (ani so špeciálnym `kind`) — keďže podľa bodu 1 (Q9) nie je daňovým dokladom, jej zmiešanie do tej istej tabuľky ako riadne faktúry by vytváralo trvalé riziko, že sa omylom započíta do DPH/eFaktúra/číslovacej logiky. Ak bude Esblu v budúcnosti potrebovať evidovať aj proforma/výzvy na úhradu (produktová otázka, nie súčasť tejto architektúry), odporúčam **úplne samostatnú, jednoduchšiu entitu** (napr. `payment_requests`) bez prístupu k `invoice_number_sequences`, `invoice_tax_breakdowns` a bez akejkoľvek cesty do eFaktúra pipeline — nie rozšírenie `invoices.kind`.

Dobropis/ťarchopis sú **samostatné `invoices` záznamy** s `kind IN ('credit_note','debit_note')` a `corrects_invoice_id` odkazujúcim na pôvodnú finalizovanú faktúru — **nikdy priamy UPDATE finalizovanej faktúry**. "Storno" nie je samostatný `kind` — je to dobropis na 100 % sumy pôvodnej faktúry (bežná slovenská prax), nie mazanie záznamu (faktúra ako daňový doklad sa nikdy fyzicky nemaže — GDPR výmaz rieši samostatne retenčná politika, bod 19/32) a nie zmena `document_status` na pôvodnom zázname (korekcia 10, bod 12). Vlastné číslovanie (vlastná sekvencia alebo zdieľaná s faktúrami — rozhodnutie pre CLIA/účtovníka, nie čisto technické).

---

## 15. Prijaté faktúry — dva vstupné kanály

**Cesta A (dnes existuje ako substrát): AI Inbox.** Foto/PDF → AI extrakcia (`scan-document`, dnes už extrahuje `invoiceFields` pre `document_type='invoice'`) → review používateľom → vytvorenie `invoices` záznamu s `source='ai_inbox', direction='received'`. **Chýba dnes:** podpora PDF príloh (dnes iba obrázky) a emailový intake — obe sú budúca práca, nie Fáza 0.

**Cesta B (budúca): eFaktúra cez Peppol.** PDS webhook → štruktúrovaná XML → **deterministický parser** (nie AI) → `invoices` záznam s `source='efaktura_peppol', direction='received'`.

**Kritický bezpečnostný princíp (explicitne z bodu 10 zadania):** Pre cestu B **AI nikdy neprepisuje autoritatívne XML/Peppol hodnoty.** AI smie iba: kategorizovať (priradiť do custom category), navrhnúť prepojenie na vozidlo/stroj/náklad (bod 27, s `confirmed_by_user` gate presne ako dnešný `document_links`), vysvetliť obsah faktúry v prirodzenom jazyku. Súčty, DPH, čísla faktúry z XML sú vždy zdroj pravdy, nikdy sa nimi AI "neopravuje".

## 16. Deduplikácia

Rovnaká faktúra môže prísť via eFaktúra + emailový PDF + odfotenie v teréne — nesmie vzniknúť trojmo. **Korekcia 11 — explicitná, prioritizovaná hierarchia signálov** (namiesto pôvodného jedného plochého "fingerprintu"), aplikovaná v tomto poradí, prvá zhoda na vyššej úrovni rozhoduje:

1. **Najsilnejšia úroveň — provider/message ID + XML hash:** `peppol_message_id` (alebo iný provider-špecifický stabilný identifikátor) zhodný **AND/OR** `original_document_hash` (hash presne toho istého XML) zhodný. Toto je deterministická, kryptograficky silná zhoda — ak sedí, ide vždy o ten istý dokument, **automatické zlúčenie je bezpečné**.
2. **Stredná úroveň — dodávateľ + číslo faktúry:** `(supplier.ico alebo peppol_identifier) + invoice_number` zhodné. Silný, ale nie kryptografický signál (teoreticky si dvaja rôzni dodávatelia s rovnakým IČO by museli byť ten istý subjekt, ale číslo faktúry samo osebe nie je globálne unikátne) — **automatické zlúčenie povolené, ALE iba ak sa navyše zhoduje aj `issue_date` a `total_amount` v rámci zaokrúhľovacej tolerancie.**
3. **Slabšie signály (dátum + suma bez zhody dodávateľa/čísla, podobnosť textu a pod.):** **NIKDY automatické zlúčenie.** Vždy iba "možný duplikát" flag pre review používateľom.

Pri zhode na úrovni 1 alebo 2 (so splnenou dodatočnou podmienkou) sa nový príjem **nevytvorí ako nová faktúra**, ale pripojí ako ďalší `invoice_attachments` záznam k existujúcej + `invoice_events` eventom `duplicate_source_detected`. **Pri akejkoľvek neistote (úroveň 3, alebo čiastočná zhoda na úrovni 2 bez potvrdenia dátumu/sumy) ide VŽDY o review používateľovi, nikdy o automatické rozhodnutie — a AI sama nikdy nerozhoduje o zlúčení v žiadnom z týchto prípadov**, AI smie nanajvýš označiť "toto vyzerá ako možný duplikát X" ako návrh pre používateľa (rovnaký princíp ako bod 15: AI kategorizuje/navrhuje, nikdy sama nerozhoduje o autoritatívnych dátach).

## 17. PDF vs. eFaktúra — oddelenie ciest

Kanonický záznam `invoices` (+ `invoice_items`) je **jediný zdroj pravdy**. Z neho vedú dve nezávislé, jednosmerné cesty: `invoices → PDF renderer` (pre bežnú tlačenú/emailovú faktúru) a `invoices → Peppol/EN16931 XML renderer` (pre eFaktúru). **Explicitne NIE `PDF → OCR → XML`** pre vlastné vystavené faktúry — to by znovu-zaviedlo AI/OCR neistotu do dát, ktoré appka sama vytvorila štruktúrovane. OCR/AI extrakcia sa používa výhradne pre **prijaté** dokumenty (cesta A vyššie), nikdy pre vlastné vystavené.

## 18. XML generovanie/validačný pipeline (návrh, nie implementácia)

`invoices (kanonický, syntax-neutrálny záznam — korekcia 2)` → `syntax-špecifický EN16931 XML generátor` → `XSD schema validácia` → `Schematron business-rule validácia (Peppol validačné artefakty + SK CIUS, ak/keď bude publikovaná)` → `odoslanie providerovi`.

**Syntax (opravené — korekcia 2):** Pôvodný text tvrdil "UBL, nie CII" ako všeobecnú vlastnosť modelu — to bolo nepresné. EN16931 ako norma je **syntax-neutrálna** a pripúšťa oboje (UBL aj CII). Presnejšie: **Peppol BIS Billing konkrétne** (dnešná primárna, certifikovaná cesta pre SK eFaktúru cez PDS, bod 1/4) je postavený na **UBL 2.1**, čo potvrdzuje OpenPeppol SK country profile — takže UBL generátor je to, čo sa reálne bude potrebovať pre Fázu 6-7 s PDS/Peppol providerom. Ale **kanonický `invoices` model sám o sebe generátor syntaxe nepredpisuje** — XML generátor je samostatná, vymeniteľná vrstva (`invoices → generátor(syntax) → XML`), takže ak by Esblu niekedy potrebovalo alternatívny, nie-PDS delivery kanál (korekcia 1) s inou syntaxou (CII), model to nevylučuje.

CIUS (Core Invoice Usage Specification) pre Slovensko — v čase researchu (15.9.2026) nebola nájdená samostatná zverejnená SK CIUS špecifikácia nad rámec všeobecného Peppol BIS Billing + SK TDD rozšírenia (bod 4) — **treba sledovať, či FS/MF SR CIUS ešte zverejní**, pred Fázou 5.

---

## 18a. Prieskum kandidátov eInvoice/PDS providerov — VÝBER ZATIAĽ NEUZAVRETÝ (korekcia 13)

**Táto sekcia bola v pôvodnej verzii dokumentu iba odkazovaná ("bod 15"), ale chýbala ako samostatný obsah — doplnené 15.9.2026.** Zoznam nižšie je **čisto informačný prieskum na porovnanie, NIE rozhodnutie.** Výber konkrétneho providera je **samostatné obchodné rozhodnutie, ktoré sa urobí až tesne pred Fázou 6** (bod 35), nezávisle od tohto architektonického dokumentu — architektúra (bod 14/22, `EInvoiceProvider` abstrakcia) je navrhnutá zámerne tak, aby na tomto výbere nezávisela.

Oficiálny register FS (https://vpds.financnasprava.sk/) je prístupný iba po prihlásení cez portál FS — nebolo možné anonymne prehliadať. Nižšie je prieskum z verejne dostupných zdrojov (marketingové/produktové stránky providerov), **nie z oficiálneho registra priamo** — treba brať ako orientačné, nie definitívne.

| Kandidát | Verejné API docs | Sandbox | Send+Receive | Peppol AP | Webhooks | Pricing (verejné) | White-label/OEM | Poznámka |
|---|---|---|---|---|---|---|---|---|
| **ePošťák** (Kaja Solutions s.r.o.) | Áno (epostak.sk/api-integracia) | Áno (email-gated provisioning) | Áno | Tvrdené, neoverené voči registru | Áno | Voľný tier 500 prijatých/5 odoslaných mesačne; €8-19/mesiac vyššie tiery | **Áno, explicitne** ("ePošťák pod kapotou") | Jediný s kompletne verejnou API dokumentáciou aj cenníkom |
| **Flowis** (postarflowis.sk) | Nenájdené verejne — "vyžaduje obchodný kontakt" | Nespomenuté verejne | Áno | Tvrdené (self-claimed "prvý certifikovaný") | Nespomenuté verejne | Čiastočne verejné (nižšie tiery), API tiery "coming soon" | Implikované (partneri: SuperFaktura, FLOWii, MADE/Urbis) | Už dnes PDS pre iné SK SaaS produkty — relevantný precedens pre embed model |
| **SOFTIP Digitálny poštár** | Nenájdené — "vyžaduje obchodný kontakt" | Nespomenuté | Áno (tvrdené) | Tvrdené | Nespomenuté | Nespomenuté | Nespomenuté | Primárne pre vlastných ERP zákazníkov SOFTIP-u |
| **KROS** (cez partnera Connect International B.V.) | Nenájdené — "vyžaduje obchodný kontakt" | Nespomenuté | Áno (cez partnera) | Áno, cez Connect International B.V. | Nespomenuté | Nespomenuté | KROS sám je "sprostredkovateľ", nie priamy PDS | Ukazuje, že aj medzinárodný Peppol AP sa dá v SK trhu biele-značkovať — Connect International B.V. samo osobe nebolo v tomto prieskume samostatne preverené |

**Explicitne NEVYBERÁM žiadneho kandidáta.** Pozorovanie: ePošťák má dnes najviac verejne overiteľných technických detailov (API docs, sandbox proces, cenník, white-label ponuka), čo z neho robí najľahšie **vyhodnotiteľného** kandidáta na technický pilot — to je **fakt o dostupnosti verejných informácií, nie odporúčanie zazmluvniť si ho.** Pred akýmkoľvek obchodným rozhodnutím (Fáza 6 vstup) treba: (a) prihlásiť sa do oficiálneho registra FS a overiť certifikačný status všetkých kandidátov priamo, (b) osloviť Flowis/SOFTIP/KROS priamo pre chýbajúce API detaily, (c) porovnať zmluvné podmienky vrátane DPA-relevantných otázok (bod 34), (d) zvážiť, či "prvý slovenský certifikovaný" marketingové tvrdenie ePošťáka aj Flowis (ktoré si navzájom protirečia) má na rozhodnutie vôbec vplyv (pravdepodobne nie — technická/zmluvná spôsobilosť je relevantná, "kto bol prvý" nie).

## 19. Prijatý eFaktúra flow (webhook architektúra)

`Provider webhook → overenie podpisu (HMAC/mTLS podľa providera) → mapovanie provider-account → company_id (NIKDY neveriť company_id v tele webhooku priamo — presne princíp už použitý v HMAC action-confirmation systéme) → idempotency check (bod 20) → uloženie raw payload/XML (bod 22, archív) → validácia → deterministický parser → vytvorenie invoices záznamu (source='efaktura_peppol') → invoice_events log`. Mapovanie provider-account → company_id ide cez novú tabuľku `einvoice_provider_accounts (company_id, provider_id, provider_account_id, credentials_ref)` — nikdy sa neodvodzuje z obsahu webhooku.

## 20. Idempotencia

Pre odoslanie, príjem webhooku aj status callback: stabilný `(provider_id, provider_message_id)` alebo `(provider_id, document_id)` ako unique constraint na `invoice_events`/samostatnej `einvoice_delivery_log` tabuľke. Retry na strane providera (bežné pri webhookoch) nesmie vytvoriť duplicitný event ani duplicitnú faktúru — `ON CONFLICT DO NOTHING`/`UPSERT` vzor na tomto unique kľúči.

## 21. Archív a retencia

`invoice_attachments` uchováva: kanonický snapshot (JSON kópia `invoices`+`invoice_items` v okamihu finalizácie/odoslania), originál XML, provider message ID, timestampy, delivery status eventy (cez `invoice_events`), human-readable PDF, výsledok validácie. **Presná retenčná lehota (typicky 10 rokov pre účtovné doklady na Slovensku podľa zákona o účtovníctve, nie DPH zákona) sa v rámci tejto úlohy NEURČUJE natvrdo** — patrí do právneho auditu s CLIA (bod 32), nie do technického rozhodnutia tohto dokumentu.

## 22. eReporting

Podľa researchu (bod 1) je eReporting z pohľadu Esblu **z veľkej časti transparentný** — povinnosť sa považuje za splnenú doručením cez certifikovaného PDS (§85o ods. 11). Esblu preto **nemusí implementovať vlastný priamy reporting kanál do FS** — musí ale: (a) evidovať, že PDS doručenie prebehlo (delivery_status='delivered'), (b) od 1.7.2030 sledovať prípadnú zmenu na takmer-reálny-čas režim (bod 1, C-klasifikácia — nejasné, ako presne sa zmení technický kontrakt s PDS). Toto je oblasť na sledovanie, nie na predčasnú implementáciu.

---

## 23. Obchodní partneri (customers/suppliers)

Návrh: jedna tabuľka `business_partners` s `kind IN ('customer','supplier','both')` namiesto dvoch oddelených tabuliek — v stavebníctve je bežné, že subdodávateľ je súčasne aj odberateľ (napr. prenájom stroja). Polia: `legal_name, ico, dic, ic_dph, address_*, country_code, email, phone, peppol_identifier, default_payment_terms_days, default_currency`. **Budúce rozšírenie (nie teraz):** automatický lookup z verejného registra (RPO/ORSR API) pri zadaní IČO — spomenuté v zadaní ako niečo na zváženie, Fáza 2+.

## 24. Company billing profile

Rozšírenie existujúcej firemnej identity o fakturačné polia (bod 9, `company_billing_profile`). **Dôležité zistenie z auditu (bod 5.2):** dnes existujú **dve** potenciálne miesta pre firemné dáta — `companies` (multi-tenant, `owner_id`) a `settings` (viazané na `user_id`, obsahuje `logo_path`). Pred návrhom `company_billing_profile` tabuľky **treba najprv vyjasniť, či `settings` je živý, používaný zdroj pravdy alebo legacy pozostatok** — toto je otvorená otázka na zodpovedanie predtým, než sa začne Fáza 1 (odporúčam to ako prvý krok Fázy 1, nie hádať teraz).

## 25. VAT engine

**Minimalistický, deterministický, ŽIADNA AI matematika.** Vstup: riadky s `quantity, unit_price, vat_rate`. Výstup: `line_net_amount = round(quantity × unit_price, 2)`, `line_vat_amount = round(line_net_amount × vat_rate, 2)`, `line_gross_amount = line_net_amount + line_vat_amount`, agregácia po sadzbách do `vat_breakdown`, `subtotal_amount = Σline_net`, `vat_total_amount = Σvat_breakdown.vat_amount`, `total_amount = subtotal + vat_total ± rounding_amount` (zaokrúhľovací rozdiel sa explicitne eviduje, nikdy "nezmizne"). Fáza 1: štandardné sadzby + viac sadzieb na faktúre. Reverse charge (`vat_category_code='AE'`, nulová DPH suma, textová poznámka "prenesenie daňovej povinnosti") — zaradiť do Fázy 1 rozsahu vzhľadom na význam pre stavebníctvo, ale s výhradou bodu 1/C (nepotvrdená interakcia s eFaktúrou).

## 26. Mena/decimal

**Kritické pravidlo:** žiadna autoritatívna peňažná matematika v JS floating point. DB: `numeric(14,2)` (rovnaký typ, aký už appka používa pre `vehicle_services.cost`/`machine_services.cost` — konzistentné s existujúcim vzorom). TS strana: potrebná decimal knižnica (dnes v `package.json` **žiadna nie je** — pridanie je implementačná úloha budúcej fázy, nie Fázy 0). Zaokrúhľovacia hranica: na úrovni riadku (line-level rounding), nie až na súčte — bežný a menej sporný prístup, ale finálne potvrdenie nechať účtovníkovi/CLIA. AI-extrahované sumy (z `scan-document`, JS `number`) sú prijateľné **iba** pre prijaté dokumenty v review stave pred potvrdením používateľom — nikdy sa nepoužívajú priamo ako finálne `invoices` hodnoty bez explicitného prechodu cez VAT engine prepočet/potvrdenie.

## 27. PDF

Deterministické generovanie z finalizovaného `invoices` snapshotu (nikdy z live/draft dát, aby sa PDF nezmenilo pod nohami po vystavení). Audit: v repozitári dnes **nie je žiadna PDF knižnica** — voľba (napr. `@react-pdf/renderer`, `pdf-lib`, alebo server-side Puppeteer/HTML→PDF) je implementačné rozhodnutie budúcej fázy. Požiadavky: `logo_path` z `company_billing_profile`/`settings`, SK/DE/EN lokalizácia (existujúca i18n infraštruktúra), QR/Pay by Square kód — **budúca funkcia, nie Fáza 0** (vyžaduje vlastnú špecifikáciu formátu, momentálne mimo rozsahu), stiahnutie/zdieľanie na Androide cez existujúci mobile build vzor.

## 28. Platby

Fáza 1: výhradne ručné označenie „uhradené" + dátum platby (`invoice_payments`, bod 9). **Bankové prepojenie/open banking sa do Fázy 1 nezahŕňa** — samostatná, výrazne komplexnejšia budúca iniciatíva (vlastný bezpečnostný audit, PSD2 aspekty) mimo rozsahu tohto dokumentu.

## 29. Napojenie na existujúce entity Esblu

Prijatá faktúra (napr. servis vozidla, nákup materiálu) sa napája na `vehicles`/`machines`/`vehicle_services`/`machine_services`/`custom_document_categories` **rovnakým vzorom ako dnešný `document_links`** — buď rozšírenie tejto tabuľky o `invoice_id` FK, alebo analogická nová `invoice_links` tabuľka (rozhodnutie: rozšíriť existujúcu vs. novú, necháva sa na implementačnú fázu — oba prístupy sú validné, dôležité je zachovať `confidence`/`confirmed_by_user` gate vzor). **Prepracovanie existujúceho nákladového enginu (napr. automatické generovanie `vehicle_services.cost` z faktúry) NIE JE súčasťou tejto architektúry** — vyžaduje samostatný audit, presne ako žiada zadanie.

---

## 30. Intent/Voice Engine — budúca integrácia (návrh, bez implementácie)

Existujúci Intent Engine (`lib/intents/*`) má presne tri kategórie, do ktorých fakturačné intenty zapadajú:

**READ (bez potvrdenia, `readOnly:true`):** `SHOW_INVOICE` ("Ukáž faktúru od firmy X"), `SEARCH_INVOICES` (rozšírenie existujúceho `documentTypes` filtra o `invoice`/`received`/`issued`), `INVOICE_STATUS_SUMMARY` ("Koľko máme po splatnosti?").

**ACTION+CONFIRMATION (`requiresConfirmation:true`, cez existujúci `action_preview` flow):** `CREATE_DRAFT_INVOICE` ("Vytvor faktúru pre firmu X na 500 eur"), `MARK_INVOICE_PAID`, `ASSIGN_RECEIVED_INVOICE_TO_VEHICLE` (analogické k dnešnému `ASSIGN_DOCUMENTS_TO_CATEGORY`).

**VYSOKO RIZIKOVÉ (potrebujú prísnejšie potvrdenie než dnešný štandard — napr. explicitné zobrazenie PRESNÉHO obsahu pred odoslaním, nie len "naozaj chceš X?"):** `FINALIZE_INVOICE` (immutabilita — nedá sa vziať späť), `SEND_EINVOICE` (ide von z firmy, právne záväzné, nedá sa "zmazať" po doručení). Tieto musia ísť cez presne ten istý HMAC server-proof mechanizmus, aký už dnes chráni `CREATE_DOCUMENT_CATEGORY`/`ASSIGN_DOCUMENTS_TO_CATEGORY` (`assistant_action_confirmations`, nonce + server_proof, SECURITY DEFINER RPC) — **žiadny nový, samostatný confirmation systém sa nevymýšľa.** Toto je návrh na budúcu fázu (7+), nie implementácia teraz.

## 31. Role a oprávnenia

Existujúci `company_members.role ∈ {owner, admin, employee}` + `permissions (jsonb)`. Fakturačné dáta sú citlivejšie než napr. sklad — **žiadny default plný prístup pre employee**. Návrh granularity (cez existujúce `permissions` jsonb, bez schema migrácie): `invoices.view_received`, `invoices.view_issued`, `invoices.create_draft`, `invoices.finalize`, `invoices.send_einvoice`, `invoices.mark_paid`, `invoices.export`. Predvolené: owner/admin majú všetko; employee predvolene iba `view_received` + `create_draft` (môže pripraviť, nemôže finalizovať/odoslať) — presný default set je produktové rozhodnutie pre schválenie, nie čisto technické.

## 32. Audit trail

`invoice_events` (bod 9) — nemenný log: `created, draft_edited, finalized, sent, delivery_accepted, delivery_rejected, corrected, payment_recorded, provider_callback`, s `actor_user_id`/`actor_source` (`user`/`ai_intent`/`provider_webhook`/`system`). **Nikdy neukladá secrets** (provider API kľúče/tokeny idú do samostatného, server-only `einvoice_provider_accounts.credentials_ref`, nikdy priamo do event payloadu).

## 33. Bezpečnostný model — invarianty, ktoré sa NESMÚ porušiť

Priamy prepis požiadaviek zadania, potvrdený ako záväzný pre každú budúcu fázu:
- Multi-tenant izolácia cez `company_id` + RLS na každej novej tabuľke (rovnaký vzor ako existujúce tabuľky).
- User-scoped Supabase klient všade (`getUserScopedSupabaseClient`), **nikdy service-role** pre bežné operácie.
- Provider secrets výhradne server-side, nikdy v klientskom kóde ani v `invoice_events` payloade.
- Webhook signature validácia povinná pred akýmkoľvek spracovaním (bod 19).
- Idempotencia na všetkých externých vstupoch (bod 20).
- Rate limiting na provider-facing endpointoch (implementačný detail budúcej fázy).
- Immutabilita finalizovanej faktúry vynútená na DB úrovni, nie len UI (bod 13).
- **Žiadna AI daňová matematika** (bod 25) — AI navrhuje/kategorizuje, nikdy nepočíta finálne DPH/súčty pre vlastné vystavené faktúry.
- **Žiadne AI-generované XML bez deterministickej validácie** (bod 18) — XML generuje deterministický kód z kanonického modelu, AI sa do XML generovania nezapája vôbec.
- Vysoko rizikové akcie (finalizácia, odoslanie eFaktúry) idú výhradne cez existujúci HMAC action-confirmation systém.

## 34. GDPR/CLIA dopad (zoznam, nie prepis právnych dokumentov)

**Nové osobné/citlivé dáta:** identity zákazníkov/dodávateľov (`business_partners` — môžu byť aj SZČO, teda fyzické osoby), adresy, fakturačné údaje, bankové/platobné info (IBAN), Peppol identifikátory, provider message metadata.

**Nové dátové toky:** Esblu ↔ eInvoice provider/PDS ↔ Peppol sieť ↔ protistrana ↔ Finančná správa (eReporting). Toto je **nový spracovateľský reťazec** oproti dnešnému (dnes: Esblu ↔ Supabase ↔ OpenAI pre AI extrakciu).

**Pravdepodobne nový (sub)spracovateľ:** vybraný eInvoice/PDS provider (bod 15/16) — bude potrebovať **novú DPA** (rovnaký `legal_documents`/`company_dpa_acceptances` verziovací mechanizmus, aký dnes existuje pre iných subdodávateľov, viď `docs/gdpr-compliance-review-2026-08-15.md` spomínaný v `lib/legal-config.ts`).

**Retencia:** pravdepodobne odlišná (dlhšia, zvyčajne ~10 rokov pre účtovné doklady) od dnešnej retenčnej politiky pre AI Inbox dokumenty — **vyžaduje samostatné právne posúdenie s CLIA**, nie technické rozhodnutie tu.

**Medzinárodné prenosy:** závisí od výberu providera (SK-based providery z bodu 15 minimalizujú toto riziko oproti napr. Connect International B.V., ktoré je medzinárodné — relevantné pre výber v bode 16).

**Dokumenty na budúcu aktualizáciu (AŽ s CLIA, nie teraz):** Privacy Policy (nová kategória spracovania + nový subprocessor v sekcii E, presne ako pri minulých revíziách 1.1→1.2→1.3), Subprocessors stránka, možno nová DPA príloha pre eInvoice providera, Terms (fakturačné funkcie ako nová funkcionalita).

---

## 35. Fázovaný implementačný plán

| Fáza | Obsah | Predpoklad |
|---|---|---|
| **0** (táto úloha) | Research + kanonická architektúra | — |
| **1** | Obchodní partneri (`business_partners`) + company billing profile (+ vyjasnenie `companies` vs `settings`) | Schválenie tohto dokumentu |
| **2** | Interný fakturačný model — `invoices`/`invoice_items`, draft/finalizácia, číslovanie, VAT engine, bez PDF/eFaktúry | Fáza 1 |
| **3** | UI pre vystavené faktúry + PDF export | Fáza 2 |
| **4** | Prepojenie prijatých faktúr s AI Inboxom (dedup, `invoice_links`) | Fáza 2 (dátový model) |
| **5** | EN16931/Peppol XML generovanie/parsovanie/validácia (bez reálneho odoslania) | Fáza 2–3, ideálne aj vyjasnená SK CIUS |
| **6** | Provider sandbox integrácia (vybraný kandidát z bodu 15) | Fáza 5 + uzavretý obchodný kontakt s providerom |
| **7** | Produkčné pripojenie k providerovi, reálne odosielanie/prijímanie eFaktúry | Fáza 6 + zmluva s providerom + DPA + overenie (nie predpoklad) skutočného DIČ/IČ DPH stavu Esblu s.r.o. mimo repozitára (korekcia 12) |
| **8** | eReporting doladenie, právne dokončenie, produkčná pripravenosť na 1.1.2027 | Fáza 7 |

Toto poradie zodpovedá návrhu zo zadania — audit nenašiel dôvod ho meniť.

## 36. Riziká a blokátory

1. **Nepotvrdená interakcia reverse charge (stavebníctvo) s eFaktúrou** (bod 1/C) — môže ovplyvniť dátový model VAT enginu, ak sa ukáže špecifická požiadavka.
2. **Chýbajúca SK CIUS špecifikácia** (bod 18) — XML generátor (Fáza 5) nemožno finalizovať, kým nebude jasné, či/ako sa líši od všeobecného Peppol BIS Billing.
3. **Oficiálny zoznam PDS je login-gated** (bod 2/15) — plné porovnanie kandidátov vyžaduje buď prihlásenie do portálu FS, alebo priamy obchodný kontakt.
4. **Nejasný vzťah `companies` vs `settings`** (bod 5.2/24) — musí sa vyjasniť pred Fázou 1, inak riziko duplicitného zdroja pravdy pre billing profil.
5. **Esblu s.r.o. samo nemá DIČ/IČ DPH** (bod 5.2) — organizačná, nie technická prekážka pre Fázu 7.
6. **Marketingové "sme prví" tvrdenia dvoch providerov si protirečia** (ePošťák vs. Flowis, bod 15) — neovplyvňuje architektúru, ale relevantné pre obchodné rozhodnutie.
7. **Metodika eReportingu od 1.7.2030** je zatiaľ nejasná v detaile (bod 1/C, Q6) — dlhodobé riziko, nie okamžité.

## 37. Čo vyžaduje externé povolenie/zmluvu/registráciu

- Zazmluvnenie certifikovaného PDS providera (bod 15/16) — obchodný kontakt, zmluva.
- Registrácia Esblu s.r.o. (alebo per-company) v Peppol sieti cez zvoleného providera.
- Prípadná DPA s providerom (bod 34).
- Doplnenie DIČ/IČ DPH pre Esblu s.r.o., ak má samo fakturovať B2B.
- Právne schválenie CLIA pre nové/upravené Privacy Policy, Subprocessors, DPA.

## 38. Čo sa dá začať okamžite bez providera

- Fáza 1 (business partners, billing profile).
- Fáza 2 (interný model, draft/finalizácia, číslovanie, VAT engine) — plnohodnotná interná fakturácia (vystavenie, PDF, sledovanie platby) **funguje aj úplne bez akéhokoľvek eInvoice providera** — toto je dôležité: Esblu môže dodať reálnu produktovú hodnotu (Fázy 1-4) úplne nezávisle od výberu/zmluvy s PDS providerom.
- Fáza 3, 4 (UI, PDF, prepojenie na AI Inbox).
- Návrh (nie implementácia) Fázy 5 XML mapovania — dá sa pripravovať paralelne, keďže EN16931/Peppol BIS je dnes už stabilná, verejná špecifikácia nezávislá od konkrétneho providera.

## 39. Čo sa NESMIE implementovať, kým nie je vybraný provider

- Reálne odoslanie/prijatie cez Peppol (Fáza 6-7) — zjavne závislé od providera.
- Akékoľvek natvrdo zakódované provider-špecifické API volania mimo `EInvoiceProvider` abstraktného rozhrania (bod 22 zadania — abstrakcia musí byť hotová PRED prvou konkrétnou integráciou, nie naopak).
- Ukladanie provider credentials/webhook secrets (triviálne, ale explicitne: kým nie je zmluva, niet čo ukladať).

## 40. Odhad rozsahu jednotlivých fáz

*(Orientačný, kvalitatívny — nie hodinový odhad, keďže presný odhad by vyžadoval detailný implementačný plán mimo rozsahu Fázy 0.)*

| Fáza | Relatívna náročnosť | Hlavné riziko |
|---|---|---|
| 1 | Malá–stredná | Vyjasnenie `companies`/`settings` |
| 2 | Stredná–veľká (jadro modelu) | VAT engine korektnosť, číslovanie concurrency |
| 3 | Stredná (UI-ťažká) | PDF knižnica voľba, konzistencia s existujúcim UI |
| 4 | Stredná | Dedup logika, PDF podpora v AI Inbox |
| 5 | Veľká (špecializovaná doména) | SK CIUS neistota, Schematron validácia |
| 6 | Stredná–veľká | Závisí úplne od zvoleného providera a kvality jeho sandboxu |
| 7 | Veľká, ale hlavne netechnická (zmluvná/organizačná) | Obchodné rokovania, DPA, DIČ/IČ DPH |
| 8 | Malá–stredná | Legislatívne doladenie tesne pred 1.1.2027 |

---

## Konkrétne odporúčanie pre PRVÚ implementačnú úlohu

**Odporúčam ako prvý implementačný krok (po schválení tohto dokumentu): Fáza 1 — a v rámci nej najprv vyjasnenie vzťahu `companies` ↔ `settings`, potom `business_partners` tabuľka + jej CRUD (znovupoužitím RLS/UI vzoru z `custom_document_categories`), a napokon `company_billing_profile`.**

Dôvod: (1) je to jediný krok, ktorý je úplne nezávislý od výberu providera aj od nedoriešených právnych detailov (reverse charge, SK CIUS) — dá sa začať okamžite; (2) `business_partners` je predpoklad pre všetko ostatné (bez zákazníka/dodávateľa nemožno vytvoriť žiadnu faktúru); (3) najviac priamo znovupoužíva existujúci, už-auditovaný a bezpečný vzor (`custom_document_categories`), čo minimalizuje riziko nových bezpečnostných chýb; (4) dáva CLIA aj obchodnej strane čas na paralelné riešenie zmluvy s providerom a právnych dokumentov, kým sa buduje neprovider-závislá časť.

**Explicitne NEODPORÚČAM** začať s Fázou 5 (XML/Peppol) ako prvým krokom — bez `business_partners`/kanonického modelu (Fázy 1-2) hotového by generovanie XML nemalo z čoho čerpať dáta, a SK CIUS neistota (riziko #2) robí investíciu do XML generátora predčasnou.

---

# FÁZA 1A — Audit: `companies` vs. `settings`, návrh jediného source-of-truth

**Vykonané:** 15.9.2026, priamym auditom produkčnej DB (`fkpgvgvsmbpieduoatrt`, iba READ dopyty) a kódovej základne. **Žiadny SQL zápis, migrácia ani implementácia neboli vykonané — presne podľa pokynu.**

## 1. Kto dnes číta/zapisuje `companies`

**RLS:** jediná politika `companies_select_member` (`SELECT`, iba pre aktívnych `company_members` danej firmy). **Žiadna INSERT/UPDATE/DELETE RLS politika neexistuje** — všetky zápisy idú výhradne cez `SECURITY DEFINER` RPC, nikdy priamym `.from("companies")` klientským volaním.

- **Zápis (INSERT):** iba `esblu_ensure_my_owner_company()` — pri prvom bootstrape novej firmy vloží `(owner_id, name)`, kde `name` sa naplní z `settings.company_name` **volajúceho v danom okamihu** (alebo `'Moja firma'` ako fallback, ak `settings` riadok ešte neexistuje/je prázdny).
- **Zápis (DELETE):** `esblu_owner_delete_company()` (existencia potvrdená v `information_schema.routines`, obsah nebol v rámci Fázy 1A čítaný — mimo rozsahu tejto úlohy).
- **Update:** **NENÁJDENÝ NIKDE.** Po vytvorení sa `companies.name` už nikdy needituje žiadnou cestou v kóde.
- **Čítanie:** `esblu_get_company_profile()` (JOIN cez `companies` na `settings` ownera), `app/api/account/delete/route.ts` a `app/api/account/preflight/route.ts` (kontrola `owner_id` pri mazaní účtu — anomália "owner bez aktívneho membershipu"), `lib/company.ts` wrappery.

## 2. Kto dnes číta/zapisuje `settings`

**RLS:** jediná politika `"Users can manage own settings"` (`ALL`, `auth.uid() = user_id`) — **plne per-user self-service CRUD**, bez rolového rozlíšenia (owner/admin/employee majú identické práva — ale iba nad **vlastným** riadkom).

- **Zápis:** `app/nastavenia/page.tsx` — `saveSettings()`, `saveLogoPathToDatabase()`, mazanie loga — **všetko filtrované `.eq("user_id", userId)` volajúceho**, nikdy ownera firmy. `lib/i18n/LocaleProvider.tsx` — `setLocale()` robí best-effort `UPDATE settings SET locale=... WHERE user_id=...` (bez INSERT fallbacku — ak riadok neexistuje, update potichu ovplyvní 0 riadkov, žiadna chyba sa nezobrazí).
- **Čítanie:** `app/nastavenia/page.tsx` — `loadSettings(currentUserId)`, vždy vlastný riadok. `hooks/use-plan-usage.ts` — `.from("settings").select("plan").eq("user_id", session.user.id)` — **vlastný riadok volajúceho, NIE ownera firmy.** `esblu_get_company_profile()` RPC — **JOIN na `settings` cez `companies.owner_id`**, teda vždy riadok OWNERA, bez ohľadu na volajúceho. `esblu_ensure_my_owner_company()` — číta vlastný riadok volajúceho, ale iba raz, v momente bootstrapu.

## 3. Kde je dnes `company_name`/`logo_path`/`locale`/`plan`

Všetky štyri polia žijú **výhradne na `settings`**, ktorá má DB-level `UNIQUE(user_id)` (potvrdené — `settings_user_id_key`), teda **striktne 1 riadok na používateľa, nie na firmu.**

- `company_name`, `logo_path`: živá, zobrazovaná hodnota (cez `esblu_get_company_profile()`) = vždy **ownerov** riadok. Ak admin/employee otvorí Nastavenia a zmení "Názov firmy", zapíše sa to do **jeho vlastného** `settings` riadku — zobrazí sa to späť **iba jemu** (keďže `loadSettings()` číta tiež vlastný riadok), ale **nikdy sa to neprejaví v `esblu_get_company_profile()`/Dashboard brandingu ostatných členov ani jeho vlastnom**, pretože ten číta výhradne ownerov riadok. Používateľ (admin/employee) tak môže nadobudnúť dojem, že zmenu "uložil", hoci na zdieľané firemné dáta nemá reálne žiadny vplyv.
- `plan`: rovnaký per-user scope, ale číta sa **nekonzistentne** — `usePlanUsage()` číta **volajúceho vlastný** riadok (nie ownera), na rozdiel od `esblu_get_company_profile()` vzoru. Pozri Blocker A nižšie.
- `locale`: zapisuje sa (best-effort, per user), ale **nikde v kóde sa nečíta späť** — potvrdené aj priamym DB dopytom: 0 zo 7 produkčných `settings` riadkov má `locale` vyplnené. Appka de facto vždy spolieha na `localStorage`.
- `companies.name`: existuje ako samostatný stĺpec, nastaví sa raz pri založení firmy, **nikdy sa nezobrazuje v UI ako "aktuálny" názov** (UI vždy ide cez `getCompanyProfile()` → `settings`).

## 4. Čo je legacy vs. aktívne

| Prvok | Stav |
|---|---|
| `settings.company_name`, `settings.logo_path` (ownerov riadok) | **AKTÍVNE** — toto sú fakticky dnešné "firemné" dáta, hoci uložené na nesprávnom (per-user) mieste. |
| `settings.plan` | **AKTÍVNE, ale s nekonzistentným scope** (Blocker A). |
| `settings.locale` | **DE FACTO MŔTVE** — write-only stĺpec, nikdy sa nečíta, 0 riadkov v produkcii ho má vyplnené. Funkcionalita "obnov jazyk po prihlásení z iného zariadenia" opísaná v komentári kódu dnes reálne nefunguje. |
| `companies.name` | **DE FACTO VESTIGIÁLNE po vytvorení** — nastaví sa raz, nikdy sa needituje, nikdy sa nezobrazuje. |
| `companies.id`/`owner_id` | **AKTÍVNE a kritické** — skutočná multi-tenant kotva, cieľ takmer všetkých `company_id` FK v DB. |

## 5. Čo sa má migrovať

- `settings.company_name` (ownerov riadok) → nové `company_billing_profile.legal_name`.
- `settings.logo_path` (ownerov riadok) → `company_billing_profile.logo_path`.
- `settings.plan` → **NEMIGROVAŤ automaticky, kým sa nevyrieši Blocker A** (nie je jasné, či je to company-wide alebo per-user dáta — technicky sa dá presunúť oboma smermi, ale bez rozhodnutia by som iba prenášal existujúcu nekonzistenciu na nové miesto).
- `settings.locale` → **NEMIGROVAŤ do company profilu** (je to legitímne per-user dáta, nie firemné).

## 6. Odporúčaný source-of-truth

- `companies` (`id`, `owner_id`) — **zostáva** multi-tenant kotva, nemeniť.
- **Nová `company_billing_profile`** (FK `company_id`, NIE `user_id`) — **stáva sa** jediným zdrojom pravdy pre firemné meno/logo/(budúce billing polia, bod 22 hlavného dokumentu).
- `settings` — zredukuje sa na skutočne per-user dáta (dnes: `locale`; `plan` až po vyriešení Blockera A).
- `companies.name` — odporúčam **neudržiavať v synchronizácii** s `company_billing_profile.legal_name` (zabránilo by to duplicite zápisu) a v UI ho ponechať ako "názov v čase založenia firmy" pre interné/audit účely, nie ako živé pole.

## 7. Návrh `company_billing_profile`

Zhodný s bodom 22 hlavného dokumentu vyššie: `company_id (PK/FK → companies.id), legal_name, address_*, ico, dic, ic_dph, iban, bic, default_vat_rate, invoice_numbering_prefix, default_due_days, logo_path, contact_email, einvoice_provider_id (nullable)`. Poznámka pre Fázu 1B: `legal_name`/`logo_path` sa dajú zaviesť už teraz (Fáza 1A nadväzne), zvyšné fakturačné polia (ico/dic/ic_dph/iban/...) môžu prísť v tej istej tabuľke hneď, keďže ide o jednu migráciu — netreba umelo deliť na dve tabuľky.

## 8. Ako sa vyhneme duplicite

- Po nasadení Fázy 1B je `company_billing_profile` **jediné** miesto zápisu/čítania pre firemné meno/logo — `settings.company_name`/`logo_path` appka prestáva čítať aj zapisovať (stĺpce zostávajú v DB, nemažú sa hneď — rollback okno).
- `esblu_get_company_profile()` sa prepíše z JOIN-cez-ownerov-settings na priame čítanie `company_billing_profile` podľa `company_id` volajúceho (žiadny JOIN na `owner_id` už nie je potrebný — čistejšie aj konzistentnejšie so zvyškom RLS modelu).
- Backfill (Fáza 1B) je jednosmerný a jednorazový — nie priebežná synchronizácia medzi `settings` a `company_billing_profile` (dve priebežne synchronizované kópie tých istých dát by boli presne tá duplicita, ktorej sa treba vyhnúť).

## 9. Dopad na existujúce UI/RLS

- **`app/nastavenia/page.tsx`:** zásadná zmena — dnes upravuje vlastný `settings` riadok volajúceho (čo je pre firemné meno/logo architektonicky nesprávne, bod 3 vyššie). Po migrácii musí upravovať `company_billing_profile` podľa `company_id` aktívneho membershipu, **s UI/RLS obmedzením na owner/admin** (nie každý member — rovnaký vzor ako `custom_document_categories` UPDATE/DELETE, kde SELECT majú všetci členovia, ale zápis iba owner/admin). Employee by mal vidieť firemné meno/logo read-only.
- **Nová RLS na `company_billing_profile`:** `SELECT` pre všetkých aktívnych členov firmy (potrebujú vidieť branding), `INSERT`/`UPDATE` iba owner/admin, **žiadny `DELETE`** (profil firmy sa nemaže samostatne, iba spolu s firmou cez existujúci `esblu_owner_delete_company()` flow).
- **`esblu_get_company_profile()`:** prepísať JOIN podľa bodu 8.
- **`hooks/use-plan-usage.ts`:** súvisiaci, ale **mimo jadra Fázy 1B** nález — pozri Blocker A/B nižšie. Nespomínam ho ako "urobiť v Fáze 1B", pretože si vyžaduje samostatné produktové rozhodnutie skôr, než sa čokoľvek zmení.
- **`lib/i18n/LocaleProvider.tsx`:** mimo rozsahu Fázy 1A (per-user dáta, nie company profil) — nález o nefunkčnosti (bod 4) iba zaznamenávam, neopravujem.

## 10. Presný implementačný plán Fázy 1B (bez SQL, iba plán na schválenie)

a. Vytvoriť `company_billing_profile` (FK `company_id`, RLS ako v bode 9) — jedna migrácia, so všetkými poľami z bodu 7 naraz (nie iba name/logo).
b. Jednorazový backfill: pre každú firmu nájsť `settings` riadok jej `owner_id`, skopírovať `company_name → legal_name`, `logo_path → logo_path` do nového riadku.
c. Prepísať `esblu_get_company_profile()` na čítanie z `company_billing_profile`.
d. Prepísať sekciu "Firma" v `app/nastavenia/page.tsx` na `company_billing_profile`, s owner/admin-only zápisom a read-only zobrazením pre employee.
e. Ponechať `settings.company_name`/`logo_path` stĺpce nezmazané do potvrdenia stability nového flow v produkcii — ich odstránenie je samostatné, neskoršie rozhodnutie.
f. Regresný test: Dashboard branding musí po zmene zobrazovať identické `company_name`/`logo` pre owner, admin aj employee tej istej firmy (dnes to platí vďaka JOIN triku; po migrácii to musí platiť vďaka priamemu company-scoped čítaniu — toto je test, ktorý by mal explicitne overiť, že sa migráciou nič nepokazilo).
g. **Mimo Fázy 1B, samostatná položka na rozhodnutie:** Blocker A/B (plán a usage counting) — odporúčam vyriešiť predtým, než sa plán/limity akokoľvek prepoja s billing profilom (napr. budúce "platený tier = viac faktúr mesačne").

## Blockery (Fáza 1A) — neuzavreté, nepredpokladám odpoveď

- **BLOCKER A — scope `plan`:** `settings.plan` sa dnes číta DVOMA nekonzistentnými spôsobmi: `esblu_get_company_profile()`-štýl (cez ownera, company-wide efekt) vs. `usePlanUsage()` (vlastný riadok volajúceho). Neviem z kódu s istotou určiť, ktoré správanie je zamýšľané — či mal byť plán vždy per-firma (a `usePlanUsage` je bug), alebo skutočne per-user (nezvyčajné pre B2B appku s rolami owner/admin/employee, ale nedá sa to vylúčiť bez potvrdenia). **Toto je produktové/obchodné rozhodnutie, nie niečo, čo mám odvodzovať sám** — potrebné vyjasniť pred akoukoľvek migráciou `plan` mimo `settings`.
- **BLOCKER B — usage counting per-user namiesto per-company:** `usePlanUsage()` počíta využitie zdrojov (`vehicles`/`machines`/`inventory_items`/`ai_evidence`) filtrovaním `.eq("user_id", session.user.id)`, **nie** `.eq("company_id", ...)` — hoci všetky tieto tabuľky majú oba stĺpce. Ak je to skutočne bug (firma s viacerými členmi by tak mohla efektívne obísť plánový limit, keďže každý člen má vlastný počítaný "účet"), ide o závažný nález **nad rámec fakturačného projektu** — nahlasujem ho tu, lebo som naň narazil počas auditu `settings`, ale **neopravujem ho** (mimo zadania Fázy 1A aj mimo "žiadny kód" obmedzenia tejto úlohy). Odporúčam samostatné rozhodnutie/úlohu.
- **BLOCKER C — osirelé `settings` riadky:** 2 zo 7 produkčných `settings` riadkov patria používateľom bez aktívneho `company_members` záznamu. Nie je jasné, či ide o očakávaný stav (napr. návšteva Nastavenia pred dokončením onboardingu, alebo bývalý odobratý člen) alebo dáta na vyčistenie — nespôsobuje bezpečnostný problém (RLS ich stále správne izoluje per-user), ale spomínam pre úplnosť pred akýmkoľvek budúcim mazacím/cleanup skriptom.

---

*Koniec dokumentu (revízia 1, vrátane Fázy 1A). Žiadny kód, SQL, migrácia, provider signup, zmluva, secret, commit ani push neboli v rámci tejto úlohy vykonané. Čaká sa na rozhodnutie k Blockerom A/B/C a na schválenie postupu do Fázy 1B.*
