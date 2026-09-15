import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import type { CompanyMemberRole } from "@/lib/company";
import { readExtractedDate } from "@/lib/vehicle-documents";
import {
  isDocumentTypeFilter,
  type DocumentTypeFilter,
  type IntentResult,
  type ParsedIntent,
} from "@/lib/intents/types";
import {
  AI_EVIDENCE_DOCUMENT_TYPE_LABEL,
  amountMatches,
  matchesDateRange,
} from "@/lib/intents/handlers";
import {
  listCompanyCustomCategories,
  findMatchingCustomCategory,
  createCustomCategory,
  normalizeCanonicalCategorySlug,
  type CustomDocumentCategory,
} from "@/lib/custom-document-categories";
import {
  generateActionConfirmationNonce,
  isActionConfirmationSecretConfigured,
  signActionConfirmation,
  verifyActionConfirmation,
  type ActionConfirmationPayload,
} from "@/lib/intents/action-confirmation-proof";

// =============================================================================
// Esblu — Intent Engine WRITE akcie (doplnenie zadania, body 5-13, 22; HARDENED
// podľa bezpečnostného review — server-side confirmation-table + HMAC proof
// model, pozri migráciu
// supabase/migrations/20260915120000_add_assistant_action_confirmations.sql
// a lib/intents/action-confirmation-proof.ts).
// =============================================================================
// KAŽDÝ write intent (EXPORT_DOCUMENTS, CREATE_DOCUMENT_CATEGORY,
// RENAME_DOCUMENT_CATEGORY, ASSIGN_DOCUMENTS_TO_CATEGORY) prechádza
// DVOJKROKOVÝM tokom:
//   1) buildActionPreview() — VŽDY iba READ (okrem toho, že si "všimne", čo
//      by sa malo stať). Nikdy nezapisuje do DB. Vracia buď `action_preview`
//      (čaká sa na potvrdenie v UI), alebo priamy `not_found`/`error`/
//      `action_result`, ak sa dá už teraz s istotou povedať, že akcia
//      nemá zmysel (napr. 0 dokumentov na export, zložka už existuje).
//
//      Pre CREATE_DOCUMENT_CATEGORY/RENAME_DOCUMENT_CATEGORY/
//      ASSIGN_DOCUMENTS_TO_CATEGORY appka NAVYŠE:
//        - vygeneruje kryptograficky náhodný `nonce`,
//        - zostaví kanonický payload (userId/companyId/intent/canonicalArgs/
//          expectedCount/nonce/expiresAt) a vypočíta `serverProof` =
//          HMAC-SHA256(ESBLU_ACTION_CONFIRMATION_SECRET, payload) — VÝHRADNE
//          server-only, appka to robí PRED volaním RPC,
//        - zavolá RPC `esblu_create_action_confirmation` (SECURITY DEFINER),
//          ktorej odovzdá aj `nonce`/`serverProof`/`expiresAt` — RPC ich iba
//          uloží (validuje tvar/allowlist/rozumné hranice), samotný SECRET
//          nikdy nevidí a teda ani nevie posúdiť kryptografickú platnosť,
//        - klientovi vráti VÝHRADNE opaque `confirmationId` — NIKDY
//          `serverProof`/kanonické args/secret (pozri IntentResult#action_preview
//          v lib/intents/types.ts — tieto polia tam ani neexistujú).
//
//      DÔLEŽITÉ (3. bezpečnostné review): `esblu_create_action_confirmation`
//      JE a MUSÍ zostať `GRANT EXECUTE TO authenticated` (Next.js server ju
//      volá pod identitou prihláseného používateľa) — teda AJ authenticated
//      používateľ z browser konzoly ju vie zavolať priamo, s vlastným
//      intentom/args/count/nonce/"proof". DB samotná to nevie odmietnuť (nie
//      je jej úlohou rozlišovať "browser" od "Next.js server" — z pohľadu
//      Postgresu je to rovnaká authenticated rola s rovnakým JWT). Takýto
//      priamo-vytvorený riadok teda V DB PRETRVÁVA, ale nemá PLATNÝ
//      `server_proof` (útočník nepozná `ESBLU_ACTION_CONFIRMATION_SECRET`,
//      ktorý existuje VÝHRADNE ako env premenná Next.js servera) — execute
//      krok (nižšie) ho preto odmietne vykonať.
//
//   2) executeAction() — volá sa VÝHRADNE z app/api/assistant/action/execute
//      PO explicitnom potvrdení v UI, a dostáva IBA `confirmationId` (žiadny
//      intent/args z tela requestu). Server:
//        a) atomicky "claim-ne" presne ten jeden confirmation riadok cez RPC
//           `esblu_claim_action_confirmation` (SECURITY DEFINER; interne
//           `UPDATE ... WHERE id=$1 AND user_id=auth.uid() AND
//           company_id=<aktívna firma> AND consumed_at IS NULL AND
//           expires_at > now() RETURNING ...`) — toto JEDNÝM krokom overí
//           vlastníctvo/firmu/expiráciu/nepoužitosť AJ zabráni replay útoku,
//        b) z NÁVRATOVEJ HODNOTY RPC (nie z tela requestu!) prečíta
//           intent/canonical_args/expected_count/nonce/server_proof/
//           expires_at/user_id/company_id,
//        c) REKONŠTRUUJE presne ten istý kanonický payload a overí
//           `server_proof` cez `verifyActionConfirmation()` (timing-safe
//           HMAC porovnanie) — TOTO je jediný krok, ktorý odlišuje
//           "vzniklo zo skutočného preview flow" od "priame RPC volanie
//           útočníka". Ak proof nesedí → žiadny business write, generic
//           fail-closed odpoveď (confirmation je v tomto bode AJ TAK už
//           spotrebovaná krokom (a), takže replay nehrozí ani pri zlyhaní
//           proof verifikácie),
//        d) až PO úspešnej proof verifikácii revaliduje permissions
//           (ownerOrAdminOnly pre RENAME) a pri bulk akcii (ASSIGN)
//           revaliduje AKTUÁLNY počet dotknutých dokumentov proti uloženému
//           expected_count — ak sa líši, appka NIČ nezapíše a vyžiada nový
//           preview (fail-safe),
//        e) až POTOM vykoná samotný DB zápis (cez bežného user-scoped
//           klienta, RLS na cieľových tabuľkách — documents/
//           custom_document_categories — sa aplikuje normálne).
//
// assistant_action_confirmations SAMOTNÁ tabuľka nemá pre authenticated/anon
// žiadnu RLS policy (SELECT/INSERT/UPDATE/DELETE) ani table-level grant —
// jediný povolený prístup sú tieto dve úzke SECURITY DEFINER RPC funkcie
// (pozri migráciu, sekcia "ZÁMERNE ŽIADNA RLS POLICY"). Appka preto v tomto
// súbore NIKDY nevolá `.from("assistant_action_confirmations")` priamo. Toto
// RLS/REVOKE rieši iba "surový" INSERT/UPDATE/SELECT — samotnú ochranu proti
// "priame RPC volanie vytvorí kryptograficky PLATNÝ confirmation" rieši
// VÝHRADNE HMAC proof popísaný vyššie.
//
// EXPORT_DOCUMENTS je zámerná výnimka: nezapisuje nič do DB (iba
// stiahne/zdieľa súbor cez existujúci klientsky ExcelJS flow), takže
// NEPOUŽÍVA assistant_action_confirmations ani HMAC proof vôbec —
// buildActionPreview mu rovno pripojí `exportPayload` (a `affectedCount`, no
// NIE `confirmationId`) a executeAction sa preň VÔBEC nevolá — klient po
// potvrdení spustí export priamo (pozri komentár pri IntentResult#exportPayload
// v lib/intents/types.ts).
//
// FAIL CLOSED PRE CHÝBAJÚCI SECRET (bod 11 zadania): ak
// `ESBLU_ACTION_CONFIRMATION_SECRET` chýba/má nedostatočnú entropiu,
// `signActionConfirmation()`/`verifyActionConfirmation()` vrátia `null`/`false`
// — `insertActionConfirmation()` aj `executeAction()` to explicitne
// kontrolujú a write akcie (CREATE/RENAME/ASSIGN) v tom prípade NEFUNGUJÚ
// (generic chyba, nikdy tichý fallback na "nepodpísaný" tok). READ intenty a
// EXPORT_DOCUMENTS týmto nie sú vôbec ovplyvnené.
//
// `role`/`companyId`/`userId` MUSÍ volajúci (route.ts) odvodiť VÝHRADNE zo
// session JWT (verifyRequestUser + company_members), nikdy z tela requestu.
// =============================================================================

