import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { IntentResult } from "@/lib/intents/types";
import type { CompanyMemberRole } from "@/lib/company";

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
  if (!ctx.financeView) return denied(locale);

  const { data, error } = await supabase
    .from("invoices")
    .select(
      "id, invoice_number, supplier_invoice_number, direction, total_amount, currency, payment_status, document_status, issue_date"
    )
    .eq("document_status", "finalized")
    .neq("payment_status", "paid")
    .order("issue_date", { ascending: false })
    .limit(50);

  if (error) {
    return { kind: "error", text: translate(locale, "search.errors.generic") };
  }

  const rows = (data as InvoiceRow[]) ?? [];

  if (rows.length === 0) {
    return { kind: "answer", text: translate(locale, "invoices.voice.noUnpaid") };
  }

  return {
    kind: "list",
    title: translate(locale, "invoices.sections.unpaid"),
    items: rows.map((row) => ({
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
