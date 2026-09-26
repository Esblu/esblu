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
import { classifyEditFieldReply, classifyNewNameReply, classifyQuantityReply, isExistingTargetRepair } from "@/lib/intents/slot-replies";
import { decomposeCommand, isWriteAction } from "@/lib/intents/command-grammar";
import { listCompanyCustomCategories, findMatchingCustomCategory } from "@/lib/custom-document-categories";
import { listDocumentFolders, folderSpokenKey } from "@/lib/document-folders";
import { invoiceItemDescriptions, needsDomainClarification, readInvoiceStartChoice, type AssistantDomain } from "@/lib/intents/domain-action";
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
  /**
   * Komerčný nárok modulu (lib/entitlements.ts) — samostatná brána PO bráne
   * oprávnení. Vracia lokalizovaný text odmietnutia alebo null. Chýba = bez
   * obmedzenia (iba testy starších scenárov); route ju dodáva vždy.
   */
  entitlementGate?: (intent: IntentName) => string | null;
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

/**
 * Otázka pri doméne bez akcie. Ponúka IBA možnosti, na ktoré má volajúci
 * právo (brána oprávnení už prešla pre čítanie danej oblasti). Nič nečíta.
 * `invoiceItems`: `null` = bez zapečatenej otázky; "" = otázka vytvoriť /
 * vyhľadať bez položiek; text = zachytené popisy položiek.
 */
function domainClarification(
  domain: AssistantDomain,
  rawText: string,
  ctx: { locale: Locale; financeManage: boolean; manager: boolean }
): { text: string; invoiceItems: string | null } {
  const t = (key: string, vars?: Record<string, string>) => translate(ctx.locale, key, vars);
  if (domain === "invoice") {
    if (!ctx.financeManage) return { text: t("assistant.domain.invoiceSearchOnly"), invoiceItems: null };
    const items = invoiceItemDescriptions(rawText);
    if (items.length > 0) {
      const and = t("search.voice.invoice.and");
      const names = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
      return { text: t("assistant.domain.invoiceItems", { items: names }), invoiceItems: items.join(", ") };
    }
    return { text: t("assistant.domain.invoiceAsk"), invoiceItems: "" };
  }
  if (domain === "machine" || domain === "vehicle" || domain === "inventory") {
    return { text: t(`assistant.domain.${domain}${ctx.manager ? "Manage" : "Read"}`), invoiceItems: null };
  }
  if (domain === "partner") {
    return { text: t(ctx.financeManage ? "assistant.domain.partnerManage" : "assistant.domain.partnerRead"), invoiceItems: null };
  }
  return { text: t(`assistant.domain.${domain}`), invoiceItems: null };
}

