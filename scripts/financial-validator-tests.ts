// =============================================================================
// Testy finančnej brány pred vznikom hlasového konceptu.
//
// SPUSTENIE
//   npm run test:money
//
// PREČO EXISTUJÚ
// --------------
// Z produkcie: „Vytvor faktúru Tester 1, kopanie za 300 eur, dovoz za 45
// eur s 23 percentnou DPH." sa uložilo ako jeden riadok „300 eur, dovoz"
// za 1 €. Základ 1 €, DPH 0,23 €, spolu 1,23 €. Ani jedno z tých čísel vo
// vete nezaznelo — jednotka pochádzala z mena partnera „Tester 1".
//
// Testy nižšie strážia dve veci, ktoré to spolu spôsobili:
//   1. každá vyslovená suma musí skončiť ako cena práve jednej položky,
//   2. množstvo sa nikdy nesmie stať cenou.
// =============================================================================

import assert from "node:assert/strict";
import {
  checkVoiceInvoiceDraft,
  type VoiceDraftCheckInput,
} from "../lib/invoicing/voice-financial-validator.ts";
import { detectPriceModeStatement } from "../lib/invoicing/price-mode.ts";
import { extractInvoiceItems, moneyTokens } from "../lib/intents/invoice-items.ts";

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    passed++;
  } catch {
    failed++;
    console.error(
      `FAIL  ${label}\n      dostal: ${JSON.stringify(actual)}\n      čakal:  ${JSON.stringify(expected)}`
    );
  }
}

const PARTNER = "11111111-1111-4111-8111-111111111111";

/** Doklad, ktorý má prejsť. Jednotlivé testy menia vždy jednu vec. */
function validDraft(overrides: Partial<VoiceDraftCheckInput> = {}): VoiceDraftCheckInput {
  return {
    financeManage: true,
    partnerId: PARTNER,
    items: [
      { description: "kopanie", quantity: 1, unitPrice: 300 },
      { description: "dovoz", quantity: 1, unitPrice: 45 },
    ],
    currency: "EUR",
    vatCategoryCode: "S",
    vatRate: 23,
    spokenAmounts: [300, 45],
    parserAmbiguous: false,
    pendingQuestions: 0,
    priceModeMixed: false,
    localDate: "2026-09-23",
    idempotencyClaimed: true,
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// 1. Správny doklad prejde
// -----------------------------------------------------------------------------
check("dvojpoložkový doklad prejde", checkVoiceInvoiceDraft(validDraft()), null);

// -----------------------------------------------------------------------------
// 2. Presne ten doklad, ktorý vznikol v produkcii
//
// Jeden riadok „300 eur, dovoz" za 1 €, kým vo vete zazneli 300 a 45.
// -----------------------------------------------------------------------------
check(
  "produkčný doklad za 1 € NEPREJDE",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [{ description: "300 eur, dovoz", quantity: 1, unitPrice: 1 }],
      spokenAmounts: [300, 45],
    })
  ),
  "money_not_reconciled"
);

// -----------------------------------------------------------------------------
// 3. Rekonciliácia súm
// -----------------------------------------------------------------------------
check(
  "stratená druhá suma",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [{ description: "kopanie", unitPrice: 300 }],
      spokenAmounts: [300, 45],
    })
  ),
  "money_not_reconciled"
);
check(
  "suma navyše, ktorá nezaznela",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [
        { description: "kopanie", unitPrice: 300 },
        { description: "dovoz", unitPrice: 45 },
        { description: "vymyslené", unitPrice: 99 },
      ],
      spokenAmounts: [300, 45],
    })
  ),
  "money_not_reconciled"
);
check(
  "zamenená hodnota",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [
        { description: "kopanie", unitPrice: 300 },
        { description: "dovoz", unitPrice: 54 },
      ],
      spokenAmounts: [300, 45],
    })
  ),
  "money_not_reconciled"
);
// Dve rovnaké sumy sú legitímne — porovnáva sa multimnožina, nie počet
// rôznych hodnôt.
check(
  "dve položky po 50 € prejdú",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [
        { description: "doprava tam", unitPrice: 50 },
        { description: "doprava späť", unitPrice: 50 },
      ],
      spokenAmounts: [50, 50],
    })
  ),
  null
);
check(
  "jedna z dvoch rovnakých súm chýba",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [{ description: "doprava", unitPrice: 50 }],
      spokenAmounts: [50, 50],
    })
  ),
  "money_not_reconciled"
);

