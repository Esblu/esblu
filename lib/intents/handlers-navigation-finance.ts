import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { IntentResult, InvoiceStatusFilter } from "@/lib/intents/types";
import type { CompanyMemberRole } from "@/lib/company";
import { isInvoiceOverdue } from "@/lib/invoicing/vat-engine";
import { stockStatus, type InventoryItemRow } from "@/lib/inventory";
import { fetchMachineDocuments } from "@/lib/machine-documents";
import {
  listCompanyCustomCategories,
  findMatchingCustomCategory,
} from "@/lib/custom-document-categories";

// =============================================================================
// Voice Phase 1 — navigácia a účtovnícke čítanie.
//
// AUTORIZÁCIA
// -----------
// Tieto handlery ako jediné z čitacích dostávajú rolu volajúceho. Nie preto,
// že by RLS nestačila — tá by zamestnancovi vrátila nula riadkov a žiadne
// dáta by neunikli. Dôvod je iný: "nič sa nenašlo" je pre používateľa
// nepravdivá odpoveď a zároveň nepriamo vypovedá o tom, že dáta existujú,
// len ich nevidí. Preto sa rola kontroluje PRED dotazom a odmietnutie je
// explicitné.
//
// Rola sa berie výhradne zo servera (JWT → company_members), nikdy z tela
// požiadavky — pozri app/api/assistant/intent/route.ts.
//
// Kontrola tu NENAHRÁDZA RLS, iba ju predbieha. Keby sa niekto pomýlil
// a guard vynechal, databáza aj tak nič nevydá.
// =============================================================================

export type ReadContext = {
  role: CompanyMemberRole;
  /** Zrkadlí esblu_my_finance_view() — počíta sa na serveri, nie u klienta. */
  financeView: boolean;
  /** Zrkadlí esblu_role_can_operate(). */
  canOperate: boolean;
};

function denied(locale: Locale): IntentResult {
  return { kind: "error", text: translate(locale, "search.voice.states.denied") };
}

// -----------------------------------------------------------------------------
// Navigácia
// -----------------------------------------------------------------------------

/**
 * Moduly appky a ich podmienka viditeľnosti.
 *
 * Kľúčové slová sú zjednotené naprieč SK/CZ/DE/EN do jedného zoznamu na
 * modul — rovnaký princíp ako vo zvyšku parsera. Jazyk je vstup, nie
 * samostatná vetva logiky.
 */
const MODULES: {
  key: string;
  href: string;
  labelKey: string;
  keywords: string[];
  requires: "finance" | "operational" | "any";
}[] = [
  {
    key: "inbox",
    href: "/ai-evidencia",
    labelKey: "nav.inbox",
    keywords: ["inbox", "evidencia", "doklady", "posteingang", "belege", "dokumenty", "dokumente", "documents"],
    requires: "any",
  },
  {
    key: "invoices",
    href: "/faktury",
    labelKey: "nav.invoices",
    keywords: ["faktury", "faktura", "rechnungen", "rechnung", "invoices", "invoice"],
    requires: "finance",
  },
  {
    key: "partners",
    href: "/obchodni-partneri",
    labelKey: "nav.businessPartners",
    keywords: ["partneri", "partner", "obchodni partneri", "geschaftspartner", "partners", "kunden", "zakaznici"],
    requires: "finance",
  },
  {
    key: "vehicles",
    href: "/vozidla",
    labelKey: "nav.vehicles",
    keywords: ["vozidla", "vozidlo", "auta", "auto", "fahrzeuge", "fahrzeug", "vehicles", "vehicle"],
    requires: "operational",
  },
  {
    key: "machines",
    href: "/stroje",
    labelKey: "nav.machines",
    keywords: ["stroje", "stroj", "maschinen", "maschine", "machines", "machine", "bagre"],
    requires: "operational",
  },
  {
    key: "inventory",
    href: "/sklad",
    labelKey: "nav.inventory",
    keywords: ["sklad", "zasoby", "lager", "bestand", "inventory", "warehouse"],
    requires: "operational",
  },
  {
    key: "settings",
    href: "/nastavenia",
    labelKey: "nav.settings",
    keywords: ["nastavenia", "nastavenie", "einstellungen", "settings"],
    requires: "any",
  },
];

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

