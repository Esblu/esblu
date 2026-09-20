# Esblu — Zákazky: architektonický návrh

**Dátum:** 2026-09-20
**Stav:** NÁVRH — **neimplementovať teraz**
**Dôvod odkladu:** eFaktúra má termín 1. 1. 2027. Zákazky termín nemajú.

---

## 1. Prečo zákazky vôbec

Z konkurenčného auditu: **zákazky/projekty majú AI BOS, Stavario, FLOWii aj KROS ONIX.** Esblu ich nemá. Je to najväčšia modulová medzera.

Dôvod je hlbší než „konkurencia to má". Pre stavebnú, výkopovú alebo servisnú firmu je **zákazka prirodzená os, okolo ktorej sa točí všetko ostatné**. Majiteľ nepremýšľa v tabuľkách faktúr a vozidiel — premýšľa v „Rekonštrukcia Hlavná 12". Na tej zákazke stál bager, jazdila Avia, minulo sa 14 ton štrku, prišli tri dodávateľské faktúry a vystavili sme dve.

Bez zákazky zostane Esblu **súborom nespojených agend**. S ňou sa stane systémom.

## 2. Čo to NEMÁ byť

Explicitne **nie**:

- ERP projektové riadenie s WBS, kritickou cestou a resource levelingom
- Gantt ako prvá funkcia
- Rozpočtovanie a kalkulácie (to je CENKROS a KROS ONIX — nesúťažíme tam)
- Fakturačné míľniky a zádržné
- Subdodávateľské reťazce
- BIM, výkresy, 3D
- Time tracking zamestnancov (to je dochádzka, a tú vedome nestaviame)

**Test, ktorý musí návrh prejsť:** majiteľ osemčlennej výkopovej firmy musí zákazku založiť **za 20 sekúnd, v mobile, na stavbe** — meno, partner, prípadne termín. Všetko ostatné je voliteľné a dopĺňa sa samo tým, že sa k zákazke priraďujú veci, ktoré aj tak vznikajú.

Ak si návrh vyžiada vyplnenie formulára s 12 poľami, je zlý.

## 3. Dátový model

### 3.1 `jobs` — jadro

```
jobs
  id                    uuid pk
  company_id            uuid not null          -- RLS scope
  code                  text                    -- voliteľné firemné označenie, napr. "2026-014"
  name                  text not null           -- "Rekonštrukcia Hlavná 12"
  status                text not null           -- planned | active | on_hold | done | cancelled
  business_partner_id   uuid                    -- zákazník
  site_address          text                    -- kde to je
  site_lat, site_lng    numeric                 -- pre budúce "ktorá zákazka je najbližšie"
  starts_on             date
  due_on                date                    -- napojenie na deadline engine
  closed_at             timestamptz
  note                  text
  created_by/updated_by uuid
  created_at/updated_at timestamptz
```

**Povinné je len `name`.** Všetko ostatné voliteľné. To je celý návrh podstaty.

### 3.2 `job_links` — univerzálna väzba

Namiesto `job_id` stĺpca na ôsmich tabuľkách jedna prepojovacia tabuľka, konzistentne so vzorom, ktorý už používa `document_links`:

```
job_links
  id              uuid pk
  company_id      uuid not null
  job_id          uuid not null → jobs(id) on delete cascade
  entity_type     text not null   -- invoice | document | vehicle | machine
                                  -- | inventory_movement | photo | partner
  entity_id       uuid not null
  role            text            -- napr. 'issued_invoice', 'cost_invoice',
                                  -- 'assigned_machine', 'site_photo'
  confirmed_by_user boolean not null default false
  created_at      timestamptz

  unique (job_id, entity_type, entity_id, role)
```

