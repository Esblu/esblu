// =============================================================================
// Dashboard „Dnes" — čo dnes treba riešiť (2026-10-22).
//
// Čistá agregácia EXISTUJÚCICH dát aktívnej firmy. Žiadny nový dátový model,
// žiadny tracking, žiadne volanie navonok — volajúci (app/components/
// Dashboard.tsx) načíta riadky pod RLS aktívnej firmy a táto funkcia z nich
// iba poskladá zoradený zoznam upozornení s akciou.
//
// Pravidlá:
//   - Rola sa NEOBCHÁDZA: finančné položky iba pri `financeView`, prevádzkové
//     iba pri `operational`, predplatné iba pri `billingOwner`. RLS je aj tak
//     autorita — toto len zabráni tomu, aby UI ukazovalo prázdne/nepovolené
//     kategórie.
//   - Jedna firma: vstup je vždy z jednej (aktívnej) firmy; funkcia nič
//     nemieša a nemá ako.
//   - Závažnosť: urgent (po termíne) → today (dnes) → soon (do 14 dní) →
//     info (do 30 dní / súhrny).
//
// Texty sa skladajú v UI cez i18n kľúče (`titleKey` + `vars`).
// =============================================================================

import { buildMachineDeadlines, buildVehicleDeadlines, type DeadlineType, type MinimalMachine, type MinimalServiceRecord, type MinimalVehicle } from "@/lib/deadlines";
import type { VehicleVignette } from "@/lib/vehicle-vignettes";
import { creditedTotals, isOpenReceivable, type SettlementDocument } from "@/lib/invoicing/credit-note-semantics";
import { stockStatus, type InventoryItemRow } from "@/lib/inventory";
import { inventoryItemDetailHref, invoiceDetailHref } from "@/lib/entity-links";
import { formatMoney } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";

export type TodaySeverity = "urgent" | "today" | "soon" | "info";

export const TODAY_SEVERITY_ORDER: TodaySeverity[] = ["urgent", "today", "soon", "info"];

/** Okno „čoskoro" (dni). Nad ním do 30 dní je to už iba „info". */
export const TODAY_SOON_DAYS = 14;
export const TODAY_INFO_DAYS = 30;
/** Splatnosť faktúry: koľko dní dopredu ju ukazujeme ako „čoskoro". */
export const TODAY_INVOICE_SOON_DAYS = 7;
/** Koniec skúšobnej verzie: koľko dní vopred to vlastník uvidí. */
export const TODAY_TRIAL_NOTICE_DAYS = 5;

export type TodayCategory = "invoice" | "received" | "vehicle" | "machine" | "inventory" | "inbox" | "chat" | "billing";

export type TodayItem = {
  /** Stabilný kľúč pre React a testy. */
  id: string;
  severity: TodaySeverity;
  category: TodayCategory;
  /** i18n kľúč titulku + premenné. */
  titleKey: string;
  vars: Record<string, string | number>;
  /** i18n kľúč akcie (CTA) a cieľ. */
  ctaKey: string;
  href: string;
  /** Na zoradenie v rámci rovnakej závažnosti (menej = skôr). */
  sortDays: number;
};

export type TodayInvoice = SettlementDocument & {
  direction: string;
  kind: string;
  invoice_number: string | null;
  supplier_invoice_number?: string | null;
  currency: string | null;
  source?: string | null;
  correction_review_status?: string | null;
  advance_review_status?: string | null;
};

export type TodayInput = {
  access: {
    financeView: boolean;
    operational: boolean;
    /** Iba vlastník spravuje predplatné (canonical: billing authority = owner). */
    billingOwner: boolean;
  };
  /** Kalendárny deň používateľa YYYY-MM-DD. */
  today: string;
  /** Jazyk pre formát súm (predvolene sk). */
  locale?: Locale;
  vehicles?: MinimalVehicle[];
  vignettes?: VehicleVignette[];
  vehicleServices?: MinimalServiceRecord[];
  machines?: MinimalMachine[];
  machineServices?: MinimalServiceRecord[];
  inventory?: InventoryItemRow[];
  invoices?: TodayInvoice[];
  /** Počet nepriradených dokladov v Inboxe (lib/inbox-unassigned.ts). */
  inboxUnassigned?: number;
  /** Súčet neprečítaných správ (esblu_get_my_unread_counts). */
  unreadChat?: number;
  /** Koniec skúšobnej verzie (entitlements.trial.endsAt), ak je aktívna. */
  trialEndsAt?: string | null;
  trialActive?: boolean;
};

function dateFromIso(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((dateFromIso(toDay).getTime() - dateFromIso(fromDay).getTime()) / 86_400_000);
}

/** Termín (STK/EK/servis…) → závažnosť „Dnes". */
export function deadlineSeverity(daysRemaining: number): TodaySeverity | null {
  if (daysRemaining < 0) return "urgent";
  if (daysRemaining === 0) return "today";
  if (daysRemaining <= TODAY_SOON_DAYS) return "soon";
  if (daysRemaining <= TODAY_INFO_DAYS) return "info";
  return null;
}

