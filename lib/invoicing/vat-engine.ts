import Decimal from "decimal.js";
// Relatívny import (rovnako ako v lib/intents/*): vďaka nemu sa modul dá
// spustiť priamo v Node, takže peňažná matematika má vlastné testy bez
// bundlera. `local-date.ts` sám žiadne importy nemá.
import { todayLocalDate } from "../local-date.ts";
import { type VatCategoryCode } from "./vat-categories.ts";
import { DEFAULT_PRICE_MODE, type PriceMode } from "./price-mode.ts";

// -----------------------------------------------------------------------------
// Deterministický VAT engine (Fáza 2 — fakturačné jadro).
//
// KRITICKÉ PRAVIDLO (zadanie Fázy 2, bod 4/15/38): žiadna autoritatívna
// peňažná matematika v JS floating point (number). Tento súbor preto
// výhradne používa `decimal.js`.
//
// PREČO decimal.js (zdokumentovaný dôvod výberu, zadanie bod 4):
// - Bezzávislostná (0 runtime dependencies), deterministická aritmetika s
//   ľubovoľnou presnosťou — žiadne IEEE-754 zaokrúhľovacie chyby typu
//   0.1 + 0.2 !== 0.3, ktoré by pri JS number mohli pri väčšom počte
//   riadkov/vysokých množstvách nedeterministicky posunúť DPH súčet o cent.
// - Explicitná kontrola zaokrúhľovacieho režimu (`ROUND_HALF_UP` — bežné
//   "zaokrúhli 0.5 nahor" správanie, na rozdiel od default "round half to
//   even"/bankárske zaokrúhlenie niektorých iných knižníc), čo zodpovedá
//   bežnej slovenskej účtovnej praxi aj Fázy 0 rozhodnutiu.
// - Široko používaná, dlhodobo udržiavaná (miliardy týždenných sťahovaní),
//   funguje rovnako v Node (server RPC prípravné výpočty/validácia) aj v
//   prehliadači (draft editor UI) bez natívnych bindingov — dôležité pre
//   Next.js Edge/serverless kompatibilitu.
// - Alternatívy zvážené a zamietnuté: `big.js` (menší, ale chudobnejšia
//   dokumentácia/ekosystém, rovnaká funkcionalita by sa musela dolaďovať
//   ručne); `dinero.js` (vnucuje vlastnú "Money" abstrakciu naviazanú na
//   ISO menové kódy — Esblu už má menu ako samostatný `currency` stĺpec a
//   explicitné `numeric(18,2)` v DB, netreba druhú vrstvu abstrakcie navyše).
//
// AUTORITATÍVNY VÝPOČET JE VŽDY V DB (migrácia
// 20260916095000_add_invoicing_core_rpc.sql, `esblu_finalize_invoice`) —
// tento súbor sa používa na klientský/server-side PREVIEW počas editácie
// draftu (živé súčty v UI, priebežné ukladanie `invoice_items.line_*_amount`
// polí), NIKDY sa mu naslepo neverí pri finalizácii. `esblu_finalize_invoice`
// prepočíta úplne rovnaké vzorce nezávisle v SQL a je to, čo sa naozaj zapíše
// ako finálne, immutable číslo — táto duplicita (JS aj SQL) je zámerná
// (defense in depth), nie redundancia na odstránenie.
//
// EN16931 / Peppol BIS Billing 3.0 business rules (docs.peppol.eu, overené
// web-researchom 16.9.2026), presne replikované aj v `esblu_finalize_invoice`:
//   BR-CO-10/13: Invoice total net (BT-109) = Σ line net amount (BT-131).
//   BR-CO-17: VAT category tax amount (BT-117)
//             = ROUND(VAT category taxable amount (BT-116) × rate / 100, 2),
//             kde BT-116 = SÚČET line net amounts danej kategórie/sadzby.
//             DÔLEŽITÉ: sadzba sa aplikuje na už ZOSČÍTANÝ základ, nie na
//             súčet už individuálne zaokrúhlených per-line DPH súm — to je
//             bežná chyba, ktorá pri viacerých riadkoch tej istej sadzby
//             môže dať iný výsledok, než Peppol/EN16931 validátor akceptuje.
//   BR-CO-14: Invoice total VAT amount (BT-110) = Σ VAT category tax amount.
//   BR-CO-15: Invoice total with VAT (BT-112) = BT-109 + BT-110.
// `invoice_items.line_vat_amount`/`line_gross_amount` (per riadok) preto
// slúžia VÝHRADNE na UI zobrazenie toho konkrétneho riadku — nikdy nie sú
// vstupom do VAT breakdown agregácie (pozri `computeInvoiceTotals` nižšie).
//
// DÔLEŽITÝ DODATOK (VAT category semantics audit): pre kategórie Z/E/AE je
// vat_amount VŽDY 0, nezávisle od čísla vo `vatRate` (pozri `effectiveVatRate`
// nižšie) — `vatRate` má reálny percentuálny význam iba pre S. Toto UŽ NIE JE
// 1:1 identické s tým, čo by SQL `esblu_finalize_invoice` spočítalo, KEBY by
// v riadku ostala nenulová `vat_rate` pri Z/E/AE (SQL RPC v súčasnosti stále
// robí čisto `line_net * vat_rate / 100` bez ohľadu na kategóriu). Namiesto
// zásahu do finalize RPC (vyžadovalo by migráciu — zámerne NEURENÉ, pozri
// zadanie "STOP a najprv reportuj dôvod") je táto medzera uzavretá na UI
// úrovni: `app/faktury/InvoiceDetailView.tsx` vynucuje `vat_rate = 0` a
// disabled input pre každú Z/E/AE položku PRED uložením aj finalizáciou —
// jediná existujúca cesta zápisu do DB teda vždy zapíše 0 pre tieto
// kategórie, takže JS preview a SQL authoritative výpočet sa v praxi zhodujú.
// -----------------------------------------------------------------------------

