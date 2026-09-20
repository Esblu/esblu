import type { Invoice } from "@/lib/invoices";
import type { CandidateParty, ReceivedInvoiceCandidate } from "@/lib/invoicing/received-candidate";

// =============================================================================
// Dedupe prijatých faktúr.
//
// Tá istá faktúra príde ako foto zo stavby, ako PDF mailom účtovníčke a od
// 2027 ako Peppol XML. Bez dedupe AI Inbox aktívne škodí.
//
// VRSTVY (docs/received-invoice-dedupe-en16931-design.md §2)
//   A  exact source hash        documents.content_sha256      — pred uploadom
//   B  structured fingerprint   invoices.dedupe_fingerprint   — tento modul
//   C  transport ID             invoices.transport_message_id — až s Peppolom
//   D  source document          invoices.source_document_id   — RPC
//
// ABSOLÚTNE PRAVIDLO: systém nikdy automaticky nemaže dokument. Ani pri
// exact zhode. Duplikát znamená "neveď druhý canonical záznam", nie
// "zahoď dáta".
//
// EXACT vs NEAR: exact duplicate smie DB blokovať, near duplicate iba varuje
// a rozhoduje používateľ. Zamieňať to by znamenalo buď tiché prepisovanie
// účtovných záznamov, alebo zablokovanie legitímnej opravnej cesty.
// =============================================================================

/**
 * Normalizácia čísla dokladu. MUSÍ zostať zhodná s partial unique indexom
 * invoices_received_supplier_number_uniq a s RPC
 * esblu_create_received_invoice_draft:
 *
 *   upper(regexp_replace(value, '[\s\-/]', '', 'g'))
 *
 * Vedúce nuly sa ZÁMERNE nezahadzujú — FA-0001 a FA-1 sú rôzne doklady.
 */
export function normalizeSupplierInvoiceNumber(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s\-/]/g, "").toUpperCase();
  return normalized === "" ? null : normalized;
}

/**
 * Identita dodávateľa pre fingerprint — prvá neprázdna vyhráva:
 *   1. vat_identifier / IČ DPH
 *   2. legal_registration_scheme_id : legal_registration_id
 *   3. SK:ICO: + IČO
 *   4. nič → null
 *
 * Bod 4 je zásadný. Bez spoľahlivého identifikátora sa fingerprint NEPOČÍTA
 * vôbec. Porovnávať faktúry podľa mena firmy je presne ten typ heuristiky,
 * ktorý spôsobí buď falošnú zhodu (dve rôzne faktúry splynú), alebo falošné
 * odmietnutie (legitímna faktúra sa nedá zaevidovať). Ani jedno nie je
 * prijateľné pri účtovnom zázname.
 */
export function normalizePartyIdentity(party: CandidateParty): string | null {
  const vat = (party.vat_identifier ?? party.ic_dph ?? "").replace(/[\s.\-/]/g, "").toUpperCase();
  if (vat) return vat;

  if (party.legal_registration_id && party.legal_registration_scheme_id) {
    const scheme = party.legal_registration_scheme_id.replace(/[\s.\-/]/g, "").toUpperCase();
    const id = party.legal_registration_id.replace(/[\s.\-/]/g, "").toUpperCase();
    if (scheme && id) return `${scheme}:${id}`;
  }

  const ico = (party.ico ?? "").replace(/[\s.\-/]/g, "").toUpperCase();
  if (ico) return `SK:ICO:${ico}`;

  return null;
}

function normalizeAmount(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "";
  // Rovnaký tvar ako to_char(round(v,2),'FM999999999990.00') na DB strane.
  return value.toFixed(2);
}

