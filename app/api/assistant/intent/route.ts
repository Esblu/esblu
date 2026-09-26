import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { classifyIntentWithAi } from "@/lib/intents/ai-fallback";
import type { ParseHints } from "@/lib/intents/parse";
import type { FolderRef } from "@/lib/document-folders";
import { isValidConversationId } from "@/lib/intents/conversation";
import { resolveClientCalendarDate } from "@/lib/local-date";
import { readUiContext } from "@/lib/intents/ui-context";
import { runAssistantTurn } from "@/lib/intents/orchestrator";
import { getCompanyEntitlements, entitlementDenialMessage } from "@/lib/entitlements-server";
import { assistantEntitlementDenial } from "@/lib/entitlements";
import { isRegisteredReadOnlyIntent } from "@/lib/intents/registry";

// -----------------------------------------------------------------------------
// POST /api/assistant/intent
//
// Esblu Intent Engine — jediný vstupný bod pre inteligentné textové
// vyhľadávanie (zadanie "ESBLU — INTENT ENGINE + INTELIGENTNÉ TEXTOVÉ
// VYHĽADÁVANIE + AUTOMATICKÉ UPOZORNENIA NA LEHOTY").
//
// Táto route je TENKÁ: overí prihlásenie (Bearer → auth.uid()), AKTÍVNE
// členstvo vo firme (fail closed) a oprávnenia z tých istých RPC ako RLS,
// prečíta TVAR vstupov z tela a zavolá orchestrátor
// (lib/intents/orchestrator.ts#runAssistantTurn). Tam je celé poradie:
// aktívna úloha → parser → zamestnanec → AI (bez mazania a bez založenia
// bez výslovných slov) → poistky → brána oprávnení → handler → otázka.
// Zápisy nikdy nevykoná priamo — iba náhľad s jednorazovým potvrdením
// (app/api/assistant/action/execute) alebo draft faktúry na kontrolu.
// -----------------------------------------------------------------------------

// Hlasový záznam má strop 20 s (lib/voice-config.ts) a pri súvislom diktovaní
// faktúry to je bežne 250–400 znakov. Pôvodných 200 znakov odmietalo dlhé,
// úplne správne prepisy ešte pred spracovaním (a klient ukázal „nerozumel
// som"). 600 znakov pokryje 20 s reči s rezervou a stále drží vstup krátky.
const MAX_TEXT_LENGTH = 600;

const ANSWER_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Štruktúrovaná odpoveď na otázku „ktorého partnera myslíte?".
 *
 * Tlačidlo posiela identifikátor namiesto zobrazeného textu. Predtým
 * niesol význam iba popisok („Tester1 · 4678922778"), ktorý sa musel
 * spätne rozpoznávať z reťazca — a práve to viedlo k tomu, že sa výber
 * partnera dal zameniť za inú odpoveď.
 *
 * Tu sa overuje IBA tvar. Že partner existuje, patrí do firmy volajúceho
 * a že ho server sám ponúkol, sa kontroluje v continueInvoiceDraftFlow.
 */
function readPartnerSelectionAnswer(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const answer = raw as Record<string, unknown>;
  if (answer.type !== "partner_selection") return null;
  const partnerId = answer.partnerId;
  return typeof partnerId === "string" && ANSWER_UUID_PATTERN.test(partnerId)
    ? partnerId
    : null;
}

/**
 * Výber dokladov z obrazovky („tieto doklady"). Iba tvar: najviac 500
 * odkazov, typ z uzavretého zoznamu, UUID. Či doklady existujú a patria
 * volajúcemu, overuje handler pod RLS. Na nástenke výber neexistuje.
 */
function readSelectionContext(raw: unknown): { items: FolderRef[]; folderId: string | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as { items?: unknown; folderId?: unknown };
  if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 500) return null;
  const items: FolderRef[] = [];
  for (const item of source.items) {
    if (!item || typeof item !== "object") continue;
    const { type, id } = item as { type?: unknown; id?: unknown };
    if ((type === "invoice" || type === "document") && typeof id === "string" && ANSWER_UUID_PATTERN.test(id)) {
      items.push({ type, id });
    }
  }
  if (items.length === 0) return null;
  const folderId =
    typeof source.folderId === "string" && ANSWER_UUID_PATTERN.test(source.folderId) ? source.folderId : null;
  return { items, folderId };
}

