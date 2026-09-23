// =============================================================================
// Režim ceny: sú vyslovené sumy s daňou, alebo bez nej?
//
// DVE RÔZNE OTÁZKY
// ----------------
// „Uvedené ceny sú už s DPH" hovorí, AKO sú sumy vyjadrené.
// „Dvadsaťtri percent" hovorí, AKÁ daň sa uplatní.
//
// Sú to dve nezávislé veci a jedna z druhej nevyplýva. Z vety „ceny sú s
// DPH" sa NEDÁ odvodiť sadzba — ani z krajiny, ani z partnera, ani zo
// sumy. Preto sa prvá odpoveď uloží a pýta sa už len tá druhá.
//
// Z reálneho testu: používateľ nadiktoval tri položky, appka sa spýtala na
// DPH, on odpovedal „uvedené ceny sú už s DPH" — a appka zopakovala tú
// istú otázku, akoby nič nepovedal. Otázka bola správna, ignorovanie
// odpovede nie.
//
// Modul nemá importy: tie isté pravidlá bežia na serveri aj v teste.
// =============================================================================

/**
 *   "net"     sumy sú bez dane; daň sa pripočíta
 *   "gross"   sumy už daň obsahujú; základ sa dopočíta
 *   "mixed"   veta hovorí o rôznych režimoch pre rôzne riadky — nepodporuje
 *             sa a je to dôvod na otázku, nie na odhad
 */
export type PriceMode = "net" | "gross";

export type PriceModeStatement = PriceMode | "mixed" | null;

/** Odstráni diakritiku a zjednotí veľkosť písmen. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// -----------------------------------------------------------------------------
// Frázy
// -----------------------------------------------------------------------------
//
// ROZLÍŠENIE OD VETY SO SADZBOU
// -----------------------------
// „s 23 percent DPH" znamená daň NAVYŠE, nie cenu s daňou — a rozlíši sa
// to samotným tvarom frázy: reťazec „s dph" sa v nej nenachádza, lebo
// medzi predložkou a skratkou stojí číslo. To isté platí pre „vrátane
// 23 % DPH", „mit 23 Prozent MwSt" aj „including 23% VAT".
//
// Vďaka tomu veta, ktorá povie oboje naraz („ceny sú s DPH, sadzba 23"),
// nastaví režim AJ sadzbu — a nič sa nestratí.

const GROSS_PHRASES = [
  // SK/CZ
  "s dph",
  "s danou",
  "vratane dph",
  "vratane dane",
  "vcetne dph",
  "vcetne dane",
  "aj s dph",
  "uz s dph",
  "brutto",
  // DE
  "inkl dph",
  "inkl mwst",
  "inkl. mwst",
  "inklusive mwst",
  "inklusive mehrwertsteuer",
  "mit mehrwertsteuer",
  "bruttopreis",
  "bruttopreise",
  // EN
  "including vat",
  "including tax",
  "include vat",
  "includes vat",
  "included vat",
  "incl vat",
  "incl. vat",
  "vat included",
  "tax included",
  "gross price",
  "gross prices",
];

const NET_PHRASES = [
  // SK/CZ
  "bez dph",
  "bez dane",
  "netto",
  "plus dph",
  "k tomu dph",
  // DE
  "ohne mwst",
  "zzgl mwst",
  "zzgl. mwst",
  "exkl mwst",
  "exkl. mwst",
  "nettopreis",
  "nettopreise",
  // EN
  "excluding vat",
  "excl vat",
  "excl. vat",
  "without vat",
  "net price",
  "net prices",
  "plus vat",
];

/**
 * Slová, ktoré vyčleňujú JEDEN riadok („prvá cena je s DPH").
 *
 * Zmiešané režimy Esblu nepodporuje — a kým ich nepodporuje, je jediná
 * správna odpoveď otázka. Doklad, kde je polovica riadkov prepočítaná inak
 * než druhá, sa na prvý pohľad nedá odlíšiť od správneho.
 */
const ROW_SCOPED_WORDS = [
  "prva",
  "prvy",
  "prve",
  "druha",
  "druhy",
  "druhe",
  "tretia",
  "treti",
  "posledna",
  "posledny",
  "erste",
  "erster",
  "zweite",
  "zweiter",
  "letzte",
  "first",
  "second",
  "third",
  "last",
  "only the",
  "iba prva",
  "len prva",
];

