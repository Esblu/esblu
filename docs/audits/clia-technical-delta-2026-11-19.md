# CLIA — technická delta: produkcia vs. podklady poskytnuté CLIA (stav 2026-11-19)

**Účel:** presný technický súhrn rozdielov medzi **skutočným stavom produkcie** a materiálmi, ktoré CLIA dostala alebo posúdila.
**Nie je to právne stanovisko.** Návrhy znení sú výslovne označené **DRAFT — na kontrolu prevádzkovateľom** a nič sa
nezverejnilo ani neodoslalo. **VOP sú mimo rozsahu CLIA** (týka sa ich iba odkaz, kde je to nutné na pochopenie GDPR dopadu).

**Východiská (čo CLIA má):**
- balík CLIA „GDPR Esblu“ 09. 11. 2026 + stanovisko 11. 11. 2026 (J10.1) — Q1–Q14 **uzavreté**
  (`docs/clia-gdpr-reconciliation-2026-11-10.md` §18): DPA elektronicky, Anthropic ako sprostredkovateľ, DPIA nie je blocker,
  cookie lišta netreba, EN/DE preklady, `legal_acceptance_evidence` 5 r., `trial_claims` ≤ 5 r., Q14 Google v mobile (doc);
- eFaktúra: `docs/einvoice-clia-change-request.md`, `docs/clia-delta-einvoice-api-partner-2026-10-06.md`, `docs/clia-delta-email-2026-10-07.md`
  a informácie, ktoré CLIA už k eFaktúre vyriešila — **tieto otázky sa tu znovu neotvárajú**;
- návrh správy `docs/clia-delta-2026-11-24-draft.md` (stav: draft, neodoslaný; krok L1 prevádzkovateľa, termín 24. 11.).
  Tento dokument ho **dopĺňa**, nenahrádza.

**Zdroj overenia:** kód `f8262b4` (obsahuje `origin/main` `12da726` = produkcia + neprodukčné billing commity), migrácie,
dokumentácia, `docs/ops/service-intervention-log.md`. Produkčnú DB som v tomto audite nečítal — produkčné fakty sú z
read-only záznamov z 11.–19. 11. Položky, ktoré treba ešte overiť, sú označené **[OVERIŤ]**.

---

## 1. Čo je dnes reálne v produkcii (19. 11. 2026)

| Oblasť | Stav produkcie | Dôkaz |
|---|---|---|
| Web + DB (release J10.2) | beží od 11. 11.; VOP 1.2 + termination workflow od 12. 11. | log zásahov 11.–12. 11. |
| Verejná registrácia | otvorená od 17. 11. (`registration_policy = open`) | migrácia `20261117100000`, log 17. 11. |
| Auth e-maily | **vlastný SMTP Resend** (`smtp.resend.com`, `noreply@mail.esblu.com`), doložené doručenie 17. 11. 22:55 UTC | draft CLIA §1.1, DNS |
| Android 1.0.1 (vc4) | interné testovanie Google Play; **Google prihlásenie v appke** (OAuth PKCE, `com.esblu.app://auth/callback`) | `docs/android-release-vc4-2026-11-17.md` P3 |
| Stripe / predplatné | **vypnuté**; kód aj 8 migrácií iba na stagingu/vetve; produkcia `web_provider = none`; live režim pripravený, nezapnutý | `prod-cleanup-and-operator-plan-2026-11-19.md` §0, `billing-live-rollout-2026-11-19.md` |
| eFaktúra (eFaktura.sk, Peppol) | **vypnutá** (bez env, 0 riadkov, webhook 503); nová zmluva od poskytovateľa doručená, nepodpísaná | `einvoice-production-gate-2026-11-12.md` |
| Retenčná purge (`ESBLU_GDPR_RETENTION_PURGE_ENABLED`) | **vypnutá** — prvý beh čaká na súhlas (krok P3) | `launch-remaining-steps-2026-11-19.md` |
| Posledná produkčná migrácia | `20261117213219` / `open_public_registration`; 108 záznamov histórie | read-only 19. 11. |

## 2. Delta podľa tém

### 2.1 Stripe (platby predplatného) — NOT LIVE, ale pripravené na live

**Rozdiel voči materiálom CLIA:** CLIA dokumenty Stripe neuvádzajú (v reconciliation 10. 11. „NOT LIVE — správne neuvedené“).
Od 18.–19. 11. je implementácia kompletná a otestovaná v Stripe sandboxe; aktivácia je naplánovaná (S3–S9). Pred zapnutím
treba GDPR re-review (DPA čl. IX — oznámenie).

