import type { SupabaseClient } from "@supabase/supabase-js";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import {
  hasExplicitCreateWording,
  isIntentCompatibleWithUtterance,
  isServiceUtterance,
  maintenanceDescription,
  parseIntentDeterministic,
  violatesMachineCreateInvariant,
  type ParseHints,
} from "@/lib/intents/parse";
import {
  isRegisteredReadOnlyIntent,
  isRegisteredWriteIntent,
  isRegisteredReviewableDraftIntent,
} from "@/lib/intents/registry";
import { executeIntent } from "@/lib/intents/handlers";
import {
  buildActionPreview,
  createFolderActionConfirmation,
  createOperationalActionConfirmation,
  createInboxActionConfirmation,
} from "@/lib/intents/actions";
import { checkIntentAccess, denialMessageKey, restrictedAssistantDenial } from "@/lib/intents/permissions";
import { handleInboxIntent } from "@/lib/intents/inbox-intents";
import {
  classifyClarificationReply,
  resumePendingIntent,
  sealPendingClarification,
  unsealPendingClarification,
} from "@/lib/intents/pending-clarification";
import { classifyConfirmationReply } from "@/lib/intents/confirmation-reply";
import { handleOperationalIntent, isOperationalFamilyIntent } from "@/lib/intents/operational-intents";
import { folderIntentPermission, handleFolderIntent, isFolderFamilyIntent } from "@/lib/intents/folder-intents";
import type { FolderRef } from "@/lib/document-folders";
import { clearConversationContext, loadConversationContext } from "@/lib/intents/conversation";
import { resolveUiEntity, moduleMatchesEntity, type UiContext, type UiContextEntityType } from "@/lib/intents/ui-context";
import { handleProcessCurrentDocumentAsReceivedInvoice } from "@/lib/intents/handlers-context";
import { startInvoiceDraftFlow, continueInvoiceDraftFlow } from "@/lib/intents/invoice-draft-flow";
import { readSlots, type InvoiceDraftField } from "@/lib/intents/invoice-slots";
import { decideInvoiceTurn, invoiceTaskFrom, isTaskCancel } from "@/lib/intents/conversation-state";
import { handlePartnerCreate } from "@/lib/intents/partner-intents";
import type { IntentName, IntentResult, ParsedIntent } from "@/lib/intents/types";
import type { CompanyMemberRole } from "@/lib/company";

// =============================================================================
// Asistent — JEDEN serverový orchestrátor pre každú vetu.
//
// Route (app/api/assistant/intent) iba overí prihlásenie, členstvo a
// oprávnenia z RPC a zavolá `runAssistantTurn`. UI iba zachytí hlas/text,
// pošle prepis + kontext + token a vykreslí výsledok. O VÝZNAME vety
// rozhoduje výhradne toto poradie:
//
//   1. aktívna úloha (faktúra v DB kontexte / zapečatená otázka)
//        → zrušenie / NOVÝ príkaz / ODPOVEĎ (lib/intents/conversation-state.ts)
//   2. až keď žiadna úloha vetu neprijala: deterministický parser
//   3. zamestnanec: odmietnutie pred AI aj pred akýmkoľvek dotazom
//   4. AI klasifikátor (iba interpretácia) → sanitizeAiIntent:
//        nikdy mazanie, nikdy založenie bez výslovných slov
//   5. poistky: servis nikdy nezaloží stroj; intent musí sedieť s vetou
//   6. brána oprávnení PRED akýmkoľvek dotazom na dáta
//   7. handler → náhľad s jednorazovým potvrdením / draft na kontrolu / čítanie
//   8. otázka handlera → zapečatený stav pre ďalšiu vetu
// =============================================================================

export type AssistantTurnInput = {
  rawText: string;
  locale: Locale;
  userId: string;
  companyId: string;
  role: string;
  financeView: boolean;
  financeManage: boolean;
  canOperate: boolean;
  conversationId: string | null;
  pendingClarification: unknown;
  structuredPartnerId: string | null;
  issueDate: string | null;
  uiContext: UiContext | null;
  moduleContext?: ParseHints["module"];
  selection: { items: FolderRef[]; folderId: string | null } | null;
  folderContextId: string | null;
};

export type AssistantTurnDeps = {
  db: SupabaseClient;
  /** AI klasifikátor — v teste náhrada. Vracia iba interpretáciu. */
  classifyWithAi: (rawText: string) => Promise<ParsedIntent | null>;
  /** Iba pre testy (expirácia zapečatenej otázky). */
  now?: number;
};

