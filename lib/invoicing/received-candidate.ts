import type { VatCategoryCode } from "@/lib/invoicing/vat-engine";

// =============================================================================
// ReceivedInvoiceCandidate — normalizovaný kandidát prijatej faktúry.
//
// PREČO TÁTO VRSTVA EXISTUJE
// --------------------------
// Review obrazovka nesmie byť naviazaná na tvar výstupu AI/OCR. Presne ten
// istý review a presne tá istá canonical cesta bude neskôr obsluhovať
// štruktúrovaný eInvoice (UBL/XML, Peppol, provider payload) — tam žiadne
// "confidence" ani "rawText" neexistuje, zato sú dáta presné.
//
// Kandidát je preto zámerne hlúpy DTO: čo v dokumente reálne stálo. Nie je
// to faktúra. Faktúra vzniká až potvrdením používateľa a canonical zápisom
// do DB, ktorá je jediná autorita.
//
// PRAVIDLÁ, KTORÉ TENTO MODUL VYNUCUJE
// ------------------------------------
//   • Neistota = null. Nikdy nie prázdny reťazec, nikdy nie odhad.
//   • AI nikdy neurčuje VAT kategóriu, dôvod oslobodenia, reverse-charge,
//     unit_code ani zhodu dodávateľa. Tie polia môžu prísť ako NÁVRH
//     (`*_suggested`), ale do canonical zápisu ich dostane len používateľ.
//   • Sumy z dokumentu sú comparison signal, nie autorita. Canonical totals
//     sa počítajú z riadkov a finalizuje ich DB.
// =============================================================================

/** Odkiaľ kandidát prišiel. Review vrstva sa podľa toho NEVETVÍ — slúži na
 *  audit a na to, aby UI vedelo, či má zmysel zobrazovať OCR confidence. */
export type ReceivedCandidateSource = "ai_ocr" | "ubl_xml" | "provider" | "manual";

/**
 * Identita strany v rozsahu, v akom ju canonical model (business_partners /
 * invoice_parties) pozná. Zámerne rovnaké názvy polí ako v DB — kandidát sa
 * tak mapuje na master data bez prekladovej tabuľky.
 */
export type CandidateParty = {
  legal_name: string | null;
  ico: string | null;
  dic: string | null;
  ic_dph: string | null;
  /** EN16931 BT-31 (seller) / BT-48 (buyer). */
  vat_identifier: string | null;
  /** EN16931 BT-30 / BT-47. */
  legal_registration_id: string | null;
  legal_registration_scheme_id: string | null;
  /** EN16931 BT-34 / BT-49. */
  electronic_address: string | null;
  electronic_address_scheme_id: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  postal_code: string | null;
  country_code: string | null;
  email: string | null;
};

export type CandidateLineItem = {
  description: string | null;
  quantity: number | null;
  /** Voľný textový label tak, ako stál v dokumente ("ks", "hod", "m3"). */
  unit: string | null;
  /**
   * NÁVRH kanonického UN/ECE kódu. Nikdy sa neodvodzuje z `unit` bez
   * potvrdenia — do canonical zápisu ide len to, čo používateľ potvrdil.
   */
  unit_code_suggested: string | null;
  unit_price: number | null;
  /**
   * NÁVRH VAT kategórie. AI nie je daňová autorita; kým používateľ
   * nepotvrdí, review UI musí túto položku považovať za nevyriešenú.
   */
  vat_category_suggested: VatCategoryCode | null;
  /** NÁVRH sadzby. Význam má výhradne pre kategóriu S. */
  vat_rate_suggested: number | null;
};

/** Sumy prečítané z dokumentu. VÝHRADNE porovnávací signál (§12 zadania). */
export type CandidateDocumentTotals = {
  subtotal: number | null;
  vat_total: number | null;
  total: number | null;
};

