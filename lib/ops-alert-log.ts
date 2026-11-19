import "server-only";

import type { OpsAlertNotifier } from "@/lib/einvoice/ops/alert-sink";

// =============================================================================
// Jediné miesto, kde sa prevádzkový alert E-Faktúry zapíše do serverového logu
// (Vercel runtime logs → log alert / drain). Iba strojové kódy, prostredie a
// počítadlo — nikdy firma, IČO, doklad, telo webhooku ani tajomstvá. Volá sa iba
// pri novom alerte alebo renotifikácii (dedupe v einvoice_ops_alerts).
// =============================================================================

export const logOpsAlert: OpsAlertNotifier = (n) => {
  console.error(
    `[einvoice-ops-alert] ${JSON.stringify({ code: n.code, severity: n.severity, environment: n.environment, detail: n.detailCode ?? null, occurrences: n.occurrences, created: n.created })}`
  );
};