/** Modul obrazovky — iba z uzavretého zoznamu. Nie je to oprávnenie. */
const MODULE_CONTEXTS = ["dashboard", "inventory", "machines", "vehicles", "invoices", "inbox", "folders", "partners"] as const;
function readModuleContext(raw: unknown): ParseHints["module"] | undefined {
  return typeof raw === "string" && (MODULE_CONTEXTS as readonly string[]).includes(raw)
    ? (raw as ParseHints["module"])
    : undefined;
}

/** Naposledy použitý priečinok v rozhovore — iba UUID; overí sa pod RLS. */
function readFolderContext(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const folderId = (raw as { folderId?: unknown }).folderId;
  return typeof folderId === "string" && ANSWER_UUID_PATTERN.test(folderId) ? folderId : null;
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    const { user, error: authError } = await verifyRequestUser(req, locale);
    if (authError || !user) {
      return Response.json({ success: false, error: authError }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | {
          text?: string;
          conversationId?: string;
          pendingClarification?: unknown;
          localDate?: string;
          uiContext?: unknown;
          answer?: unknown;
          selectionContext?: unknown;
          folderContext?: unknown;
          moduleContext?: unknown;
        }
      | null;
    const rawText = typeof body?.text === "string" ? body.text.trim() : "";

    // Kalendárny deň používateľa. Server beží v UTC, takže o polnoci
    // stredoeurópskeho času by sám odvodil včerajšok — a `issue_date` je
    // daňovo relevantný údaj. Klient preto pošle svoj deň a server ho
    // OVERÍ: tvar, reálnosť dátumu a odchýlku najviac jeden deň od UTC
    // (viac už nie je časové pásmo, ale iný dátum).
    //
    // `null` znamená "nevieme to spoľahlivo určiť" a NEMÁ náhradnú
    // hodnotu. Čítacie a navigačné príkazy dátum nepotrebujú, takže ich
    // to nezastaví; zakladanie dokladu sa naň ale spoľahnúť musí a nižšie
    // sa kvôli nemu zastaví.
    //
    // Toto NIE JE autorizačný vstup: neurčuje firmu ani používateľa a
    // nemá vplyv na to, kto smie doklad vytvoriť — to drží rola a RLS.
    const issueDate = resolveClientCalendarDate(body?.localDate);

    // Kontext otvorenej obrazovky — iba modul, typ entity a UUID.
    // Neplatný tvar sa ticho zahodí a príkaz sa spracuje, akoby nič
    // otvorené nebolo. Overenie proti databáze prebieha nižšie.
    const uiContext = readUiContext(body?.uiContext);

    // Štruktúrovaná odpoveď z tlačidla („vybral som tohto partnera").
    // Prečíta sa iba tvar; či ten partner naozaj existuje, patrí do firmy
    // volajúceho a bol vôbec ponúknutý, rozhoduje až server nižšie.
    const structuredPartnerId = readPartnerSelectionAnswer(body?.answer);

    // Identifikátor prebiehajúceho dialógu. Sám osebe nič neodomyká —
    // server pri ňom vždy overuje aj totožnosť volajúceho a jeho aktívnu
    // firmu (SECURITY DEFINER funkcie, migrácia 20260924100000). Neplatný
    // tvar sa ticho zahodí a príkaz sa spracuje ako nový.
    const conversationId = isValidConversationId(body?.conversationId)
      ? body.conversationId
      : null;

    if (!rawText) {
      return Response.json(
        { success: false, error: translate(locale, "search.errors.missingQuery") },
        { status: 400 }
      );
    }

    if (rawText.length > MAX_TEXT_LENGTH) {
      return Response.json(
        { success: false, error: translate(locale, "search.errors.textTooLong") },
        { status: 400 }
      );
    }

    // verifyRequestUser() vyššie už overil, že táto hlavička existuje a je
    // platný "Bearer <token>" (inak by sme sem nedošli) — tu ju iba znova
    // vytiahneme, aby sme ňou mohli "obliecť" user-scoped klienta nižšie.
    const authorization = req.headers.get("authorization") || "";
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const supabase = getUserScopedSupabaseClient(accessToken);

    // Fail closed: bez aktívneho membershipu appka nemá čo prehľadávať —
    // nikdy nespustí handler "naprázdno" (čo by pri chybe v RLS mohlo byť
    // nebezpečné ticho-prázdne správanie namiesto explicitnej chyby).
    const { data: membership, error: membershipError } = await supabase
      .from("company_members")
      .select("company_id, role")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (membershipError || !membership) {
      return Response.json(
        { success: false, error: translate(locale, "search.errors.noActiveCompany") },
        { status: 403 }
      );
    }

    // Oprávnenia sa počítajú NA SERVERI z rovnakých RPC, aké používa RLS —
    // nie z roly odhadnutej na klientovi a nie z tela požiadavky. Keby RPC
    // zlyhalo, `false` znamená odmietnutie, nie tichý prechod.
    const [financeViewResult, financeManageResult, canOperateResult] = await Promise.all([
      supabase.rpc("esblu_my_finance_view"),
      supabase.rpc("esblu_my_finance_manage"),
      supabase.rpc("esblu_role_can_operate"),
    ]);

    // Komerčné nároky firmy (moduly) — z DB podľa JWT, nikdy z klienta.
    // Čítanie existujúcich dát nárok nevyžaduje (rovnako ako ručné UI; rola
    // a financie rozhodujú vždy). Zápisy modulu bez nároku = odmietnutie;
    // nečitateľný stav = zápisy odmietnuté (fail closed). Písanie aj hlas.
    const entitlements = await getCompanyEntitlements(supabase);
    const entitlementGate = (intentName: Parameters<typeof assistantEntitlementDenial>[1]) => {
      const denial = assistantEntitlementDenial(entitlements, intentName, isRegisteredReadOnlyIntent);
      return denial ? entitlementDenialMessage(locale, denial) : null;
    };

    const readCtx = {
      financeView: financeViewResult.data === true,
      canOperate: canOperateResult.data === true,
    };
    const financeManage = financeManageResult.data === true;

    // ------------------------------------------------------------------
    // Všetko ďalšie — aktívna úloha, parser, AI, poistky, brána oprávnení,
    // handler a zapečatená otázka — rozhoduje JEDEN orchestrátor
    // (lib/intents/orchestrator.ts). Route iba dodá overenú totožnosť,
    // firmu a oprávnenia z RPC; z klienta sa neberie nič z toho.
    // ------------------------------------------------------------------
    const selection = readSelectionContext(body?.selectionContext);
    const output = await runAssistantTurn(
      { db: supabase, classifyWithAi: classifyIntentWithAi },
      {
        rawText,
        locale,
        userId: user.id,
        companyId: membership.company_id as string,
        role: membership.role as string,
        financeView: readCtx.financeView,
        financeManage,
        canOperate: readCtx.canOperate,
        conversationId,
        pendingClarification: body?.pendingClarification,
        structuredPartnerId,
        issueDate,
        uiContext,
        moduleContext: readModuleContext(body?.moduleContext),
        selection,
        folderContextId: readFolderContext(body?.folderContext),
        entitlementGate,
      }
    );
    // Prevádzková diagnostika BEZ obsahu: žiadny prepis, meno, suma ani
    // identifikátor — iba to, ako sa veta spracovala. Stačí na rozlíšenie
    // zlyhania smerovania (recognized=false) od otázky na chýbajúci údaj
    // (resultKind=clarify) a od odmietnutia (resultKind=error). Zlyhanie
    // prepisu reči loguje /api/assistant/transcribe (502/422).
    console.info(
      "esblu_assistant_turn",
      JSON.stringify({
        recognized: output.recognized,
        intent: output.intent ?? null,
        source: output.source ?? null,
        resultKind: output.result.kind,
        pending: Boolean(output.pendingClarification),
        textLength: rawText.length,
        voice: Boolean(conversationId),
      })
    );
    return Response.json(output);
  } catch (error) {
    console.error(
      "api/assistant/intent: neočakávaná chyba:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      { success: false, error: translate(locale, "search.errors.generic") },
      { status: 500 }
    );
  }
}