export type ReceivedInvoiceCandidate = {
  source: ReceivedCandidateSource;
  supplier: CandidateParty;
  /** Odberateľ z dokumentu — používa sa len na sanity check "je to naozaj
   *  faktúra pre nás", nikdy sa z neho nič nezapisuje. */
  buyer: CandidateParty | null;
  supplier_invoice_number: string | null;
  issue_date: string | null;
  due_date: string | null;
  delivery_date: string | null;
  tax_point_date: string | null;
  currency: string | null;
  iban: string | null;
  bic: string | null;
  payment_reference: string | null;
  variable_symbol: string | null;
  buyer_reference: string | null;
  purchase_order_reference: string | null;
  items: CandidateLineItem[];
  document_totals: CandidateDocumentTotals | null;
  /** Prepojenie na zdroj (documents.id pri AI/OCR ceste). */
  source_document_id: string | null;
  /** Iba pri source='ai_ocr'. Štruktúrované zdroje confidence nemajú. */
  extraction_confidence: number | null;
};

// -----------------------------------------------------------------------------
// Normalizačné helpery
// -----------------------------------------------------------------------------

/** Prázdny/whitespace reťazec je neznáma hodnota, nie hodnota. */
export function candidateText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function candidateNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    // Európske formáty: "1 234,56" aj "1.234,56" aj "1234.56".
    const normalized = trimmed
      .replace(/\s/g, "")
      .replace(/\.(?=\d{3}\b)/g, "")
      .replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Dátum sa akceptuje IBA ako jednoznačné ISO `YYYY-MM-DD`. Formáty typu
 * `03/04/2026` sú v SK/DE/EN kontexte nejednoznačné (marec vs apríl) a
 * hádať ich by znamenalo vyrobiť nesprávny daňový dátum — preto null.
 * Prompt extrakčného modelu žiada ISO, takže toto je posledná poistka.
 */
export function candidateIsoDate(value: unknown): string | null {
  const text = candidateText(value);
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return text;
}

export function emptyCandidateParty(): CandidateParty {
  return {
    legal_name: null,
    ico: null,
    dic: null,
    ic_dph: null,
    vat_identifier: null,
    legal_registration_id: null,
    legal_registration_scheme_id: null,
    electronic_address: null,
    electronic_address_scheme_id: null,
    address_line1: null,
    address_line2: null,
    city: null,
    postal_code: null,
    country_code: null,
    email: null,
  };
}

const VAT_CATEGORY_VALUES: readonly VatCategoryCode[] = ["S", "Z", "E", "AE"];

function candidateVatCategory(value: unknown): VatCategoryCode | null {
  const text = candidateText(value);
  if (!text) return null;
  const upper = text.toUpperCase();
  return (VAT_CATEGORY_VALUES as readonly string[]).includes(upper)
    ? (upper as VatCategoryCode)
    : null;
}

// -----------------------------------------------------------------------------
// Adaptér: výstup /api/scan-document → kandidát
// -----------------------------------------------------------------------------

/**
 * Tvar, v akom extrakčná route vracia `invoiceFields`. Držaný voľne
 * (`unknown` hodnoty), pretože ide o výstup modelu — každé pole sa
 * normalizuje cez helpery vyššie a nič sa nepreberá naslepo.
 */
export type ScanInvoiceFieldsLike = Record<string, unknown> | null | undefined;

function partyFromScan(prefix: "supplier" | "customer", fields: Record<string, unknown>): CandidateParty {
  const party = emptyCandidateParty();
  party.legal_name = candidateText(fields[prefix]);
  party.ico = candidateText(fields[`${prefix}Ico`]);
  party.dic = candidateText(fields[`${prefix}Dic`]);
  party.ic_dph = candidateText(fields[`${prefix}VatId`]);
  // IČ DPH a EN16931 vat_identifier sú v SK/CZ/DE praxi ten istý reťazec.
  // Canonical vrstva ho potrebuje pod vat_identifier, convenience vrstva
  // pod ic_dph — držíme obe, nevymýšľame rozdiel, ktorý dokument nemá.
  party.vat_identifier = party.ic_dph;
  party.address_line1 = candidateText(fields[`${prefix}Address`]);
  party.city = candidateText(fields[`${prefix}City`]);
  party.postal_code = candidateText(fields[`${prefix}PostalCode`]);
  party.country_code = candidateText(fields[`${prefix}CountryCode`])?.toUpperCase() ?? null;
  party.email = candidateText(fields[`${prefix}Email`]);
  return party;
}

