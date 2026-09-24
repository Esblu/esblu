import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeSpz } from "@/lib/normalize-spz";
import { tokenStem } from "@/lib/intents/entity-resolution";

// =============================================================================
// Esblu — deterministické vyhľadávanie entít (vozidlo/stroj/skladová
// položka) pre Intent Engine (lib/intents/handlers.ts).
// =============================================================================
// Číta VÝHRADNE cez `supabase` klienta, ktorý volajúci odovzdá — v praxi
// vždy user-scoped klient postavený na Bearer tokene prihláseného
// používateľa (pozri lib/server-supabase-user-client.ts), takže RLS
// (company_id = esblu_my_active_company_id()) je jediná a postačujúca
// autorizácia. Tento modul NIKDY nedostáva ani nepoužíva company_id od
// volajúceho ako parameter na filtrovanie — RLS to robí sama, presne ako
// v existujúcom app/vozidla/page.tsx (`.eq("company_id", ...)` tam je iba
// doplnková UX konzistencia, nie bezpečnostná hranica).
//
// ŠPZ normalizácia je zámerne zhodná s existujúcim `lib/normalize-spz.ts`
// použitým v celej appke (napr. app/vozidla/page.tsx, AI Evidencia) — "TT
// 123AB", "TT123AB", "tt123ab" musia byť tá istá zhoda.
// =============================================================================

export type SearchedVehicle = {
  id: string;
  spz: string | null;
  vin: string | null;
  znacka: string | null;
  model: string | null;
  stk: string | null;
  ek: string | null;
};

export type SearchedMachine = {
  id: string;
  name: string | null;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
};

export type SearchedInventoryItem = {
  id: string;
  name: string | null;
  category: string | null;
  quantity: number | null;
  unit: string | null;
  location: string | null;
};

const VEHICLE_COLUMNS = "id, spz, vin, znacka, model, stk, ek";
const MACHINE_COLUMNS = "id, name, category, manufacturer, model, serial_number";
const INVENTORY_COLUMNS = "id, name, category, quantity, unit, location";

function normalizeForFreeTextMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function textIncludes(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return normalizeForFreeTextMatch(haystack).includes(
    normalizeForFreeTextMatch(needle)
  );
}

// Minimálna dĺžka KRATŠIEHO z dvoch porovnávaných slov, aby sa prefix-zhoda
// vôbec zvážila — zabraňuje falošným zhodám na krátkych časticiach/
// predložkách (napr. "na" by inak bolo prefixom desiatok slov).
const STEM_MATCH_MIN_LENGTH = 3;

/**
 * Deterministický, auditovateľný fallback pre slovenskú/českú deklináciu
 * ("spreja"/"sprejom"/"sprejov" ↔ DB názov "Sprej") — ŽIADNY fuzzy/
 * Levenshtein matching, iba explicitné, vysvetliteľné pravidlo: dve
 * normalizované slová sa považujú za rovnaký "stem", ak jedno je presným
 * prefixom druhého A kratšie z nich má aspoň STEM_MATCH_MIN_LENGTH
 * znakov. Volá sa VÝHRADNE ako fallback, keď presná substring zhoda
 * (textIncludes) nenájde nič — nikdy ju nenahrádza, iba ju dopĺňa (fail
 * closed princíp "nikdy nehádaj": toto je stále striktné pravidlo, nie
 * štatistický odhad).
 */
function tokensShareStem(a: string, b: string): boolean {
  if (!a || !b) return false;
  // Krátke slová („na", „z", „CAT") sa porovnávajú presne; skloňovanie
  // s pohyblivým „e" (bager/bagra) rieši zdieľaný kmeň z entity-resolution.
  if (a === b) return true;
  if (tokenStem(a) === tokenStem(b)) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < STEM_MATCH_MIN_LENGTH) return false;
  return longer.startsWith(shorter);
}

/** `textIncludes` doplnené o `tokensShareStem` fallback nad jednotlivými
 * slovami dopytu — KAŽDÉ slovo dopytu musí mať zhodu (stem alebo presnú)
 * v haystacku, aby fallback nenachádzal príliš voľné zhody pri
 * viacslovných dopytoch. */
function textIncludesWithStemFallback(haystack: string, needle: string): boolean {
  if (!needle) return false;
  if (textIncludes(haystack, needle)) return true;

  const haystackTokens = normalizeForFreeTextMatch(haystack)
    .split(/\s+/)
    .filter(Boolean);
  const needleTokens = normalizeForFreeTextMatch(needle)
    .split(/\s+/)
    .filter(Boolean);
  if (needleTokens.length === 0) return false;

  return needleTokens.every((nt) => haystackTokens.some((ht) => tokensShareStem(ht, nt)));
}