const DEADLINE_TITLE: Record<DeadlineType, string> = {
  vehicle_stk: "stk",
  vehicle_ek: "ek",
  vehicle_vignette: "vignette",
  vehicle_service: "vehicleService",
  machine_service: "machineService",
};

function invoiceLabel(invoice: TodayInvoice): string {
  return (invoice.direction === "received" ? invoice.supplier_invoice_number : invoice.invoice_number) || "—";
}

function invoiceAmount(invoice: TodayInvoice, locale: Locale): string {
  const n = typeof invoice.total_amount === "number" ? invoice.total_amount : Number(invoice.total_amount ?? 0);
  return formatMoney(Number.isFinite(n) ? n : 0, invoice.currency || "EUR", locale);
}

export function buildTodayItems(input: TodayInput): TodayItem[] {
  const items: TodayItem[] = [];
  const { access, today } = input;
  const locale: Locale = input.locale ?? "sk";
  const todayDate = dateFromIso(today);

  // --- Financie --------------------------------------------------------------
  if (access.financeView && input.invoices) {
    const invoices = input.invoices;
    const credited = creditedTotals(invoices);
    let issuedDrafts = 0;

    for (const invoice of invoices) {
      if (invoice.document_status === "draft") {
        if (invoice.direction === "received") {
          const einvoice = invoice.source === "efaktura_peppol";
          items.push({
            id: `received-draft:${invoice.id}`,
            severity: "today",
            category: "received",
            titleKey: einvoice ? "today.items.einvoiceReview" : "today.items.receivedReview",
            vars: { number: invoiceLabel(invoice), amount: invoiceAmount(invoice, locale) },
            ctaKey: "today.cta.reviewReceived",
            href: invoiceDetailHref(invoice.id),
            sortDays: 0,
          });
        } else if (invoice.kind !== "credit_note") {
          issuedDrafts += 1;
        }
        continue;
      }

      if (
        invoice.direction === "received" &&
        (invoice.correction_review_status === "review" || invoice.advance_review_status === "review")
      ) {
        items.push({
          id: `received-review:${invoice.id}`,
          severity: "today",
          category: "received",
          titleKey: "today.items.receivedNeedsCheck",
          vars: { number: invoiceLabel(invoice) },
          ctaKey: "today.cta.reviewReceived",
          href: invoiceDetailHref(invoice.id),
          sortDays: 0,
        });
      }

      if (!invoice.due_date || invoice.payment_status === "overpaid" || !isOpenReceivable(invoice, credited)) continue;
      const days = daysBetween(today, invoice.due_date);
      const issued = invoice.direction !== "received";
      let severity: TodaySeverity | null = null;
      let titleKey = "";
      if (days < 0) {
        severity = "urgent";
        titleKey = issued ? "today.items.issuedOverdue" : "today.items.receivedOverdue";
      } else if (days === 0) {
        severity = "today";
        titleKey = issued ? "today.items.issuedDueToday" : "today.items.receivedDueToday";
      } else if (days <= TODAY_INVOICE_SOON_DAYS) {
        severity = "soon";
        titleKey = issued ? "today.items.issuedDueSoon" : "today.items.receivedDueSoon";
      }
      if (!severity) continue;
      items.push({
        id: `invoice:${invoice.id}`,
        severity,
        category: "invoice",
        titleKey,
        vars: { number: invoiceLabel(invoice), amount: invoiceAmount(invoice, locale), days: Math.abs(days) },
        ctaKey: issued ? (days < 0 ? "today.cta.checkPayment" : "today.cta.openInvoice") : "today.cta.payInvoice",
        href: invoiceDetailHref(invoice.id),
        sortDays: days,
      });
    }

    if (issuedDrafts > 0) {
      items.push({
        id: "invoice-drafts",
        severity: "info",
        category: "invoice",
        titleKey: "today.items.issuedDrafts",
        vars: { count: issuedDrafts },
        ctaKey: "today.cta.openDrafts",
        href: "/faktury?section=drafts",
        sortDays: 0,
      });
    }
  }

  // --- Prevádzka -------------------------------------------------------------
  if (access.operational) {
    const deadlines = [
      ...buildVehicleDeadlines(input.vehicles ?? [], input.vignettes ?? [], input.vehicleServices ?? [], "sk", todayDate),
      ...buildMachineDeadlines(input.machines ?? [], input.machineServices ?? [], todayDate),
    ];
    for (const deadline of deadlines) {
      const severity = deadlineSeverity(deadline.daysRemaining);
      if (!severity) continue;
      const kind = DEADLINE_TITLE[deadline.deadlineType];
      const state = deadline.daysRemaining < 0 ? "Overdue" : deadline.daysRemaining === 0 ? "Today" : "Soon";
      items.push({
        id: `deadline:${deadline.deadlineType}:${deadline.entityId}:${deadline.vignetteCountryCode ?? ""}`,
        severity,
        category: deadline.entityType,
        titleKey: `today.items.${kind}${state}`,
        vars: {
          entity: deadline.entityLabel,
          days: Math.abs(deadline.daysRemaining),
          country: deadline.vignetteCountryCode ?? "",
        },
        ctaKey: deadline.entityType === "vehicle" ? "today.cta.openVehicle" : "today.cta.openMachine",
        href: deadline.targetRoute,
        sortDays: deadline.daysRemaining,
      });
    }

    for (const item of input.inventory ?? []) {
      const status = stockStatus(item);
      if (status !== "out" && status !== "low") continue;
      items.push({
        id: `stock:${item.id}`,
        severity: status === "out" ? "today" : "soon",
        category: "inventory",
        titleKey: status === "out" ? "today.items.stockOut" : "today.items.stockLow",
        vars: { name: item.name || "—", quantity: item.quantity ?? 0, unit: item.unit ?? "" },
        ctaKey: "today.cta.restock",
        href: inventoryItemDetailHref(item.id),
        sortDays: status === "out" ? 0 : 1,
      });
    }
  }

  // --- Dokumenty a komunikácia (RLS rozhodne, čo vidí) ------------------------
  if ((input.inboxUnassigned ?? 0) > 0) {
    items.push({
      id: "inbox-unassigned",
      severity: "info",
      category: "inbox",
      titleKey: "today.items.inboxUnassigned",
      vars: { count: input.inboxUnassigned ?? 0 },
      ctaKey: "today.cta.openInbox",
      href: "/ai-evidencia",
      sortDays: 0,
    });
  }
  if ((input.unreadChat ?? 0) > 0) {
    items.push({
      id: "chat-unread",
      severity: "info",
      category: "chat",
      titleKey: "today.items.chatUnread",
      vars: { count: input.unreadChat ?? 0 },
      ctaKey: "today.cta.openChat",
      href: "/chat",
      sortDays: 1,
    });
  }

  // --- Predplatné: IBA vlastník ---------------------------------------------
  if (access.billingOwner && input.trialActive && input.trialEndsAt) {
    // Kalendárne dni do konca (časť dňa sa nezaokrúhľuje nahor na celý deň navyše).
    const daysRemaining = /^\d{4}-\d{2}-\d{2}/.test(input.trialEndsAt) ? daysBetween(today, input.trialEndsAt.slice(0, 10)) : null;
    const status = daysRemaining === null ? null : { daysRemaining };
    if (status && status.daysRemaining >= 0 && status.daysRemaining <= TODAY_TRIAL_NOTICE_DAYS) {
      items.push({
        id: "trial-ending",
        severity: status.daysRemaining <= 1 ? "today" : "soon",
        category: "billing",
        titleKey: "today.items.trialEnding",
        vars: { days: status.daysRemaining },
        ctaKey: "today.cta.openBilling",
        href: "/nastavenia/predplatne",
        sortDays: status.daysRemaining,
      });
    }
  }

  const rank = (severity: TodaySeverity) => TODAY_SEVERITY_ORDER.indexOf(severity);
  return items.sort((a, b) => rank(a.severity) - rank(b.severity) || a.sortDays - b.sortDays || a.id.localeCompare(b.id));
}