**Tok a údaje (technicky):**

| Smer | Údaje |
|---|---|
| Esblu → Stripe (API) | ID ceny, interné `esblu_checkout_id` (metadata, `client_reference_id`), existujúce `customer` ID, `locale=sk`, `origin_context` (web/appka); **nie** e-mail, meno ani IČO firmy |
| Používateľ → Stripe (Stripe Checkout, doména Stripe) | e-mail, meno, fakturačná adresa (povinná), IČ DPH/tax ID (voliteľné, zapnuté), platobná karta / SEPA |
| Stripe → Esblu (webhook, `/v1/events`, API) | stav predplatného, obdobia, ID faktúry, sumy, mena, **krajina z fakturačnej adresy** (`tax_country`), refundácie, spory |
| Uložené v Esblu DB | `subscription_accounts` (provider customer/subscription ID, obdobia, stav), `billing_checkout_sessions` (`created_by` = user ID), `billing_events` (ID udalosti, typ, SHA-256 payloadu, `summary` ≤ 4 kB), `billing_store_reports` (sumy, krajina) — **bez čísla karty, bez adresy, bez e-mailu** |
| Retencia v Esblu | `subscription_accounts`, `billing_checkout_sessions` → kaskáda so zrušením firmy; `billing_events`, `billing_store_reports` → **SET NULL** (ostávajú bez väzby na firmu) — **retenčná lehota v kóde nie je definovaná** |
| Webhooky | podpis Stripe, dedupe podľa ID udalosti, test/live striktne oddelené (`livemode` kontrola, DB guard prostredia) |

**Doklady:** Stripe automaticky vystavuje **Stripe Invoice** ku každému cyklu; Esblu dnes vlastný daňový doklad za predplatné
nevystavuje. Model dokladov je otvorený (účtovníčka, § 7a) — pozri `efaktura-readiness-audit-2026-11-19.md` §10.

**Čo CLIA nemá a je nové:** (a) Stripe je technicky pripravený aj pre platbu z Android appky cez webový Checkout
(`origin_context=mobile_app`); Google Play Billing / „external transaction“ reportovanie je v kóde, **nie live**;
(b) `billing_events`/`billing_store_reports` prežijú zrušenie firmy (účtovná evidencia Esblu) — v Zásadách 1.4 je účel
„Plnenie účtovných a daňových povinností Spoločnosti“ (10 r.), ale technické platobné záznamy bez väzby na doklad nemajú lehotu.

### 2.2 Resend (SMTP pre auth e-maily) — LIVE od ≤ 17. 11. 2026

Plne pokryté v drafte 24. 11. §1.1. Technické doplnenie:
- V kóde aplikácie **nie je** žiadna Resend integrácia/SDK; Resend používa iba Supabase Auth ako SMTP (registrácia,
  potvrdenie, obnova hesla cez `resetPasswordForEmail`). Pozvánky do firmy sa e-mailom neposielajú.
- `/subprocessors` (texty `legal.subprocessors.emailHistoryResend*`) stále tvrdí „Resend nie je aplikáciou nikde použitý“ —
  **nepravdivé**. Interný `docs/gdpr-subprocessors.md` (verzia 1.0, 18. 8.) je tiež zastaraný (Resend „nepoužívaný“,
  prevádzkovateľ uvedený ako fyzická osoba).
- **[OVERIŤ]** prevádzkovateľ: dátum prvého odoslania, región Resend (EÚ/US), akceptácia DPA Resend.

### 2.3 Google OAuth v Android appke — LIVE v internom teste, verejné vydanie pripravené

- CLIA Q14 uzavretá ako „pravdivé, nie úplné, doplniť pri revízii PP“. S verejným vydaním appky (krok AN5) ide o reálny
  rozdiel v Zásadách 1.4 („dostupné vo webovom rozhraní“) a v DPA 1.3 (rovnaká formulácia).
- Technicky: Capacitor Browser → Supabase `/authorize` (PKCE) → `com.esblu.app://auth/callback` → `/token`; údaje od Google
  rovnaké ako na webe (meno, e-mail, avatar URL, Google ID). Žiadne Google SDK s ďalšími údajmi; FCM je samostatný (už v DPA p3).

### 2.4 eFaktúra — súčasný model (bez znovuotvárania vyriešených otázok)