export type ActionContext = {
  companyId: string;
  userId: string;
  role: CompanyMemberRole;
};

function actionResult(success: boolean, text: string): IntentResult {
  return { kind: "action_result", success, text };
}

function notFoundResult(locale: Locale, key: string, vars?: Record<string, string | number>): IntentResult {
  return { kind: "not_found", text: translate(locale, key, vars) };
}

function ownerOrAdminOnly(locale: Locale, ctx: ActionContext): IntentResult | null {
  // Rovnaký princíp ako RLS UPDATE/DELETE na custom_document_categories
  // (owner/admin) — Intent Engine tu NIKDY nedáva employee-ovi VIAC práv,
  // než má dnes v appke (bod 12/21 zadania: "Employee nesmie dostať nové
  // právo cez Intent Engine"), iba explicitne a zrozumiteľne odmietne
  // skôr, než appka čokoľvek skúsi zapísať (namiesto surovej DB chyby).
  if (ctx.role === "owner" || ctx.role === "admin") return null;
  return actionResult(false, translate(locale, "search.actions.errors.ownerOrAdminOnly"));
}

// -----------------------------------------------------------------------------
// assistant_action_confirmations — server-side "pending write action" state.
// -----------------------------------------------------------------------------

// Presne tie WRITE intenty, ktoré cez confirmation RPC idú (EXPORT_DOCUMENTS
// zámerne mimo — pozri komentár na začiatku súboru). Zrkadlí CHECK constraint
// AJ vlastný allowlist check vnútri esblu_create_action_confirmation() v
// migrácii 20260915120000 — appka aj DB (dvakrát nezávisle) odmietajú
// čokoľvek mimo tohto zoznamu.
const CONFIRMATION_BOUND_INTENTS = [
  "CREATE_DOCUMENT_CATEGORY",
  "RENAME_DOCUMENT_CATEGORY",
  "ASSIGN_DOCUMENTS_TO_CATEGORY",
] as const;

type ConfirmationBoundIntentName = (typeof CONFIRMATION_BOUND_INTENTS)[number];

function isConfirmationBoundIntentName(value: string): value is ConfirmationBoundIntentName {
  return (CONFIRMATION_BOUND_INTENTS as readonly string[]).includes(value);
}

type ClaimedActionConfirmation = {
  intent: string;
  canonical_args: Record<string, unknown>;
  expected_count: number | null;
  nonce: string;
  server_proof: string;
  expires_at_epoch: number;
  user_id: string;
  company_id: string;
};

// 5 minút — appka (Node) toto POČÍTA a PODPISUJE, RPC dostane hotovú
// hodnotu ako `p_expires_at_epoch` (pozri komentár v migrácii, prečo RPC
// nesmie počítať expiráciu nezávisle od toho, čo appka podpísala).
const CONFIRMATION_TTL_SECONDS = 5 * 60;