export type AssistantTurnOutput = {
  success: true;
  recognized: boolean;
  intent?: string;
  source?: string;
  result: IntentResult;
  /** `null` = zahodiť starú otázku; `undefined` = pole v odpovedi chýba (tiež zahodí). */
  pendingClarification?: string | null;
};

/**
 * Ktoré intenty sa dajú doplniť z otvorenej entity, a akého typu tá entita
 * musí byť. Doplní sa VÝHRADNE chýbajúci hľadaný výraz — vyslovené meno má
 * vždy prednosť pred tým, čo je práve otvorené.
 */
const CONTEXTUAL_QUERY_INTENTS: Record<string, UiContextEntityType> = {
  SHOW_VEHICLE_DOCUMENTS: "vehicle",
  SHOW_VEHICLE_SERVICE: "vehicle",
  VEHICLE_STK_STATUS: "vehicle",
  VEHICLE_EK_STATUS: "vehicle",
  VEHICLE_VIGNETTE_STATUS: "vehicle",
  VEHICLE_COST_SUMMARY: "vehicle",
  VEHICLE_REPORT: "vehicle",
  OPEN_VEHICLE: "vehicle",
  SHOW_MACHINE_SERVICE: "machine",
  SHOW_MACHINE_DOCUMENTS: "machine",
  SHOW_MACHINE_PHOTOS: "machine",
  MACHINE_REPORT: "machine",
  OPEN_MACHINE: "machine",
  INVENTORY_ITEM_STATUS: "inventory_item",
  OPEN_INVENTORY_ITEM: "inventory_item",
  SEARCH_PARTNER: "partner",
  SEARCH_INVOICE: "invoice",
};

function withContextualQuery(intent: ParsedIntent, entity: Awaited<ReturnType<typeof resolveUiEntity>>): ParsedIntent {
  if (!entity || !entity.label) return intent;
  if (intent.args.query?.trim()) return intent;
  const expected = CONTEXTUAL_QUERY_INTENTS[intent.name];
  if (!expected || expected !== entity.entityType) return intent;
  return { ...intent, args: { ...intent.args, query: entity.label } };
}

// -----------------------------------------------------------------------------
// AI klasifikátor smie vetu VYLOŽIŤ — nesmie mazať ani zakladať sám.
// -----------------------------------------------------------------------------

const DESTRUCTIVE_INTENTS: ReadonlySet<string> = new Set([
  "FOLDER_DELETE",
  "FOLDER_REMOVE_ITEMS",
  "INVENTORY_ITEM_DELETE",
  "MACHINE_DELETE",
  "VEHICLE_DELETE",
  "INBOX_DELETE_UNASSIGNED",
  "DELETE_DOCUMENT_CATEGORY",
]);

const CREATE_INTENTS: ReadonlySet<string> = new Set([
  "MACHINE_CREATE",
  "VEHICLE_CREATE",
  "INVENTORY_ITEM_CREATE",
  "PARTNER_CREATE",
  "CREATE_INVOICE_DRAFT",
  "FOLDER_CREATE",
  "CREATE_DOCUMENT_CATEGORY",
  "ENTITY_CREATE",
]);

/**
 * Výsledok AI: mazanie nikdy (cieľ ani rozsah nesmie vybrať model),
 * založenie iba pri výslovných slovách založenia pre danú oblasť. Presný
 * cieľ (`entityId`) ani serverové príznaky sa z AI neprijímajú nikdy.
 */
export function sanitizeAiIntent(intent: ParsedIntent | null, rawText: string): ParsedIntent | null {
  if (!intent) return null;
  if (DESTRUCTIVE_INTENTS.has(intent.name)) return null;
  // Servisná veta, ktorú model označil za založenie stroja, sa nezahodí —
  // invariant nižšie z nej urobí zápis servisu (nikdy nový stroj).
  const serviceMisread = intent.name === "MACHINE_CREATE" && isServiceUtterance(rawText);
  if (CREATE_INTENTS.has(intent.name) && !serviceMisread && !hasExplicitCreateWording(intent.name, rawText)) return null;
  const args = { ...intent.args };
  delete args.entityId;
  delete args.confirmedNew;
  return { ...intent, args, source: "ai" };
}