export function countBySeverity(items: TodayItem[]): Record<TodaySeverity, number> {
  const counts: Record<TodaySeverity, number> = { urgent: 0, today: 0, soon: 0, info: 0 };
  for (const item of items) counts[item.severity] += 1;
  return counts;
}

// =============================================================================
// Prvé kroky (onboarding checklist) — odvodené z existujúcich dát, nič sa
// neukladá na server. Skrytie zoznamu si pamätá iba toto zariadenie.
// =============================================================================

export type FirstStepKey = "company" | "profile" | "firstRecord" | "invite";

export type FirstStep = { key: FirstStepKey; done: boolean; optional: boolean };

export type FirstStepsInput = {
  role: "owner" | "admin" | "accountant" | "employee" | null;
  /** Vyplnené základné fakturačné údaje firmy; null = rola ich nevidí. */
  profileComplete: boolean | null;
  recordCount: number;
  /** Členovia + otvorené pozvánky okrem mňa; null = rola ich nevidí. */
  teamCount: number | null;
};

/** Zoznam krokov pre vlastníka/správcu; iným rolám sa nezobrazuje. */
export function buildFirstSteps(input: FirstStepsInput): FirstStep[] {
  if (input.role !== "owner" && input.role !== "admin") return [];
  const steps: FirstStep[] = [{ key: "company", done: true, optional: false }];
  if (input.profileComplete !== null) steps.push({ key: "profile", done: input.profileComplete, optional: false });
  steps.push({ key: "firstRecord", done: input.recordCount > 0, optional: false });
  if (input.teamCount !== null) steps.push({ key: "invite", done: input.teamCount > 0, optional: true });
  return steps;
}

/** Zoznam má zmysel, kým nie sú hotové povinné kroky. */
export function firstStepsPending(steps: FirstStep[]): boolean {
  return steps.some((step) => !step.optional && !step.done);
}

export function isBillingProfileComplete(profile: {
  legal_name?: string | null;
  ico?: string | null;
  address_line1?: string | null;
  city?: string | null;
} | null): boolean {
  if (!profile) return false;
  return [profile.legal_name, profile.ico, profile.address_line1, profile.city].every(
    (value) => typeof value === "string" && value.trim().length > 0
  );
}