**Nezmenené voči tomu, čo CLIA dostala:** API partner model, Esblu nie je Access Point ani sprostredkovateľ na PFS, klient si
na PFS sám zvolí eFaktura.sk a overovací kód zadá v Esblu (kód sa neukladá), eFaktura s. r. o. = ďalší sprostredkovateľ Esblu,
prijatý doklad = koncept na kontrolu, doručenie ≠ úhrada, Esblu nie je zákonný archív.

**Nové od posledných podkladov (technické fakty):**

| # | Zmena | Dopad na údaje |
|---|---|---|
| E1 | Prijímané XML je **Peppol SBDH obálka + UBL**; ukladá sa nezmenené (vrátane identifikátorov odosielateľa/príjemcu v obálke) | o niečo viac metadát v uloženom origináli (bez nových kategórií OÚ) |
| E2 | Fail-closed `RECIPIENT_MISMATCH`: doklad iného príjemcu sa nepriradí žiadnej firme, ostáva uložený pre operátorskú kontrolu, bez ACK (runbook §12) | dočasné uloženie dokladu bez priradenia k zákazníkovi — prístup iba operátor |
| E3 | Webhook replay guard + index `body_sha256` (ukladá sa iba hash tela, 90 dní) | bez zmeny kategórií |
| E4 | Company export obsahuje históriu stavov eFaktúry (`einvoice_events`, `einvoice_lifecycle.{json,csv}`); termination vyžaduje **server-side dôkaz dokončeného exportu** (`company_export_runs`, migrácia `20261113110000`) **[OVERIŤ v prod]** | nová tabuľka metadát exportu **bez definovanej retencie** |
| E5 | Limit pokusov aktivácie: `einvoice_enroll_attempts` (firma, používateľ, čas, výsledok; 30 dní) | technický log |
| E6 | Poskytovateľ doručil **novú zmluvu s novým číslom** (limit zodpovednosti 10 000 €/rok, kauzalita, výnimky vrátane čl. 82 GDPR). Rozhoduje prevádzkovateľ; technické dôsledky v `efaktura-readiness-audit-2026-11-19.md` §9 | — |
| E7 | DPA poskytovateľa (verejné, stav 12. 11., verzia `2026-11-25-v1`): ďalší sub-processori aj v USA (Railway, Vercel, Resend), Cloudflare R2, AI fallback; výmaz po ukončení + 30 dní; zálohy ≤ 4 mes.; 10 r. iba dôkaz doručenia | vstup pre zoznam sprostredkovateľov a informáciu o prenosoch pri aktivácii |
| E8 | Zistené technické medzery (nie právne otázky): trvalý dôkaz poverenia klienta, offboarding u poskytovateľa, dôkazy po ukončení firmy | pozri audit eFaktúry D-M1, D-G1, D-G2 |

Aktivácia ostáva podmienená bránou G1–G12 (vrátane oznámenia sprostredkovateľa D-15 podľa DPA 1.3 čl. 9.3).

### 2.5 Zoznam sprostredkovateľov — realita vs. dokumenty

| Poskytovateľ | Produkcia | `/subprocessors` | DPA 1.3 príl. 3 | Zásady 1.4 | Delta |
|---|---|---|---|---|---|
| Supabase Pte. Ltd. | LIVE (eu-central-1) | áno | áno | áno | — |
| Vercel Inc. | LIVE (fra1) | áno | áno | áno | — |
| OpenAI Ireland Ltd. | LIVE | áno | áno | — (sprostredkovateľ) | — |
| Google FCM | LIVE | áno | áno | áno | — |
| Anthropic PBC | servisné nástroje | áno | áno | — | — (CLIA 11. 11.) |
| Namecheap Private Email | LIVE (info@/privacy@) | áno | nie (kontext prevádzkovateľa) | áno | — |
| **Resend** | **LIVE (auth SMTP)** | **nie — text tvrdí opak** | **nie** | **nie** | **rozdiel (draft §1.1)** |
| Google (OAuth) | LIVE web + **Android** | — (zdroj, nie sprostredkovateľ) | text „vo webovom rozhraní“ | text „vo webovom rozhraní“ | **rozdiel (Android)** |
| RPO / RÚZ | LIVE (verejné registre) | — | — | interne doplnené (Q12) | — |
| Stripe | NOT LIVE (pripravené) | nie | nie | nie | pred aktiváciou |
| eFaktura s. r. o. | NOT LIVE (zmluva doručená) | nie | nie | nie | pred aktiváciou (G3/G4) |
| Google Play Billing / Apple | NOT LIVE | — | — | — | pred aktiváciou |

