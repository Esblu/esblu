# Esblu — Smart Dashboard: návrh

**Dátum:** 2026-09-20
**Stav:** NÁVRH
**Základné pravidlo:** **read-only intelligence. Nič proaktívne nezapisuje.**

---

## 1. Čo to je

Jedna obrazovka, ktorá odpovedá na otázku: **„Čo mám dnes riešiť?"**

Nie graf obratu. Nie KPI dlaždice. **Prioritizovaný zoznam vecí, ktoré si vyžadujú akciu.**

Priamo napĺňa hlavné produktové pravidlo zo zadania:

> otvorím Esblu → **vidím čo treba riešiť** → odfotím alebo poviem čo chcem → Esblu nájde správne firemné dáta → pripraví bezpečnú akciu → potvrdím

Dashboard je prvý krok tohto reťazca a dnes chýba.

## 2. Prečo je to differentiator

Z konkurenčného auditu:

- **iDoklad** — dashboard s obratom, po splatnosti, grafmi po mesiacoch. Klasický finančný prehľad.
- **AI BOS** — AI týždenné zhrnutie, rebríček hodín, rozloženie úloh. Najbližšie k tomuto konceptu, ale sústredené na čas a projekty.
- **Stavario** — reporty z dochádzky, denníka a skladov v reálnom čase.
- **POHODA / KROS** — Business Intelligence ako platený doplnok. Analytický nástroj, nie denný prehľad.

**Nikto nemá prioritizovaný zoznam „čo treba riešiť" naprieč faktúrami, vozidlami, strojmi, skladom a Inboxom.**

To je preto, že nikto z nich tie agendy nemá súčasne. Esblu ich má — a to je presne dôvod, prečo je tento dashboard pre Esblu prirodzený a pre nich nie.

## 3. Obsah — čo sa zobrazuje

### 3.1 Faktúry po splatnosti
```
invoices
  where direction='issued'
    and document_status='finalized'
    and payment_status <> 'paid'
    and due_date < current_date
  order by due_date asc
```
Priorita podľa počtu dní po splatnosti a sumy.
🔒 Vyžaduje `finance.view`.

### 3.2 Prijaté faktúry pred splatnosťou
```
  where direction='received'
    and payment_status <> 'paid'
    and due_date between current_date and current_date + 7
```
„Čo musím zaplatiť tento týždeň."
🔒 Vyžaduje `finance.view`.

### 3.3 Blížiace sa termíny vozidiel
STK, EK, PZP, diaľničné známky z `vehicle_services` a `vehicle_vignettes`.
Okno: 30 dní. Po expirácii vyššia priorita.

### 3.4 Stroje pred servisom
Z `machine_services` — plánovaný servis, revízia, kontrola.
Okno: 30 dní.

### 3.5 Sklad pod minimom
`inventory_items` pod definovaným minimom.
⚠️ **Dnes `inventory_items` minimum pravdepodobne neeviduje** — treba overiť, prípadne doplniť `min_quantity` stĺpec. Do tej doby tento blok vynechať, nie improvizovať.

### 3.6 Inbox čaká na review
`documents` so `status` v stave čakajúcom na spracovanie a `deleted_at is null`.
Zvýraznené tie, ktoré vyzerajú ako faktúra.

### 3.7 eFaktúra — chyby a stavy
**Až po Fáze F/H.** Neúspešné odoslania, odmietnuté doklady, doklady čakajúce na potvrdenie doručenia.

### 3.8 Urgentné termíny z deadline engine
Existujúci deadline engine — všetko ostatné, čo má termín.

## 4. Čo dashboard NEROBÍ

❌ **Nezapisuje nič.** Žiadny auto-fix, žiadne auto-označenie ako prečítané, žiadne automatické vytváranie úloh.
❌ **Neposiela notifikácie** (to je samostatná funkcia s vlastným súhlasom a vlastnými pravidlami).
❌ **Nerozhoduje** o tom, či je faktúra naozaj nezaplatená — zobrazuje stav, ktorý je v DB.
❌ **Nepoužíva AI na generovanie odporúčaní.** Pravidlá sú deterministické a vysvetliteľné.