/** Tlačidlá Áno / Nie — text ide tou istou cestou ako vyslovená odpoveď. */
export function yesNoReplies(locale: Locale): { label: string; text: string }[] {
  return [
    { label: translate(locale, "assistant.quick.yes"), text: translate(locale, "assistant.quick.yes") },
    { label: translate(locale, "assistant.quick.no"), text: translate(locale, "assistant.quick.no") },
  ];
}

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
  // Rozpracovaná faktúra pokračuje iba s aktívnym modulom fakturácie; inak
  // veta prejde bežnou cestou, kde ju zastaví brána nároku (bod 6*).
  if (flowCtx && financeManage && !input.entitlementGate?.("CREATE_INVOICE_DRAFT")) {
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
  // „Áno, vytvor" po otázke „Chcete vytvoriť novú faktúru?" — položky zo
  // zapečatenej otázky (nie z tejto krátkej odpovede).
  let invoiceStartText: string | null = null;
  // Oprava „To je už vytvorené" → úvodná veta pred odpoveďou handlera.
  let repairLead: string | null = null;
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
    } else if (pending.slot === "invoice_start" && readInvoiceStartChoice(rawText, Boolean(pending.args.query)) !== null) {
      const choice = readInvoiceStartChoice(rawText, Boolean(pending.args.query));
      if (choice === "cancel") {
        return done({
          success: true,
          recognized: true,
          intent: pending.intent,
          source: "conversation",
          result: { kind: "answer", text: t("assistant.clarify.cancelled") },
          pendingClarification: null,
        });
      }
      intent = choice === "create"
        ? { name: "CREATE_INVOICE_DRAFT", args: {}, source: "deterministic" }
        : { name: "SEARCH_DOCUMENTS", args: { documentTypes: ["invoice"] }, source: "deterministic" };
      if (choice === "create" && pending.args.query) invoiceStartText = pending.args.query;
      resumed = true;
    } else if (pending.slot === "invoice_start") {
      // Iná veta než voľba = nový príkaz (otázka sa zahodí, nič sa nedomýšľa).
    } else if (pending.slot === "quantity") {
      // „Koľko kusov chcete pridať k položke X?" — slot má PREDNOSŤ pred
      // globálnym parserom: „päť", „5 kusov", „pridaj desať", „vlastne tri".
      const mode = pending.args.quantityMode ?? "add";
      const reply = classifyQuantityReply(rawText, mode);
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
      if (reply.kind === "repair" || reply.kind === "unclear") {
        // Úloha pokračuje — tá istá otázka, ten istý cieľ, nový token.
        const question = translate(locale, `assistant.inventory.askQuantityFor.${mode}`, { name: pending.args.entityName ?? pending.args.query ?? "" });
        const lead = reply.kind === "repair"
          ? translate(locale, "assistant.repair.existing", { name: pending.args.entityName ?? pending.args.query ?? "" })
          : t("assistant.inventory.quantityNotUnderstood");
        return done({
          success: true,
          recognized: true,
          intent: pending.intent,
          source: "conversation",
          result: { kind: "answer", text: `${lead} ${question}` },
          pendingClarification: sealPendingClarification(pending.intent, pending.args, { slot: "quantity" }, binding, sealOptions),
        });
      }
      if (reply.kind === "answer") {
        intent = { name: pending.intent, args: { ...pending.args, quantity: reply.quantity, quantityMode: reply.mode }, source: "deterministic" };
        resumed = true;
      }
      // new_command → globálny parser nižšie (úloha sa nahrádza).
    } else if (pending.slot === "container_type") {
      // „Myslíte zložku dokumentov „X“ alebo priečinok „X“?"
      const choice = classifyContainerReply(rawText);
      if (choice === "cancel") {
        return done({ success: true, recognized: true, intent: pending.intent, source: "conversation", result: { kind: "answer", text: t("assistant.clarify.cancelled") }, pendingClarification: null });
      }
      if (choice === "category" || choice === "folder") {
        intent = explicitContainerIntent({ name: pending.intent, args: pending.args, source: "deterministic" }, choice);
        resumed = true;
      } else if (choice === "unclear") {
        const name = pending.args.categoryName ?? pending.args.folderName ?? "";
        return done({
          success: true,
          recognized: true,
          intent: pending.intent,
          source: "conversation",
          result: {
            kind: "answer",
            text: name ? translate(locale, "assistant.container.ask", { name }) : t("assistant.container.askCreate"),
            quickReplies: [
              { label: t("assistant.container.category"), text: t("assistant.container.category") },
              { label: t("assistant.container.folder"), text: t("assistant.container.folder") },
            ],
          },
          pendingClarification: sealPendingClarification(pending.intent, pending.args, { slot: "container_type" }, binding, sealOptions),
        });
      }
      // new_command → globálny parser nižšie.
    } else if (pending.slot === "edit_field") {
      // „Čo chcete na položke X zmeniť? Počet alebo názov?"
      const name = pending.args.entityName ?? pending.args.query ?? "";
      const reply = classifyEditFieldReply(rawText);
      if (reply.kind === "cancel") {
        return done({ success: true, recognized: true, intent: pending.intent, source: "conversation", result: { kind: "answer", text: t("assistant.clarify.cancelled") }, pendingClarification: null });
      }
      if (reply.kind === "repair" || reply.kind === "unclear") {
        return done({
          success: true,
          recognized: true,
          intent: pending.intent,
          source: "conversation",
          result: { kind: "answer", text: translate(locale, "assistant.inventory.askEditField", { name }) },
          pendingClarification: sealPendingClarification(pending.intent, pending.args, { slot: "edit_field" }, binding, sealOptions),
        });
      }
      if (reply.kind === "quantity") {
        intent = {
          name: "INVENTORY_QUANTITY_ADJUST",
          args: { query: name, entityName: name, quantityMode: reply.mode, ...(reply.quantity !== undefined ? { quantity: reply.quantity } : {}) },
          source: "deterministic",
        };
        resumed = true;
      } else if (reply.kind === "name") {
        if (reply.newName) {
          intent = { name: "INVENTORY_ITEM_RENAME", args: { query: name, newName: reply.newName }, source: "deterministic" };
          resumed = true;
        } else {
          return done({
            success: true,
            recognized: true,
            intent: "INVENTORY_ITEM_RENAME",
            source: "conversation",
            result: { kind: "answer", text: translate(locale, "assistant.inventory.askNewName", { name }) },
            pendingClarification: sealPendingClarification("INVENTORY_ITEM_RENAME", { query: name }, { slot: "new_name" }, binding, sealOptions),
          });
        }
      }
      // new_command → globálny parser nižšie.
    } else if (pending.slot === "new_name") {
      const reply = classifyNewNameReply(rawText);
      if (reply.kind === "cancel") {
        return done({ success: true, recognized: true, intent: pending.intent, source: "conversation", result: { kind: "answer", text: t("assistant.clarify.cancelled") }, pendingClarification: null });
      }
      if (reply.kind === "answer") {
        intent = { name: pending.intent, args: { ...pending.args, newName: reply.value }, source: "deterministic" };
        resumed = true;
      }
    } else if (pending.slot === "create_module") {
      // „V ktorom module ju chcete vytvoriť?" → „To je už vytvorené."
      // Cieľ existuje: nič nezakladať, pokračovať nad EXISTUJÚCOU položkou.
      if (isExistingTargetRepair(rawText)) {
        const name = pending.args.entityName;
        if (!name) {
          return done({
            success: true,
            recognized: true,
            source: "conversation",
            result: { kind: "answer", text: t("assistant.repair.noTarget") },
            pendingClarification: null,
          });
        }
        intent = pending.args.quantityMode
          ? { name: "INVENTORY_QUANTITY_ADJUST", args: { quantityMode: pending.args.quantityMode, query: name, entityName: name }, source: "deterministic" }
          : { name: "INVENTORY_ITEM_STATUS", args: { query: name }, source: "deterministic" };
        resumed = true;
        repairLead = translate(locale, "assistant.repair.existing", { name });
      }
    } else if (
      pending.slot === "inventory_item" &&
      isExistingTargetRepair(rawText)
    ) {
      // „Položka X sa nenašla." → „Ale už existuje." — spýtať sa na presný názov.
      return done({
        success: true,
        recognized: true,
        intent: pending.intent,
        source: "conversation",
        result: { kind: "answer", text: t("assistant.repair.whichExisting") },
        pendingClarification: sealPendingClarification(pending.intent, pending.args, { slot: "inventory_item" }, binding, sealOptions),
      });
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

  // 3b. Oprava bez rozpracovanej úlohy („Už existuje." po vykonanom príkaze):
  //     nič nevytvárať a nehádať cieľ — povedať, ako pokračovať.
  if (!intent && isExistingTargetRepair(rawText)) {
    return done({
      success: true,
      recognized: true,
      source: "conversation",
      result: { kind: "answer", text: t("assistant.repair.noTarget") },
      pendingClarification: null,
    });
  }

  // 3c. Výslovná akcia nad pomenovaným typom („Vymaž partnera X"), ktorú
  //     deterministická gramatika nevie vykonať: AI ju NESMIE preložiť na
  //     niečo iné (hľadanie, iný typ). Jasná veta namiesto náhodného výsledku.
  if (!intent) {
    const grammar = decomposeCommand(rawText);
    if (grammar?.entityType && isWriteAction(grammar.action)) {
      return done({
        success: true,
        recognized: true,
        source: "deterministic",
        result: { kind: "answer", text: t("assistant.clarify.actionNotSupported") },
        pendingClarification: null,
      });
    }
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
      // Otázka na modul je rozpracovaná úloha: nesie meno (a či išlo o
      // „pridaj"), aby oprava „To je už vytvorené" pokračovala nad
      // existujúcou položkou namiesto „Nerozumel som".
      const addVerb = /^\s*(pridaj|prihod|dopln|add)/i.test(rawText.normalize("NFD").replace(/[̀-ͯ]/g, ""));
      return done({
        success: true,
        recognized: true,
        intent: intent.name,
        source: intent.source,
        result: { kind: "answer", text: t("assistant.clarify.createModule") },
        pendingClarification: sealPendingClarification(
          "ENTITY_CREATE",
          { entityName: intent.args.entityName, ...(addVerb ? { quantityMode: "add" as const } : {}) },
          { slot: "create_module" },
          binding,
          sealOptions
        ),
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

  // 5c. „Zložka" je v reči NEJEDNOZNAČNÁ: zložka dokumentov (vlastná
  //     kategória) aj priečinok dokladov. Bez automatickej preferencie —
  //     pri zhode oboch sa asistent spýta (najmä pred mazaním/premenovaním).
  //     Dopyt beží IBA pre typ, na ktorý má volajúci právo.
  if (containerNounKind(rawText) === "ambiguous" && CONTAINER_PAIRS[intent.name] && !resumed) {
    intent = { ...intent, args: { ...intent.args, ambiguousContainer: true } };
  }
  if (intent.args.ambiguousContainer) {
    const decision = await resolveAmbiguousContainer(db, intent, input.moduleContext ?? null, {
      role: input.role,
      financeView: input.financeView,
      financeManage,
      canOperate: input.canOperate,
    });
    if ("ask" in decision) {
      const name = decision.name ?? "";
      return done({
        success: true,
        recognized: true,
        intent: intent.name,
        source: intent.source,
        result: {
          kind: "answer",
          text: name ? translate(locale, "assistant.container.ask", { name }) : t("assistant.container.askCreate"),
          quickReplies: [
            { label: t("assistant.container.category"), text: t("assistant.container.category") },
            { label: t("assistant.container.folder"), text: t("assistant.container.folder") },
          ],
        },
        // Tá istá úloha pokračuje po odpovedi „zložka dokumentov" / „priečinok".
        pendingClarification: sealPendingClarification(intent.name, intent.args, { slot: "container_type" }, binding, sealOptions),
      });
    }
    intent = decision.intent;
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

  // 6*. BRÁNA NÁROKU MODULU — až po role (rola má prednosť a nárok ju nikdy
  //     nerozširuje). Hlas ani písanie nič neodomknú: neaktívny modul =
  //     odmietnutie pred akýmkoľvek dotazom.
  const entitlementText = input.entitlementGate?.(intent.name) ?? null;
  if (entitlementText) {
    return done({
      success: true,
      recognized: true,
      intent: intent.name,
      source: intent.source,
      result: { kind: "error", text: entitlementText },
    });
  }

  // 6a. „Vymaž zložku" bez mena → otázka (nie „nerozumel som").
  if ((intent.name === "DELETE_DOCUMENT_CATEGORY" || intent.name === "RENAME_DOCUMENT_CATEGORY") && !intent.args.categoryName?.trim()) {
    return done({
      success: true,
      recognized: true,
      intent: intent.name,
      source: intent.source,
      result: { kind: "answer", text: t(intent.name === "DELETE_DOCUMENT_CATEGORY" ? "assistant.clarify.whichCategoryDelete" : "assistant.clarify.whichCategory") },
      pendingClarification: sealPendingClarification(intent.name, intent.args, { slot: "folder" }, binding, sealOptions),
    });
  }

  // 6b. DOMÉNA BEZ AKCIE (asistent / hlas): holé „Faktúru, …", „Stroj.",
  //     „Sklad." sa nezmení na hľadanie — asistent sa spýta, čo s tým.
  //     Beží PO bráne oprávnení (odmietnutý nedostane ani otázku) a PRED
  //     akýmkoľvek dotazom. Písané hľadanie na nástenke (bez dialógu) ostáva.
  const domain = input.conversationId && !resumed ? needsDomainClarification(intent, rawText) : null;
  if (domain) {
    const clarification = domainClarification(domain, rawText, {
      locale,
      financeManage,
      manager: input.role === "owner" || input.role === "admin",
    });
    let pendingToken: string | null = null;
    if (clarification.invoiceItems !== null) {
      pendingToken = sealPendingClarification(
        "CREATE_INVOICE_DRAFT",
        clarification.invoiceItems ? { query: clarification.invoiceItems } : {},
        { slot: "invoice_start" },
        binding,
        sealOptions
      );
    }
    const quickReplies = clarification.invoiceItems === null
      ? undefined
      : clarification.invoiceItems
        ? yesNoReplies(locale)
        : [
            { label: t("assistant.quick.create"), text: t("assistant.quick.create") },
            { label: t("assistant.quick.search"), text: t("assistant.quick.search") },
          ];
    return done({
      success: true,
      recognized: true,
      intent: intent.name,
      source: intent.source,
      result: { kind: "answer", text: clarification.text, ...(quickReplies && pendingToken ? { quickReplies } : {}) },
      pendingClarification: pendingToken,
    });
  }

  const resolvedEntity =
    input.uiContext && moduleMatchesEntity(input.uiContext) && intent.name !== "DOCUMENT_INTAKE"
      ? await resolveUiEntity(db, input.uiContext)
      : null;
  const actionCtx = { companyId: input.companyId, userId: input.userId, role: input.role as CompanyMemberRole };
  const readCtx = { role: input.role as CompanyMemberRole, financeView: input.financeView, canOperate: input.canOperate, companyId: input.companyId };

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
      // Po „Áno" na „Chcete vytvoriť novú faktúru?" sa položky berú z
      // pôvodnej (zapečatenej) vety, nie z krátkej odpovede.
      const flowText = invoiceStartText ? `za ${invoiceStartText}` : rawText;
      result = await startInvoiceDraftFlow(db, locale, flowCtx, flowText, intent.args.partnerQuery, invoiceStartText ? undefined : intent.args.query, intent.args.amount);
    }
  } else {
    result = await buildActionPreview(db, locale, actionCtx, intent);
  }

  // 8. Otázka handlera → zapečatený krátkodobý stav pre ďalšiu vetu.
  let pendingClarification: string | null = null;
  if (result && "awaiting" in result && result.awaiting) {
    const sealedArgs = result.awaiting.patch ? { ...intent.args, ...result.awaiting.patch } : intent.args;
    pendingClarification = sealPendingClarification(intent.name, sealedArgs, result.awaiting, binding, sealOptions);
    const hasCandidate = Boolean(result.awaiting.candidate);
    const { awaiting: _awaiting, ...rest } = result;
    void _awaiting;
    result = rest as IntentResult;
    // „Myslíte …?" → tlačidlá Áno / Nie (tá istá cesta ako hlasová odpoveď).
    if (hasCandidate && pendingClarification && (result.kind === "answer" || result.kind === "not_found" || result.kind === "list")) {
      result = { ...result, quickReplies: yesNoReplies(locale) };
    }
  }

  if (repairLead && (result.kind === "answer" || result.kind === "not_found")) {
    result = { ...result, text: `${repairLead} ${result.text}` };
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

// =============================================================================
// „ZLOŽKA" — nejednoznačné slovo pre dva typy kontajnerov.
//
// V Esblu sú dva rôzne kontajnery: zložka dokumentov (vlastná kategória,
// UI „Zložky") a priečinok dokladov (UI „Priečinky"). Používateľ nemusí
// poznať internú terminológiu a „zložka" hovorí o oboch. Preto:
//   - výslovný pojem („priečinok", „kategória", „zložka dokumentov") platí priamo,
//   - holé „zložka": overia sa OBA typy (iba tie, na ktoré má volajúci právo),
//     presne jedna zhoda = ten typ, zhoda oboch = OTÁZKA (žiadna preferencia),
//     žiadna = nenájdené v povolenom type,
//   - založenie: typ podľa obrazovky (Priečinky / Inbox), inak otázka.
// Mazanie ani premenovanie sa nikdy nepripraví, kým nie je typ jednoznačný.
// =============================================================================

type ContainerNoun = "ambiguous" | "category" | "folder" | null;

/** Aký pojem pre kontajner zaznel? */
export function containerNounKind(rawText: string): ContainerNoun {
  const text = rawText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/(^|[^a-z])(priecin|belegordner|accounting folder)/.test(text)) return "folder";
  if (/(^|[^a-z])(kategori|category|categories|kategorie)/.test(text)) return "category";
  if (/(^|[^a-z])zlozk\S*\s+(dokument|doklad)/.test(text)) return "category";
  if (/(^|[^a-z])zlozk/.test(text)) return "ambiguous";
  return null;
}

type ContainerPair = { folder: IntentName; toFolderArgs: (args: ParsedIntent["args"]) => ParsedIntent["args"]; name: (args: ParsedIntent["args"]) => string | undefined };

/** Zložka dokumentov ↔ priečinok dokladov pre tú istú akciu. */
const CONTAINER_PAIRS: Partial<Record<IntentName, ContainerPair>> = {
  DELETE_DOCUMENT_CATEGORY: { folder: "FOLDER_DELETE", toFolderArgs: (a) => ({ folderName: a.categoryName }), name: (a) => a.categoryName?.trim() || undefined },
  RENAME_DOCUMENT_CATEGORY: { folder: "FOLDER_RENAME", toFolderArgs: (a) => ({ folderName: a.categoryName, newName: a.newCategoryName }), name: (a) => a.categoryName?.trim() || undefined },
  OPEN_DOCUMENT_FOLDER: { folder: "FOLDER_OPEN", toFolderArgs: (a) => ({ folderName: a.categoryName ?? a.query }), name: (a) => (a.categoryName ?? a.query)?.trim() || undefined },
  CREATE_DOCUMENT_CATEGORY: { folder: "FOLDER_CREATE", toFolderArgs: (a) => ({ folderName: a.categoryName }), name: (a) => a.categoryName?.trim() || undefined },
};

/** Výsledný intent pre zvolený typ (bez príznaku nejednoznačnosti). */
function explicitContainerIntent(intent: ParsedIntent, kind: "category" | "folder"): ParsedIntent {
  const args = { ...intent.args };
  delete args.ambiguousContainer;
  const pair = CONTAINER_PAIRS[intent.name];
  if (kind === "category" || !pair) return { ...intent, args };
  return { ...intent, name: pair.folder, args: pair.toFolderArgs(args) };
}

function classifyContainerReply(rawText: string): "category" | "folder" | "cancel" | "unclear" | "new_command" {
  const text = rawText.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
  if (isTaskCancel(rawText) || /^(nie|no|nein)$/.test(text)) return "cancel";
  const words = text.split(" ");
  if (words.length > 6) return "new_command";
  const folder = /(priecin|folder|ordner|belegordner)/.test(text);
  const category = /(dokument|doklad|kategori|category|kategorie|zlozk)/.test(text);
  if (folder && !category) return "folder";
  if (category && !folder) return "category";
  if (/^(ten |to |tu )?(prv|first|erst)/.test(text)) return "category";
  if (/^(ten |to |tu )?(druh|second|zweit)/.test(text)) return "folder";
  if (parseIntentDeterministic(rawText)) return "new_command";
  return "unclear";
}

/**
 * Rozhodne typ pre holé „zložka". Oprávnenie pre KAŽDÝ typ sa overí PRED
 * dopytom na ten typ — typ, na ktorý volajúci nemá právo, sa nečíta ani
 * neprezradí (ani v otázke).
 */
async function resolveAmbiguousContainer(
  db: SupabaseClient,
  intent: ParsedIntent,
  moduleContext: string | null,
  access: { role: string; financeView: boolean; financeManage: boolean; canOperate: boolean }
): Promise<{ intent: ParsedIntent } | { ask: true; name?: string }> {
  const pair = CONTAINER_PAIRS[intent.name];
  if (!pair) return { intent: explicitContainerIntent(intent, "category") };
  const folderArgs = pair.toFolderArgs(intent.args);
  const canCategory = !checkIntentAccess(intent.name, intent.args, access);
  const folderRequirement = folderIntentPermission(pair.folder);
  const canFolder = !checkIntentAccess(pair.folder, folderArgs, access) && (folderRequirement === "manage" ? access.financeManage : access.financeView);
  const only = (kind: "category" | "folder") => ({ intent: explicitContainerIntent(intent, kind) });

  if (!canCategory && !canFolder) return only("category"); // brána oprávnení odmietne
  if (canCategory !== canFolder) return only(canCategory ? "category" : "folder");

  const name = pair.name(intent.args);
  if (intent.name === "CREATE_DOCUMENT_CATEGORY") {
    // Založenie: typ podľa obrazovky, inak otázka (nikdy tichý výber).
    if (moduleContext === "folders") return only("folder");
    if (moduleContext === "inbox") return only("category");
    return { ask: true };
  }
  // Bez mena: najprv otázka na meno (6a); typ sa rozhodne po odpovedi
  // (príznak nejednoznačnosti ostáva v zapečatenej otázke).
  if (!name) return { intent };

  const categories = await listCompanyCustomCategories(db);
  const categoryMatch = Boolean(findMatchingCustomCategory(categories, name));
  const key = folderSpokenKey(name);
  const folderMatch = key ? (await listDocumentFolders(db)).some((folder) => folderSpokenKey(folder.name) === key) : false;

  if (categoryMatch && folderMatch) return { ask: true, name };
  if (folderMatch) return only("folder");
  // Iba zložka, alebo nič: nenájdené oznámi handler zložky (rovnaká veta ako doteraz).
  return only("category");
}
