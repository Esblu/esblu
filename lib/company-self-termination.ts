// =============================================================================
// Samoobslužné ukončenie / výmaz firmy vlastníkom — prepínač (release 2026-11-26).
// Predvolene VYPNUTÉ; zapína sa iba ESBLU_COMPANY_SELF_TERMINATION=on (server).
// Používa ho výmaz (app/api/account/delete — 503 ESBLU_COMPANY_DELETION_SUPPORT_ONLY)
// aj preflight (app/api/account/preflight — ownerDeletionBlocked
// COMPANY_DELETION_SUPPORT_ONLY), aby UI vrátane starších Android verzií
// (vc3/vc4 — vetva „ownerDeletionBlocked“ bez nevratného tlačidla) neponúklo výmaz.
// =============================================================================

export const COMPANY_DELETION_SUPPORT_ONLY = "COMPANY_DELETION_SUPPORT_ONLY" as const;

export function companySelfTerminationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ESBLU_COMPANY_SELF_TERMINATION ?? "").trim().toLowerCase() === "on";
}
