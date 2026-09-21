import type { BusinessPartner } from "@/lib/business-partners";
import type { CandidateParty } from "@/lib/invoicing/received-candidate";
import { partnerNameExactKey } from "@/lib/partner-matching";

// =============================================================================
// Supplier matching — priradenie dodávateľa z kandidáta k master data.
//
// ZÁVÄZNÉ PRAVIDLO (§6 zadania):
//   Zhoda mena firmy NIKDY sama osebe neauto-selectuje.
//
// Dôvod nie je opatrnosť pre opatrnosť. Zlý partner v master data sa šíri do
// všetkých budúcich faktúr a do XML výstupu, kde už je právne záväzný.
// "Stavby s.r.o." a "STAVBY s. r. o." môžu a nemusia byť tá istá firma —
// rozhodnúť to vie človek, nie Levenshtein.
//
// Preto je priorita postavená tak, že auto-match dovolia len DETERMINISTICKÉ
// identifikátory (1–4), a meno (5) je vždy len návrh na potvrdenie.
// =============================================================================

/** Podľa čoho zhoda vznikla. Poradie = priorita, 1 je najsilnejšia. */
export type SupplierMatchCriterion =
  | "vat_identifier"
  | "legal_registration"
  | "electronic_address"
  | "ico"
  | "legal_name";

export type SupplierMatchStatus =
  /** Jeden partner, deterministický identifikátor. Predvybrať a označiť ako potvrdené. */
  | "exact"
  /** Jeden partner, ale iba podľa mena. Predvybrať NESMIE — len navrhnúť. */
  | "probable"
  /** Viac kandidátov. Nikdy nepredvyberať, vždy nechať vybrať. */
  | "ambiguous"
  /** Nič sa nenašlo. Ponúknuť vytvorenie nového — po potvrdení. */
  | "none";

export type SupplierMatch = {
  partner: BusinessPartner;
  criterion: SupplierMatchCriterion;
  /** True iba pre kritériá 1–4. */
  deterministic: boolean;
};

export type SupplierMatchResult = {
  status: SupplierMatchStatus;
  matches: SupplierMatch[];
  /**
   * Partner, ktorý sa smie predvyplniť do formulára. Nenulový VÝHRADNE pri
   * status === "exact". Pri "probable"/"ambiguous"/"none" je vždy null —
   * používateľ musí vybrať sám.
   */
  autoSelected: BusinessPartner | null;
};

// -----------------------------------------------------------------------------
// Normalizácia identifikátorov
// -----------------------------------------------------------------------------

/** Veľké písmená, bez medzier, pomlčiek a bodiek. `null` pre prázdnu hodnotu. */
function normalizeIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s.\-/]/g, "").toUpperCase();
  return normalized === "" ? null : normalized;
}

/**
 * Meno firmy na porovnanie: bez diakritiky, bez právnej formy, bez
 * interpunkcie, jednoduché medzery. "Stavby, s. r. o." → "STAVBY".
 *
 * Samotná definícia sa presunula do lib/partner-matching.ts, aby existovala
 * RAZ — ten istý kanonický názov potrebuje aj hlasové rozpoznanie
 * odberateľa. Správanie sa presunom NEZMENILO; tento re-export drží
 * doterajší názov, takže párovanie dodávateľov je bit po bite to isté.
 */
export { partnerNameExactKey as normalizeCompanyName } from "@/lib/partner-matching";

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

