# Esblu — Compliance delta: rola ÚČTOVNÍK a riadenie prístupu

**Dátum:** 2026-09-22
**Účel:** podklad pre externý právny / GDPR review (CLIA)
**Stav:** interný pracovný dokument
**Nadväzuje na:** `docs/invoicing-compliance-delta-for-clia.md`

---

## ⚠️ Čo tento dokument NIE JE

- **Nie je** právne stanovisko.
- **Nie je** návrh zmien Privacy Policy, Terms, DPA, Cookies ani zoznamu subprocesorov.
- **Nie je** schválenie čohokoľvek.

**Verejné právne stránky sa touto zmenou nemenia.** Dokument zaznamenáva zmenu v riadení prístupu k už existujúcim údajom, aby mal právny tím úplný vstup.

---

## 1. Zhrnutie pre právny tím

Pribudla štvrtá rola používateľa: **`accountant` (účtovník)**.

Zmena **nezavádza žiadnu novú kategóriu osobných údajov** ani nový účel spracúvania. Nemení sa ani rozsah zbieraných údajov, ani retencia, ani zoznam subprocesorov. Mení sa **iba to, kto z existujúcich údajov čo vidí** — a to smerom k prísnejšiemu oddeleniu.

Z pohľadu GDPR ide o opatrenie podľa čl. 32 (zabezpečenie spracúvania), konkrétne o uplatnenie zásady **minimalizácie prístupu**, nie o nové spracúvanie podľa čl. 6.

---

## 2. Postavenie účtovníka

Účtovník je **company-internal authorized user** — člen firmy zákazníka (`company_members`), nie samostatný príjemca údajov a nie ďalší sprostredkovateľ. Platí pre neho presne ten istý vzťah prevádzkovateľ – sprostredkovateľ ako pre ostatné role: **prevádzkovateľom zostáva zákazník, Esblu zostáva sprostredkovateľom.**

Praktický scenár: externá účtovníčka, ktorej firma potrebuje sprístupniť doklady, ale nie prevádzkovú evidenciu majetku. Ak je takáto osoba zmluvne treťou stranou voči zákazníkovi, vzťah medzi ňou a zákazníkom **rieši zákazník**, nie Esblu — Esblu len poskytuje technický prostriedok na obmedzenie jej prístupu.

**Poznámka pre právny tím:** práve preto považujeme túto zmenu za posilnenie pozície zákazníka ako prevádzkovateľa. Doteraz musel externej účtovníčke dať rolu `employee` s finančným oprávnením, čím jej zároveň sprístupnil celý prevádzkový denník firmy. To bol reálny nadbytočný prístup.

---

## 3. Ku ktorým kategóriám údajov má účtovník prístup

### 3.1 Má prístup

| Kategória | Tabuľky | Obsahuje osobné údaje? |
|---|---|---|
| Faktúry vydané a prijaté | `invoices`, `invoice_items`, `invoice_parties`, `invoice_tax_breakdowns`, `invoice_payments`, `invoice_events` | Áno — pri SZČO/fyzickej osobe sú fakturačné údaje osobnými údajmi |
| Obchodní partneri | `business_partners` | Áno — meno, adresa, e-mail, telefón, identifikátory |
| Fakturačný profil firmy | `company_billing_profile` | Áno — údaje o zákazníkovi |
| Finančne citlivé doklady | `documents` s `document_type in ('invoice','receipt')` a ich prílohy | Áno — obsah dokladu |
| Vlastné zložky dokladov | `custom_document_categories` | Nie (iba názvy zložiek) |

Rozsah je zhodný s tým, čo doteraz mala osoba s `permissions.finance` — **nič sa nerozširuje**.

### 3.2 Nemá prístup

Od migrácie `20260923100000` účtovník **nevidí vôbec**:

`vehicles`, `machines`, `inventory_items`, `vehicle_services`, `machine_services`, `vehicle_photos`, `machine_photos`, `inventory_photos`, `vehicle_vignettes`, `ai_evidence` (vážne lístky a dodacie listy).

Nemá ani správu členov firmy, pozvánky, role, oprávnenia, DPA gate ani mazanie firmy — tie zostávajú majiteľovi, resp. majiteľovi a správcovi.

### 3.3 Minimálny resolver identifikátorov — jediná výnimka

Doklad sa môže odvolávať na vozidlo alebo stroj. Aby účtovník videl, **o ktorú entitu ide**, existuje jediná úzka cesta: RPC `esblu_document_entity_labels()`.

**Vracia:** typ entity, jej `id` a **jeden zobraziteľný reťazec** (napr. `BA123AB — Škoda Octavia`).

**Nevracia:** VIN, rok výroby, palivo, výkon, termíny STK/EK, sériové čísla, kategórie, poznámky, ceny, servisné záznamy, fotografie.