**Prečo posledný bod:** ak dashboard povie „zaplať faktúru Novákovi", používateľ musí vedieť presne prečo. Deterministické pravidlo „splatnosť bola pred 12 dňami" je overiteľné. AI zhrnutie nie je.

To neznamená, že AI tu nikdy nebude — ale AI vrstva patrí **nad** deterministický základ, ako voliteľné zhrnutie, nie namiesto neho.

## 5. Bezpečnosť — najdôležitejšia časť návrhu

Dashboard agreguje naprieč **všetkými** agendami. To z neho robí **najrizikovejšiu obrazovku v aplikácii** z hľadiska úniku dát.

### Pravidlá

1. **Každý blok kontroluje oprávnenie samostatne.**
   Používateľ bez `finance.view` nevidí bloky 3.1, 3.2 a 3.7 — **a nevidí ani to, že existujú.** Žiadne „máte 3 faktúry po splatnosti (nemáte oprávnenie zobraziť)". Taká správa je sama osebe únik informácie.

2. **Company scope v každom dotaze.**
   Žiadna agregácia nesmie siahnuť mimo `esblu_my_active_company_id()`.

3. **Žiadny service_role → load all → filter v aplikácii.**
   Toto je presne ten typ obrazovky, kde je pokušenie načítať všetko jedným dotazom a filtrovať v JS. **Nerobiť to.** Každý blok je vlastný dotaz pod RLS.

4. **Počty rešpektujú RLS.**
   Ak sa zobrazuje „5 vecí na riešenie", tých 5 musí byť 5 vecí, ktoré ten konkrétny používateľ smie vidieť.

5. **Žiadny agregačný endpoint s elevated právami.**
   Ak sa neskôr pridá materializovaná view alebo cache pre výkon, musí byť company-scoped a pod RLS, nie globálna.

## 6. Prioritizácia

Jednoduchá, deterministická, vysvetliteľná:

| Úroveň | Kritérium |
|---|---|
| 🔴 **Urgentné** | po splatnosti / po expirácii / prepadnuté |
| 🟠 **Tento týždeň** | do 7 dní |
| 🟡 **Tento mesiac** | do 30 dní |
| ⚪ **Informatívne** | Inbox čaká, sklad pod minimom |

Sekundárne radenie: suma zostupne pri finančných položkách, dátum vzostupne pri termínoch.

**Bez skórovacieho algoritmu.** Používateľ musí vedieť, prečo je niečo hore.

## 7. Mobil

Dashboard je **primárne mobilná obrazovka.** Majiteľ ho otvorí v aute pred stavbou, nie za stolom.

- Jeden stĺpec, karty zhora nadol podľa priority
- Prvé dve položky viditeľné bez scrollovania
- Tap na položku → priamo na detail
- Žiadne grafy na mobile (na desktope voliteľne)

## 8. Kedy to stavať

**Po Fáze B (prijaté faktúry).** Skôr by bol dashboard poloprázdny — bez prijatých faktúr chýba polovica obsahu bloku „čo musím zaplatiť".

**Blok 3.7 (eFaktúra) až po Fáze F/H.**

**Blok 3.5 (sklad) až po overení, či `inventory_items` eviduje minimum.**

Zvyšok (3.1, 3.3, 3.4, 3.6, 3.8) sa dá postaviť z dnešných dát a je to relatívne lacné — väčšina dotazov je jednoduchá a deadline engine už existuje.

## 9. Vzťah k hlasu

Dashboard a Voice Action Orchestrator sú dve strany tej istej mince:

- **Dashboard** odpovedá na „čo treba riešiť" **vizuálne**
- **Hlas Fáza 1 (read-only)** odpovedá na to isté **hlasom**

Oba čítajú tie isté deterministické pravidlá. Ak sa pravidlá napíšu raz a poriadne, hlasová vrstva ich len prečíta nahlas — bez duplikovania logiky.

**Odporúčanie:** pravidlá implementovať ako samostatnú vrstvu (napr. `lib/attention-rules`), nie priamo v dashboard komponente. Dashboard aj orchestrátor ju potom zdieľajú.