Formálne nezrovnalosti: `/subprocessors` uvádza „posledná aktualizácia 16. 8. 2026“ a zároveň „platí od 2026-09-09“
(`legalConfig.effectiveDate`); interný `docs/gdpr-subprocessors.md` je z augusta a neodráža CLIA stav ani Esblu s.r.o. ako prevádzkovateľa.

### 2.6 Retencia a výmaz — účet, firma, dôkazy

**Hlavná delta voči materiálom CLIA:** v reconciliation (10. 11.) bolo uvedené, že firma s účtovnými záznamami sa **nedá
zrušiť** (`ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION`) a XML v `einvoice-documents` sa **nikdy nemaže**. Od **12. 11. 2026
(produkcia, migrácia `20261112110000`)** platí **termination workflow**:

1. Owner v Nastaveniach → Zrušiť firmu → preflight zistí finalizované doklady / e-faktúry → termination panel.
2. Export (JSON + CSV + súbory po dávkach, SHA-256). Owner zvolí `exported` (a pri migrácii `20261113110000` server overí
   dokončený export ≤ 24 h) alebo **`waived` (výmaz bez exportu)**, potvrdí nevratnosť frázou.
3. Jedna DB transakcia zmaže **aj finalizované faktúry, položky, e-faktúry (`einvoice_*`) a históriu**; Storage (vrátane XML
   e-faktúr) zmaže cleanup job po commite (retry cron).
4. Ochranné triggery fungujú mimo workflow ďalej (aj pre service_role); výnimka je viazaná na `executing` riadok v tej istej transakcii.
5. **Blokuje:** aktívne predplatné; registrácia u poskytovateľa eFaktúry (`EINVOICE_PROVIDER_ENROLLED`).

**Čo po zrušení ostáva (vlastné údaje Esblu):**

| Záznam | Obsah | Lehota podľa dokumentácie | Technické vynútenie |
|---|---|---|---|
| `company_terminations` | ID firmy/ownera, stav, režim exportu (`exported`/`waived`), agregované počty, `export_run_id` | 5 r. (dôkaz zmluvného vzťahu) | **nie je v purge** → dnes neobmedzene |
| `legal_acceptance_evidence` | osoba, e-mail, verzia, čas, metóda, rola, firma (VOP/PP/DPA) | 5 r. od archivácie | v purge funkcii, **purge vypnutá** |
| `trial_claims` | SHA-256 (krajina:IČO), druh, prvá firma, obdobie trialu | ≤ 5 r. | purge od `trial_ends_at` (nie od konca vzťahu), **purge vypnutá** |
| `company_export_runs` | metadáta exportu, SHA-256 ZIP/dávok, `requested_by` | **nedefinované** | žiadna purge **[OVERIŤ, či je v prod]** |
| `billing_events`, `billing_store_reports` | platobné udalosti Esblu (bez karty/adresy) | účtovné povinnosti Esblu (Zásady: 10 r.) — pre technické záznamy bez väzby na doklad **nedefinované** | žiadna purge |
| `einvoice_enroll_attempts` | firma, user, čas, výsledok | 30 dní | v RPC (pri ďalšom pokuse tej firmy); pri zrušení firmy kaskádou zmazané (FK `on delete cascade`) |

**Zrušenie účtu (používateľ):** DB commit v jednej transakcii → Storage → `auth.admin.deleteUser` (retry cron); prijatia
dokumentov sa pred výmazom archivujú do `legal_acceptance_evidence` (CLIA Q3). Bez zmeny voči CLIA.

**Stav purge:** všetky lehoty z Q9 a J10.1 sú implementované v `esblu_gdpr_retention_purge`, ale v produkcii **nebežia**
(flag OFF; read-only precheck 11. 11.: prvý beh by zmazal 36 technických riadkov). Kým prevádzkovateľ purge nezapne,
technická retencia je **dlhšia** ako v Zásadách 1.4 pri kategóriách push/pozvánky/technické logy.

### 2.7 Účtovná archivácia faktúr