/**
 * Obsahuje text frázu ako SAMOSTATNÉ slovo?
 *
 * Porovnávanie podreťazcom sa v tomto projekte už raz vypomstilo: „ešte"
 * sedelo vnútri mena „Tester1" a výber partnera sa tváril ako pridávanie
 * položky. Tu by zase „erste" sedelo vo „verstehen sich netto" a jasná
 * veta by sa čítala ako reč o jednom riadku. Preto hranice slov.
 */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(folded: string, phrase: string): boolean {
  const needle = escapeForRegex(fold(phrase));
  return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`).test(folded);
}

function containsAny(folded: string, phrases: string[]): boolean {
  return phrases.some((phrase) => containsPhrase(folded, phrase));
}

/**
 * Hovorí veta o tom, ako sú ceny vyjadrené?
 *
 * Vracia `null`, keď o tom nehovorí — a to je väčšina viet. Nič sa
 * nedomýšľa: mlčanie znamená „nevieme", nie „bez dane". Predvolený režim
 * dosadzuje až vrstva nad týmto modulom, a to iba ten, ktorý zodpovedá
 * formuláru v UI.
 */
export function detectPriceModeStatement(rawText: string): PriceModeStatement {
  const folded = fold(rawText);

  const saysGross = containsAny(folded, GROSS_PHRASES);
  const saysNet = containsAny(folded, NET_PHRASES);

  if (!saysGross && !saysNet) return null;

  // „Prvá cena je s DPH" — reč je o jednom riadku, nie o všetkých.
  if (containsAny(folded, ROW_SCOPED_WORDS)) return "mixed";

  // Obe naraz („ceny sú s DPH, teda nie bez dane") sa rozlišovať nedá.
  if (saysGross && saysNet) return "mixed";

  if (saysNet) return "net";
  return "gross";
}

/**
 * Predvolený režim, keď o ňom nikto nepovedal nič.
 *
 * Zhoduje sa s formulárom v UI, kde sa jednotková cena zadáva bez dane.
 * Hlas tak nevytvára doklady s inými východiskami než klikanie.
 */
export const DEFAULT_PRICE_MODE: PriceMode = "net";

export function isPriceMode(value: unknown): value is PriceMode {
  return value === "net" || value === "gross";
}

/**
 * Režim celého dokladu odvodený z jeho riadkov — žiadny druhý uložený údaj.
 *
 * Doklad nemá vlastný stĺpec s režimom zámerne: dva zdroje pravdy sa raz
 * rozídu a potom sa nedá zistiť, ktorý platí. Režim vie každý riadok sám a
 * doklad sa ho spýta vtedy, keď treba popísať stĺpec s cenou.
 *
 * `null` znamená, že riadky sa nezhodujú. Esblu taký doklad nevytvára (hlas
 * sa radšej spýta), ale keby sa raz zjavil, žiadny popis stĺpca by o ňom
 * nehovoril pravdu — tak sa nebude tvrdiť nič.
 */
/**
 * Preklad popisu stĺpca s jednotkovou cenou podľa režimu. Pri nezhodných
 * riadkoch (`null`) zostáva neutrálny popis — tvrdiť o všetkých riadkoch
 * niečo, čo platí len pre časť, je horšie než nepovedať nič.
 */
export function unitPriceLabelKey(mode: PriceMode | null): string {
  if (mode === "gross") return "invoices.newInvoice.itemUnitPriceGrossLabel";
  if (mode === "net") return "invoices.newInvoice.itemUnitPriceNetLabel";
  return "invoices.newInvoice.itemUnitPriceLabel";
}

export function invoicePriceMode(
  items: readonly { price_mode?: PriceMode | null }[]
): PriceMode | null {
  if (items.length === 0) return DEFAULT_PRICE_MODE;
  const first = items[0].price_mode ?? DEFAULT_PRICE_MODE;
  for (const item of items) {
    if ((item.price_mode ?? DEFAULT_PRICE_MODE) !== first) return null;
  }
  return first;
}