**Prečo takto:**
- Nové typy entít nevyžadujú migráciu `jobs`
- `confirmed_by_user` umožní AI navrhnúť väzbu („táto faktúra vyzerá, že patrí k zákazke X"), ktorú používateľ potvrdí — presne ten vzor, ktorý už `document_links` používa
- RLS je jednoduché: `company_id` scope, rovnako ako všade inde

**Kompromis, ktorý si treba priznať:** polymorfná väzba nemá referenčnú integritu cez FK. Rieši sa to buď trigger validáciou, alebo vedomým prijatím, že orphan link je neškodný (zobrazí sa ako „záznam nenájdený" a dá sa zmazať). **Odporúčam druhé** — trigger validácia pre 6 typov entít je viac kódu než hodnoty.

### 3.3 `job_costs` — voliteľné, nie v prvej verzii

Neskôr, ak sa ukáže potreba nákladov, ktoré nie sú faktúra ani skladový pohyb (hotovosť, vlastná práca):

```
job_costs
  id, company_id, job_id, description, amount, currency,
  cost_type, incurred_on, source_document_id, created_by, created_at
```

**Zámerne nie v prvej verzii.** Väčšina nákladov sú prijaté faktúry a skladové výdaje — tie sa naviažu cez `job_links` a sčítajú sa z nich.

## 4. Čo zákazka prepája

| Entita | Väzba | Ako vzniká |
|---|---|---|
| **Partner** | `jobs.business_partner_id` | pri založení |
| **Vydané faktúry** | `job_links` role=`issued_invoice` | pri vystavení sa vyberie zákazka |
| **Prijaté faktúry** | `job_links` role=`cost_invoice` | **AI návrh v review** + potvrdenie |
| **Dokumenty** | `job_links` role=`job_document` | z AI Inboxu |
| **Fotografie** | `job_links` role=`site_photo` | odfotené na stavbe |
| **Stroje** | `job_links` role=`assigned_machine` | priradenie na obdobie |
| **Vozidlá** | `job_links` role=`assigned_vehicle` | priradenie |
| **Sklad** | `job_links` role=`material_issue` | výdaj materiálu na zákazku |
| **Termín** | `jobs.due_on` | deadline engine |
| **Náklady** | odvodené | suma z naviazaných prijatých faktúr + skladových výdajov |

## 5. Ekonomika zákazky — odvodená, nie zadaná

```
Výnosy   = Σ total_amount naviazaných finalized vydaných faktúr
Náklady  = Σ total_amount naviazaných finalized prijatých faktúr
         + Σ hodnota naviazaných skladových výdajov
Marža    = Výnosy − Náklady
```

**Zásadné pravidlo:** toto je **read-only odvodený pohľad, nikdy nie zapisovaná hodnota.** Žiadny `jobs.total_revenue` stĺpec, ktorý by sa musel udržiavať v synchronizácii a ktorý by sa nevyhnutne rozišiel s realitou.

Rovnako platí pravidlo z fakturačného core: **žiadna JS float authority.** Sumy sa počítajú v DB z persistovaných hodnôt.

## 6. Prečo nie teraz — a čo z toho vyplýva

| Dôvod | |
|---|---|
| **eFaktúra má termín, zákazky nie** | 1. 1. 2027. KROS aj STORMWARE sú už v produkcii s Peppol AP. |
| **Zákazka bez prijatých faktúr je poloprázdna** | Najväčšia hodnota zákazky je „koľko ma to stálo". Bez Fázy B to nevieme. |
| **Zákazka bez skladových pohybov je poloprázdna** | Dnes je `inventory_items` evidencia stavu, nie pohybov. Pre náklady na zákazku treba pohyby. |
| **Riziko scope creep** | Zákazky sú prirodzený magnet na Gantt, rozpočty, dochádzku a míľniky. Kým je fakturačný core nedokončený, je to nebezpečné. |

**Predpoklady, ktoré musia byť splnené, než sa zákazky začnú stavať:**
1. Prijaté faktúry v produkcii (Fáza B)
2. Dedupe v produkcii (Fáza C)
3. eFaktúra outbound aspoň ako interný nástroj (Fáza F)
4. Skladové pohyby (dnes neexistujú)

## 7. Minimálna prvá verzia (keď príde čas)

**Iterácia 1 — 2 týždne:**
- `jobs` tabuľka + RLS + CRUD
- Zoznam a detail zákazky
- Väzba na partnera
- Väzba na vydané a prijaté faktúry cez `job_links`
- Odvodený súčet výnosov a nákladov
- Zákazka ako voliteľné pole pri vystavení faktúry a pri review prijatej faktúry

**To je všetko.** Žiadny Gantt, žiadne fázy, žiadne míľniky, žiadne rozpočty.

**Iterácia 2 — podľa reálneho dopytu:**
- Fotky a dokumenty
- Priradenie strojov a vozidiel
- Materiál zo skladu
- `due_on` v deadline engine a v smart dashboarde
- AI návrh väzby prijatej faktúry na zákazku

## 8. Bezpečnosť

Nič výnimočné — platia existujúce pravidlá:
- `company_id` na `jobs` aj `job_links`, RLS scope ako všade
- Ekonomika zákazky obsahuje finančné údaje → **vyžaduje `finance.view`**
- Zoznam a detail zákazky bez ekonomiky → bežné oprávnenie
- **Dôsledok:** employee vidí, že na zákazke stál bager, ale nevidí maržu. To je správne.
- Žiadny service_role → load all → filter v aplikácii
