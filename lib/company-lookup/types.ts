// =============================================================================
// Esblu — Company lookup (PHASE 1): spoločný kontrakt providerov a API.
// =============================================================================
// Modul je bez importov a bez "server-only": typy zdieľa server (provider
// vrstva, API routes) aj klient (CompanyLookupCombobox). Žiadna logika.
//
// Pravidlá kontraktu (audit 2026-10-01, časť E):
//   - každý výsledok nesie source + authority + checkedAt + status,
//   - status je VERIFIED / STALE / UNAVAILABLE / NOT_FOUND — nikdy sa
//     výpadok providera nevydáva za "subjekt neexistuje",
//   - authority je pevne daná typom zdroja (nie AI, nie heuristika),
//   - providerRef je technický odkaz do registra (napr. "rpo:1003617"),
//     NIKDY osobný údaj,
//   - do výsledku sa nedostanú štatutári, ich adresy, spoločníci ani surová
//     odpoveď providera (data minimization).
// =============================================================================

export type VerificationStatus = "VERIFIED" | "STALE" | "UNAVAILABLE" | "NOT_FOUND";

export type SourceAuthority =
  | "official_registry"
  | "licensed_aggregator"
  | "document_extracted"
  | "user_declared";

export type ProviderErrorCode =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "UPSTREAM_HTTP"
  | "BAD_RESPONSE"
  | "TOO_LARGE"
  | "NETWORK"
  | "CIRCUIT_OPEN"
  | "AMBIGUOUS";

export type ProviderError = { code: ProviderErrorCode; retryable: boolean };

export type ProviderResult<T> = {
  source: CompanyLookupSourceId;
  authority: SourceAuthority;
  /** ISO čas pokusu. */
  checkedAt: string;
  status: VerificationStatus;
  data: T | null;
  /** Technický odkaz do registra, bez osobných údajov. */
  providerRef: string | null;
  error: ProviderError | null;
};

export type CompanyLookupSourceId = "rpo" | "ruz";

export type CompanyRegistryStatus = "active" | "terminated";

/** Jeden návrh v autocomplete — iba to, čo treba na rozpoznanie firmy. */
export type CompanyCandidate = {
  ico: string;
  name: string;
  city: string | null;
  status: CompanyRegistryStatus;
  terminatedOn: string | null;
  registryRef: string;
};

export type CompanyLegalForm = { code: string; name: string };

/** Údaje na predvyplnenie obchodného partnera. Nič navyše. */
export type CompanyDetail = {
  ico: string;
  name: string;
  /** Z RÚZ; null ak subjekt v RÚZ nie je, RÚZ nedostupný alebo nejednoznačný. */
  dic: string | null;
  addressLine1: string | null;
  city: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2, iba ak ho vieme bezpečne odvodiť z číselníka RPO. */
  countryCode: string | null;
  legalForm: CompanyLegalForm | null;
  status: CompanyRegistryStatus;
  terminatedOn: string | null;
  establishedOn: string | null;
  /** Názov zdrojového registra (napr. "Obchodný register", "Živnostenský register"). */
  sourceRegister: string | null;
  registryRef: string;
  /** Kontrolná číslica IČO — iba varovanie, nikdy dôvod na odmietnutie. */
  icoChecksumValid: boolean;
};

export type CompanyLookupWarning =
  | "RPO_DETAIL_UNAVAILABLE"
  | "RUZ_UNAVAILABLE"
  | "RUZ_NOT_FOUND"
  | "DIC_AMBIGUOUS"
  | "ICO_CHECKSUM";

export interface CompanyLookupProvider {
  readonly id: CompanyLookupSourceId;
  readonly authority: SourceAuthority;
  searchByName(query: string, opts: { onlyActive: boolean; limit: number }): Promise<ProviderResult<CompanyCandidate[]>>;
  searchByIco(ico: string, opts: { limit: number }): Promise<ProviderResult<CompanyCandidate[]>>;
  getDetailByIco(ico: string): Promise<ProviderResult<Omit<CompanyDetail, "dic">>>;
}

/** Enrichment (RÚZ) — iba DIČ podľa IČO. */
export interface CompanyTaxIdEnrichmentProvider {
  readonly id: CompanyLookupSourceId;
  readonly authority: SourceAuthority;
  getDicByIco(ico: string): Promise<ProviderResult<{ dic: string | null; ambiguous: boolean }>>;
}

// -----------------------------------------------------------------------------
// HTTP kontrakt /api/company-lookup/*
// -----------------------------------------------------------------------------

export type CompanyLookupErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "QUERY_TOO_SHORT"
  | "INVALID_QUERY"
  | "INVALID_ICO"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "UNAVAILABLE";

export type CompanyLookupErrorBody = { ok: false; code: CompanyLookupErrorCode };

export type CompanySearchResponseBody = {
  ok: true;
  mode: "name" | "ico";
  status: VerificationStatus;
  source: CompanyLookupSourceId;
  checkedAt: string;
  results: CompanyCandidate[];
};

export type CompanyDetailResponseBody = {
  ok: true;
  checkedAt: string;
  company: CompanyDetail;
  sources: { id: CompanyLookupSourceId; status: VerificationStatus }[];
  warnings: CompanyLookupWarning[];
};