Decimal.set({ rounding: Decimal.ROUND_HALF_UP });

// Kategórie sa presunuli do lib/invoicing/vat-categories.ts (bez importov),
// aby sa dali overiť aj tam, kde by sa celý VAT engine ťahať nemal.
// Správanie sa presunom nezmenilo; tieto re-exporty držia doterajšie názvy.
export {
  VAT_CATEGORY_CODES,
  isVatCategoryCode,
  type VatCategoryCode,
} from "./vat-categories.ts";

export interface VatEngineLineInput {
  quantity: number | string;
  unitPrice: number | string;
  vatCategoryCode: VatCategoryCode;
  /** Percento, napr. 20 pre 20 %, nie 0.20. */
  vatRate: number | string;
  /**
   * Ako sa má čítať `unitPrice`. Predvolene "net" — presne to, čo engine
   * robil predtým, než režim ceny vôbec existoval. Pozri KANONICKÝ PEŇAŽNÝ
   * MODEL nižšie.
   */
  priceMode?: PriceMode;
}

export interface VatEngineLineResult {
  lineNetAmount: string;
  lineVatAmount: string;
  lineGrossAmount: string;
}

export interface VatBreakdownResult {
  vatCategoryCode: VatCategoryCode;
  vatRate: string;
  taxableAmount: string;
  vatAmount: string;
}

export interface VatEngineResult {
  lines: VatEngineLineResult[];
  breakdown: VatBreakdownResult[];
  subtotalAmount: string;
  vatTotalAmount: string;
  totalAmount: string;
}

