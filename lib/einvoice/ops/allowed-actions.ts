// =============================================================================
// E-Faktúra — povolené akcie pre UI (SERVER počíta, klient iba vykresľuje).
//
// Zrkadlí pravidlá esblu_einvoice_operator_begin / esblu_einvoice_request_outbound
// (20261002140000), aby UI neponúkalo tlačidlo, ktoré DB aj tak odmietne. NIE
// JE to bezpečnostná hranica — každú akciu znova overí DB (rola, nárok, stav,
// lease, cooldown). Klient tieto pravidlá neopakuje.
// =============================================================================

import type { EinvoiceAccess, InboundAllowedActions, OutboundAllowedActions } from "../ui/types.ts";

type AttemptLike = {
  state: string;
  provider_submission_id: string | null;
  send_outcome_unknown: boolean;
  reconciled_absent_at: string | null;
};

export function outboundAllowedActions(input: {
  access: EinvoiceAccess;
  readinessReady: boolean;
  /** Pokusy zoradené od najnovšieho. */
  attempts: AttemptLike[];
}): OutboundAllowedActions {
  const { access } = input;
  const latest = input.attempts[0] ?? null;
  // Reconcile = iba čítanie stavu u poskytovateľa → aj pri pozastavenom rollout-e.
  const canReconcile = access.financeManage && access.providerConfigured;
  const canOperate = canReconcile && access.rolloutEnabled;
  const canCreate = canOperate && access.entitlementActive;

  const send = canCreate && input.readinessReady && latest === null;
  const reconcile = canReconcile && latest !== null && ["sending", "sent", "deferred"].includes(latest.state);
  const unknownUnresolved = latest !== null && latest.send_outcome_unknown && latest.provider_submission_id === null && latest.reconciled_absent_at === null;
  const retry = canCreate && latest !== null && ["failed", "rejected"].includes(latest.state) && !unknownUnresolved;
  return { send, reconcile, retry };
}

export function inboundAllowedActions(input: {
  access: EinvoiceAccess;
  status: string;
  invoiceId: string | null;
  hasXml: boolean;
  lastErrorCode: string | null;
}): InboundAllowedActions {
  const { access } = input;
  // Phase 6: spracovanie aj ACK idú cez claim s rollout bránou — bez povolenia by akcia nič nespravila.
  const canOperate = access.financeManage && access.providerConfigured && access.rolloutEnabled;
  const reprocessable =
    ["received", "stored", "parsed"].includes(input.status) ||
    // Trvalé chyby dát (nepodporovaný profil / dobropis) sa opätovným spracovaním nezmenia — tlačidlo sa neponúka.
    (input.status === "failed" && input.hasXml && input.invoiceId === null && input.lastErrorCode !== "UNSUPPORTED_PROFILE");
  const reprocess = canOperate && access.entitlementActive && reprocessable;
  const ackRetry = canOperate && ["ack_pending", "draft_created", "duplicate"].includes(input.status) && input.invoiceId !== null && input.hasXml;
  return { reprocess, ackRetry };
}
