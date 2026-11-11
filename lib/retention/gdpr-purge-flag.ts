// J10 CLIA retenčná purge (esblu_purge_gdpr_technical_retention + neúspešné
// registrácie) beží v cron jobe telemetry-maintenance IBA po výslovnom
// súhlase vlastníka: ESBLU_GDPR_RETENTION_PURGE_ENABLED = "true".
// Bez flagu (default, aj v produkcii) sa nič nemaže — fail safe.
export function gdprRetentionPurgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ESBLU_GDPR_RETENTION_PURGE_ENABLED?.trim() === "true";
}
