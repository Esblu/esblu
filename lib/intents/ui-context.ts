import type { SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// Kontext aktuálnej obrazovky — čo má znamenať „tento dokument".
//
// PREČO TO NIE JE „POSLEDNÝ DOKUMENT"
// -----------------------------------
// Najlacnejšie by bolo odvodiť „tento" z databázy: naposledy nahraný,
// naposledy otvorený, najnovší v Inboxe. Každá z tých možností je tichá
// chyba čakajúca na svoju chvíľu. Kolega nahrá doklad o sekundu skôr,
// beží dávkové spracovanie, používateľ má otvorené dve karty — a príkaz
// spracuje cudzí doklad. Pri faktúrach to nie je preklep, to je zlý doklad
// v účtovníctve.
//
// Preto „tento" znamená VÝHRADNE entitu, ktorú má používateľ naozaj
// otvorenú, a klient ju musí explicitne poslať s požiadavkou. Keď nič
// otvorené nie je, asistent to prizná a poprosí o otvorenie — nehádá.
//
// ČO SA POSIELA
// -------------
// Iba modul (enum), typ entity (enum) a jej identifikátor (UUID). Žiadny
// obsah dokumentu, žiadny text z OCR, žiadne osobné údaje, žiadny stav
// stránky. Kontext je popis TOHO, ČO JE OTVORENÉ, nie prenos dát.
//
// ČO Z TOHO NEVYPLÝVA ŽIADNE OPRÁVNENIE
// -------------------------------------
// Klient identifikátor iba NAVRHUJE. Server si ho overí znova: či entita
// existuje, či patrí do aktívnej firmy volajúceho a či ju volajúci vôbec
// smie čítať — a to výhradne cez user-scoped klienta, takže posledné slovo
// má RLS. Firma, používateľ, rola ani oprávnenia sa z klienta NEBERÚ
// nikdy; odvodzujú sa z tokenu.
//
// ŽIVOTNOSŤ
// ---------
// Kontext je viazaný na JEDNU požiadavku. Neukladá sa do databázy a nie je
// to konverzačná pamäť. Keď používateľ prejde inam, klient pošle iný
// kontext (alebo žiadny); keď sa odhlási alebo prepne firmu, ďalšia
// požiadavka má iný token a overenie proti aktívnej firme zlyhá samo.
// =============================================================================

/** Moduly, ktoré môžu mať otvorenú entitu. Uzavretý zoznam. */
export const UI_CONTEXT_MODULES = [
  "inbox",
  "invoice",
  "partner",
  "vehicle",
  "machine",
  "inventory",
] as const;

export type UiContextModule = (typeof UI_CONTEXT_MODULES)[number];

/** Typy entít. Uzavretý zoznam — nie ľubovoľný názov tabuľky od klienta. */
export const UI_CONTEXT_ENTITY_TYPES = [
  "document",
  "invoice",
  "partner",
  "vehicle",
  "machine",
  "inventory_item",
] as const;

export type UiContextEntityType = (typeof UI_CONTEXT_ENTITY_TYPES)[number];

export type UiContext = {
  module: UiContextModule;
  entityType: UiContextEntityType;
  entityId: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Prečíta kontext z tela požiadavky.
 *
 * Prísne: neznámy modul, neznámy typ entity alebo identifikátor, ktorý nie
 * je UUID, znamenajú `null` — teda „nič otvorené". Neplatný kontext sa
 * nikdy nesnaží zachrániť; príkaz sa spracuje ako keby žiadny kontext
 * nebol. Ostatné polia sa ignorujú, vrátane akéhokoľvek `companyId`,
 * `userId`, `role` či `permissions`, ktoré by klient pribalil.
 */
export function readUiContext(raw: unknown): UiContext | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;

  // `module` je v Next.js vyhradený názov premennej (@next/next/
  // no-assign-module-variable), preto `moduleName`.
  const moduleName = source.module;
  const entityType = source.entityType;
  const entityId = source.entityId;

  if (
    typeof moduleName !== "string" ||
    !(UI_CONTEXT_MODULES as readonly string[]).includes(moduleName)
  ) {
    return null;
  }
  if (
    typeof entityType !== "string" ||
    !(UI_CONTEXT_ENTITY_TYPES as readonly string[]).includes(entityType)
  ) {
    return null;
  }
  if (typeof entityId !== "string" || !UUID_PATTERN.test(entityId)) return null;

  return {
    module: moduleName as UiContextModule,
    entityType: entityType as UiContextEntityType,
    entityId,
  };
}

// -----------------------------------------------------------------------------
// Serverová reautorizácia
// -----------------------------------------------------------------------------

/**
 * Entita potvrdená serverom. `label` je bezpečné označenie na zobrazenie —
 * nikdy sa nezobrazuje interný identifikátor.
 */
export type ResolvedUiEntity = {
  entityType: UiContextEntityType;
  entityId: string;
  label: string;
  /** Surový riadok pre volajúceho, ktorý potrebuje viac (napr. dokument). */
  row: Record<string, unknown>;
};

/** Ako sa entita každého typu overuje a čím sa pomenuje. */
const ENTITY_SOURCES: Record<
  UiContextEntityType,
  { table: string; columns: string; label: (row: Record<string, unknown>) => string }
> = {
  document: {
    table: "documents",
    // `extracted_fields` je tu preto, že z neho stavia kandidáta prijatá
    // faktúra. Nikdy sa neposiela klientovi — zostáva na serveri.
    columns: "id, document_type, status, original_filename, extracted_fields, deleted_at, archived_from_inbox_at",
    label: (row) => asText(row.original_filename) || asText(row.document_type) || "",
  },
  invoice: {
    table: "invoices",
    columns: "id, invoice_number, supplier_invoice_number, direction, document_status, payment_status, total_amount, currency",
    label: (row) =>
      asText(row.invoice_number) || asText(row.supplier_invoice_number) || "",
  },
  partner: {
    table: "business_partners",
    columns: "id, legal_name, ico",
    label: (row) => asText(row.legal_name),
  },
  vehicle: {
    table: "vehicles",
    columns: "id, spz, znacka, model",
    label: (row) => asText(row.spz) || asText(row.znacka),
  },
  machine: {
    table: "machines",
    columns: "id, name",
    label: (row) => asText(row.name),
  },
  inventory_item: {
    table: "inventory_items",
    columns: "id, name, quantity, unit, min_quantity",
    label: (row) => asText(row.name),
  },
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Overí, že otvorená entita naozaj existuje a volajúci ju smie použiť.
 *
 * Dotaz beží cez user-scoped klienta, takže firemná izolácia aj finančné
 * obmedzenia platia bez toho, aby sa tu čokoľvek duplikovalo:
 *
 *   - cudzí tenant → RLS nevráti riadok → `null`
 *   - podvrhnutý identifikátor → riadok neexistuje → `null`
 *   - zmazaná entita → `null` (a pri dokumentoch aj archivovaná)
 *   - zamestnanec a finančný doklad → `esblu_can_read_document` v RLS
 *     nepustí → `null`
 *   - účtovník a prevádzkový stroj → prevádzkový gate nepustí → `null`
 *
 * Volajúci nedostane dôvod. „Nenašlo sa" a „nesmieš" sú zvonku to isté,
 * pretože rozdiel medzi nimi je sám informáciou o cudzích dátach.
 */
export async function resolveUiEntity(
  supabase: SupabaseClient,
  context: UiContext
): Promise<ResolvedUiEntity | null> {
  const source = ENTITY_SOURCES[context.entityType];
  if (!source) return null;

  const { data, error } = await supabase
    .from(source.table)
    .select(source.columns)
    .eq("id", context.entityId)
    .maybeSingle();

  if (error || !data) return null;

  // `select()` s dynamickým zoznamom stĺpcov nevie typovať výsledok, preto
  // cez `unknown`. Hodnoty sa aj tak čítajú cez `asText`, ktorý typ overuje.
  const row = data as unknown as Record<string, unknown>;

  // Zmazané a z Inboxu archivované dokumenty sa nepovažujú za otvorené.
  // RLS ich síce vidieť môže, ale pracovať s nimi nemá zmysel.
  if (context.entityType === "document") {
    if (row.deleted_at !== null && row.deleted_at !== undefined) return null;
    if (row.archived_from_inbox_at !== null && row.archived_from_inbox_at !== undefined) {
      return null;
    }
  }

  return {
    entityType: context.entityType,
    entityId: context.entityId,
    label: source.label(row),
    row,
  };
}

/**
 * Sedí modul, ktorý klient hlási, k typu entity?
 *
 * Nie je to bezpečnostná kontrola — tou je `resolveUiEntity` — ale
 * ochrana pred nezmyslom typu „modul faktúr a otvorené vozidlo", z ktorého
 * by kontextový príkaz odvodil niečo nečakané.
 */
export function moduleMatchesEntity(context: UiContext): boolean {
  switch (context.module) {
    case "inbox":
      return context.entityType === "document";
    case "invoice":
      return context.entityType === "invoice";
    case "partner":
      return context.entityType === "partner";
    case "vehicle":
      return context.entityType === "vehicle";
    case "machine":
      return context.entityType === "machine";
    case "inventory":
      return context.entityType === "inventory_item";
  }
}