**Obmedzenie rozsahu:** vracia iba entity, na ktoré sa odvoláva doklad, ktorý volajúci **smie čítať**. Nie zoznam vozidiel firmy — len tie, ktoré sú naviazané na jeho doklady. Funkcia je `SECURITY DEFINER`, a preto si vnútri sama overuje firmu volajúceho **aj** čitateľnosť naviazaného dokladu; bez tejto dvojitej kontroly by išlo o tunel okolo RLS.

**Dopad na minimalizáciu:** účtovník sa o prevádzkovom majetku firmy dozvie presne toľko, koľko už aj tak stojí na doklade, ktorý spracúva.

---

## 4. Sprísnenie prístupu zamestnanca

Zamestnancovi (`employee`) sa finančné údaje odopierajú **tvrdo**, teda pred čítaním `permissions`. Doteraz platilo, že zamestnanec financie nemá, ale iba preto, že `company_members` nemá klientsky zapisovateľnú politiku — teda zhodou okolností konfigurácie, nie pravidlom. Od migrácie `20260922100000` je to pravidlo: aj keby sa mu do `permissions` čokoľvek zapísalo, finančné funkcie vrátia `false`.

To isté platí pre hlasové ovládanie — viď bod 6.

---

## 5. Kde je prístup vynútený

| Vrstva | Mechanizmus |
|---|---|
| Databáza | RLS policies nad každou dotknutou tabuľkou |
| Rozhodovacia logika | `esblu_my_finance_view/manage()`, `esblu_has_finance_*_in_company()`, `esblu_role_can_operate()` — všetky `SECURITY DEFINER`, `search_path` prázdny |
| Server (API) | user-scoped Supabase klient s bearer tokenom volajúceho; **service_role sa na tieto cesty nepoužíva** |
| Klient | skrytie modulov a route guardy — **iba pohodlie, nie autorizácia** |

Klientska vrstva je zámerne uvedená ako posledná a označená ako nezáväzná: obísť sa dá, databázová vrstva nie.

**Overenie:** 20 testov rolových funkcií a 25 testov nad reálnymi RLS politikami proti produkčnej databáze, všetko v rollbacknutých transakciách a výhradne na syntetických dátach. Testované role: majiteľ, správca bez oprávnenia, správca s oprávnením, účtovník, zamestnanec, **zamestnanec s podvrhnutými finančnými oprávneniami**, cudzí tenant, neprihlásený používateľ.

---

## 6. Hlasové ovládanie a role

Hlasové ovládanie **nemá vlastnú autorizačnú cestu**. Prepis reči sa zapisuje do toho istého vstupu ako klávesnica a ďalej ide rovnakým reťazcom: intent → server → user-scoped klient → RLS.

Z toho vyplýva:

- účtovník hlasom nedosiahne na prevádzkové moduly, lebo mu ich nevracia databáza;
- zamestnanec hlasom nedosiahne na faktúry ani obchodných partnerov z rovnakého dôvodu;
- rizikové operácie (zmazanie zložky, hromadný presun) vyžadujú HMAC-podpísané potvrdenie, ktoré sa dá uplatniť **práve raz**;
- hlas nikdy nepoužíva `service_role`.

**Audio sa neukladá.** Nahrávka ide do prepisu a zaniká v pamäti; do databázy sa nezapisuje ani zvuk, ani prepis.

---

## 7. Čo si zaslúži pozornosť právneho tímu

1. **Postavenie externej účtovníčky.** Ak zákazník dá rolu `accountant` osobe mimo svojej organizácie, vzniká vzťah medzi ním a ňou. Esblu doň nevstupuje, ale stojí za zváženie, či to má byť spomenuté v dokumentácii pre zákazníka.
2. **Rozsah resolvera.** Domnievame sa, že „ŠPZ a značka vozidla uvedeného na doklade“ je primerané minimum. Ak by právny tím považoval aj to za nadbytočné, dá sa zúžiť na samotné ŠPZ.
3. **Retencia sa nemení.** Rola neovplyvňuje, ako dlho sa údaje uchovávajú.

---

## 8. Čo sa NEMENILO

- Privacy Policy, Terms, DPA, Cookies, zoznam subprocesorov — **bez zmeny**.
- Rozsah zbieraných údajov — **bez zmeny**.
- Účely spracúvania — **bez zmeny**.
- Retencia — **bez zmeny**.
- Subprocesori — **bez zmeny**.

---

## 9. Migrácie, ktorých sa dokument týka

| Migrácia | Obsah |
|---|---|
| `20260922100000_add_accountant_role_and_scope_gates.sql` | rola `accountant`, tvrdé odopretie financií zamestnancovi, prevádzkový gate, rozšírenie allowlistu potvrdzovaných akcií |
| `20260923100000_accountant_least_privilege_entity_resolver.sql` | odopretie čítania prevádzkových tabuliek účtovníkovi, minimálny resolver označení entít |