| Kategória | Rola Esblu | Technický stav | Delta voči CLIA |
|---|---|---|---|
| Faktúry a e-faktúry **zákazníka** (vydané/prijaté v Esblu) | sprostredkovateľ | finalizované doklady nemenné; originál XML byte-identický + SHA-256; Esblu **nie je zákonný archív** (VOP 21.3, 22.6); export ZIP/CSV/JSON; **výmaz možný v termination** po exporte alebo s `waived` | áno — predtým „zrušenie blokované / XML sa nikdy nemaže“ |
| Doklady **Esblu** (predaj predplatného) | prevádzkovateľ | dnes žiadne v produkcii (billing OFF); plánovaný zdroj = Stripe Invoice alebo vlastný doklad Esblu (otvorené) | nové (pred aktiváciou Stripe) |
| Platobné záznamy Esblu (`billing_events`) | prevádzkovateľ | prežijú zrušenie firmy (SET NULL), bez lehoty | nové |
| Testovacie „faktúry“ z vývoja v produkcii | — | prevádzkovateľ 19. 11. rozhodol, že FA20260001/TEST-2026-002 nie sú účtovné doklady a odstránia sa s testovacou firmou (zatiaľ nevykonané) | iba na vedomie, nie otázka pre CLIA |

Zálohy: Supabase denné zálohy 7 dní, PITR vypnuté; **Storage (súbory, XML) nie je súčasťou DB zálohy** — bez zmeny voči CLIA.

## 3. Návrhy zmien znení — **DRAFT, na kontrolu prevádzkovateľom (neodoslané, nezverejnené)**

> Všetky texty nižšie sú pracovné návrhy pre rozhodnutie prevádzkovateľa a prípadné posúdenie CLIA. Nie sú právnym
> stanoviskom. VOP sa netýkajú.

**DRAFT-1 — Zásady, „Zasielanie prevádzkových a autentifikačných oznámení“, Kategórie príjemcov (doplnenie):**
> „… najmä Supabase Pte. Ltd. a Vercel Inc. Autentifikačné e-maily (najmä potvrdenie registrácie a obnova hesla) odosiela
> poskytovateľ e-mailových služieb Resend ([právnická osoba a krajina — doplní prevádzkovateľ podľa zmluvy]) prostredníctvom domény mail.esblu.com.“
> *(Presný názov právnickej osoby, región a mechanizmus prenosu doplní prevádzkovateľ podľa zmluvy/DPA Resend.)*

**DRAFT-2 — Zásady aj DPA 1.3, Google prihlásenie:**
> „… pričom prihlasovanie cez Google je dostupné vo webovom rozhraní aj v mobilnej aplikácii Esblu.“

**DRAFT-3 — `/subprocessors`, nahradenie historickej poznámky o Resend:**
> „Resend — odosielanie autentifikačných e-mailov (potvrdenie registrácie, obnova hesla) z domény mail.esblu.com od
> [dátum doplní prevádzkovateľ]. Údaje: e-mailová adresa príjemcu, obsah e-mailu s jednorazovým odkazom, metadáta doručenia.
> Miesto spracúvania: [región]; prenosy: [DPF/SCC].“ + zjednotiť dátum „Posledná aktualizácia“ s dátumom účinnosti.

**DRAFT-4 — Zásady, nový účel „Platby a správa predplatného“ (iba ak sa Stripe aktivuje):**
> „**Účel spracúvania:** spracovanie platieb za predplatné, správa predplatného, vrátenie platieb a riešenie sporov.
> **Kategória osobných údajov:** identifikátor zákazníka a predplatného u platobnej služby, údaje o platbách, sumách, období,
> krajine fakturačnej adresy, refundáciách a sporoch. Údaje platobnej karty Spoločnosť neprijíma ani neukladá; zadávajú sa
> priamo platobnej službe. **Kategórie príjemcov:** Stripe [entita doplní prevádzkovateľ] … **Lehota:** [doplní prevádzkovateľ
> po porade s účtovníčkou a CLIA].“ *(Rola Stripe — sprostredkovateľ vs. samostatný prevádzkovateľ — je otázka v drafte 24. 11. §3.2 bod 2.)*

**DRAFT-5 — `/zrusenie-uctu`, sekcia „Čo sa zmaže“ (zosúladenie s termination workflow):**
> „Pri zrušení firmy, ktorá má finalizované účtovné doklady alebo elektronické faktúry, Vám aplikácia najprv ponúkne export
> všetkých údajov a súborov. Doklady sa zmažú až po Vašom potvrdení, že ste export prevzali, alebo že export nepožadujete.
> Uchovávanie účtovných dokladov počas zákonných lehôt zabezpečuje Zákazník. Spoločnosť si ponechá iba záznam o ukončení
> (bez obsahu dokladov), dôkaz o prijatí zmluvných dokumentov a vlastné záznamy o platbách za predplatné počas lehôt
> uvedených v Zásadách ochrany osobných údajov.“

