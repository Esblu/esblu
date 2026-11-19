# CLIA — technický briefing: nesúlad pri ukončení firmy (výmaz účtovných dokladov) a návrh nápravy (2026-11-19)

> **DRAFT — interný technický podklad. Neodosielať CLIA ani nikomu inému bez schválenia prevádzkovateľom.**
> Nie je to právne stanovisko. Všetky navrhované znenia (časť 5) sú **DRAFT**. VOP sú mimo rozsahu CLIA a uvádzajú sa
> iba tam, kde je to nutné na pochopenie GDPR dopadu.

**Vzťah k iným podkladom:** dopĺňa `docs/audits/clia-technical-delta-2026-11-19.md` (§2.6, §2.7, otázka 4.1, DRAFT-5) —
neopakuje ho. Tento dokument **nahrádza DRAFT-5** z delty (text „doklady sa zmažú…“ by po náprave nebol pravdivý) a
**rozširuje otázku 4.1**. Technický návrh: `docs/retention-archive-design-2026-11-19.md`.

---

## 1. Čo CLIA dostala (stav 10.–11. 11. 2026)

V reconciliation (`docs/clia-gdpr-reconciliation-2026-11-10.md`, riadky „účtovné záznamy“ a „účtovné/eInvoice guardy“):

- účtovné záznamy: 10 r.; finalizované faktúry nemenné; **zrušenie firmy blokované** (`ESBLU_ACCOUNTING_RECORDS_BLOCK_DELETION`);
- `einvoice-documents` (XML e-faktúr) **sa nikdy nemaže**; firma s účtovnými záznamami **sa nedá zrušiť**.

## 2. Skutočný stav produkcie od 12. 11. 2026 (nesúlad)

Migrácia `20261112110000_company_termination_workflow` (produkcia od 12. 11. 2026, VOP 1.2 čl. 20.6) zaviedla
samoobslužné ukončenie firmy s dokladmi:

1. Owner → Nastavenia → Zrušiť firmu → export (alebo **`waived` = bez exportu**) → potvrdenie frázou.
2. `esblu_company_termination_commit` v jednej transakcii **zmaže**: finalizované faktúry, dobropisy, položky, strany
   (odberateľ/dodávateľ), rozpis DPH, úhrady, históriu dokladu, zálohy a ich odpočty, stav zaúčtovania, e-faktúry
   (odoslané aj prijaté), **históriu doručenia e-faktúr** (`einvoice_events`), **záznamy o odovzdaní účtovníkovi**
   (kaskádou) a sken prijatej faktúry.
3. Cleanup job po commite zmaže zo Storage aj **XML e-faktúr** (`einvoice-documents`) a skeny.
4. V Esblu ostane iba `company_terminations` (ID firmy/ownera, režim exportu, agregované počty — bez obsahu dokladov)
   a pri `exported` metadáta exportu (`company_export_runs`).

**Rozdiel voči CLIA:** (a) zrušenie firmy s dokladmi už nie je blokované; (b) XML e-faktúr sa maže; (c) pri `waived`
nemusí existovať žiadna kópia dokladov ani u zákazníka, ani v Esblu.

**Skutočné použitie v produkcii (read-only záznamy do 19. 11.):** workflow nebol použitý na skutočné doklady zákazníka.
Jediné plánované použitie je schválené vyčistenie **syntetických testovacích dát** (5 testovacích firiem; v jednej z nich
2 testovacie „faktúry“, ktoré prevádzkovateľ 19. 11. vyhlásil za neúčtovné) — `prod-cleanup-and-operator-plan-2026-11-19.md`.
**[OVERIŤ]** prevádzkovateľ: read-only `select termination_mode, export_mode, status, count(*) from company_terminations group by 1,2,3`
pred odoslaním.

## 3. Náprava (implementovaná na vetve, NENASADENÁ)

Migrácia `20261121100000_retention_archive_company_termination` (+ rollback, testy):

