// =============================================================================
// E-Faktúra UI — čistý view-model (klient aj test, bez I/O a bez Reactu).
//
// Iba mapuje strojové kódy a stavy zo servera na i18n kľúče a rozhoduje, čo
// sa zobrazí. O tom, čo je POVOLENÉ, rozhoduje server (`allowed`) a DB — tu sa
// pravidlá oprávnení neopakujú. Neznámy kód = všeobecná zrozumiteľná správa,
// nikdy surový technický text.
// =============================================================================

import type { EinvoiceTimelineItem, InboundDetailDto, InboundItemDto, OutboundAttemptDto, OutboundSummaryDto } from "./types.ts";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;
export type HasKey = (key: string) => boolean;

const NS = "invoices.einvoice";

export function pick(has: HasKey, key: string, fallback: string): string {
  return has(key) ? key : fallback;
}

// ------------------------------------------------------------------- readiness

export function readinessIssueText(issue: { code: string; params?: Record<string, string | number> }, t: Translate, has: HasKey): string {
  const key = `${NS}.issues.${issue.code}`;
  return has(key) ? t(key, issue.params) : t(`${NS}.issueUnknown`, { code: issue.code });
}

// ------------------------------------------------------------------- outbound

export function outboundStateKey(state: string, has: HasKey): string {
  return pick(has, `${NS}.state.${state}`, `${NS}.events.toGeneric`);
}

/** Vysvetlenie stavu; pri neistom výsledku vždy upozornenie na overenie (nikdy „odoslať znova"). */
export function outboundStateHintKey(attempt: Pick<OutboundAttemptDto, "state" | "category">, has: HasKey): string | null {
  if (attempt.category === "retry_exhausted_unknown") return `${NS}.stateHint.unknown`;
  const key = `${NS}.stateHint.${attempt.state}`;
  return has(key) ? key : null;
}

export function transportMessageKey(code: string | null, has: HasKey): string | null {
  if (!code) return null;
  return pick(has, `${NS}.transport.${code}`, `${NS}.transport.generic`);
}

export type StatusTone = "neutral" | "progress" | "success" | "warning" | "danger";

/** Tón stavu (farba je IBA doplnok — text a ikona nesú význam aj bez farby). */
export function outboundTone(attempt: Pick<OutboundAttemptDto, "state" | "category">): StatusTone {
  if (attempt.state === "delivered") return "success";
  if (attempt.state === "rejected" || attempt.state === "failed") return "danger";
  if (attempt.category === "retry_exhausted_unknown" || attempt.state === "deferred") return "warning";
  if (attempt.state === "sending" || attempt.state === "sent") return "progress";
  return "neutral";
}

export function toneSymbol(tone: StatusTone): string {
  switch (tone) {
    case "success":
      return "✓";
    case "danger":
      return "✕";
    case "warning":
      return "!";
    case "progress":
      return "…";
    default:
      return "•";
  }
}

export type OutboundPanelModel = {
  current: OutboundAttemptDto | null;
  previous: OutboundAttemptDto[];
  showReadiness: boolean;
  notices: string[];
  showSend: boolean;
  showDownload: boolean;
  showEvidence: boolean;
  actions: ("reconcile" | "retry")[];
};

export function outboundPanelModel(summary: OutboundSummaryDto): OutboundPanelModel {
  const [current = null, ...previous] = summary.attempts;
  const notices: string[] = [];
  if (!summary.access.providerConfigured) notices.push(`${NS}.panel.notConfigured`);
  else if (!summary.access.rolloutEnabled) notices.push(`${NS}.panel.rolloutDisabled`);
  if (!summary.access.entitlementActive) notices.push(`${NS}.panel.entitlementRequired`);
  if (!summary.access.financeManage) notices.push(`${NS}.panel.readOnly`);
  const actions: ("reconcile" | "retry")[] = [];
  if (summary.allowed.reconcile) actions.push("reconcile");
  // Pri neistom výsledku server retry nikdy nepovolí; obrana aj v UI.
  if (summary.allowed.retry && current?.category !== "retry_exhausted_unknown") actions.push("retry");
  return {
    current,
    previous,
    showReadiness: current === null || ["failed", "rejected"].includes(current.state),
    notices,
    showSend: summary.allowed.send,
    showDownload: current?.hasDocument === true,
    showEvidence: current?.state === "delivered",
    actions,
  };
}