**DRAFT-6 — DPA príloha 3 + Zásady + `/subprocessors`, eFaktura.sk (až po podpise zmluvy a overení jej Prílohy 2):**
> „eFaktura s. r. o., [sídlo, IČO z novej zmluvy č. …] — prenos elektronických faktúr v sieti Peppol, registrácia Zákazníka
> u poskytovateľa doručovacej služby, príjem dokladov. Údaje: obsah elektronických faktúr, identifikačné a kontaktné údaje
> odberateľov a dodávateľov, Peppol identifikátory. Miesto spracúvania a ďalší sprostredkovatelia: [podľa DPA poskytovateľa].“

**DRAFT-7 — interný register (nie verejný):** aktualizovať `docs/gdpr-subprocessors.md` (Esblu s.r.o. ako prevádzkovateľ,
Resend LIVE, Anthropic, FCM, RPO/RÚZ, plánovaní: Stripe, eFaktura.sk) a doplniť retenciu `company_terminations`,
`company_export_runs`, `billing_events` do retenčnej politiky.

## 4. Nové otázky pre CLIA (iba technicky nové; vyriešené sa neotvárajú)

1. **Termination s `waived`:** je pre Esblu ako sprostredkovateľa postačujúce, že owner potvrdí výmaz účtovných dokladov bez
   exportu (pokyn prevádzkovateľa podľa DPA o vrátení/výmaze), alebo má Esblu vyžadovať export / dodatočné upozornenie?
   (Technicky: dôkaz voľby je v `company_terminations.export_mode`.)
2. **Lehoty pre vlastné technické záznamy Esblu** bez definovanej retencie: `company_terminations` (doc 5 r., nevynútené),
   `company_export_runs`, `billing_events`/`billing_store_reports` mimo účtovných dokladov — potvrdiť lehotu a účel.
3. **eFaktúra — dôkazy po ukončení firmy:** je prípustné ponechať minimálny pseudonymizovaný záznam prenosov (ID u poskytovateľa,
   hash dokladu, časy, stav, bez obsahu) na účel ochrany právnych nárokov Esblu (existujúci účel, 5 r.) — v súvislosti s novou
   zmluvou poskytovateľa (kauzalita)? Ak áno, či to treba uviesť v Zásadách/DPA.
4. **eFaktúra — evidencia poverenia klienta** (kto aktivoval príjem, kedy, s akým vyhlásením; bez FS kódu): spadá pod účel
   „Správa zmluvného vzťahu“ (5 r.), alebo je to údaj spracúvaný v mene Zákazníka?
5. **Stripe z Android appky** (webový Checkout v in-app prehliadači): treba v Zásadách rozlišovať platbu na webe a v appke,
   ak je príjemca rovnaký (Stripe)?

## 5. Overenia pre prevádzkovateľa pred odoslaním CLIA

| # | Overenie | Prečo |
|---|---|---|
| V1 | Resend: dátum prvého odoslania, región, DPA | doplniť DRAFT-1/3 |
| V2 | Či sú v produkcii migrácie `20261113100000` a `20261113110000` (read-only `schema_migrations`) | E4, 2.6 |
| V3 | Stripe entita (Stripe Payments Europe Ltd.?) z účtu/dokladu | DRAFT-4 |
| V4 | Číslo a dátum novej zmluvy eFaktura.sk, text Prílohy 2 (DPA) | DRAFT-6 |
| V5 | Či `info@`/`privacy@` nie sú presmerované na Gmail (P4) | Q11 OWNER verify |
| V6 | Rozhodnutie o zapnutí retenčnej purge (P3) | 2.6 |

## 6. Čo sa zámerne neotvára

Q1–Q14 (11. 11.), Anthropic ako sprostredkovateľ, cookies bez lišty, preklady EN/DE, DPA elektronicky, `trial_claims` ≤ 5 r.,
otázky eFaktúry, ktoré CLIA už vyriešila (rola eFaktura.sk ako ďalšieho sprostredkovateľa, model PFS → overovací kód,
koncept ≠ zaúčtovanie, Esblu nie je AP/archív), VOP (vrátane predplatného, 48 h ochrannej lehoty a refundácií — patria inému
posúdeniu).