/**
 * Všetky vozidlá aktívnej firmy (RLS-scoped). Volá sa raz na vyhľadávaciu
 * požiadavku — firma má rádovo desiatky/stovky vozidiel, nie milióny, takže
 * "fetch all + filtruj v appke" (rovnaký vzor ako app/vozidla/page.tsx a
 * app/components/Dashboard.tsx) je tu bezpečné aj efektívne (jedna query,
 * žiadny N+1 — bod 17 zadania).
 *
 * Exportované aj priamo (nie iba cez search*) — Intent Engine ho použije
 * pre `listAll` ("Ukáž všetky vozidlá/stroje/skladové položky.", doplnenie
 * zadania, úloha 1) — presne tá istá RLS-scoped query ako pri vyhľadávaní,
 * iba bez následného filtrovania.
 */
export async function fetchCompanyVehicles(
  supabase: SupabaseClient
): Promise<SearchedVehicle[]> {
  const { data, error } = await supabase.from("vehicles").select(VEHICLE_COLUMNS);
  if (error) {
    console.error("fetchCompanyVehicles zlyhalo:", error.message);
    return [];
  }
  return (data as SearchedVehicle[]) || [];
}

export async function fetchCompanyMachines(
  supabase: SupabaseClient
): Promise<SearchedMachine[]> {
  const { data, error } = await supabase.from("machines").select(MACHINE_COLUMNS);
  if (error) {
    console.error("fetchCompanyMachines zlyhalo:", error.message);
    return [];
  }
  return (data as SearchedMachine[]) || [];
}

export async function fetchCompanyInventoryItems(
  supabase: SupabaseClient
): Promise<SearchedInventoryItem[]> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select(INVENTORY_COLUMNS);
  if (error) {
    console.error("fetchCompanyInventoryItems zlyhalo:", error.message);
    return [];
  }
  return (data as SearchedInventoryItem[]) || [];
}

/**
 * Nájde vozidlo PRESNE podľa ŠPZ (po normalizácii). Toto je deterministická
 * cesta pre "TT123AB" / "nájdi TT123AB" / "kedy končí STK TT123AB" a pod. —
 * vracia buď presne jedno vozidlo, alebo null (nikdy nehádaná zhoda).
 */
export async function resolveVehicleByPlate(
  supabase: SupabaseClient,
  rawPlate: string
): Promise<SearchedVehicle | null> {
  const normalized = normalizeSpz(rawPlate);
  if (!normalized) return null;

  const vehicles = await fetchCompanyVehicles(supabase);
  return vehicles.find((v) => normalizeSpz(v.spz) === normalized) ?? null;
}

/**
 * Voľné vyhľadávanie vozidiel podľa ŠPZ (aj čiastočná zhoda po normalizácii)
 * alebo značky/modelu — vracia VŠETKY zhody, aby volajúci (Intent Engine)
 * mohol rozhodnúť medzi "presne jedno → OPEN" a "viac → DISAMBIGUATE",
 * presne podľa zadania ("Ak sú dve možné entity → nehádať, ukázať výber").
 */
export async function searchVehicles(
  supabase: SupabaseClient,
  queryText: string
): Promise<SearchedVehicle[]> {
  const normalizedQuery = normalizeSpz(queryText);
  const vehicles = await fetchCompanyVehicles(supabase);

  if (normalizedQuery) {
    const plateMatches = vehicles.filter((v) =>
      (normalizeSpz(v.spz) ?? "").includes(normalizedQuery)
    );
    if (plateMatches.length > 0) return plateMatches;
  }

  return vehicles.filter((v) =>
    textIncludes(`${v.znacka || ""} ${v.model || ""} ${v.vin || ""}`, queryText)
  );
}

export async function searchMachines(
  supabase: SupabaseClient,
  queryText: string
): Promise<SearchedMachine[]> {
  const machines = await fetchCompanyMachines(supabase);
  return machines.filter((m) =>
    textIncludes(
      `${m.name || ""} ${m.category || ""} ${m.manufacturer || ""} ${m.model || ""} ${m.serial_number || ""}`,
      queryText
    )
  );
}

export async function searchInventoryItems(
  supabase: SupabaseClient,
  queryText: string
): Promise<SearchedInventoryItem[]> {
  const items = await fetchCompanyInventoryItems(supabase);
  const haystackOf = (i: SearchedInventoryItem) =>
    `${i.name || ""} ${i.category || ""} ${i.location || ""}`;

  const exact = items.filter((i) => textIncludes(haystackOf(i), queryText));
  if (exact.length > 0) return exact;

  // Fallback pre slovenskú deklináciu ("Aký máme zostatok pre položku
  // spreja?" musí nájsť DB položku "Sprej") — pozri
  // textIncludesWithStemFallback vyššie. Zapína sa IBA keď presná zhoda
  // vráti 0 výsledkov (root cause opravy inventory-status bugu, doplnenie
  // zadania bod 2).
  return items.filter((i) => textIncludesWithStemFallback(haystackOf(i), queryText));
}
