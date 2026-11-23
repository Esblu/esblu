// =============================================================================
// Kritický prevádzkový alert cleanupu po zrušení účtu / ukončení firmy (P1-5). Iba strojový kód a počty —
// nikdy firma, používateľ ani cesty súborov. Zachytí ho log alert / drain (Vercel runtime logs).
// =============================================================================

export type AccountDeletionAlert = {
  code: "ACCOUNT_CLEANUP_RETRY_EXHAUSTED" | "TERMINATION_STORAGE_NOT_PURGED";
  exhausted: number;
  unpurged: number;
};

export function formatAccountDeletionAlert(a: AccountDeletionAlert): string {
  return `[account-deletion-alert] ${JSON.stringify({ code: a.code, severity: "critical", exhausted: a.exhausted, termination_unpurged: a.unpurged })}`;
}

export function logAccountDeletionAlert(a: AccountDeletionAlert): void {
  console.error(formatAccountDeletionAlert(a));
}