function itemsFromScan(raw: unknown): CandidateLineItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): CandidateLineItem | null => {
      if (!entry || typeof entry !== "object") return null;
      const row = entry as Record<string, unknown>;
      const description = candidateText(row.description);
      // Riadok bez popisu nie je položka — zahodiť je správnejšie než
      // vyrobiť prázdny riadok, ktorý používateľ musí mazať.
      if (!description) return null;
      return {
        description,
        quantity: candidateNumber(row.quantity),
        unit: candidateText(row.unit),
        unit_code_suggested: candidateText(row.unitCode),
        unit_price: candidateNumber(row.unitPrice),
        vat_category_suggested: candidateVatCategory(row.vatCategoryCode),
        vat_rate_suggested: candidateNumber(row.vatRate),
      };
    })
    .filter((item): item is CandidateLineItem => item !== null);
}

/**
 * Preloží `invoiceFields` z /api/scan-document na canonical kandidáta.
 * Nič nedopĺňa a nič nedopočítava — chýbajúce pole zostáva null a review
 * obrazovka ho ukáže ako prázdne, nie ako uhádnutú hodnotu.
 */
export function receivedCandidateFromScan(params: {
  fields: ScanInvoiceFieldsLike;
  sourceDocumentId: string | null;
  confidence?: number | null;
}): ReceivedInvoiceCandidate {
  const fields = (params.fields ?? {}) as Record<string, unknown>;

  return {
    source: "ai_ocr",
    supplier: partyFromScan("supplier", fields),
    buyer: partyFromScan("customer", fields),
    supplier_invoice_number: candidateText(fields.invoiceNumber),
    issue_date: candidateIsoDate(fields.issueDate),
    due_date: candidateIsoDate(fields.dueDate),
    delivery_date: candidateIsoDate(fields.deliveryDate),
    tax_point_date: candidateIsoDate(fields.taxPointDate),
    currency: candidateText(fields.currency)?.toUpperCase() ?? null,
    iban: candidateText(fields.iban)?.replace(/\s/g, "").toUpperCase() ?? null,
    bic: candidateText(fields.bic)?.replace(/\s/g, "").toUpperCase() ?? null,
    payment_reference: candidateText(fields.paymentReference),
    variable_symbol: candidateText(fields.variableSymbol),
    buyer_reference: candidateText(fields.buyerReference),
    purchase_order_reference: candidateText(fields.purchaseOrderReference),
    items: itemsFromScan(fields.lineItems),
    document_totals: {
      subtotal: candidateNumber(fields.subtotalAmount),
      vat_total: candidateNumber(fields.vatAmount),
      total: candidateNumber(fields.totalAmount),
    },
    source_document_id: params.sourceDocumentId,
    extraction_confidence:
      typeof params.confidence === "number" && Number.isFinite(params.confidence)
        ? params.confidence
        : null,
  };
}

// -----------------------------------------------------------------------------
// Porovnanie dokumentových a canonical súm (§12 zadania)
// -----------------------------------------------------------------------------

export type TotalsComparison = {
  /** Suma z dokumentu (to, čo AI prečítala). Môže byť null. */
  documentTotal: number | null;
  /** Suma vypočítaná z riadkov canonical engine. Vždy definovaná. */
  computedTotal: number;
  /** Absolútny rozdiel, ak sa dá porovnať. */
  difference: number | null;
  /** True ak sa dá porovnať a rozdiel presahuje toleranciu. */
  mismatch: boolean;
};

/**
 * Tolerancia 0,01 € pokrýva legitímne rozdiely zaokrúhľovania medzi
 * dodávateľovým systémom a naším per-kategóriu prepočtom. Väčší rozdiel je
 * varovanie pre používateľa — nikdy nie dôvod prepísať canonical sumu
 * hodnotou z dokumentu.
 */
export function compareCandidateTotals(
  documentTotal: number | null,
  computedTotal: number,
  toleranceEur = 0.01
): TotalsComparison {
  if (documentTotal === null || !Number.isFinite(documentTotal)) {
    return { documentTotal: null, computedTotal, difference: null, mismatch: false };
  }
  const difference = Math.abs(documentTotal - computedTotal);
  return {
    documentTotal,
    computedTotal,
    difference,
    mismatch: difference > toleranceEur + Number.EPSILON,
  };
}
