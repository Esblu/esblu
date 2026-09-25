import type { IntentArgs, IntentName } from "./types.ts";

// =============================================================================
// Intent Engine — JEDNO miesto, ktoré rozhoduje, či rola smie príkaz vôbec
// spracovať.
//
// PRAVIDLO
// --------
// Hlas je iba ďalší ovládač. Nesmie mať viac práv než UI a databáza, a
// preto sa oprávnenie overuje PRED akýmkoľvek dotazom — aj pred počítaním,
// hľadaním kandidátov či zisťovaním názvov. „Nič sa nenašlo" by zamestnancovi
// nepriamo prezradilo, že dáta existujú; namiesto toho dostane jasné
// odmietnutie bez akéhokoľvek obsahu.
//
// Toto je predsieň, nie náhrada RLS. Databáza vynucuje to isté znova
// (pozri supabase/migrations/20260926120000_role_scope_voice_hardening.sql).
//
// ROLY
// ----
//   owner       všetko, nebezpečné akcie s potvrdením
//   admin       prevádzka áno; financie iba s výslovným finance.view/manage
//   accountant  iba účtovníctvo: faktúry, bločky, dodacie listy, priečinky,
//               stiahnutia, partneri — žiadne vozidlá, stroje, sklad
//   employee    ŽIADNY všeobecný asistent. Predvolene odmietnuté všetko;
//               prejde iba výslovný zoznam príjmu dokladov
//               (EMPLOYEE_ASSISTANT_ALLOWLIST). UI práva sa tým nemenia —
//               sklad na čítanie, stroje/vozidlá podľa UI, financie nikdy.
//               Rovnako sa správa každá rola mimo owner/admin/accountant
//               (fail closed).
//
// Modul je bez importov z appky (iba typy), aby ho testy spustili v Node.
// =============================================================================

export type AccessContext = {
  role: "owner" | "admin" | "accountant" | "employee" | string;
  /** esblu_my_finance_view() — počíta server, nie klient. */
  financeView: boolean;
  /** esblu_my_finance_manage(). */
  financeManage: boolean;
  /** esblu_role_can_operate(): owner/admin/employee. */
  canOperate: boolean;
};

export type AccessRequirement =
  | "any"
  | "operational_read"
  | "operational_write"
  | "vehicle_write"
  | "inventory_write"
  | "finance_view"
  | "finance_manage"
  | "category_manage";

export type AccessDenial = "finance" | "operational" | "write" | "inventory_read_only" | "category" | "assistant_scope";

/** Roly, ktoré majú všeobecný asistent (s obmedzeniami nižšie). */
const FULL_ASSISTANT_ROLES = ["owner", "admin", "accountant"] as const;

/**
 * Jediné intenty, ktoré smie rola bez všeobecného asistenta (zamestnanec)
 * spustiť: príjem dokladu na spracovanie. Nie výnimky po moduloch — jeden
 * biely zoznam, všetko ostatné je odmietnuté.
 */
export const EMPLOYEE_ASSISTANT_ALLOWLIST: readonly IntentName[] = ["DOCUMENT_INTAKE"];

/** Typy, ktoré smie zamestnanec odoslať cez príjem. */
const INTAKE_TYPES: readonly string[] = ["invoice", "receipt", "delivery_note"];

export function hasFullAssistant(role: string): boolean {
  return (FULL_ASSISTANT_ROLES as readonly string[]).includes(role);
}

function isAllowlistedIntake(name: IntentName, args: IntentArgs): boolean {
  if (!EMPLOYEE_ASSISTANT_ALLOWLIST.includes(name)) return false;
  return (args.documentTypes ?? []).every((type) => INTAKE_TYPES.includes(type));
}

/**
 * Rozhodnutie PRED klasifikáciou cez AI a pred akýmkoľvek dotazom. Pre rolu
 * bez všeobecného asistenta: nerozpoznaná veta aj čokoľvek mimo bieleho
 * zoznamu = odmietnutie (text sa ani neposiela na AI klasifikáciu). Pre
 * ostatné roly `null` — pokračuje sa bežnou bránou `checkIntentAccess`.
 */