/**
 * Vytvorí nový server-side "pending action" záznam — VOLÁ sa VÝHRADNE z
 * build*Preview() funkcií nižšie, PO tom, čo appka overila, že akcia dáva
 * zmysel (žiadne duplicity, cieľová zložka existuje a pod.). `canonicalArgs`
 * sú VŽDY presne tie appkou už validované/normalizované hodnoty, z ktorých
 * appka vypočítala zobrazený `summary` — nikdy surové dáta od klienta.
 *
 * HARDENED (3. bezpečnostné review): appka PRED volaním RPC vygeneruje
 * `nonce` a vypočíta `serverProof` = HMAC-SHA256(ESBLU_ACTION_CONFIRMATION_SECRET,
 * kanonický payload) — VÝHRADNE server-only, RPC (hoci `GRANT EXECUTE TO
 * authenticated`, teda technicky volateľná aj priamo z browsera) tento
 * secret nikdy nevidí, takže priame RPC volanie útočníka nevie vyprodukovať
 * KRYPTOGRAFICKY PLATNÝ proof — iba execute krok (`executeAction`) túto
 * platnosť napokon overuje. Ak secret chýba/je neplatný, appka write akciu
 * vôbec nezačne (fail closed, bod 11 zadania).
 */
async function insertActionConfirmation(
  supabase: SupabaseClient,
  ctx: ActionContext,
  intent: ConfirmationBoundIntentName,
  canonicalArgs: Record<string, unknown>,
  expectedCount: number | null
): Promise<string | null> {
  const nonce = generateActionConfirmationNonce();
  const expiresAtEpochSeconds = Math.floor(Date.now() / 1000) + CONFIRMATION_TTL_SECONDS;

  const payload: ActionConfirmationPayload = {
    userId: ctx.userId,
    companyId: ctx.companyId,
    intent,
    canonicalArgs,
    expectedCount,
    nonce,
    expiresAtEpochSeconds,
  };

  const serverProof = signActionConfirmation(payload);
  if (!serverProof) {
    console.error("insertActionConfirmation: ESBLU_ACTION_CONFIRMATION_SECRET chýba/je neplatný — write akcia odmietnutá (fail closed).");
    return null;
  }

  const { data, error } = await supabase.rpc("esblu_create_action_confirmation", {
    p_intent: intent,
    p_canonical_args: canonicalArgs,
    p_expected_count: expectedCount,
    p_nonce: nonce,
    p_server_proof: serverProof,
    p_expires_at_epoch: expiresAtEpochSeconds,
  });

  if (error || !data) {
    console.error("esblu_create_action_confirmation zlyhalo:", error?.message);
    return null;
  }

  return data as string;
}

/**
 * Atomicky "claim-ne" presne jeden pending confirmation riadok a OVERÍ jeho
 * HMAC `server_proof` — TOTO JE jediné miesto, ktoré rozhoduje o
 * replay/tamper/priame-RPC-volanie ochrane (bod 1/2/6/7/9 zadania).
 *
 * Krok 1 (claim): volá RPC `esblu_claim_action_confirmation` (SECURITY
 * DEFINER), ktorá interne robí JEDNU atomickú `UPDATE ... WHERE id=$1 AND
 * user_id=auth.uid() AND company_id=<aktívna firma> AND consumed_at IS NULL
 * AND expires_at > now() RETURNING ...` — ak dva requesty s tým istým
 * confirmationId prídu súbežne (replay), iba JEDEN z nich nájde riadok s
 * `consumed_at IS NULL` a "vyhrá" (claim-ne ho); druhý ho už nenájde (0
 * riadkov). HARDENED (2. review): appka sem NIKDY nerobí priamy
 * `.from("assistant_action_confirmations").update(...)`.
 *
 * Krok 2 (proof verifikácia): appka rekonštruuje presne ten istý kanonický
 * payload z NÁVRATOVEJ HODNOTY RPC (user_id/company_id/intent/
 * canonical_args/expected_count/nonce/expires_at_epoch) a cez
 * `verifyActionConfirmation()` timing-safe porovná s uloženým `server_proof`.
 * HARDENED (3. review): TOTO je krok, ktorý odlišuje "vzniklo zo
 * skutočného buildActionPreview() flow" od "authenticated používateľ
 * zavolal esblu_create_action_confirmation priamo z browser konzoly s
 * vlastným/náhodným proof" — bez znalosti ESBLU_ACTION_CONFIRMATION_SECRET
 * útočník nevie vyrobiť proof, ktorý by tu prešiel. Confirmation je v tomto
 * bode AJ TAK už spotrebovaná (claim krokom 1), takže aj keď proof zlyhá,
 * replay rovnakého confirmationId nie je možný.
 *
 * Ak claim zlyhá ALEBO proof nesedí, appka vždy vráti `null` — nikdy
 * nerozlišuje dôvod smerom ku klientovi (fail closed, žiadny detail, ktorý
 * by mohol pomôcť útočníkovi).
 */
async function claimActionConfirmation(
  supabase: SupabaseClient,
  confirmationId: string
): Promise<ClaimedActionConfirmation | null> {
  const { data, error } = await supabase
    .rpc("esblu_claim_action_confirmation", { p_confirmation_id: confirmationId })
    .maybeSingle();

  if (error) {
    console.error("esblu_claim_action_confirmation zlyhalo:", error.message);
    return null;
  }

  const claimed = (data as ClaimedActionConfirmation | null) ?? null;
  if (!claimed) return null;

  const payload: ActionConfirmationPayload = {
    userId: claimed.user_id,
    companyId: claimed.company_id,
    intent: claimed.intent,
    canonicalArgs: claimed.canonical_args,
    expectedCount: claimed.expected_count,
    nonce: claimed.nonce,
    expiresAtEpochSeconds: claimed.expires_at_epoch,
  };

  if (!verifyActionConfirmation(payload, claimed.server_proof)) {
    console.error("claimActionConfirmation: HMAC server_proof nesedí — confirmation nevznikla zo skutočného preview flow (fail closed, žiadny business write).");
    return null;
  }

  return claimed;
}

function readStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function readDocumentTypesArg(args: Record<string, unknown>): DocumentTypeFilter[] | undefined {
  const value = args.documentTypes;
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter(isDocumentTypeFilter);
  return filtered.length > 0 ? filtered : undefined;
}

// -----------------------------------------------------------------------------
// EXPORT_DOCUMENTS
// -----------------------------------------------------------------------------

// Iba typy, pre ktoré appka DNES má reálny, existujúci export flow (bod 4/19
// zadania: "Nevytváraj nový server export... reuseuj existujúci XLSX export").
// "insurance"/"service_document"/"vehicle_registration"/"other" v
// public.documents nemajú vlastné XLSX hlavičky ani export funkciu — export
// takých typov appka zámerne fail-closed odmieta, namiesto tichého
// vynechania dát bez upozornenia.
const EXPORTABLE_DOCUMENT_TYPES: ReadonlySet<DocumentTypeFilter> = new Set([
  "receipt",
  "invoice",
  "weigh_ticket",
  "delivery_note",
]);

type ExportInboxRecord = {
  id: string;
  created_at: string | null;
  note: string | null;
  extracted_fields: Record<string, unknown> | null;
};

type ExportEvidenceRecord = {
  id: string;
  spz: string | null;
  document_type: string | null;
  movement_type: string | null;
  supplier: string | null;
  customer: string | null;
  document_number: string | null;
  material: string | null;
  material_original: string | null;
  material_category: string | null;
  document_date: string | null;
  brutto: number | null;
  tara: number | null;
  netto: number | null;
  unit: string | null;
  construction_site: string | null;
  source_location: string | null;
  destination_location: string | null;
  photo_url: string | null;
  raw_text: string | null;
  created_at: string | null;
  quantity: number | null;
};

export type ExportDocumentsFilters = {
  query?: string;
  documentTypes?: DocumentTypeFilter[];
  dateFrom?: string;
  dateTo?: string;
  amount?: number;
};