| Oblasť | Po náprave |
|---|---|
| Bežné ukončenie firmy (`exported` aj `waived`) | doklady a dôkazy sa **nemažú** — v tej istej transakcii sa presunú do oddeleného **retenčného archívu** (`esblu_retention`), až potom sa firma a ostatné údaje zmažú |
| Čo sa archivuje | finalizované faktúry + položky/strany/DPH/úhrady/história/zálohy/stav zaúčtovania; originál prijatej faktúry (sken) vrátane súboru; e-faktúry vrátane XML a SHA-256; história doručenia; metadáta odovzdaní účtovníkovi; identita firmy (názov, IČO, DIČ, IČ DPH, adresa) |
| Čo sa maže ako doteraz | používateľské účty (ak o to owner požiada), členstvá, pozvánky, chat, vozidlá/stroje/sklad, fotky, neúčtovné dokumenty, AI výstupy, koncepty faktúr |
| Minimalizácia | archív neobsahuje ID používateľov (kto vystavil, kto zaznamenal úhradu…), AI výstupy, e-mail ani IBAN firmy; nemá väzbu na účty; ostáva iba obsah dokladu |
| Prístup | zákazník (owner/admin/zamestnanec/účtovník), iné firmy ani verejnosť **nemajú** prístup; schéma nie je v API; čítanie/export iba operátor cez funkcie s povinnou referenciou a účelom; **každý prístup v append-only logu** |
| Lehoty | konfigurovateľná tabuľka po kategóriách; **návrh 10 r. po roku dokladu** (stav PROPOSED, neschválené) |
| Automatický výmaz po lehote | funkcia s dry-run, mazanie iba schválených lehôt, **legal hold** blokuje výmaz, každý beh auditovaný; **nenaplánovaná** |
| Výnimka | výmaz bez archívu iba pre syntetické testovacie dáta: samostatná funkcia, iba administrátor DB (nie aplikácia), povinná referencia schválenia + odôvodnenie, zapísané v audite |

Nasadenie je podmienené schválením prevádzkovateľa a úpravou textov (časť 5), aby UI nesľubovalo výmaz.

## 4. Otázky pre CLIA

1. **Právny základ uchovávania (kľúčová otázka).** Pri dokladoch zákazníka je Esblu sprostredkovateľ; DPA a čl. 28 ods. 3
   písm. g) GDPR predpokladajú po skončení služieb vrátenie alebo výmaz, *pokiaľ právo Únie alebo členského štátu
   nevyžaduje uchovávanie*. Povinnosť uchovávať účtovné záznamy (z. 431/2002 § 35) a faktúry (z. 222/2004 § 76) má
   zákazník ako účtovná jednotka / platiteľ. Môže / musí Esblu po ukončení zmluvy držať archív dokladov? Ak áno, na akom
   základe — (a) pokyn zákazníka v DPA/VOP (archív ako súčasť služby), (b) vlastný oprávnený záujem Esblu (preukázanie
   plnenia, právne nároky — najmä pri e-faktúrach a dôkazoch doručenia), (c) zákonná povinnosť? Ak nie, je správny
   pôvodný stav (výmaz po exporte) a nesúlad je iba v informáciách poskytnutých CLIA?
2. **Režim `waived`:** ak sa archív potvrdí, má zákazník mať možnosť žiadať okamžitý výmaz aj dokladov (napr. pri
   doložení, že ich uchováva inde), alebo archív platí vždy?
3. **Lehoty:** je 10 rokov od konca roka dokladu správna lehota pre všetky kategórie (vrátane histórie doručenia
   e-faktúr a záznamov o odovzdaní účtovníkovi), alebo pre časť z nich postačuje 5 r. (dôkaz zmluvného vzťahu)?
4. **Fyzické osoby na dokladoch** (SZČO, kontaktné údaje strán): postačuje odstrániť väzby na používateľov Esblu, alebo
   treba ďalšiu pseudonymizáciu? (Technicky by narušila obsah dokladu.)
5. **Výdaj z archívu:** komu a na základe čoho môže Esblu vydať doklady zaniknutej firmy (zákazník po ukončení, jeho
   účtovník, správca dane, likvidátor, súd)? Treba overovať totožnosť / oprávnenie a ako?
6. **Informovanie:** treba o uchovaní dokladov po ukončení informovať v Zásadách / DPA / pri ukončení v aplikácii, a v akom
   rozsahu (návrhy v časti 5)?
7. **Historické ukončenia** (ak by nejaké s reálnymi dokladmi existovali — podľa časti 2 zatiaľ nie): treba ich riešiť
   (oznámenie zákazníkovi), keď doklady už neexistujú?

## 5. Návrhy znení — **DRAFT, iba po schválení prevádzkovateľom**