function round2(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

// -----------------------------------------------------------------------------
// VAT category semantics (audit, Fáza 2 pokračovanie): S (standard-rated) je
// JEDINÁ kategória, kde má `vatRate` skutočný význam percentuálnej sadzby.
// Z (zero rate), E (exempt) a AE (reverse charge) majú VAT amount VŽDY 0 —
// to určuje samotná kategória, nie číslo v `vatRate` poli. AE nie je "0 % DPH"
// v bežnom zmysle (je to presun daňovej povinnosti na odberateľa), ale pre
// účely SUMY na tejto faktúre platí rovnaké pravidlo: vat_amount = 0.
// Táto funkcia preto nikdy neinterpretuje `vatRate` ako percento mimo
// kategórie S — a defenzívne ošetruje aj neplatnú/nerozlíšenú (NaN) sadzbu
// pre S ako 0 pre účely PREVIEW zobrazenia (autoritatívna klientská aj DB
// validácia pred uložením/finalizáciou nesmie nerozlíšenú S sadzbu vôbec
// pripustiť — pozri validateDraftBeforeFinalize/findUnresolvedVatRateErrors
// v lib/invoices.ts; toto je iba obranná poistka proti "NaN €" v live náhľade).
// -----------------------------------------------------------------------------
function effectiveVatRate(categoryCode: VatCategoryCode, rawRate: Decimal.Value): Decimal {
  if (categoryCode !== "S") return new Decimal(0);
  const rate = new Decimal(rawRate);
  return rate.isFinite() ? rate : new Decimal(0);
}

// =============================================================================
// KANONICKÝ PEŇAŽNÝ MODEL
//
// Toto je jediné miesto, kde sa rozhoduje, čo je na faktúre zdrojový údaj a
// čo je z neho dopočítané. Kto to raz rozviaže, vráti chybu, ktorá stála
// jednu cestu do produkcie.
//
// PRAVIDLO
// --------
// `unit_price` je JEDINÉ cenové pole. `price_mode` hovorí, ako sa má čítať.
// Dve cenové polia vedľa seba neexistujú — dva zdroje pravdy sa raz rozídu.
//
//   REŽIM "net"   → unit_price je cena BEZ dane
//                   AUTORITATÍVNE:  line_net   = ROUND(quantity × unit_price, 2)
//                   DOPOČÍTANÉ:     line_vat, line_gross, základ, daň, spolu
//
//   REŽIM "gross" → unit_price je cena S DAŇOU, tak, ako ju človek povedal
//                   AUTORITATÍVNE:  line_gross = ROUND(quantity × unit_price, 2)
//                   DOPOČÍTANÉ:     line_net, line_vat, základ, daň, spolu
//
// Vyslovená suma je zdrojový údaj. Žiadna výpočtová vrstva ju nesmie zmeniť.
//
// KDE SA ZAOKRÚHĽUJE
// ------------------
// Presne na dvoch miestach a nikde inde:
//
//   1. raz na riadok — autoritatívna suma ROUND(quantity × unit_price, 2)
//   2. raz na skupinu (kategória + sadzba + režim):
//        net   → daň skupiny = ROUND(základ × sadzba / 100, 2)   [EN16931 BR-CO-17]
//        gross → základ skupiny = ROUND(suma s daňou / (1 + sadzba/100), 2)
//                daň skupiny   = suma s daňou − základ skupiny
//
// Dopočítané riadkové zložky sa NEZAOKRÚHĽUJÚ samostatne. Rozdeľujú sa zo
// skupinového čísla pravidlom najväčších zvyškov (`allocateByLargestRemainder`),
// takže ich súčet sedí na skupinu na cent. Práve toto tu predtým chýbalo:
// riadky sa zaokrúhľovali nezávisle od skupiny, obe čísla boli „správne" a
// dokopy dali o cent viac.
//
// ČO Z TOHO PLYNIE (platí vždy, nie „skoro vždy")
// -----------------------------------------------
//   Σ line_net   = základ
//   Σ line_vat   = daň
//   Σ line_gross = spolu (pred rounding_amount)
//   základ + daň = spolu
//   v režime gross navyše: Σ vyslovených súm = spolu, na cent
//
// REŽIM "net" SA TÝMTO NEZMENIL. Základ, daň aj celková suma vychádzajú
// presne ako predtým; dopočítaná je iba riadková daň, ktorá sa teraz
// rozdeľuje zo skupiny namiesto samostatného zaokrúhľovania — čiže sedí na
// rozpis dane. Historické finalizované doklady sa nikdy neprepočítavajú.
//
// ÚČTOVNÍK / CLIA
// ---------------
// Voľba „základ sa dopočíta zo skupinovej sumy s daňou" je TECHNICKÉ
// rozhodnutie o konzistencii, nie tvrdenie o právnej povinnosti. Zaokrúhľovacie
// pravidlo pre ceny s daňou nie je v celej EÚ jednotné — presnú metódu treba
// dať účtovníkovi na posúdenie (pozri docs/canonical-monetary-model.md).
// =============================================================================

/**
 * Rozdelí `total` (v centoch) medzi riadky v pomere ich váh tak, aby súčet
 * sedel na `total` PRESNE.
 *
 * Pravidlo najväčších zvyškov: každý riadok dostane celú časť svojho podielu,
 * a zvyšné centy idú riadkom s najväčším desatinným zvyškom. Pri rovnakom
 * zvyšku rozhoduje poradie riadku na faktúre — nie poradie v pamäti, nie
 * náhoda. To isté pravidlo, v tom istom poradí, má aj SQL vo
 * `esblu_finalize_invoice`; preto sa koncept a finalizácia nemôžu rozísť.
 */
function allocateByLargestRemainder(weights: Decimal[], total: Decimal): Decimal[] {
  const weightSum = weights.reduce((acc, weight) => acc.plus(weight), new Decimal(0));

  // Nulový (alebo degenerovaný) základ na rozdelenie: rozdeliť sa nedá nič a
  // nič sa ani nevymyslí. Všetko je nula.
  if (weightSum.isZero() || weightSum.isNegative()) {
    return weights.map(() => new Decimal(0));
  }

  const shares = weights.map((weight) => weight.times(total).dividedBy(weightSum));
  const floors = shares.map((share) => share.floor());
  const allocated = floors.reduce((acc, value) => acc.plus(value), new Decimal(0));

  // Koľko centov ostalo nerozdelených. Vždy 0 ≤ deficit < počet riadkov.
  const deficit = total.minus(allocated).toNumber();

  const order = shares
    .map((share, index) => ({ index, remainder: share.minus(floors[index]) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);

  const result = floors.slice();
  for (let i = 0; i < deficit && i < order.length; i++) {
    result[order[i].index] = result[order[i].index].plus(1);
  }
  return result;
}

/**
 * Prepočíta JEDEN samostatný riadok.
 *
 * Pozor: riadok na faktúre nikdy nestojí sám — jeho daň sa rozdeľuje zo
 * skupiny, takže jediný správny vstup je celý doklad. Táto funkcia preto iba
 * pošle jeden riadok cez `computeInvoiceTotals`; pre doklad s jednou položkou
 * je výsledok totožný a pre viac položiek sa takto nedá omylom obísť
 * skupinové zaokrúhlenie.
 */
export function computeInvoiceLine(input: VatEngineLineInput): VatEngineLineResult {
  return computeInvoiceTotals([input]).lines[0];
}

/**
 * Základ dane zo sumy S DAŇOU — pre CELÚ skupinu naraz, nie po riadkoch.
 *
 * Toto je jediné zaokrúhlenie, ktoré v režime gross rozhoduje o výsledku.
 * Daň sa z neho už nepočíta nezávisle, ale odčíta: daň = suma s daňou −
 * základ. Vďaka tomu súčet sedí na vyslovenú sumu vždy, nie väčšinou.
 *
 * Pri nulovej sadzbe (alebo kategórii bez dane) je suma s daňou totožná so
 * základom a nič sa nedelí.
 */
export function taxableFromGross(
  grossAmount: Decimal.Value,
  vatCategoryCode: VatCategoryCode,
  vatRate: Decimal.Value
): string {
  const gross = new Decimal(grossAmount);
  const rate = effectiveVatRate(vatCategoryCode, vatRate);

  if (rate.isZero()) return round2(gross).toFixed(2);

  return round2(gross.dividedBy(rate.dividedBy(100).plus(1))).toFixed(2);
}

interface Bucket {
  code: VatCategoryCode;
  rate: Decimal;
  priceMode: PriceMode;
  indexes: number[];
  /** ROUND(quantity × unit_price, 2) po riadkoch — autoritatívne sumy. */
  authoritative: Decimal[];
}

/**
 * Prepočíta celú faktúru podľa kanonického peňažného modelu (pozri komentár
 * vyššie): riadky + rozpis dane + súčty.
 *
 * EN16931 / Peppol BIS 3.0: BR-CO-10/13 (základ = Σ riadkových základov),
 * BR-CO-17 (daň kategórie sa počíta zo ZOSČÍTANÉHO základu, nie zo súčtu
 * jednotlivo zaokrúhlených riadkových daní), BR-CO-14, BR-CO-15.
 *
 * Riadky s cenami s daňou a bez dane sa zoskupujú oddelene, aj keď majú tú
 * istú sadzbu: každá skupina má vlastnú autoritatívnu sumu, z ktorej sa
 * počíta. V rozpise dane sa potom sčítajú pod jednu kategóriu a sadzbu. Esblu
 * zmiešané režimy na jednom doklade zatiaľ neponúka (hlas sa radšej spýta),
 * ale keby sa raz zjavili, aritmetika ich neskazí.
 */
export function computeInvoiceTotals(
  lines: VatEngineLineInput[],
  roundingAmount: number | string = 0
): VatEngineResult {
  // 1. Autoritatívna suma na riadok — jediné riadkové zaokrúhlenie.
  const authoritative = lines.map((line) =>
    round2(new Decimal(line.quantity).times(new Decimal(line.unitPrice)))
  );

  // 2. Skupiny: kategória + sadzba + režim ceny.
  const buckets = new Map<string, Bucket>();
  lines.forEach((line, index) => {
    const rate = effectiveVatRate(line.vatCategoryCode, line.vatRate);
    const priceMode = line.priceMode ?? DEFAULT_PRICE_MODE;
    const key = `${line.vatCategoryCode}:${rate.toFixed(4)}:${priceMode}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.indexes.push(index);
      existing.authoritative.push(authoritative[index]);
    } else {
      buckets.set(key, {
        code: line.vatCategoryCode,
        rate,
        priceMode,
        indexes: [index],
        authoritative: [authoritative[index]],
      });
    }
  });

  // 3. Skupinové zaokrúhlenie + rozdelenie dopočítanej zložky späť na riadky.
  const lineNet: Decimal[] = new Array(lines.length);
  const lineVat: Decimal[] = new Array(lines.length);
  const lineGross: Decimal[] = new Array(lines.length);

  const bucketResults: {
    code: VatCategoryCode;
    rate: Decimal;
    taxable: Decimal;
    vat: Decimal;
  }[] = [];

  for (const bucket of buckets.values()) {
    const authSum = bucket.authoritative.reduce(
      (acc, value) => acc.plus(value),
      new Decimal(0)
    );

    let taxable: Decimal;
    let vat: Decimal;
    /** Skupinové číslo, ktoré sa rozdeľuje späť na riadky, v centoch. */
    let distributed: Decimal;

    if (bucket.priceMode === "gross") {
      // Autoritatívna je suma S DAŇOU. Základ sa dopočíta raz, pre celú
      // skupinu, a daň je zvyšok — takže súčet nemôže ujsť ani o cent.
      taxable = new Decimal(taxableFromGross(authSum, bucket.code, bucket.rate));
      vat = authSum.minus(taxable);
      distributed = taxable;
    } else {
      // Autoritatívny je základ. Daň podľa BR-CO-17 zo zosčítaného základu.
      taxable = authSum;
      vat = round2(authSum.times(bucket.rate).dividedBy(100));
      distributed = vat;
    }

    const allocatedCents = allocateByLargestRemainder(
      bucket.authoritative.map((value) => value.times(100)),
      distributed.times(100)
    );

    bucket.indexes.forEach((lineIndex, position) => {
      const authoritativeAmount = bucket.authoritative[position];
      const allocated = allocatedCents[position].dividedBy(100);

      if (bucket.priceMode === "gross") {
        lineGross[lineIndex] = authoritativeAmount;
        lineNet[lineIndex] = allocated;
        lineVat[lineIndex] = authoritativeAmount.minus(allocated);
      } else {
        lineNet[lineIndex] = authoritativeAmount;
        lineVat[lineIndex] = allocated;
        lineGross[lineIndex] = authoritativeAmount.plus(allocated);
      }
    });

    bucketResults.push({ code: bucket.code, rate: bucket.rate, taxable, vat });
  }

  // 4. Rozpis dane: režimy sa tu opäť spájajú pod jednu kategóriu a sadzbu.
  const grouped = new Map<
    string,
    { code: VatCategoryCode; rate: Decimal; taxable: Decimal; vat: Decimal }
  >();
  for (const result of bucketResults) {
    const key = `${result.code}:${result.rate.toFixed(4)}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.taxable = existing.taxable.plus(result.taxable);
      existing.vat = existing.vat.plus(result.vat);
    } else {
      grouped.set(key, { ...result });
    }
  }

  const breakdown: VatBreakdownResult[] = Array.from(grouped.values())
    .sort((a, b) => a.code.localeCompare(b.code) || a.rate.comparedTo(b.rate))
    .map((group) => ({
      vatCategoryCode: group.code,
      vatRate: group.rate.toFixed(4),
      taxableAmount: group.taxable.toFixed(2),
      vatAmount: group.vat.toFixed(2),
    }));

  const subtotal = bucketResults.reduce(
    (acc, result) => acc.plus(result.taxable),
    new Decimal(0)
  );
  const vatTotal = bucketResults.reduce(
    (acc, result) => acc.plus(result.vat),
    new Decimal(0)
  );
  const total = subtotal.plus(vatTotal).plus(new Decimal(roundingAmount));

  return {
    lines: lines.map((_, index) => ({
      lineNetAmount: lineNet[index].toFixed(2),
      lineVatAmount: lineVat[index].toFixed(2),
      lineGrossAmount: lineGross[index].toFixed(2),
    })),
    breakdown,
    subtotalAmount: subtotal.toFixed(2),
    vatTotalAmount: vatTotal.toFixed(2),
    totalAmount: total.toFixed(2),
  };
}

/** Overí, či je zadaná hodnota platný VAT category kód (S/Z/E/AE). */
/**
 * Odvodený (nie uložený) "po splatnosti" stav — presne podľa Fázy 0/zadania:
 * overdue sa nikdy neukladá do DB, počíta sa vždy nanovo.
 */
export function isInvoiceOverdue(
  dueDate: string | null,
  paymentStatus: string,
  /**
   * Kalendárny dnešok. Predvolene deň prostredia, kde kód beží — v
   * prehliadači teda deň používateľa. Predtým sa tu počítal UTC deň, takže
   * faktúra splatná „dnes" sa o polnoci stredoeurópskeho času ešte niekoľko
   * hodín tvárila ako splatná zajtra.
   *
   * Parameter je tu preto, aby sa dal v testoch a na serveri odovzdať
   * konkrétny deň namiesto spoliehania sa na pásmo procesu.
   */
  today: string = todayLocalDate()
): boolean {
  if (!dueDate || paymentStatus === "paid") return false;
  return dueDate < today;
}