/** Kritériá 1–4 v poradí priority. Každé musí byť exact na normalizovanej hodnote. */
const DETERMINISTIC_CRITERIA: ReadonlyArray<{
  criterion: SupplierMatchCriterion;
  candidateValue: (party: CandidateParty) => string | null;
  partnerValue: (partner: BusinessPartner) => string | null;
}> = [
  {
    criterion: "vat_identifier",
    candidateValue: (p) => normalizeIdentifier(p.vat_identifier ?? p.ic_dph),
    partnerValue: (p) => normalizeIdentifier(p.vat_identifier ?? p.ic_dph),
  },
  {
    criterion: "legal_registration",
    // Scheme ID je súčasťou kľúča — to isté číslo v inej schéme je iná identita.
    candidateValue: (p) =>
      p.legal_registration_id && p.legal_registration_scheme_id
        ? `${normalizeIdentifier(p.legal_registration_scheme_id)}:${normalizeIdentifier(p.legal_registration_id)}`
        : null,
    partnerValue: (p) =>
      p.legal_registration_id && p.legal_registration_scheme_id
        ? `${normalizeIdentifier(p.legal_registration_scheme_id)}:${normalizeIdentifier(p.legal_registration_id)}`
        : null,
  },
  {
    criterion: "electronic_address",
    candidateValue: (p) =>
      p.electronic_address && p.electronic_address_scheme_id
        ? `${normalizeIdentifier(p.electronic_address_scheme_id)}:${normalizeIdentifier(p.electronic_address)}`
        : null,
    partnerValue: (p) =>
      p.electronic_address && p.electronic_address_scheme_id
        ? `${normalizeIdentifier(p.electronic_address_scheme_id)}:${normalizeIdentifier(p.electronic_address)}`
        : null,
  },
  {
    criterion: "ico",
    candidateValue: (p) => normalizeIdentifier(p.ico),
    partnerValue: (p) => normalizeIdentifier(p.ico),
  },
];

/**
 * Nájde dodávateľa pre kandidáta.
 *
 * `partners` je celý zoznam partnerov firmy (už RLS-scoped). Filtrovanie na
 * `kind` sa tu ZÁMERNE nerobí: partner vedený ako 'customer' nám legitímne
 * môže poslať faktúru a odmietnuť deterministickú zhodu na IČ DPH len kvôli
 * príznaku v master data by vyrobilo duplicitného partnera.
 */
export function matchSupplier(
  candidate: CandidateParty,
  partners: readonly BusinessPartner[]
): SupplierMatchResult {
  for (const rule of DETERMINISTIC_CRITERIA) {
    const wanted = rule.candidateValue(candidate);
    if (!wanted) continue;

    const hits = partners.filter((partner) => rule.partnerValue(partner) === wanted);
    if (hits.length === 1) {
      return {
        status: "exact",
        matches: [{ partner: hits[0], criterion: rule.criterion, deterministic: true }],
        autoSelected: hits[0],
      };
    }
    if (hits.length > 1) {
      // Ten istý deterministický identifikátor na dvoch partneroch je
      // nekonzistentné master data. Rozhodnúť musí používateľ — auto-match
      // by tu tipoval medzi dvoma rovnako silnými zhodami.
      return {
        status: "ambiguous",
        matches: hits.map((partner) => ({
          partner,
          criterion: rule.criterion,
          deterministic: true,
        })),
        autoSelected: null,
      };
    }
  }

  // Kritérium 5 — meno. Iba návrh, nikdy auto-select.
  const wantedName = partnerNameExactKey(candidate.legal_name);
  if (wantedName) {
    const nameHits = partners.filter(
      (partner) => partnerNameExactKey(partner.legal_name) === wantedName
    );
    if (nameHits.length === 1) {
      return {
        status: "probable",
        matches: [{ partner: nameHits[0], criterion: "legal_name", deterministic: false }],
        autoSelected: null,
      };
    }
    if (nameHits.length > 1) {
      return {
        status: "ambiguous",
        matches: nameHits.map((partner) => ({
          partner,
          criterion: "legal_name" as const,
          deterministic: false,
        })),
        autoSelected: null,
      };
    }
  }

  return { status: "none", matches: [], autoSelected: null };
}

/**
 * Posledná kontrola tesne pred vytvorením nového partnera.
 *
 * Medzi otvorením review obrazovky a kliknutím na "Vytvoriť dodávateľa" mohol
 * partnera založiť niekto iný (alebo ten istý používateľ v druhej karte).
 * Volajúci MUSÍ načítať čerstvý zoznam a spustiť toto — inak vznikne tichý
 * duplikát v master data.
 *
 * Vracia existujúceho partnera, ak deterministická zhoda existuje; inak null.
 */
export function findDeterministicDuplicate(
  candidate: CandidateParty,
  partners: readonly BusinessPartner[]
): BusinessPartner | null {
  for (const rule of DETERMINISTIC_CRITERIA) {
    const wanted = rule.candidateValue(candidate);
    if (!wanted) continue;
    const hit = partners.find((partner) => rule.partnerValue(partner) === wanted);
    if (hit) return hit;
  }
  return null;
}
