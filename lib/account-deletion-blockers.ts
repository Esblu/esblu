// =============================================================================
// Dôvody, prečo owner nemôže firmu zrušiť samoobslužne (zdieľané klient/server,
// bez závislostí). Zrkadlí OwnerDeletionBlocker v lib/account-deletion-retention.ts.
// =============================================================================

export type OwnerDeletionBlockerCode = "FINALIZED_ACCOUNTING_DOCUMENTS" | "EINVOICE_RECORDS" | "EINVOICE_PROVIDER_ENROLLED";

/** i18n kľúč vysvetlenia, prečo owner nemôže firmu zrušiť samoobslužne. */
export function ownerDeletionBlockerMessageKey(blocker: OwnerDeletionBlockerCode | null | undefined): string {
  switch (blocker) {
    case "EINVOICE_RECORDS":
      return "settings.errors.companyHasAccountingRecords";
    case "EINVOICE_PROVIDER_ENROLLED":
      return "settings.deleteModal.ownerBlockedEinvoiceEnrolled";
    default:
      return "settings.deleteModal.ownerBlockedRetention";
  }
}