async function sha256Hex(input: string): Promise<string | null> {
  // Web Crypto je dostupné v prehliadači aj v Node 18+. Ak by nebolo
  // (starý webview, neistý kontext), fingerprint sa NEPOČÍTA — radšej
  // žiadny dedupe než nesprávny.
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef?.subtle) return null;

  const bytes = new TextEncoder().encode(input);
  const digest = await cryptoRef.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Vrstva B — deterministický fingerprint identity dokladu.
 *
 *   sha256( sellerIdentity | číslo | issue_date | total | currency | kind )
 *
 * Vracia null, ak dodávateľ nemá spoľahlivý identifikátor alebo chýba
 * niektorá zložka. NULL znamená "dedupe pre tento doklad nebeží" — UI to
 * musí používateľovi povedať, nie to ticho preskočiť.
 *
 * `total` sa zámerne berie z CANONICAL prepočtu riadkov, nie z dokumentu:
 * fingerprint musí byť rovnaký pre PDF aj XML tej istej faktúry, a jediné,
 * čo je pri oboch cestách rovnaké, je náš vlastný prepočet.
 */
export async function computeDedupeFingerprint(params: {
  supplier: CandidateParty;
  supplierInvoiceNumber: string | null;
  issueDate: string | null;
  canonicalTotal: number | null;
  currency: string | null;
  kind: string;
}): Promise<string | null> {
  const sellerIdentity = normalizePartyIdentity(params.supplier);
  const number = normalizeSupplierInvoiceNumber(params.supplierInvoiceNumber);
  const currency = (params.currency ?? "").trim().toUpperCase();
  const total = normalizeAmount(params.canonicalTotal);

  if (!sellerIdentity || !number || !params.issueDate || !currency || total === "") {
    return null;
  }

  return sha256Hex(
    [sellerIdentity, number, params.issueDate, total, currency, params.kind].join("|")
  );
}

// -----------------------------------------------------------------------------
// Vyhľadanie duplikátov v už načítaných faktúrach firmy
// -----------------------------------------------------------------------------

export type ExactDuplicateReason =
  | "supplier_invoice_number"
  | "dedupe_fingerprint"
  | "source_document";

export type ExactDuplicate = {
  invoice: Invoice;
  reason: ExactDuplicateReason;
};

/**
 * Klientský pre-check exact duplicity — slúži na to, aby používateľ videl
 * varovanie ešte PRED odoslaním, nie ako záruka.
 *
 * Skutočnou zárukou je RPC esblu_create_received_invoice_draft, ktorá tú istú
 * kontrolu spraví vnútri transakcie. Aplikačný pre-check je race condition:
 * dvaja používatelia môžu potvrdiť ten istý doklad súčasne.
 */
export function findExactDuplicate(
  invoices: readonly Invoice[],
  params: {
    supplierBusinessPartnerId: string | null;
    supplierInvoiceNumber: string | null;
    dedupeFingerprint: string | null;
    sourceDocumentId: string | null;
    kind?: string;
  }
): ExactDuplicate | null {
  const kind = params.kind ?? "regular_invoice";
  const number = normalizeSupplierInvoiceNumber(params.supplierInvoiceNumber);

  if (params.supplierBusinessPartnerId && number) {
    const hit = invoices.find(
      (invoice) =>
        invoice.direction === "received" &&
        invoice.kind === kind &&
        invoice.supplier_business_partner_id === params.supplierBusinessPartnerId &&
        normalizeSupplierInvoiceNumber(invoice.supplier_invoice_number) === number
    );
    if (hit) return { invoice: hit, reason: "supplier_invoice_number" };
  }

  if (params.dedupeFingerprint) {
    const hit = invoices.find(
      (invoice) =>
        invoice.direction === "received" &&
        invoice.dedupe_fingerprint === params.dedupeFingerprint
    );
    if (hit) return { invoice: hit, reason: "dedupe_fingerprint" };
  }

  if (params.sourceDocumentId) {
    const hit = invoices.find(
      (invoice) => invoice.source_document_id === params.sourceDocumentId
    );
    if (hit) return { invoice: hit, reason: "source_document" };
  }

  return null;
}

export type NearDuplicateSignal = "same_supplier" | "same_amount" | "close_issue_date";

export type NearDuplicate = {
  invoice: Invoice;
  signals: NearDuplicateSignal[];
};

const NEAR_DUPLICATE_DATE_WINDOW_DAYS = 3;