// ------------------------------------------------------------------- inbound

export function inboundStateKey(status: string, has: HasKey): string {
  return pick(has, `${NS}.inboundState.${status}`, `${NS}.events.toGeneric`);
}

export function inboundErrorKey(code: string | null, has: HasKey): string | null {
  if (!code) return null;
  return pick(has, `${NS}.inbound.error.${code}`, `${NS}.inbound.error.generic`);
}

export function reviewReasonKey(code: string, has: HasKey): string {
  return pick(has, `${NS}.inbound.reviewReason.${code}`, `${NS}.inbound.reviewReason.generic`);
}

export function inboundAckKey(item: Pick<InboundItemDto, "status">): string {
  if (item.status === "acknowledged") return `${NS}.inbound.ackDone`;
  if (["ack_pending", "draft_created", "duplicate"].includes(item.status)) return `${NS}.inbound.ackPending`;
  return `${NS}.inbound.ackNotSent`;
}

export function inboundTone(item: Pick<InboundItemDto, "status">): StatusTone {
  if (item.status === "acknowledged") return "success";
  if (item.status === "failed" || item.status === "needs_review") return "danger";
  if (item.status === "ack_pending") return "warning";
  return "progress";
}

export function inboundActions(detail: InboundDetailDto): ("reprocess" | "ackRetry")[] {
  const out: ("reprocess" | "ackRetry")[] = [];
  if (detail.allowed.reprocess) out.push("reprocess");
  if (detail.allowed.ackRetry) out.push("ackRetry");
  return out;
}

// ------------------------------------------------------------------- časová os

export function timelineLabelKey(item: EinvoiceTimelineItem, has: HasKey): string {
  if (item.kind === "action") return pick(has, `${NS}.events.action.${item.code ?? ""}`, `${NS}.events.actionGeneric`);
  if (item.from === null && item.to === "queued") return `${NS}.events.created`;
  return pick(has, `${NS}.events.to.${item.to}`, `${NS}.events.toGeneric`);
}

export function timelineSourceKey(item: EinvoiceTimelineItem): string {
  if (item.actor === "self") return `${NS}.source.self`;
  if (item.source === "user") return `${NS}.source.user`;
  if (item.source === "provider") return `${NS}.source.provider`;
  return `${NS}.source.system`;
}

// ------------------------------------------------------------------- výsledky akcií

export type Feedback = { tone: "success" | "info" | "error"; key: string };

const SUCCESS: Record<string, Feedback["tone"]> = {
  QUEUED: "success",
  ALREADY_REQUESTED: "info",
  RECONCILED: "success",
  ORIGINAL_FOUND: "success",
  ABSENT_CONFIRMED: "success",
  ABSENT_RETRY_CONTINUES: "info",
  RECONCILE_INCONCLUSIVE: "info",
  ACKNOWLEDGED: "success",
  PROCESSED: "success",
  DUPLICATE: "info",
};