// -----------------------------------------------------------------------------
// 4. MNOŽSTVO SA NIKDY NESTANE CENOU
//
// Toto je jadro chyby. Množstvo má predvolenú hodnotu 1; cena nesmie mať
// žiadnu. Keby sa predvolená jednotka dostala do ceny, vznikol by doklad
// za 1 € — a vyzeral by úplne v poriadku.
// -----------------------------------------------------------------------------
check(
  "chýbajúca cena NEPREJDE, hoci množstvo je 1",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [{ description: "kopanie", quantity: 1 }],
      spokenAmounts: [],
    })
  ),
  "unit_price_invalid"
);
check(
  "cena 0 NEPREJDE",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [{ description: "kopanie", quantity: 1, unitPrice: 0 }],
      spokenAmounts: [0],
    })
  ),
  "unit_price_invalid"
);
check(
  "záporná cena NEPREJDE",
  checkVoiceInvoiceDraft(
    validDraft({ items: [{ description: "x", unitPrice: -5 }], spokenAmounts: [-5] })
  ),
  "unit_price_invalid"
);
check(
  "NaN cena NEPREJDE",
  checkVoiceInvoiceDraft(
    validDraft({ items: [{ description: "x", unitPrice: Number.NaN }], spokenAmounts: [] })
  ),
  "unit_price_invalid"
);
check(
  "Infinity cena NEPREJDE",
  checkVoiceInvoiceDraft(
    validDraft({
      items: [{ description: "x", unitPrice: Number.POSITIVE_INFINITY }],
      spokenAmounts: [],
    })
  ),
  "unit_price_invalid"
);
check(
  "nulové množstvo NEPREJDE",
  checkVoiceInvoiceDraft(
    validDraft({ items: [{ description: "x", quantity: 0, unitPrice: 300 }], spokenAmounts: [300] })
  ),
  "quantity_invalid"
);
// Množstvo smie chýbať — dosadí sa 1 ks, rovnako ako vo formulári. Cena
// takú možnosť nemá a to je celý rozdiel.
check(
  "chýbajúce množstvo prejde (doplní sa 1 ks)",
  checkVoiceInvoiceDraft(
    validDraft({ items: [{ description: "kopanie", unitPrice: 300 }], spokenAmounts: [300] })
  ),
  null
);

// -----------------------------------------------------------------------------
// 5. Ostatné brány
// -----------------------------------------------------------------------------
check("bez oprávnenia", checkVoiceInvoiceDraft(validDraft({ financeManage: false })), "not_authorized");
check("bez partnera", checkVoiceInvoiceDraft(validDraft({ partnerId: null })), "partner_missing");
check(
  "podvrhnutý partner (nie UUID)",
  checkVoiceInvoiceDraft(validDraft({ partnerId: "tester1" })),
  "partner_missing"
);
check("prázdny popis", checkVoiceInvoiceDraft(validDraft({ items: [{ description: "  ", unitPrice: 300 }], spokenAmounts: [300] })), "description_empty");
check("žiadne položky", checkVoiceInvoiceDraft(validDraft({ items: [], spokenAmounts: [] })), "no_items");
check(
  "príliš veľa položiek",
  checkVoiceInvoiceDraft(
    validDraft({
      items: Array.from({ length: 11 }, (_, i) => ({ description: `p${i}`, unitPrice: 10 })),
      spokenAmounts: Array.from({ length: 11 }, () => 10),
    })
  ),
  "too_many_items"
);
check("neplatná mena", checkVoiceInvoiceDraft(validDraft({ currency: "eur" })), "currency_invalid");
check("chýbajúca DPH kategória", checkVoiceInvoiceDraft(validDraft({ vatCategoryCode: null })), "vat_missing");
check("sadzba mimo rozsahu", checkVoiceInvoiceDraft(validDraft({ vatRate: 250 })), "vat_invalid");
check("nedokončený dialóg", checkVoiceInvoiceDraft(validDraft({ pendingQuestions: 1 })), "clarification_pending");
check("parser si nebol istý", checkVoiceInvoiceDraft(validDraft({ parserAmbiguous: true })), "parser_ambiguous");
check("zmiešané režimy ceny", checkVoiceInvoiceDraft(validDraft({ priceModeMixed: true })), "price_mode_mixed");
check("neplatný dátum", checkVoiceInvoiceDraft(validDraft({ localDate: "2026-02-31" })), "local_date_invalid");
check("chýbajúci dátum", checkVoiceInvoiceDraft(validDraft({ localDate: null })), "local_date_invalid");
check("neuplatnená idempotencia", checkVoiceInvoiceDraft(validDraft({ idempotencyClaimed: false })), "idempotency_not_claimed");