export function handleOpenModule(
  locale: Locale,
  ctx: ReadContext,
  rawQuery: string | undefined
): IntentResult {
  const needle = stripDiacritics((rawQuery ?? "").toLowerCase()).trim();

  if (!needle) {
    return { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") };
  }

  // Najdlhšia zhoda vyhráva — "obchodní partneri" sa nesmie chytiť na
  // kratšie "partner" skôr, než sa vyskúša presnejší variant.
  let best: (typeof MODULES)[number] | null = null;
  let bestLength = 0;

  for (const candidate of MODULES) {
    for (const keyword of candidate.keywords) {
      if (needle.includes(keyword) && keyword.length > bestLength) {
        best = candidate;
        bestLength = keyword.length;
      }
    }
  }

  if (!best) {
    return { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") };
  }

  // Modul, na ktorý rola nemá právo, sa neotvára — a ani sa nepriznáva, že
  // by inak existoval nejaký obsah.
  if (best.requires === "finance" && !ctx.financeView) return denied(locale);
  if (best.requires === "operational" && !ctx.canOperate) return denied(locale);

  return {
    kind: "navigate",
    entity: {
      type: "document",
      id: best.key,
      label: translate(locale, best.labelKey),
      href: best.href,
    },
  };
}

// -----------------------------------------------------------------------------
// Faktúry
// -----------------------------------------------------------------------------

type InvoiceRow = {
  id: string;
  invoice_number: string | null;
  supplier_invoice_number: string | null;
  direction: string | null;
  total_amount: number | null;
  currency: string | null;
  payment_status: string | null;
  document_status: string | null;
  issue_date: string | null;
  due_date?: string | null;
};

function invoiceLabel(row: InvoiceRow, locale: Locale): string {
  const number =
    row.direction === "received"
      ? row.supplier_invoice_number
      : row.invoice_number;

  const amount =
    typeof row.total_amount === "number"
      ? ` · ${row.total_amount} ${row.currency ?? ""}`.trimEnd()
      : "";

  return `${number ?? translate(locale, "invoices.numberFallback")}${amount}`;
}

export async function handleSearchInvoice(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext,
  rawQuery: string | undefined
): Promise<IntentResult> {
  if (!ctx.financeView) return denied(locale);

  const query = (rawQuery ?? "").trim();

  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, supplier_invoice_number, direction, total_amount, currency, payment_status, document_status, issue_date"
    )
    .order("issue_date", { ascending: false })
    .limit(200);

  if (error) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const rows = (data as InvoiceRow[]) ?? [];
  const needle = stripDiacritics(query.toLowerCase());

  // Filtrovanie v JS, nie v .or() filtri — voľný text z prepisu reči sa
  // nikdy nevkladá do PostgREST výrazu.
  const matches =
    needle === ""
      ? rows
      : rows.filter((row) =>
          [row.invoice_number, row.supplier_invoice_number]
            .filter((value): value is string => typeof value === "string" && value.length > 0)
            .some((value) => stripDiacritics(value.toLowerCase()).includes(needle))
        );

  if (matches.length === 0) {
    return { kind: "not_found", text: translate(locale, "invoices.empty") };
  }

  if (matches.length === 1) {
    return {
      kind: "navigate",
      entity: {
        type: "document",
        id: matches[0].id,
        label: invoiceLabel(matches[0], locale),
        href: `/faktury/${matches[0].id}`,
      },
    };
  }

  return {
    kind: "list",
    title: translate(locale, "invoices.register.title"),
    items: matches.slice(0, 20).map((row) => ({
      type: "document" as const,
      id: row.id,
      label: invoiceLabel(row, locale),
      href: `/faktury/${row.id}`,
    })),
  };
}

export async function handleShowUnpaidInvoices(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext
): Promise<IntentResult> {
  return handleShowInvoicesByStatus(supabase, locale, ctx, "unpaid");
}

/**
 * Faktúry podľa stavu.
 *
 * Jeden handler pre všetkých šesť filtrov namiesto šiestich takmer
 * rovnakých. Filtruje sa nad rovnakou množinou, ktorú vracia RLS — rola sa
 * kontroluje vopred z rovnakého dôvodu ako pri ostatných finančných
 * intentoch (viď hlavička súboru).
 *
 * `overdue` nie je stĺpec, ale kombinácia splatnosti a stavu úhrady;
 * počíta sa tou istou funkciou, akou ho počíta zoznam faktúr, aby sa dve
 * miesta v appke nemohli rozísť v tom, čo je po splatnosti.
 */
export async function handleShowInvoicesByStatus(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext,
  status: InvoiceStatusFilter | undefined
): Promise<IntentResult> {
  if (!ctx.financeView) return denied(locale);

  const effective: InvoiceStatusFilter = status ?? "unpaid";

  let query = supabase
    .from("invoices")
    .select(
      "id, invoice_number, supplier_invoice_number, direction, total_amount, currency, payment_status, document_status, issue_date, due_date"
    )
    .order("issue_date", { ascending: false })
    .limit(100);

  // Filtre sú pevné hodnoty z allowlistu, nie text z prepisu reči — do
  // dopytu sa preto smú dostať priamo.
  switch (effective) {
    case "unpaid":
      query = query.eq("document_status", "finalized").neq("payment_status", "paid");
      break;
    case "paid":
      query = query.eq("payment_status", "paid");
      break;
    case "overdue":
      query = query.eq("document_status", "finalized").neq("payment_status", "paid");
      break;
    case "issued":
      query = query.eq("direction", "issued");
      break;
    case "received":
      query = query.eq("direction", "received");
      break;
    case "draft":
      query = query.eq("document_status", "draft");
      break;
  }

  const { data, error } = await query;

  if (error) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  let rows = (data as InvoiceRow[]) ?? [];

  if (effective === "overdue") {
    rows = rows.filter((row) => isInvoiceOverdue(row.due_date ?? null, row.payment_status ?? ""));
  }

  if (rows.length === 0) {
    return { kind: "answer", text: translate(locale, `invoices.voice.empty.${effective}`) };
  }

  return {
    kind: "list",
    title: translate(locale, `invoices.voice.title.${effective}`),
    items: rows.slice(0, 30).map((row) => ({
      type: "document" as const,
      id: row.id,
      label: invoiceLabel(row, locale),
      href: `/faktury/${row.id}`,
    })),
  };
}

// -----------------------------------------------------------------------------
// Obchodní partneri
// -----------------------------------------------------------------------------

export async function handleSearchPartner(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext,
  rawQuery: string | undefined
): Promise<IntentResult> {
  if (!ctx.financeView) return denied(locale);

  const query = (rawQuery ?? "").trim();

  const { data, error } = await supabase
    .from("business_partners")
    .select("id, legal_name, ico")
    .order("legal_name", { ascending: true })
    .limit(300);

  if (error) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const rows = (data as { id: string; legal_name: string; ico: string | null }[]) ?? [];
  const needle = stripDiacritics(query.toLowerCase());

  const matches =
    needle === ""
      ? rows
      : rows.filter(
          (row) =>
            stripDiacritics((row.legal_name ?? "").toLowerCase()).includes(needle) ||
            (row.ico ?? "").includes(needle)
        );

  if (matches.length === 0) {
    return { kind: "not_found", text: translate(locale, "businessPartners.empty") };
  }

  if (matches.length === 1) {
    return {
      kind: "navigate",
      entity: {
        type: "document",
        id: matches[0].id,
        label: matches[0].legal_name,
        href: `/obchodni-partneri/${matches[0].id}`,
      },
    };
  }

  return {
    kind: "list",
    title: translate(locale, "businessPartners.title"),
    items: matches.slice(0, 20).map((row) => ({
      type: "document" as const,
      id: row.id,
      label: row.ico ? `${row.legal_name} · ${row.ico}` : row.legal_name,
      href: `/obchodni-partneri/${row.id}`,
    })),
  };
}

// -----------------------------------------------------------------------------
// Sklad
// -----------------------------------------------------------------------------

/**
 * Položky pod minimom alebo vypredané.
 *
 * Stav sa NEPOČÍTA znova — používa sa `stockStatus()` z lib/inventory.ts,
 * tá istá funkcia, akou stav zobrazuje zoznam skladu. Druhý výpočet by
 * znamenal, že hlas raz povie "pod minimom" o položke, ktorú obrazovka
 * ukazuje ako v poriadku.
 *
 * Položka bez nastaveného minima sa sem nikdy nedostane — o takej appka
 * nevie, koľko jej má byť, a tvrdiť o nej čokoľvek by bol výmysel.
 */
export async function handleShowLowStock(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext,
  onlyOut: boolean
): Promise<IntentResult> {
  if (!ctx.canOperate) return denied(locale);

  const { data, error } = await supabase
    .from("inventory_items")
    .select("*")
    .order("name", { ascending: true })
    .limit(300);

  if (error) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const rows = (data as InventoryItemRow[]) ?? [];
  const matches = rows.filter((item) => {
    const status = stockStatus(item);
    return onlyOut ? status === "out" : status === "low" || status === "out";
  });

  if (matches.length === 0) {
    return {
      kind: "answer",
      text: translate(locale, onlyOut ? "inventory.voice.noneOut" : "inventory.voice.noneLow"),
    };
  }

  return {
    kind: "list",
    title: translate(locale, onlyOut ? "inventory.voice.outTitle" : "inventory.voice.lowTitle"),
    items: matches.slice(0, 30).map((item) => ({
      type: "inventory_item" as const,
      id: item.id,
      label: inventoryLabel(item, locale),
      href: `/sklad/${item.id}`,
    })),
  };
}

function inventoryLabel(item: InventoryItemRow, locale: Locale): string {
  const name = item.name || translate(locale, "dashboard.noName");
  if (typeof item.quantity !== "number") return name;
  const unit = item.unit ? ` ${item.unit}` : "";
  return `${name} · ${item.quantity}${unit}`;
}

// -----------------------------------------------------------------------------
// Stroje — dokumenty a fotografie
// -----------------------------------------------------------------------------

type MachineRow = { id: string; name: string | null };

/**
 * Nájde práve jeden stroj podľa názvu.
 *
 * Vracia tri odlišné výsledky, nie dva: nič, jeden, alebo výber. Keď názov
 * sedí na viac strojov, appka nevyberá — presne ako pri partnerovi.
 */
async function resolveSingleMachine(
  supabase: SupabaseClient,
  locale: Locale,
  rawQuery: string | undefined,
  hrefFor: (id: string) => string
): Promise<{ machine: MachineRow } | { result: IntentResult }> {
  const query = (rawQuery ?? "").trim();

  if (!query) {
    return { result: { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") } };
  }

  const { data, error } = await supabase
    .from("machines")
    .select("id, name")
    .order("name", { ascending: true })
    .limit(300);

  if (error) {
    return { result: { kind: "error", text: translate(locale, "search.errors.generic") } };
  }

  const rows = (data as MachineRow[]) ?? [];
  const needle = stripDiacritics(query.toLowerCase());
  const matches = rows.filter((row) =>
    stripDiacritics((row.name ?? "").toLowerCase()).includes(needle)
  );

  if (matches.length === 0) {
    return { result: { kind: "not_found", text: translate(locale, "machines.list.noneYet") } };
  }

  if (matches.length > 1) {
    return {
      result: {
        kind: "disambiguate",
        candidates: matches.slice(0, 10).map((row) => ({
          type: "machine" as const,
          id: row.id,
          label: row.name ?? translate(locale, "dashboard.noName"),
          href: hrefFor(row.id),
        })),
      },
    };
  }

  return { machine: matches[0] };
}

export async function handleShowMachineDocuments(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext,
  rawQuery: string | undefined
): Promise<IntentResult> {
  if (!ctx.canOperate) return denied(locale);

  const resolved = await resolveSingleMachine(supabase, locale, rawQuery, (id) => `/stroje/${id}`);
  if ("result" in resolved) return resolved.result;

  const machineLabel = resolved.machine.name ?? translate(locale, "dashboard.noName");
  const documents = await fetchMachineDocuments(supabase, resolved.machine.id);

  if (documents.length === 0) {
    return {
      kind: "answer",
      text: translate(locale, "machines.voice.noDocuments", { machine: machineLabel }),
    };
  }

  return {
    kind: "document_list",
    title: translate(locale, "machines.detail.documentsTitle"),
    entity: {
      type: "machine",
      id: resolved.machine.id,
      label: machineLabel,
      href: `/stroje/${resolved.machine.id}`,
    },
    items: documents.slice(0, 30).map((entry) => ({
      typeLabel: translate(locale, `inbox.documentTypes.${entry.documentType}`),
      dateLabel: entry.date,
      label: entry.label,
      href: entry.href,
      linkLabel: machineLabel,
    })),
  };
}

/**
 * Fotogaléria stroja.
 *
 * Nevracia samotné fotky ani ich adresy — iba navigáciu na detail stroja,
 * kde galéria už je. Prenášať sem odkazy na súbory by znamenalo druhú
 * cestu k obsahu úložiska, ktorá by sa musela samostatne strážiť.
 */
export async function handleShowMachinePhotos(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ReadContext,
  rawQuery: string | undefined
): Promise<IntentResult> {
  if (!ctx.canOperate) return denied(locale);

  const resolved = await resolveSingleMachine(
    supabase,
    locale,
    rawQuery,
    (id) => `/stroje/${id}?tab=photos`
  );
  if ("result" in resolved) return resolved.result;

  return {
    kind: "navigate",
    entity: {
      type: "machine",
      id: resolved.machine.id,
      label: resolved.machine.name ?? translate(locale, "dashboard.noName"),
      href: `/stroje/${resolved.machine.id}?tab=photos`,
    },
  };
}

// -----------------------------------------------------------------------------
// Vlastné zložky dokumentov
// -----------------------------------------------------------------------------

/**
 * Otvorí vlastnú zložku v Inboxe.
 *
 * Zhoda názvu je presná po normalizácii (rovnaká funkcia ako pri zakladaní
 * zložiek), nie približná. Približná zhoda by pri "Servis" a "Servis 2026"
 * otvorila tú, ktorú si appka vybrala sama.
 */
export async function handleOpenDocumentFolder(
  supabase: SupabaseClient,
  locale: Locale,
  rawName: string | undefined
): Promise<IntentResult> {
  const name = (rawName ?? "").trim();
  if (!name) {
    return { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") };
  }

  const categories = await listCompanyCustomCategories(supabase);
  const match = findMatchingCustomCategory(categories, name);

  if (!match) {
    return {
      kind: "not_found",
      text: translate(locale, "search.actions.category.notFound", { name }),
    };
  }

  return {
    kind: "navigate",
    entity: {
      type: "document",
      id: match.id,
      label: match.name,
      href: `/ai-evidencia?openFolder=${encodeURIComponent(match.id)}`,
    },
  };
}