> Pracovné návrhy pre rozhodnutie prevádzkovateľa a posúdenie CLIA. Platia iba ak CLIA potvrdí otázku 4.1 v prospech
> archívu. Neodosielať, nezverejňovať, nenasadzovať do UI bez schválenia.

**DRAFT-R1 — `/zrusenie-uctu`, „Čo sa stane s dokladmi“ (nahrádza DRAFT-5 z technickej delty):**
> „Pri ukončení firmy, ktorá má finalizované účtovné doklady alebo elektronické faktúry, Vám aplikácia najprv ponúkne
> export všetkých údajov a súborov. Po ukončení sa údaje firmy a používateľov vymažú. Účtovné doklady, elektronické
> faktúry a záznamy o ich doručení Spoločnosť uchová v oddelenom archíve bez prístupu z aplikácie počas [lehota — doplní
> prevádzkovateľ po stanovisku CLIA] a potom ich vymaže. Z archívu sa doklady vydávajú iba na základe preukázanej žiadosti
> [okruh oprávnených — doplní prevádzkovateľ].“

**DRAFT-R2 — UI ukončenia firmy (`settings.termination`, SK; EN/DE preložiť po schválení):**
> - `intro`: „Firma obsahuje finalizované účtovné doklady alebo e-faktúry. Ako vlastník môžete firmu ukončiť. Údaje firmy
>   a používateľov sa vymažú; účtovné doklady a e-faktúry sa presunú do uzavretého archívu, kde sa uchovajú počas
>   zákonnej lehoty a potom sa vymažú.“
> - `waived`: „Export nepotrebujem.“
> - `acknowledge`: „Rozumiem, že ukončenie je nevratné a k dokladom v archíve už nebudem mať prístup z aplikácie.
>   Esblu nie je zákonný archív; za uchovávanie dokladov podľa zákona zodpovedá firma.“
> - `submit`: „Ukončiť firmu“

**DRAFT-R3 — Zásady ochrany osobných údajov, účel „Uchovávanie účtovných dokladov po ukončení služby“:**
> „**Účel:** uchovanie účtovných dokladov, elektronických faktúr a záznamov o ich doručení po ukončení používania
> služby Zákazníkom. **Právny základ:** [doplní prevádzkovateľ podľa stanoviska CLIA — pokyn Zákazníka / oprávnený
> záujem / zákonná povinnosť]. **Kategórie údajov:** údaje uvedené na dokladoch (identifikačné a kontaktné údaje
> dodávateľa a odberateľa, údaje o plnení a platbách). **Lehota:** [doplní prevádzkovateľ]. **Príjemcovia:** iba na
> preukázanú žiadosť oprávnených osôb a orgánov.“

**DRAFT-R4 — DPA, článok o skončení spracúvania (doplnenie):**
> „Ak Prevádzkovateľ neurčí inak a ak to vyžaduje [právny predpis / dohoda — doplní prevádzkovateľ], Sprostredkovateľ
> po skončení služieb uchová účtovné doklady a elektronické faktúry Prevádzkovateľa v oddelenom archíve s obmedzeným
> prístupom počas [lehota] a potom ich vymaže; ostatné osobné údaje vymaže podľa čl. [x].“

## 6. Čo sa zámerne neotvára

Q1–Q14 (11. 11.), otázky eFaktúry vyriešené CLIA (rola eFaktura.sk, PFS, koncept ≠ zaúčtovanie, Esblu nie je AP),
VOP mimo GDPR dopadu, Stripe/Resend/Google (riešené v technickej delte).

## 7. Overenia pre prevádzkovateľa pred odoslaním

| # | Overenie |
|---|---|
| R-V1 | Read-only počet `company_terminations` podľa `export_mode` / `status` v produkcii (či existuje ukončenie s reálnymi dokladmi). |
| R-V2 | Vyčistenie syntetických dát 19. 11. zapísané v `docs/ops/service-intervention-log.md` (s referenciou rozhodnutia). |
| R-V3 | Rozhodnutie, či sa náprava nasadí pred odpoveďou CLIA (odporúčanie: áno — archív je bezpečnejší default; výmaz archívu je možný neskôr, obnova zmazaného nie). |
| R-V4 | Schválenie textov R1–R4 až po stanovisku CLIA; dovtedy nenasadzovať migráciu bez úpravy UI textov (inak UI sľubuje výmaz). |
