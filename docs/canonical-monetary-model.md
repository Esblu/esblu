# Kanonický peňažný model faktúry

Interný dokument. Nie je to právne stanovisko a nie je určený na zverejnenie.

Vznikol z chyby, ktorá sa dostala do produkcie. Je tu preto, aby ju budúci
refaktor nevrátil späť.

## Čo sa stalo

Používateľ nadiktoval tri položky so sumami **s daňou**:

    kopanie 750, dovoz materiálu 250, pracovníci 800      (23 %)

Povedal 1800,00 €. Esblu ukázalo **1800,01 €**.

Cent navyše vznikol z dvoch nezávislých zaokrúhlení, z ktorých ani jedno
nebolo samo o sebe chybné:

1. Cena s daňou sa prepočítala na základ **po riadkoch** a každý riadok sa
   zaokrúhlil zvlášť:
   `750/1,23 → 609,76`, `250/1,23 → 203,25`, `800/1,23 → 650,41`
   → spolu **1463,42**
2. Daň sa podľa EN16931 BR-CO-17 počíta zo **zosčítaného** základu:
   `round(1463,42 × 23 %)` → **336,59**
3. `1463,42 + 336,59 = 1800,01`

Presný základ je `1800/1,23 = 1463,4146…`, teda **1463,41**, nie 1463,42.
Rozdiel jedného centu vznikol pri prvom kroku a druhý krok ho už nemal ako
zachytiť.

Podstatné: **vyslovená suma 1800,00 nebola v modeli uložená nikde.** Existovali
len prepočítané základy. Nebolo sa o čo oprieť, tak si toho nikto nevšimol.

Predchádzajúca sada testov to nechytila, lebo `250 + 1300 + 750` pri 23 %
zhodou okolností vyjde presne. Náhoda, nie správnosť.

## Pravidlo

`invoice_items.unit_price` je **jediné cenové pole**. `price_mode` hovorí, ako
sa má čítať.

Dve cenové polia vedľa seba (napr. `unit_price` aj `gross_unit_price`) by boli
dva zdroje pravdy. Tie sa raz rozídu a potom sa nedá zistiť, ktorý platí.

| | `unit_price` znamená | autoritatívne | dopočítané |
|---|---|---|---|
| `price_mode = 'net'` | cena **bez** dane | `line_net_amount = ROUND(quantity × unit_price, 2)` | `line_vat`, `line_gross`, základ, daň, spolu |
| `price_mode = 'gross'` | cena **s** daňou, ako ju človek zadal | `line_gross_amount = ROUND(quantity × unit_price, 2)` | `line_net`, `line_vat`, základ, daň, spolu |

**Ak používateľ zadá NET, autoritatívny je NET. Ak zadá GROSS, autoritatívny je
GROSS. Výpočet dane nikdy nemení sumu, ktorú človek zadal.**

Doklad **nemá** vlastný stĺpec s režimom. Odvodzuje sa z riadkov
(`invoicePriceMode()`), aby nevznikol druhý zdroj pravdy. Pri nezhodných
riadkoch vráti `null` a UI vtedy o režime netvrdí nič.

## Kde sa zaokrúhľuje

Presne na dvoch miestach a nikde inde.

**1. Raz na riadok** — autoritatívna suma:

    auth = ROUND(quantity × unit_price, 2)

**2. Raz na skupinu** — skupina je `(kategória DPH, sadzba, režim ceny)`:

    net:    základ = Σ auth
            daň    = ROUND(základ × sadzba / 100, 2)          [EN16931 BR-CO-17]

    gross:  suma_s_daňou = Σ auth
            základ       = ROUND(suma_s_daňou / (1 + sadzba/100), 2)
            daň          = suma_s_daňou − základ

V režime gross sa daň **odčíta**, nepočíta sa druhýkrát. Preto súčet sedí na
vyslovenú sumu vždy, nie väčšinou.