function daysBetween(a: string, b: string): number | null {
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return Math.abs(left - right) / 86_400_000;
}

/**
 * Near-duplicate — zachytáva to, čo exact vrstva zo svojej podstaty nemôže:
 * OCR preklep v čísle alebo sume. NIKDY neblokuje, iba varuje.
 *
 * Kandidát sa hlási pri zhode v DVOCH a viac signáloch. Jeden signál (napr.
 * len rovnaký dodávateľ) by vyrobil varovanie pri každej druhej faktúre a
 * používateľ by ho prestal čítať.
 */
export function findNearDuplicates(
  invoices: readonly Invoice[],
  params: {
    supplierBusinessPartnerId: string | null;
    issueDate: string | null;
    canonicalTotal: number | null;
    currency: string | null;
    excludeInvoiceId?: string | null;
  }
): NearDuplicate[] {
  const results: NearDuplicate[] = [];

  for (const invoice of invoices) {
    if (invoice.direction !== "received") continue;
    if (params.excludeInvoiceId && invoice.id === params.excludeInvoiceId) continue;

    const signals: NearDuplicateSignal[] = [];

    if (
      params.supplierBusinessPartnerId &&
      invoice.supplier_business_partner_id === params.supplierBusinessPartnerId
    ) {
      signals.push("same_supplier");
    }

    if (
      params.canonicalTotal !== null &&
      params.currency &&
      invoice.currency?.toUpperCase() === params.currency.toUpperCase() &&
      Math.abs(Number(invoice.total_amount) - params.canonicalTotal) <= 0.01
    ) {
      signals.push("same_amount");
    }

    if (params.issueDate && invoice.issue_date) {
      const distance = daysBetween(params.issueDate, invoice.issue_date);
      if (distance !== null && distance <= NEAR_DUPLICATE_DATE_WINDOW_DAYS) {
        signals.push("close_issue_date");
      }
    }

    if (signals.length >= 2) {
      results.push({ invoice, signals });
    }
  }

  return results;
}

/**
 * Vrstva A — SHA-256 binárneho obsahu súboru pre documents.content_sha256.
 * Chytí dvakrát nahratý ten istý súbor. Nechytí tú istú faktúru ako iný
 * sken — na to je vrstva B.
 */
export async function computeFileSha256(file: Blob): Promise<string | null> {
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef?.subtle) return null;
  try {
    const buffer = await file.arrayBuffer();
    const digest = await cryptoRef.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

/** Zhrnutie pre review UI. */
export type DedupeVerdict = {
  exact: ExactDuplicate | null;
  near: NearDuplicate[];
  /** True keď dodávateľ nemá identifikátor a fingerprint sa nepočítal. */
  fingerprintUnavailable: boolean;
};

export function buildDedupeVerdict(params: {
  invoices: readonly Invoice[];
  candidate: Pick<ReceivedInvoiceCandidate, "supplier_invoice_number" | "issue_date" | "currency">;
  supplierBusinessPartnerId: string | null;
  dedupeFingerprint: string | null;
  sourceDocumentId: string | null;
  canonicalTotal: number | null;
}): DedupeVerdict {
  const exact = findExactDuplicate(params.invoices, {
    supplierBusinessPartnerId: params.supplierBusinessPartnerId,
    supplierInvoiceNumber: params.candidate.supplier_invoice_number,
    dedupeFingerprint: params.dedupeFingerprint,
    sourceDocumentId: params.sourceDocumentId,
  });

  return {
    exact,
    // Near-duplicate má zmysel ukazovať len keď exact nezasiahol — inak by
    // sa používateľovi zobrazili dve varovania o tom istom doklade.
    near: exact
      ? []
      : findNearDuplicates(params.invoices, {
          supplierBusinessPartnerId: params.supplierBusinessPartnerId,
          issueDate: params.candidate.issue_date,
          canonicalTotal: params.canonicalTotal,
          currency: params.candidate.currency,
        }),
    fingerprintUnavailable: params.dedupeFingerprint === null,
  };
}