const ERROR_KEYS: [RegExp, string][] = [
  [/^UNAUTHENTICATED$|^NOT_AUTHENTICATED$/, "UNAUTHENTICATED"],
  [/^ENTITLEMENT_DENIED|^EINVOICE_ENTITLEMENT_REQUIRED$/, "ENTITLEMENT"],
  [/^FORBIDDEN$|FORBIDDEN_FINANCE_MANAGE_REQUIRED$|^FINANCE_MANAGE_REQUIRED$|^NO_ACTIVE_COMPANY$|^ESBLU_NO_ACTIVE_COMPANY$/, "FORBIDDEN"],
  [/^NOT_FOUND$|^ESBLU_EINVOICE_NOT_FOUND$|^ESBLU_INVOICE_NOT_FOUND$/, "NOT_FOUND"],
  [/RATE_LIMITED$/, "RATE_LIMITED"],
  [/ACTION_IN_PROGRESS$/, "IN_PROGRESS"],
  [/RECONCILE_REQUIRED$|PREVIOUS_OUTCOME_UNKNOWN$/, "RECONCILE_REQUIRED"],
  [/ACTION_NOT_ALLOWED$/, "NOT_ALLOWED"],
  [/NOT_LATEST_ATTEMPT$/, "NOT_LATEST_ATTEMPT"],
  [/ACK_REQUIRES_DRAFT$/, "ACK_REQUIRES_DRAFT"],
  [/^PROVIDER_NOT_CONFIGURED$|^PROVIDER_MISMATCH$/, "PROVIDER_NOT_CONFIGURED"],
  [/ROLLOUT_NOT_ENABLED$/, "ROLLOUT_NOT_ENABLED"],
  [/^RETRY_REQUIRES_OPERATOR_ACTION$/, "RETRY_REQUIRES_OPERATOR_ACTION"],
  [/^STORAGE_INTEGRITY$/, "STORAGE_INTEGRITY"],
  [/^READINESS_FAILED$|^UBL_NOT_READY$/, "READINESS_FAILED"],
  [/^INVOICE_NOT_FINALIZED$/, "INVOICE_NOT_FINALIZED"],
  [/^RECIPIENT_NOT_FOUND$|^RECIPIENT_INVALID$/, "RECIPIENT_NOT_FOUND"],
  [/^RECIPIENT_LOOKUP_UNAVAILABLE$/, "RECIPIENT_UNAVAILABLE"],
  [/^PREFLIGHT_FAILED$/, "PREFLIGHT_FAILED"],
  [/^PREFLIGHT_UNAVAILABLE$/, "PREFLIGHT_UNAVAILABLE"],
  [/^ORGANIZATION_NOT_READY$|ORGANIZATION_NOT_READY$/, "ORGANIZATION_NOT_READY"],
];

/** Odpoveď servera → zrozumiteľná správa. Neznámy kód = všeobecná chyba (nikdy surový text). */
export function feedbackFor(status: number, code: string | null | undefined): Feedback {
  const c = typeof code === "string" ? code : "";
  const ok = status >= 200 && status < 400;
  if (ok && SUCCESS[c]) return { tone: SUCCESS[c], key: `${NS}.result.${c}` };
  if (ok) return { tone: "success", key: `${NS}.result.PROCESSED` };
  for (const [re, key] of ERROR_KEYS) if (re.test(c)) return { tone: "error", key: `${NS}.errors.${key}` };
  if (status === 401) return { tone: "error", key: `${NS}.errors.UNAUTHENTICATED` };
  if (status === 403) return { tone: "error", key: `${NS}.errors.FORBIDDEN` };
  if (status === 429) return { tone: "error", key: `${NS}.errors.RATE_LIMITED` };
  // Iný konflikt stavu (409) — stav sa medzitým zmenil; UI sa po akcii znova načíta.
  if (status === 409) return { tone: "error", key: `${NS}.errors.NOT_ALLOWED` };
  if (status === 0) return { tone: "error", key: `${NS}.errors.generic` };
  return { tone: "error", key: `${NS}.errors.generic` };
}

/** Všetky i18n kľúče, ktoré view-model môže vrátiť (test overuje, že existujú v sk/en/de). */
export function allStaticKeys(): string[] {
  const keys = new Set<string>();
  for (const c of Object.keys(SUCCESS)) keys.add(`${NS}.result.${c}`);
  for (const [, k] of ERROR_KEYS) keys.add(`${NS}.errors.${k}`);
  for (const k of ["generic", "UNAUTHENTICATED", "FORBIDDEN", "RATE_LIMITED"]) keys.add(`${NS}.errors.${k}`);
  for (const k of ["notConfigured", "rolloutDisabled", "entitlementRequired", "readOnly"]) keys.add(`${NS}.panel.${k}`);
  for (const k of ["self", "user", "provider", "system"]) keys.add(`${NS}.source.${k}`);
  for (const k of ["ackDone", "ackPending", "ackNotSent"]) keys.add(`${NS}.inbound.${k}`);
  keys.add(`${NS}.events.created`);
  keys.add(`${NS}.events.toGeneric`);
  keys.add(`${NS}.events.actionGeneric`);
  keys.add(`${NS}.stateHint.unknown`);
  keys.add(`${NS}.transport.generic`);
  keys.add(`${NS}.inbound.error.generic`);
  keys.add(`${NS}.inbound.reviewReason.generic`);
  return [...keys];
}