export async function buildExportDocumentsPreview(
  supabase: SupabaseClient,
  locale: Locale,
  filters: ExportDocumentsFilters
): Promise<IntentResult> {
  const { query, documentTypes, dateFrom, dateTo, amount } = filters;
  const requestedTypes = documentTypes && documentTypes.length > 0 ? documentTypes : undefined;

  if (!query && !requestedTypes && !dateFrom && !dateTo && amount === undefined) {
    return notFoundResult(locale, "search.errors.missingQuery");
  }

  // Ak text VÝSLOVNE pomenoval typ, ktorý appka nevie exportovať (napr.
  // "Exportuj PZP." — PZP/technické preukazy nemajú export headers), appka
  // to fail-closed povie namiesto tichého vynechania (bod 19 zadania —
  // rovnaký princíp ako pri nepodporovanom formáte).
  const unsupportedRequestedTypes = (requestedTypes ?? []).filter(
    (t) => !EXPORTABLE_DOCUMENT_TYPES.has(t)
  );
  if (requestedTypes && requestedTypes.every((t) => !EXPORTABLE_DOCUMENT_TYPES.has(t))) {
    return actionResult(
      false,
      translate(locale, "search.actions.export.unsupportedType", {
        types: unsupportedRequestedTypes
          .map((t) => translate(locale, `inbox.documentTypes.${t}`))
          .join(", "),
      })
    );
  }

  // Iba exportovateľné typy (ak text žiadny typ nepomenoval, skúsime
  // VŠETKY exportovateľné typy — nikdy nepodporované typy bez filtra).
  const effectiveTypes = requestedTypes
    ? requestedTypes.filter((t) => EXPORTABLE_DOCUMENT_TYPES.has(t))
    : [...EXPORTABLE_DOCUMENT_TYPES];

  const documentsTypes = effectiveTypes.filter((t) => t === "receipt" || t === "invoice");
  const evidenceTypeLabels = effectiveTypes
    .map((t) => AI_EVIDENCE_DOCUMENT_TYPE_LABEL[t])
    .filter((label): label is string => Boolean(label));

  const shouldQueryDocuments = amount === undefined || documentsTypes.length > 0;
  const shouldQueryEvidence = amount === undefined && evidenceTypeLabels.length > 0;

  let documentsQuery = supabase
    .from("documents")
    .select("id, document_type, original_filename, note, extracted_fields, created_at")
    .is("deleted_at", null)
    .in("document_type", documentsTypes.length > 0 ? documentsTypes : ["__none__"]);
  if (query) {
    documentsQuery = documentsQuery.or(
      `original_filename.ilike.%${query}%,note.ilike.%${query}%,extracted_fields->>supplier.ilike.%${query}%,extracted_fields->>customer.ilike.%${query}%,extracted_fields->>merchant.ilike.%${query}%`
    );
  }
  documentsQuery = documentsQuery.order("created_at", { ascending: false }).limit(500);

  let evidenceQuery = supabase
    .from("ai_evidence")
    .select(
      "id, spz, document_type, movement_type, supplier, customer, document_number, material, material_original, material_category, document_date, brutto, tara, netto, unit, construction_site, source_location, destination_location, photo_url, raw_text, created_at, quantity"
    )
    .in("document_type", evidenceTypeLabels.length > 0 ? evidenceTypeLabels : ["__none__"]);
  if (query) {
    evidenceQuery = evidenceQuery.or(
      `document_number.ilike.%${query}%,supplier.ilike.%${query}%,customer.ilike.%${query}%,material.ilike.%${query}%,spz.ilike.%${query}%`
    );
  }
  if (dateFrom) evidenceQuery = evidenceQuery.gte("document_date", dateFrom);
  if (dateTo) evidenceQuery = evidenceQuery.lte("document_date", dateTo);
  evidenceQuery = evidenceQuery.order("created_at", { ascending: false }).limit(500);

  const [documentsResult, evidenceResult] = await Promise.all([
    shouldQueryDocuments ? documentsQuery : Promise.resolve({ data: [], error: null }),
    shouldQueryEvidence ? evidenceQuery : Promise.resolve({ data: [], error: null }),
  ]);

  if (documentsResult.error) {
    console.error("buildExportDocumentsPreview (documents) zlyhalo:", documentsResult.error.message);
  }
  if (evidenceResult.error) {
    console.error("buildExportDocumentsPreview (ai_evidence) zlyhalo:", evidenceResult.error.message);
  }

  const documentsRaw =
    (documentsResult.data as
      | {
          id: string;
          document_type: string;
          original_filename: string | null;
          note: string | null;
          extracted_fields: Record<string, unknown> | null;
          created_at: string;
        }[]
      | null) || [];
  const evidenceRaw = (evidenceResult.data as ExportEvidenceRecord[] | null) || [];

  const documentsFiltered = documentsRaw.filter((doc) => {
    if (!matchesDateRange(readExtractedDate(doc.extracted_fields), dateFrom, dateTo)) return false;
    if (amount !== undefined && !amountMatches(doc.extracted_fields, amount)) return false;
    return true;
  });

  const receiptRecords: ExportInboxRecord[] = documentsFiltered
    .filter((d) => d.document_type === "receipt")
    .map((d) => ({ id: d.id, created_at: d.created_at, note: d.note, extracted_fields: d.extracted_fields }));
  const invoiceRecords: ExportInboxRecord[] = documentsFiltered
    .filter((d) => d.document_type === "invoice")
    .map((d) => ({ id: d.id, created_at: d.created_at, note: d.note, extracted_fields: d.extracted_fields }));

  const totalCount = receiptRecords.length + invoiceRecords.length + evidenceRaw.length;

  if (totalCount === 0) {
    return notFoundResult(locale, "search.actions.export.noDocuments");
  }

  const inboxDocuments: {
    kind: "receipt" | "invoice";
    records: ExportInboxRecord[];
  }[] = [];
  if (receiptRecords.length > 0) inboxDocuments.push({ kind: "receipt", records: receiptRecords });
  if (invoiceRecords.length > 0) inboxDocuments.push({ kind: "invoice", records: invoiceRecords });

  const countParts: string[] = [];
  if (receiptRecords.length > 0) {
    countParts.push(translate(locale, "search.actions.export.countReceipts", { count: receiptRecords.length }));
  }
  if (invoiceRecords.length > 0) {
    countParts.push(translate(locale, "search.actions.export.countInvoices", { count: invoiceRecords.length }));
  }
  if (evidenceRaw.length > 0) {
    countParts.push(translate(locale, "search.actions.export.countEvidence", { count: evidenceRaw.length }));
  }

  let summary = translate(locale, "search.actions.export.summary", {
    total: totalCount,
    breakdown: countParts.join(", "),
  });

  // Čiastočná podpora — text pomenoval AJ typ, ktorý sa exportovať nedá
  // (napr. "Exportuj bločky a PZP." → bločky sa exportujú, PZP nie).
  // NIKDY sa to nesmie stať ticho — appka to vždy explicitne povie v
  // súhrne preview (fail-closed princíp "nikdy nevynechaj dáta potichu").
  if (unsupportedRequestedTypes.length > 0) {
    summary += ` ${translate(locale, "search.actions.export.partiallyUnsupported", {
      types: unsupportedRequestedTypes.map((t) => translate(locale, `inbox.documentTypes.${t}`)).join(", "),
    })}`;
  }

  return {
    kind: "action_preview",
    action: "EXPORT_DOCUMENTS",
    summary,
    confirmLabel: translate(locale, "search.actions.export.confirmLabel"),
    cancelLabel: translate(locale, "search.actions.cancelLabel"),
    // EXPORT_DOCUMENTS nemá confirmationId (nezapisuje nič do DB) — pozri
    // komentár na začiatku súboru a pri IntentResult#exportPayload.
    affectedCount: totalCount,
    exportPayload: {
      inboxDocuments,
      evidenceRecords: evidenceRaw,
    },
  };
}

// -----------------------------------------------------------------------------
// CREATE_DOCUMENT_CATEGORY
// -----------------------------------------------------------------------------