function notUnderstood(locale: Locale): AssistantTurnOutput {
  return {
    success: true,
    recognized: false,
    result: { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") },
    pendingClarification: null,
  };
}

const INVOICE_FIELDS: readonly InvoiceDraftField[] = ["partner", "partnerChoice", "items", "itemPrice", "total", "vat"];

/** Route: iba odpoveď pre klienta. */
export async function runAssistantTurn(deps: AssistantTurnDeps, input: AssistantTurnInput): Promise<AssistantTurnOutput> {
  return (await runAssistantTurnDetailed(deps, input)).output;
}

/**
 * To isté + výsledný intent (na testy a diagnostiku). Intent sa klientovi
 * neposiela.
 */
export async function runAssistantTurnDetailed(
  deps: AssistantTurnDeps,
  input: AssistantTurnInput
): Promise<{ output: AssistantTurnOutput; finalIntent: ParsedIntent | null }> {
  let intent: ParsedIntent | null = null;
  const done = (output: AssistantTurnOutput) => ({ output, finalIntent: intent });

  const { db } = deps;
  const { locale, rawText, conversationId, financeManage } = input;
  const t = (key: string) => translate(locale, key);
  const binding = { userId: input.userId, companyId: input.companyId };
  const sealOptions = deps.now !== undefined ? { now: deps.now } : {};
  const flowCtx = conversationId
    ? { companyId: input.companyId, userId: input.userId, conversationId, issueDate: input.issueDate }
    : null;

  // ------------------------------------------------------------------
  // 1a. AKTÍVNA ÚLOHA: rozpracovaná faktúra (stav v DB podľa volajúceho).
  //
  // O význame vety rozhoduje položená otázka — nie globálny parser.
  // „Kopanie, odvoz materiálu, pracovníci." pri otázke o položkách je
  // odpoveď; „Ukáž sklad." je nový príkaz; „Zrušiť." úlohu ukončí.
  // ------------------------------------------------------------------
  if (flowCtx && financeManage) {
    const stored = await loadConversationContext(db, flowCtx.conversationId);
    const field = stored?.pendingIntent === "CREATE_INVOICE_DRAFT" ? stored.missingFields[0] : undefined;
    if (stored && field && (INVOICE_FIELDS as readonly string[]).includes(field)) {
      const task = invoiceTaskFrom(field as InvoiceDraftField, readSlots(stored.slots));
      const decision = input.structuredPartnerId ? "answer" : decideInvoiceTurn(rawText, task);
      if (decision !== "new_command") intent = { name: "CREATE_INVOICE_DRAFT", args: {}, source: "deterministic" };
      if (decision === "cancel") {
        await clearConversationContext(db, flowCtx.conversationId);
        return done({
          success: true,
          recognized: true,
          intent: "CREATE_INVOICE_DRAFT",
          source: "conversation",
          result: { kind: "answer", text: t("assistant.clarify.taskCancelled") },
          pendingClarification: null,
        });
      }
      if (decision === "new_command") {
        // Nová úloha nahrádza nedokončenú — žiadne neskoršie obnovenie.
        await clearConversationContext(db, flowCtx.conversationId);
      } else {
        const continued = await continueInvoiceDraftFlow(db, locale, flowCtx, rawText, input.structuredPartnerId);
        if (!continued) intent = null;
        if (continued) {
          return done({ success: true, recognized: true, intent: "CREATE_INVOICE_DRAFT", source: "conversation", result: continued, pendingClarification: null });
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // 1b. AKTÍVNA ÚLOHA: zapečatená otázka ostatných modulov
  //     („Ku ktorému stroju?", „Myslíte …?", „Ako sa volá nový partner?").
  // ------------------------------------------------------------------
  let resumed = false;
  if (typeof input.pendingClarification === "string" && input.pendingClarification) {
    const pending = unsealPendingClarification(input.pendingClarification, binding, sealOptions);
    if (!pending) {
      // Vypršaná / cudzia otázka: nikdy nepokračovať v starej akcii.
      if (classifyClarificationReply(rawText, {}).kind === "answer") {
        return done({
          success: true,
          recognized: true,
          source: "conversation",
          result: { kind: "answer", text: t("assistant.clarify.expired") },
          pendingClarification: null,
        });
      }
    } else if (
      pending.slot === "partner_name" &&
      pending.candidate &&
      !isTaskCancel(rawText) &&
      classifyConfirmationReply(rawText) === "cancel"
    ) {
      // „Partner X už existuje. Chcete ho otvoriť?" → „Nie" = pripraviť nového.
      intent = { name: pending.intent, args: { ...pending.args, confirmedNew: true }, source: "deterministic" };
      resumed = true;
    } else {
      const reply = classifyClarificationReply(rawText, pending);
      if (reply.kind === "cancel") {
        return done({
          success: true,
          recognized: true,
          intent: pending.intent,
          source: "conversation",
          result: { kind: "answer", text: t("assistant.clarify.cancelled") },
          pendingClarification: null,
        });
      }
      if (reply.kind === "answer" || reply.kind === "confirm_candidate") {
        intent = resumePendingIntent(pending, reply);
        resumed = true;
      }
    }
  }

  // 2. Globálny parser — iba keď žiadna aktívna úloha vetu neprijala.
  if (!intent) intent = parseIntentDeterministic(rawText, { module: input.moduleContext });

  // 3. Zamestnanec nemá všeobecný asistent: prejde iba príjem dokladu.
  //    Pred AI klasifikáciou a pred akýmkoľvek dotazom; odpoveď je rovnaká
  //    pre každú inú vetu, takže nič neprezradí.
  const restricted = restrictedAssistantDenial(intent, { role: input.role });
  if (restricted) {
    return done({
      success: true,
      recognized: Boolean(intent),
      intent: intent?.name,
      source: intent?.source,
      result: { kind: "error", text: t(denialMessageKey(restricted)) },
    });
  }

  // 4. AI iba interpretuje — nemaže, nezakladá bez výslovných slov.
  if (!intent) intent = sanitizeAiIntent(await deps.classifyWithAi(rawText), rawText);

  // Presný cieľ a serverové príznaky smú prísť IBA zo zapečatenej otázky.
  if (intent && !resumed && (intent.args.entityId !== undefined || intent.args.confirmedNew !== undefined)) {
    const args = { ...intent.args };
    delete args.entityId;
    delete args.confirmedNew;
    intent = { ...intent, args };
  }

  if (
    !intent ||
    (!isRegisteredReadOnlyIntent(intent.name) && !isRegisteredWriteIntent(intent.name) && !isRegisteredReviewableDraftIntent(intent.name))
  ) {
    return { output: notUnderstood(locale), finalIntent: null };
  }

  // Kontext obrazovky pre príkazy, ktoré modul nepomenovali („Vytvor novú
  // položku" v Sklade). Výslovný príkaz („Vytvor faktúru" na /stroje) má
  // vždy prednosť — ten do tejto vetvy vôbec nepríde.
  if (intent.name === "ENTITY_CREATE") {
    const target: IntentName | null =
      input.moduleContext === "inventory" ? "INVENTORY_ITEM_CREATE"
      : input.moduleContext === "machines" ? "MACHINE_CREATE"
      : input.moduleContext === "vehicles" ? "VEHICLE_CREATE"
      : null;
    if (!target) {
      return done({
        success: true,
        recognized: true,
        intent: intent.name,
        source: intent.source,
        result: { kind: "answer", text: t("assistant.clarify.createModule") },
      });
    }
    intent = { ...intent, name: target };
  }

  // 5a. INVARIANT: servisná veta nikdy nezaloží stroj.
  if (violatesMachineCreateInvariant(intent.name, rawText)) {
    if (!isServiceUtterance(rawText)) return { output: notUnderstood(locale), finalIntent: null };
    intent = {
      name: "MACHINE_SERVICE_ADD",
      args: { targetModule: "machines", serviceTitle: maintenanceDescription(rawText) },
      source: intent.source,
    };
  }
  // 5b. Intent musí sedieť s TOUTO vetou („Vytvor faktúru" nikdy nevedie na
  //     stroj/vozidlo/sklad — ani cez starú otázku či AI).
  if (!isIntentCompatibleWithUtterance(intent.name, rawText)) {
    const fresh = resumed ? parseIntentDeterministic(rawText, { module: input.moduleContext }) : null;
    if (!fresh || !isIntentCompatibleWithUtterance(fresh.name, rawText)) return { output: notUnderstood(locale), finalIntent: null };
    intent = fresh;
    resumed = false;
  }
  if (intent.name === "SHOW_MACHINE_SERVICE" && !intent.args.query &&
      (input.uiContext?.entityType === "vehicle" || input.moduleContext === "vehicles")) {
    intent = { ...intent, name: "SHOW_VEHICLE_SERVICE" };
  }

  // 6. BRÁNA OPRÁVNENÍ — pred akýmkoľvek dotazom na dáta.
  const denial = checkIntentAccess(intent.name, intent.args, {
    role: input.role,
    financeView: input.financeView,
    financeManage,
    canOperate: input.canOperate,
  });
  if (denial) {
    return done({
      success: true,
      recognized: true,
      intent: intent.name,
      source: intent.source,
      result: { kind: "error", text: t(denialMessageKey(denial)) },
    });
  }

  const resolvedEntity =
    input.uiContext && moduleMatchesEntity(input.uiContext) && intent.name !== "DOCUMENT_INTAKE"
      ? await resolveUiEntity(db, input.uiContext)
      : null;
  const actionCtx = { companyId: input.companyId, userId: input.userId, role: input.role as CompanyMemberRole };
  const readCtx = { role: input.role as CompanyMemberRole, financeView: input.financeView, canOperate: input.canOperate };

  // 7. Handler.
  let result: IntentResult;
  if (intent.name === "INBOX_LIST_UNASSIGNED" || intent.name === "INBOX_DELETE_UNASSIGNED") {
    result = await handleInboxIntent(db, locale, intent, { companyId: input.companyId }, (name, canonicalArgs, expectedCount) =>
      createInboxActionConfirmation(db, actionCtx, name, canonicalArgs, expectedCount)
    );
  } else if (intent.name === "PARTNER_CREATE") {
    result = await handlePartnerCreate(db, locale, intent, { companyId: input.companyId });
  } else if (isOperationalFamilyIntent(intent.name)) {
    result = await handleOperationalIntent(
      db,
      locale,
      intent,
      { companyId: input.companyId, userId: input.userId, resolvedEntity, today: input.issueDate },
      (name, canonicalArgs, expectedCount) => createOperationalActionConfirmation(db, actionCtx, name, canonicalArgs, expectedCount)
    );
  } else if (isFolderFamilyIntent(intent.name)) {
    const required = folderIntentPermission(intent.name);
    const allowed = required === "manage" ? financeManage : input.financeView;
    if (!allowed) {
      result = { kind: "error", text: t("folders.intent.denied") };
    } else {
      result = await handleFolderIntent(
        db,
        locale,
        intent,
        {
          companyId: input.companyId,
          userId: input.userId,
          selection: input.selection?.items ?? null,
          sourceFolderId: input.selection?.folderId ?? null,
          folderContextId: input.folderContextId,
        },
        (name, canonicalArgs, expectedCount) => createFolderActionConfirmation(db, actionCtx, name, canonicalArgs, expectedCount)
      );
    }
  } else if (intent.name === "PROCESS_CURRENT_DOCUMENT_AS_RECEIVED_INVOICE") {
    result = handleProcessCurrentDocumentAsReceivedInvoice(locale, resolvedEntity, financeManage);
  } else if (isRegisteredReadOnlyIntent(intent.name)) {
    result = await executeIntent(db, locale, withContextualQuery(intent, resolvedEntity), readCtx);
  } else if (isRegisteredReviewableDraftIntent(intent.name)) {
    // Fakturovať smie iba držiteľ finančnej správy (overené aj bránou).
    if (!financeManage) {
      result = { kind: "error", text: t("search.voice.states.denied") };
    } else if (!flowCtx) {
      result = { kind: "error", text: t("assistant.invoice.useVoice") };
    } else {
      result = await startInvoiceDraftFlow(db, locale, flowCtx, rawText, intent.args.partnerQuery, intent.args.query, intent.args.amount);
    }
  } else {
    result = await buildActionPreview(db, locale, actionCtx, intent);
  }

  // 8. Otázka handlera → zapečatený krátkodobý stav pre ďalšiu vetu.
  let pendingClarification: string | null = null;
  if (result && "awaiting" in result && result.awaiting) {
    pendingClarification = sealPendingClarification(intent.name, intent.args, result.awaiting, binding, sealOptions);
    const { awaiting: _awaiting, ...rest } = result;
    void _awaiting;
    result = rest as IntentResult;
  }

  return done({
    success: true,
    recognized: true,
    intent: intent.name,
    source: resumed ? "conversation" : intent.source,
    result,
    pendingClarification,
  });
}