export function restrictedAssistantDenial(
  intent: { name: IntentName; args: IntentArgs } | null,
  ctx: Pick<AccessContext, "role">
): AccessDenial | null {
  if (hasFullAssistant(ctx.role)) return null;
  if (!intent) return "assistant_scope";
  return isAllowlistedIntake(intent.name, intent.args) ? null : "assistant_scope";
}

/** Typy dokladov, ktoré sú finančným podkladom (faktúra, bloček, dodací list). */
export const FINANCE_DOCUMENT_TYPES = ["invoice", "receipt", "delivery_note"] as const;

function mentionsFinanceDocuments(args: IntentArgs): boolean {
  return (args.documentTypes ?? []).some((type) => (FINANCE_DOCUMENT_TYPES as readonly string[]).includes(type));
}

const STATIC_REQUIREMENTS: Partial<Record<IntentName, AccessRequirement>> = {
  // Vozidlá — čítanie
  OPEN_VEHICLE: "operational_read",
  SEARCH_VEHICLE: "operational_read",
  SHOW_VEHICLE_DOCUMENTS: "operational_read",
  SHOW_VEHICLE_SERVICE: "operational_read",
  VEHICLE_STK_STATUS: "operational_read",
  VEHICLE_EK_STATUS: "operational_read",
  VEHICLE_VIGNETTE_STATUS: "operational_read",
  VEHICLE_COST_SUMMARY: "operational_read",
  VEHICLE_REPORT: "operational_read",
  VEHICLE_PHOTO_ADD: "operational_read", // iba navigácia na detail
  // Vozidlá — zápis (owner/admin, rovnako ako RLS na vehicles)
  VEHICLE_CREATE: "vehicle_write",
  VEHICLE_DELETE: "vehicle_write",
  VEHICLE_SERVICE_ADD: "vehicle_write",

  // Stroje
  OPEN_MACHINE: "operational_read",
  SEARCH_MACHINE: "operational_read",
  SHOW_MACHINE_SERVICE: "operational_read",
  MACHINE_REPORT: "operational_read",
  SHOW_MACHINE_DOCUMENTS: "operational_read",
  SHOW_MACHINE_PHOTOS: "operational_read",
  MACHINE_CREATE: "operational_write",
  MACHINE_SERVICE_ADD: "operational_write",
  MACHINE_DELETE: "operational_write",
  MACHINE_PHOTO_ADD: "operational_read", // iba navigácia na detail

  // Sklad
  OPEN_INVENTORY_ITEM: "operational_read",
  SEARCH_INVENTORY_ITEM: "operational_read",
  INVENTORY_ITEM_STATUS: "operational_read",
  SHOW_LOW_STOCK: "operational_read",
  INVENTORY_ITEM_CREATE: "inventory_write",
  INVENTORY_QUANTITY_ADJUST: "inventory_write",
  INVENTORY_ITEM_DELETE: "inventory_write",
  INVENTORY_ITEM_RENAME: "inventory_write",
  INVENTORY_ITEM_EDIT: "inventory_write",

  // Termíny sú prevádzkové (STK, EK, servis)
  UPCOMING_DEADLINES: "operational_read",

  // Financie — čítanie
  SEARCH_INVOICE: "finance_view",
  SHOW_UNPAID_INVOICES: "finance_view",
  SHOW_INVOICES_BY_STATUS: "finance_view",
  SEARCH_PARTNER: "finance_view",
  DOCUMENTS_LIST_UNDOWNLOADED: "finance_view",
  DOCUMENTS_DOWNLOAD_STATUS: "finance_view",

  // Financie — správa
  CREATE_INVOICE_DRAFT: "finance_manage",
  PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE: "finance_manage",
  FOLDER_CREATE: "finance_manage",
  FOLDER_OPEN: "finance_manage",
  FOLDER_ADD_ITEMS: "finance_manage",
  FOLDER_REMOVE_ITEMS: "finance_manage",
  FOLDER_LIST_ITEMS: "finance_manage",
  FOLDER_EXPORT: "finance_manage",
  FOLDER_DELETE: "finance_manage",
  FOLDER_RENAME: "finance_manage",
  DOCUMENTS_EXPORT: "finance_manage",
  // Inbox: nepriradené bločky/faktúry sú finančné podklady. Zmazanie =
  // rovnaké právo ako RLS documents_delete_finance_manager.
  INBOX_LIST_UNASSIGNED: "finance_view",
  INBOX_DELETE_UNASSIGNED: "finance_manage",
  // Obchodní partneri sú finančné kmeňové dáta (UI: canEdit = finance.manage).
  PARTNER_CREATE: "finance_manage",

  // Zložky Inboxu — owner/admin/accountant (zrkadlí RLS custom_document_categories)
  CREATE_DOCUMENT_CATEGORY: "category_manage",
  RENAME_DOCUMENT_CATEGORY: "category_manage",
  ASSIGN_DOCUMENTS_TO_CATEGORY: "category_manage",
  DELETE_DOCUMENT_CATEGORY: "category_manage",
  MOVE_DOCUMENTS_TO_CATEGORY: "category_manage",

  // Navigácia a príjem dokladov: každý člen firmy; modul si stráži sám.
  OPEN_MODULE: "any",
  OPEN_DOCUMENT_FOLDER: "any",
  DOCUMENT_INTAKE: "any",
  ENTITY_CREATE: "any",
};