**Dopočítaná riadková zložka sa nezaokrúhľuje samostatne.** Rozdeľuje sa zo
skupinového čísla pravidlom najväčších zvyškov: každý riadok dostane celú časť
svojho podielu a zvyšné centy idú riadkom s najväčším desatinným zvyškom. Pri
rovnakom zvyšku rozhoduje `position` — nie poradie v pamäti, nie náhoda.

To isté pravidlo v tom istom poradí má JS engine
(`allocateByLargestRemainder` v `lib/invoicing/vat-engine.ts`) aj SQL
(`esblu_finalize_invoice`). Preto sa koncept a finalizácia nemôžu rozísť.

### Príklad: 750 + 250 + 800 pri 23 %

    suma s daňou skupiny = 1800,00
    základ  = ROUND(1800 / 1,23) = 1463,41
    daň     = 1800,00 − 1463,41  =  336,59

    rozdelenie základu (146 341 centov v pomere 750 : 250 : 800):
      609,75 (zvyšok ,4166)   203,25 (,1388)   650,40 (,4444)  = 146 340
      zvyšný cent ide riadku s najväčším zvyškom → tretí riadok

    riadky:   609,75 / 140,25 / 750,00
              203,25 /  46,75 / 250,00
              650,41 / 149,59 / 800,00
                                ------
    spolu                       1800,00

## Čo z toho platí vždy

    Σ line_net    = základ
    Σ line_vat    = daň
    Σ line_gross  = spolu (pred rounding_amount)
    základ + daň  = spolu
    každý riadok:  line_net + line_vat = line_gross

a v režime gross navyše:

    Σ vyslovených súm = spolu, na cent

`esblu_finalize_invoice` to na konci ešte raz overí a pri nezhode doklad
**nevystaví** (`ESBLU_TOTALS_DO_NOT_RECONCILE`). Za normálnych okolností sa to
stať nemôže — práve preto to tam je. Radšej žiadna faktúra než faktúra, ktorá
sa nerovná sama sebe.

## Čo sa NEzmenilo

Režim `net` dáva rovnaký základ, rovnakú daň aj rovnakú celkovú sumu ako
predtým. Zmenila sa jediná vec: dopočítaná **riadková** daň sa teraz rozdeľuje
zo skupinového čísla namiesto samostatného zaokrúhlenia, takže sedí na rozpis
dane. Riadková daň bola vždy dokumentovaná ako údaj na zobrazenie.

Historické finalizované doklady sa **neprepočítavajú**. Migrácia
`20260923190000` je aditívna, predvolená hodnota `price_mode` je `'net'`, takže
každý existujúci riadok znamená presne to, čo znamenal predtým. Overené:
FA20260001 aj prijatá faktúra majú po migrácii bit po bite tie isté čísla.

## Poznámka pre účtovníka / CLIA

Voľba „v režime gross sa základ dopočíta zo **skupinovej** sumy s daňou a daň je
rozdiel" je **technické** rozhodnutie o konzistencii dokladu. Nie je to tvrdenie
o právnej povinnosti.

Zaokrúhľovacie pravidlo pre ceny uvádzané s daňou nie je v celej EÚ jednotné a
Esblu ho ani nevydáva za jednotné. Na posúdenie:

1. Je pre doklady vystavované z Esblu prijateľné, aby sa pri cenách s daňou
   základ dane odvodil zo skupinovej sumy (`ROUND(gross / (1 + r))`) a daň bola
   rozdiel — namiesto `ROUND(základ × r)`?
2. Je prijateľné rozdelenie zvyškových centov medzi riadky pravidlom najväčších
   zvyškov, keď riadkové sumy s daňou zostávajú presne také, aké ich zadal
   používateľ?
3. Má sa na doklade uvádzať výslovne, že ceny sú uvedené s daňou? Aktuálne to
   hovorí popis stĺpca („Jednotková cena s DPH").

Zmena semantiky sa týka **iba** dokladov, kde používateľ výslovne povedal, že
ceny už daň obsahujú. Doklady zadávané bez dane sa nemenia.