// -----------------------------------------------------------------------------
// 6. Režim ceny sa rozpozná — a NEZAMIEŇA sa so sadzbou
//
// Podrobné jazykové varianty má scripts/price-mode-tests.ts; tu ide o to,
// že brána a detektor hovoria o tom istom.
// -----------------------------------------------------------------------------
check('SK: „ceny sú s DPH"', detectPriceModeStatement("Uvedené ceny sú už s DPH."), "gross");
check('SK: „ceny sú bez DPH"', detectPriceModeStatement("Nie, ceny sú bez DPH."), "net");
check('SK: „s 23 percent DPH" NIE JE režim ceny', detectPriceModeStatement("kopanie 300 eur s 23 percent DPH"), null);
check('SK: „prvá cena je s DPH" je zmiešaný režim', detectPriceModeStatement("Prvá cena je s DPH."), "mixed");
check('DE: „inkl. MwSt"', detectPriceModeStatement("Die Preise sind inkl. MwSt."), "gross");
check('EN: „prices include VAT"', detectPriceModeStatement("Prices include VAT."), "gross");

// -----------------------------------------------------------------------------
// 7. Reťaz parser → brána na reálnom prepise
//
// Overuje, že to, čo parser vráti, bránou naozaj prejde — a že sumy, ktoré
// brána porovnáva, pochádzajú z tej istej vety.
// -----------------------------------------------------------------------------
{
  const TRANSCRIPT = "Vytvor faktúru Tester 1, kopanie za 300 eur, dovoz za 45 eur s 23 percentnou DPH.";
  const parsed = extractInvoiceItems(TRANSCRIPT, "Tester 1");

  check("reálny prepis: dve položky", parsed.items.length, 2);
  check("reálny prepis: kopanie 300", parsed.items[0], {
    description: "kopanie",
    unitPrice: 300,
    currency: "EUR",
  });
  check("reálny prepis: dovoz 45", parsed.items[1], {
    description: "dovoz",
    unitPrice: 45,
    currency: "EUR",
  });

  const spoken = parsed.items.map((item) => item.unitPrice as number);
  check(
    "reálny prepis prejde bránou",
    checkVoiceInvoiceDraft(
      validDraft({
        items: parsed.items.map((item) => ({
          description: item.description,
          unitPrice: item.unitPrice,
        })),
        spokenAmounts: spoken,
      })
    ),
    null
  );

  // Meno partnera obsahuje číslo. Do peňazí nepatrí — a práve odtiaľ
  // pochádzala jednotka na chybnom doklade.
  check('„Tester 1“ prispeje jednotkou do surových tokenov', moneyTokens(TRANSCRIPT).includes(1), true);
  check("ale medzi cenami položiek nie je", spoken.includes(1), false);
}

// -----------------------------------------------------------------------------

console.log(`\n${passed} prešlo, ${failed} zlyhalo`);
if (failed > 0) process.exit(1);
