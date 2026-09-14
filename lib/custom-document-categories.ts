import { supabase } from "@/lib/supabase";

// =============================================================================
// Esblu — firemné vlastné kategórie AI dokumentov (Fáza 2/4 zadania
// "Inteligentný Inbox + Univerzálne AI dokumenty").
// =============================================================================
// Backend primitíva pre "Dynamické nové kategórie": keď AI vyhodnotí
// documentType ako "other" a nevie ho namapovať na žiadny z existujúcich 8
// pevných typov (pozri app/api/scan-document/route.ts), review UI má PRED
// návrhom novej kategórie skúsiť:
//   1) canonical known types (ScanDocumentType enum — rieši sa v review UI,
//      nie tu),
//   2) existujúce custom categories tejto firmy — listCompanyCustomCategories()
//      + findMatchingCustomCategory() nižšie,
//   3) až potom (po POTVRDENÍ používateľom, nikdy automaticky) založiť novú
//      cez createCustomCategory().
//
// DB: supabase/migrations/20260914_add_custom_document_categories.sql —
// tabuľka public.custom_document_categories + documents.custom_category_id.
// RLS: SELECT/INSERT pre ktoréhokoľvek aktívneho člena firmy (rovnaká úroveň
// ako vytvorenie dokumentu), UPDATE/DELETE iba owner/admin. Tento modul teda
// nikdy nepotrebuje service_role — bežný user-scoped `supabase` klient s
// company-scoped RLS je jediná a postačujúca autorizácia (Fáza 11 princíp:
// user-scoped Supabase/RLS všade, kde je to možné).
// =============================================================================

export type CustomDocumentCategory = {
  id: string;
  company_id: string;
  name: string;
  canonical_slug: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
};

/**
 * Normalizuje názov kategórie na canonical_slug pre fuzzy-match/duplicate
 * check — rovnaký princíp ako lib/normalize-spz.ts (NFKC/NFD diakritika
 * preč), ale na rozdiel od ŠPZ tu zachovávame medzery medzi slovami
 * (kategórie sú viacslovné vety, nie kódy) a kolabujeme ich na jednu.
 * Musí zostať zhodné s CHECK (canonical_slug ~ '^[a-z0-9]+( [a-z0-9]+)*$')
 * v migrácii — inak DB insert zlyhá skôr, než čokoľvek zapíše.
 */
export function normalizeCanonicalCategorySlug(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  return normalized || null;
}

/**
 * Všetky vlastné kategórie AKTÍVNEJ firmy prihláseného používateľa (RLS
 * company-scoped, žiadny p_company_id parameter — rovnaký vzor ako
 * loadRecords() v app/ai-evidencia/page.tsx). Používa review UI PRED
 * ponúknutím novej kategórie, aby AI/appka nezakladala duplicity s
 * rovnakým významom pod iným menom (bod zadania "Nedovoľ AI vytvárať
 * stovky duplicitných kategórií").
 */
export async function listCompanyCustomCategories(): Promise<
  CustomDocumentCategory[]
> {
  const { data, error } = await supabase
    .from("custom_document_categories")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    console.error("listCompanyCustomCategories zlyhalo:", error.message);
    return [];
  }

  return (data as CustomDocumentCategory[]) || [];
}

/**
 * Nájde existujúcu kategóriu s presne rovnakým canonical_slug (krok 2 zo
 * zadania — skúsiť existujúce custom categories PRED návrhom novej). Iba
 * exact-slug zhoda (po normalizácii diakritiky/veľkosti písmen/medzier) —
 * zámerne žiadny "fuzzy"/vzdialenostný algoritmus (napr. Levenshtein), aby
 * sa nikdy tichým "priblížením" nespojili dve v skutočnosti odlišné
 * kategórie; review UI vždy ukáže návrh používateľovi na POTVRDENIE, takže
 * mierne odlišné formulácie jednoducho vedú k novému riadku, nie k chybnému
 * zlúčeniu.
 */
export function findMatchingCustomCategory(
  categories: CustomDocumentCategory[],
  candidateName: string
): CustomDocumentCategory | null {
  const candidateSlug = normalizeCanonicalCategorySlug(candidateName);
  if (!candidateSlug) return null;

  return (
    categories.find((category) => category.canonical_slug === candidateSlug) ??
    null
  );
}

export type CreateCustomCategoryError =
  | "INVALID_NAME"
  | "ALREADY_EXISTS"
  | "UNKNOWN";

/**
 * Založí novú vlastnú kategóriu — volať VÝHRADNE po explicitnom potvrdení
 * používateľom (review UI "POTVRDIŤ / UPRAVIŤ / ZRUŠIŤ", nikdy automaticky
 * po AI analýze). created_by sa nastavuje na auth.uid() (RLS with_check to
 * aj vynucuje), company_id na aktívnu firmu volajúceho.
 *
 * UNIQUE (company_id, canonical_slug) v DB je posledná poistka proti
 * duplicite aj pri súbežnom volaní (napr. dve zariadenia toho istého
 * používateľa) — na also-exists konflikt appka reaguje ako na úspech
 * (vráti existujúci riadok), nie ako na chybu, keďže výsledný stav je
 * rovnaký, ako keby insert prebehol ako prvý.
 */
export async function createCustomCategory(
  companyId: string,
  name: string,
  description: string | null = null
): Promise<
  | { ok: true; category: CustomDocumentCategory }
  | { ok: false; error: CreateCustomCategoryError }
> {
  const trimmedName = name.trim();
  const canonicalSlug = normalizeCanonicalCategorySlug(trimmedName);

  if (!trimmedName || !canonicalSlug) {
    return { ok: false, error: "INVALID_NAME" };
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return { ok: false, error: "UNKNOWN" };
  }

  const { data, error } = await supabase
    .from("custom_document_categories")
    .insert({
      company_id: companyId,
      name: trimmedName,
      canonical_slug: canonicalSlug,
      description,
      created_by: session.user.id,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") {
      // unique_violation (company_id, canonical_slug) — medzičasom už
      // vznikla (napr. súbežné potvrdenie na inom zariadení). Dohľadáme a
      // vrátime existujúci riadok namiesto chyby.
      const existing = await listCompanyCustomCategories();
      const match = findMatchingCustomCategory(existing, trimmedName);

      if (match) {
        return { ok: true, category: match };
      }

      return { ok: false, error: "ALREADY_EXISTS" };
    }

    console.error("createCustomCategory zlyhalo:", error.message);
    return { ok: false, error: "UNKNOWN" };
  }

  return { ok: true, category: data as CustomDocumentCategory };
}