export async function buildCreateCategoryPreview(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  categoryName: string | undefined
): Promise<IntentResult> {
  const trimmed = categoryName?.trim();
  if (!trimmed) {
    return notFoundResult(locale, "search.actions.category.missingName");
  }

  // Bod 8 zadania — duplicitná kontrola PRED zobrazením preview (nie až pri
  // potvrdení): ak zložka s rovnakým canonical_slug už existuje, appka to
  // povie rovno, bez zbytočného "Vytvoriť?" potvrdenia, ktoré by aj tak
  // neviedlo k novému riadku.
  const existing = await listCompanyCustomCategories(supabase);
  const match = findMatchingCustomCategory(existing, trimmed);
  if (match) {
    return actionResult(false, translate(locale, "search.actions.category.alreadyExists", { name: match.name }));
  }

  // ctx (user_id/company_id) sa TU používa VÝHRADNE na výpočet HMAC proof
  // (signActionConfirmation) — RPC esblu_create_action_confirmation si
  // user_id/company_id aj tak odvodí sama, nanovo, zo session (parametrom sa
  // neposielajú, pozri komentár pri insertActionConfirmation()).
  const confirmationId = await insertActionConfirmation(
    supabase,
    ctx,
    "CREATE_DOCUMENT_CATEGORY",
    { categoryName: trimmed },
    null
  );
  if (!confirmationId) {
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  return {
    kind: "action_preview",
    action: "CREATE_DOCUMENT_CATEGORY",
    summary: translate(locale, "search.actions.category.createSummary", { name: trimmed }),
    confirmLabel: translate(locale, "search.actions.category.createConfirmLabel"),
    cancelLabel: translate(locale, "search.actions.cancelLabel"),
    confirmationId,
  };
}

async function executeCreateCategory(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  args: Record<string, unknown>
): Promise<IntentResult> {
  const trimmed = readStringArg(args, "categoryName")?.trim();
  if (!trimmed) {
    return actionResult(false, translate(locale, "search.actions.category.missingName"));
  }

  // Znovu prepočítané NANOVO (bod 22 zadania) — nikdy sa neverí, že medzi
  // preview a potvrdením sa nič nezmenilo.
  const existing = await listCompanyCustomCategories(supabase);
  const match = findMatchingCustomCategory(existing, trimmed);
  if (match) {
    return actionResult(false, translate(locale, "search.actions.category.alreadyExists", { name: match.name }));
  }

  const created = await createCustomCategory(supabase, ctx.companyId, ctx.userId, trimmed);
  if (!created.ok) {
    if (created.error === "ALREADY_EXISTS") {
      return actionResult(false, translate(locale, "search.actions.category.alreadyExists", { name: trimmed }));
    }
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  return actionResult(true, translate(locale, "search.actions.category.createSuccess", { name: created.category.name }));
}

// -----------------------------------------------------------------------------
// RENAME_DOCUMENT_CATEGORY
// -----------------------------------------------------------------------------

function findSourceAndCollision(
  categories: CustomDocumentCategory[],
  sourceName: string,
  newName: string
): { source: CustomDocumentCategory | null; collision: CustomDocumentCategory | null } {
  const source = findMatchingCustomCategory(categories, sourceName);
  const collisionCandidate = findMatchingCustomCategory(categories, newName);
  const collision = collisionCandidate && collisionCandidate.id !== source?.id ? collisionCandidate : null;
  return { source, collision };
}

export async function buildRenameCategoryPreview(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  categoryName: string | undefined,
  newCategoryName: string | undefined
): Promise<IntentResult> {
  const permissionError = ownerOrAdminOnly(locale, ctx);
  if (permissionError) return permissionError;

  const sourceName = categoryName?.trim();
  const newName = newCategoryName?.trim();
  if (!sourceName || !newName) {
    return notFoundResult(locale, "search.actions.category.missingRenameArgs");
  }

  const existing = await listCompanyCustomCategories(supabase);
  const { source, collision } = findSourceAndCollision(existing, sourceName, newName);

  if (!source) {
    return notFoundResult(locale, "search.actions.category.notFound", { name: sourceName });
  }
  if (collision) {
    return actionResult(false, translate(locale, "search.actions.category.alreadyExists", { name: collision.name }));
  }

  const confirmationId = await insertActionConfirmation(
    supabase,
    ctx,
    "RENAME_DOCUMENT_CATEGORY",
    { categoryName: source.name, newCategoryName: newName },
    null
  );
  if (!confirmationId) {
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  return {
    kind: "action_preview",
    action: "RENAME_DOCUMENT_CATEGORY",
    summary: translate(locale, "search.actions.category.renameSummary", { from: source.name, to: newName }),
    confirmLabel: translate(locale, "search.actions.category.renameConfirmLabel"),
    cancelLabel: translate(locale, "search.actions.cancelLabel"),
    confirmationId,
  };
}

async function executeRenameCategory(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  args: Record<string, unknown>
): Promise<IntentResult> {
  const permissionError = ownerOrAdminOnly(locale, ctx);
  if (permissionError) return permissionError;

  const sourceName = readStringArg(args, "categoryName")?.trim();
  const newName = readStringArg(args, "newCategoryName")?.trim();
  if (!sourceName || !newName) {
    return actionResult(false, translate(locale, "search.actions.category.missingRenameArgs"));
  }

  const existing = await listCompanyCustomCategories(supabase);
  const { source, collision } = findSourceAndCollision(existing, sourceName, newName);

  if (!source) {
    return actionResult(false, translate(locale, "search.actions.category.notFound", { name: sourceName }));
  }
  if (collision) {
    return actionResult(false, translate(locale, "search.actions.category.alreadyExists", { name: collision.name }));
  }

  const canonicalSlug = normalizeCanonicalCategorySlug(newName);
  if (!canonicalSlug) {
    return actionResult(false, translate(locale, "search.actions.category.missingRenameArgs"));
  }

  // RLS (UPDATE = owner/admin only) je posledná, nezávislá poistka — ak by
  // ownerOrAdminOnly() vyššie mala chybu, DB update jednoducho neovplyvní
  // žiadny riadok (fail closed, nie fail open).
  const { data, error } = await supabase
    .from("custom_document_categories")
    .update({ name: newName, canonical_slug: canonicalSlug })
    .eq("id", source.id)
    .select("id, name")
    .maybeSingle();

  if (error || !data) {
    console.error("executeRenameCategory zlyhalo:", error?.message);
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  return actionResult(true, translate(locale, "search.actions.category.renameSuccess", { from: source.name, to: newName }));
}

// -----------------------------------------------------------------------------
// ASSIGN_DOCUMENTS_TO_CATEGORY
// -----------------------------------------------------------------------------

export type AssignDocumentsFilters = {
  query?: string;
  documentTypes?: DocumentTypeFilter[];
  dateFrom?: string;
  dateTo?: string;
  targetCategoryName?: string;
};

async function fetchMatchingDocumentIdsForAssign(
  supabase: SupabaseClient,
  filters: AssignDocumentsFilters
): Promise<string[]> {
  const { query, documentTypes, dateFrom, dateTo } = filters;

  let documentsQuery = supabase
    .from("documents")
    .select("id, extracted_fields, created_at")
    .is("deleted_at", null);

  if (documentTypes && documentTypes.length > 0) {
    documentsQuery = documentsQuery.in("document_type", documentTypes);
  }
  if (query) {
    documentsQuery = documentsQuery.or(
      `original_filename.ilike.%${query}%,note.ilike.%${query}%,extracted_fields->>supplier.ilike.%${query}%,extracted_fields->>customer.ilike.%${query}%,extracted_fields->>merchant.ilike.%${query}%`
    );
  }
  documentsQuery = documentsQuery.limit(1000);

  const { data, error } = await documentsQuery;
  if (error) {
    console.error("fetchMatchingDocumentIdsForAssign zlyhalo:", error.message);
    return [];
  }

  const rows =
    (data as { id: string; extracted_fields: Record<string, unknown> | null; created_at: string }[] | null) || [];

  return rows
    .filter((doc) => matchesDateRange(readExtractedDate(doc.extracted_fields), dateFrom, dateTo))
    .map((doc) => doc.id);
}

export async function buildAssignDocumentsPreview(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  filters: AssignDocumentsFilters
): Promise<IntentResult> {
  const targetName = filters.targetCategoryName?.trim();
  if (!targetName) {
    return notFoundResult(locale, "search.actions.assign.missingTarget");
  }
  if (!filters.documentTypes?.length && !filters.dateFrom && !filters.dateTo && !filters.query) {
    return notFoundResult(locale, "search.errors.missingQuery");
  }

  const categories = await listCompanyCustomCategories(supabase);
  const targetCategory = findMatchingCustomCategory(categories, targetName);
  if (!targetCategory) {
    return actionResult(false, translate(locale, "search.actions.assign.targetNotFound", { name: targetName }));
  }

  const ids = await fetchMatchingDocumentIdsForAssign(supabase, filters);
  if (ids.length === 0) {
    return notFoundResult(locale, "search.actions.assign.noDocuments");
  }

  const confirmationId = await insertActionConfirmation(
    supabase,
    ctx,
    "ASSIGN_DOCUMENTS_TO_CATEGORY",
    {
      query: filters.query,
      documentTypes: filters.documentTypes,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      targetCategoryName: targetCategory.name,
    },
    // expected_count — appka ho pri execute NANOVO prepočíta a porovná
    // (bod 9/§ASSIGN zadania: "preview count=12, pred confirm sa matching
    // dáta zmenia na 13 → fail-safe, nie automaticky priradiť 13").
    ids.length
  );
  if (!confirmationId) {
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  return {
    kind: "action_preview",
    action: "ASSIGN_DOCUMENTS_TO_CATEGORY",
    summary: translate(locale, "search.actions.assign.summary", {
      count: ids.length,
      category: targetCategory.name,
    }),
    confirmLabel: translate(locale, "search.actions.assign.confirmLabel"),
    cancelLabel: translate(locale, "search.actions.cancelLabel"),
    confirmationId,
    affectedCount: ids.length,
  };
}

async function executeAssignDocuments(
  supabase: SupabaseClient,
  locale: Locale,
  args: Record<string, unknown>,
  expectedCount: number | null
): Promise<IntentResult> {
  const filters: AssignDocumentsFilters = {
    query: readStringArg(args, "query"),
    documentTypes: readDocumentTypesArg(args),
    dateFrom: readStringArg(args, "dateFrom"),
    dateTo: readStringArg(args, "dateTo"),
    targetCategoryName: readStringArg(args, "targetCategoryName"),
  };

  const targetName = filters.targetCategoryName?.trim();
  if (!targetName) {
    return actionResult(false, translate(locale, "search.actions.assign.missingTarget"));
  }

  // Bod 11/22 zadania — VŠETKO prepočítané NANOVO priamo pred zápisom
  // (nikdy z toho, čo si appka "pamätá" z preview kroku).
  const categories = await listCompanyCustomCategories(supabase);
  const targetCategory = findMatchingCustomCategory(categories, targetName);
  if (!targetCategory) {
    return actionResult(false, translate(locale, "search.actions.assign.targetNotFound", { name: targetName }));
  }

  const ids = await fetchMatchingDocumentIdsForAssign(supabase, filters);

  // Bod 7/9 zadania — bulk expected-count revalidation: ak sa počet
  // dotknutých dokumentov od preview zmenil (pribudol/ubudol dokument
  // vyhovujúci filtru), appka NEVYKONÁ ŽIADNU zmenu a požiada o nový
  // preview — nikdy "ticho" nepriradí iný počet, než aký používateľ videl
  // a potvrdil. Confirmation je už v tomto bode spotrebovaná (claimnutá
  // pred týmto volaním) — ten istý confirmationId sa teda už nedá skúsiť
  // znova, presne ako pri akomkoľvek inom replay pokuse.
  if (expectedCount !== null && ids.length !== expectedCount) {
    return actionResult(false, translate(locale, "search.actions.confirmation.dataChanged"));
  }

  if (ids.length === 0) {
    return actionResult(false, translate(locale, "search.actions.assign.noDocuments"));
  }

  // RLS je jediná autorizácia aj tu — ak by časť riadkov appka nesmela
  // upraviť, `.select("id")` po update vráti IBA skutočne zapísané riadky
  // (fail closed: appka nikdy nepredpokladá úspech pri všetkých ID, iba pri
  // tých, ktoré DB reálne potvrdila).
  const { data, error } = await supabase
    .from("documents")
    .update({ custom_category_id: targetCategory.id })
    .in("id", ids)
    .select("id");

  if (error) {
    console.error("executeAssignDocuments zlyhalo:", error.message);
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  const updatedCount = (data as { id: string }[] | null)?.length ?? 0;

  // PRODUKČNÝ BUG FIX (bod 6 zadania) — pôvodne appka hlásila úspech už pri
  // `updatedCount > 0`, aj keby `updatedCount` bol MENŠÍ než `ids.length`
  // (napr. RLS/DB ticho odmietla časť riadkov, alebo dokument medzičasom
  // zmizol). Čiastočný update je rovnako "neočakávaný stav" ako 0 riadkov —
  // appka teraz vyžaduje PRESNÚ zhodu, inak fail closed, žiadny falošný
  // "úspech" so zavádzajúco nižším počtom, než aký si používateľ potvrdil.
  if (updatedCount !== ids.length) {
    console.error(
      `executeAssignDocuments: updatedCount (${updatedCount}) sa nezhoduje s počtom dokumentov na priradenie (${ids.length}) — fail closed, žiadny "úspech".`
    );
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  return actionResult(
    true,
    translate(locale, "search.actions.assign.success", {
      count: updatedCount,
      category: targetCategory.name,
    })
  );
}

// -----------------------------------------------------------------------------
// Centrálne dispatchery — volá sa VÝHRADNE z app/api/assistant/intent/route.ts
// (buildActionPreview) a app/api/assistant/action/execute/route.ts
// (executeAction), po overení isRegisteredWriteIntent() (registry.ts).
// -----------------------------------------------------------------------------

export async function buildActionPreview(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  intent: ParsedIntent
): Promise<IntentResult> {
  // Bod 11 zadania — fail closed HNEĎ, skôr než appka čokoľvek prečíta z DB:
  // ak ESBLU_ACTION_CONFIRMATION_SECRET chýba/je neplatný, WRITE akcie sú
  // úplne nefunkčné (READ funkcie tým nie sú dotknuté — tento branch sa
  // netýka EXPORT_DOCUMENTS, ktorý do HMAC confirmation flow vôbec nejde).
  // insertActionConfirmation() by rovnaký prípad aj tak odmietla (žiadny
  // fallback secret), toto je iba včasnejší, lacnejší návrat bez zbytočných
  // duplicity-check DB dotazov.
  if (intent.name !== "EXPORT_DOCUMENTS" && !isActionConfirmationSecretConfigured()) {
    console.error("buildActionPreview: ESBLU_ACTION_CONFIRMATION_SECRET chýba/je neplatný — write akcie odmietnuté (fail closed).");
    return actionResult(false, translate(locale, "search.errors.generic"));
  }

  switch (intent.name) {
    case "EXPORT_DOCUMENTS":
      return buildExportDocumentsPreview(supabase, locale, intent.args);
    case "CREATE_DOCUMENT_CATEGORY":
      return buildCreateCategoryPreview(supabase, locale, ctx, intent.args.categoryName);
    case "RENAME_DOCUMENT_CATEGORY":
      return buildRenameCategoryPreview(
        supabase,
        locale,
        ctx,
        intent.args.categoryName,
        intent.args.newCategoryName
      );
    case "ASSIGN_DOCUMENTS_TO_CATEGORY":
      return buildAssignDocumentsPreview(supabase, locale, ctx, {
        query: intent.args.query,
        documentTypes: intent.args.documentTypes,
        dateFrom: intent.args.dateFrom,
        dateTo: intent.args.dateTo,
        targetCategoryName: intent.args.targetCategoryName,
      });
    default:
      return { kind: "error", text: translate(locale, "search.errors.generic") };
  }
}

/**
 * Skutočné vykonanie WRITE akcie — volá sa VÝHRADNE z
 * app/api/assistant/action/execute/route.ts, po tom, čo route.ts overí, že
 * telo requestu obsahuje platný `confirmationId` (string). EXPORT_DOCUMENTS
 * sem NIKDY nepríde (nezapisuje nič do DB — klient ho spustí priamo z
 * `exportPayload` vráteného v action_preview, pozri komentár v
 * lib/intents/types.ts).
 *
 * KĽÚČOVÉ: táto funkcia už NEPRIJÍMA intent/args z volajúceho — VŽDY ich
 * načíta VÝHRADNE z DB (claimActionConfirmation), takže priame volanie
 * tohto endpointu s vymysleným intent+args (bez toho, aby predtým existoval
 * zodpovedajúci buildActionPreview() krok) je štrukturálne nemožné — žiadny
 * confirmationId neexistuje, claim vždy zlyhá, žiadny zápis sa nevykoná
 * (bod 9 zadania — "DIRECT CALL").
 */
export async function executeAction(
  supabase: SupabaseClient,
  locale: Locale,
  ctx: ActionContext,
  confirmationId: string
): Promise<IntentResult> {
  const claimed = await claimActionConfirmation(supabase, confirmationId);
  if (!claimed || !isConfirmationBoundIntentName(claimed.intent)) {
    return actionResult(false, translate(locale, "search.actions.confirmation.invalidOrExpired"));
  }

  switch (claimed.intent) {
    case "CREATE_DOCUMENT_CATEGORY":
      return executeCreateCategory(supabase, locale, ctx, claimed.canonical_args);
    case "RENAME_DOCUMENT_CATEGORY":
      return executeRenameCategory(supabase, locale, ctx, claimed.canonical_args);
    case "ASSIGN_DOCUMENTS_TO_CATEGORY":
      return executeAssignDocuments(supabase, locale, claimed.canonical_args, claimed.expected_count);
    default:
      // isConfirmationBoundIntentName() vyššie už zaručuje, že sem appka
      // nikdy nedôjde — čisto exhaustiveness fallback (fail closed).
      return actionResult(false, translate(locale, "search.errors.generic"));
  }
}
