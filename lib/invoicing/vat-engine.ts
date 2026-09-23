import Decimal from "decimal.js";
// Relatívny import (rovnako ako v lib/intents/*): vďaka nemu sa modul dá
// spustiť priamo v Node, takže peňažná matematika má vlastné testy bez
// bundlera. `local-date.ts` sám žiadne importy nemá.
import { todayLocalDate } from "../local-date.ts";
import { type VatCategoryCode } from "./vat-categories.ts";

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

/**
 * Prepočíta jeden riadok faktúry. line_net_amount = ROUND(quantity ×
 * unit_price, 2); line_vat_amount = ROUND(line_net_amount × effective_rate / 100, 2)
 * (per-riadok, IBA na UI zobrazenie); line_gross_amount = net + vat.
 * effective_rate je 0 pre všetky kategórie okrem S (pozri effectiveVatRate).
 */
export function computeInvoiceLine(input: VatEngineLineInput): VatEngineLineResult {
  const quantity = new Decimal(input.quantity);
  const unitPrice = new Decimal(input.unitPrice);
  const vatRate = effectiveVatRate(input.vatCategoryCode, input.vatRate);

  const lineNet = round2(quantity.times(unitPrice));
  const lineVat = round2(lineNet.times(vatRate).dividedBy(100));
  const lineGross = lineNet.plus(lineVat);

  return {
    lineNetAmount: lineNet.toFixed(2),
    lineVatAmount: lineVat.toFixed(2),
    lineGrossAmount: lineGross.toFixed(2),
  };
}

/**
 * Jednotková cena BEZ dane z ceny S DAŇOU.
 *
 * KEDY SA POUŽIJE
 * ---------------
 * Keď používateľ povie „uvedené ceny sú už s DPH". Esblu ukladá do
 * `invoice_items.unit_price` cenu bez dane, takže sa musí prepočítať —
 * a prepočítať sa musí TU, jediným miestom, kde v appke beží peňažná
 * matematika. Model ani parser o daň nezavadia.
 *
 * PRESNOSŤ A JEDEN CENT
 * ---------------------
 * Základ sa zaokrúhľuje na centy, lebo to je tvar, v akom cena na doklade
 * naozaj stojí a v akom ju človek v koncepte uvidí a prípadne prepíše.
 *
 * Dôsledok treba povedať nahlas: pri časti súm sa spätný prepočet od
 * vyslovenej sumy odchýli o jeden cent. „0,99 € s 23 % DPH" dá základ
 * 0,80 € a riadok 0,98 €, pretože žiadna cena v centoch nedá po pripočítaní
 * dane presne 0,99. Nie je to chyba zaokrúhľovania, ktorú by sa dalo
 * „opraviť" väčšou presnosťou — overené: šesť desatinných miest dá presne
 * tie isté výsledky, lebo riadkový základ sa aj tak počíta na centy.
 *
 * Odchýlka je najviac 1 cent na riadok a používateľ vidí skutočné súčty v
 * koncepte skôr, než čokoľvek vystaví.
 *
 * Pri nulovej sadzbe (alebo kategórii bez dane) je cena s daňou totožná s
 * cenou bez dane a nič sa nedelí.
 */
export function netUnitPriceFromGross(
  grossUnitPrice: number | string,
  vatCategoryCode: VatCategoryCode,
  vatRate: number | string
): string {
  const gross = new Decimal(grossUnitPrice);
  const rate = effectiveVatRate(vatCategoryCode, vatRate);

  if (rate.isZero()) return round2(gross).toFixed(2);

  const divisor = rate.dividedBy(100).plus(1);
  return round2(gross.dividedBy(divisor)).toFixed(2);
}

/**
 * Prepočíta celú faktúru: riadky + normalizovaný VAT breakdown (EN16931
 * BR-CO-17: sadzba aplikovaná na súčet základu danej kategórie/sadzby, nie
 * na súčet už zaokrúhlených per-line súm) + súčty (BR-CO-10/14/15).
 */
export function computeInvoiceTotals(
  lines: VatEngineLineInput[],
  roundingAmount: number | string = 0
): VatEngineResult {
  const computedLines = lines.map(computeInvoiceLine);

  const groups = new Map<
    string,
    { code: VatCategoryCode; rate: Decimal; taxable: Decimal }
  >();

  lines.forEach((line, index) => {
    const rate = effectiveVatRate(line.vatCategoryCode, line.vatRate);
    const key = `${line.vatCategoryCode}:${rate.toFixed(4)}`;
    const net = new Decimal(computedLines[index].lineNetAmount);
    const existing = groups.get(key);
    if (existing) {
      existing.taxable = existing.taxable.plus(net);
    } else {
      groups.set(key, { code: line.vatCategoryCode, rate, taxable: net });
    }
  });

  const breakdown: VatBreakdownResult[] = Array.from(groups.values())
    .sort((a, b) => a.code.localeCompare(b.code) || a.rate.comparedTo(b.rate))
    .map((group) => {
      const vatAmount = round2(group.taxable.times(group.rate).dividedBy(100));
      return {
        vatCategoryCode: group.code,
        vatRate: group.rate.toFixed(4),
        taxableAmount: group.taxable.toFixed(2),
        vatAmount: vatAmount.toFixed(2),
      };
    });

  const subtotal = computedLines.reduce(
    (acc, line) => acc.plus(line.lineNetAmount),
    new Decimal(0)
  );
  const vatTotal = breakdown.reduce(
    (acc, entry) => acc.plus(entry.vatAmount),
    new Decimal(0)
  );
  const total = subtotal.plus(vatTotal).plus(new Decimal(roundingAmount));

  return {
    lines: computedLines,
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