/** Čo intent vyžaduje. Pri dokladoch rozhoduje aj to, O AKÉ doklady ide. */
export function intentRequirement(name: IntentName, args: IntentArgs = {}): AccessRequirement {
  if (name === "SEARCH_DOCUMENTS") {
    return mentionsFinanceDocuments(args) ? "finance_view" : "any";
  }
  if (name === "EXPORT_DOCUMENTS") {
    const types = args.documentTypes ?? [];
    // Bez typu export berie aj bločky → finančný.
    if (types.length === 0 || mentionsFinanceDocuments(args)) return "finance_view";
    return "operational_read";
  }
  return STATIC_REQUIREMENTS[name] ?? "finance_manage"; // neznámy = najprísnejšie
}

function isManager(ctx: AccessContext): boolean {
  return ctx.role === "owner" || ctx.role === "admin";
}

/**
 * `null` = povolené. Inak dôvod odmietnutia (na výber správnej vety — nikdy
 * nie s obsahom dát).
 */
export function checkIntentAccess(name: IntentName, args: IntentArgs, ctx: AccessContext): AccessDenial | null {
  // Zamestnanec (a každá neznáma rola): predvolene NIE, bez ohľadu na to,
  // čo tvrdia financie či can_operate — podvrhnuté permissions.finance nič
  // neodomknú.
  if (!hasFullAssistant(ctx.role)) return isAllowlistedIntake(name, args) ? null : "assistant_scope";
  const requirement = intentRequirement(name, args);
  switch (requirement) {
    case "any":
      return null;
    case "operational_read":
      return ctx.canOperate ? null : "operational";
    case "operational_write":
    case "vehicle_write":
      if (!ctx.canOperate) return "operational";
      return isManager(ctx) ? null : "write";
    case "inventory_write":
      if (!ctx.canOperate) return "operational";
      return isManager(ctx) ? null : "inventory_read_only";
    case "finance_view":
      return ctx.financeView ? null : "finance";
    case "finance_manage":
      return ctx.financeManage ? null : "finance";
    case "category_manage":
      return ctx.role === "owner" || ctx.role === "admin" || ctx.role === "accountant" ? null : "category";
  }
}

/** Prekladový kľúč pre odmietnutie. Žiadne číslo, meno ani suma. */
export function denialMessageKey(denial: AccessDenial): string {
  switch (denial) {
    case "finance":
      return "assistant.denied.finance";
    case "operational":
      return "assistant.denied.operational";
    case "inventory_read_only":
      return "assistant.denied.inventoryReadOnly";
    case "assistant_scope":
      return "assistant.denied.employee";
    case "category":
    case "write":
      return "assistant.denied.write";
  }
}
