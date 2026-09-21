import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { parseIntentDeterministic } from "@/lib/intents/parse";
import { classifyIntentWithAi } from "@/lib/intents/ai-fallback";
import {
  isRegisteredReadOnlyIntent,
  isRegisteredWriteIntent,
  isRegisteredReviewableDraftIntent,
} from "@/lib/intents/registry";
import { executeIntent } from "@/lib/intents/handlers";
import { buildActionPreview } from "@/lib/intents/actions";
import { isValidConversationId } from "@/lib/intents/conversation";
import { boundClientCalendarDate } from "@/lib/local-date";
import {
  startInvoiceDraftFlow,
  continueInvoiceDraftFlow,
} from "@/lib/intents/invoice-draft-flow";
import type { ParsedIntent } from "@/lib/intents/types";
import type { CompanyMemberRole } from "@/lib/company";

// -----------------------------------------------------------------------------
// POST /api/assistant/intent
//
// Esblu Intent Engine — jediný vstupný bod pre inteligentné textové
// vyhľadávanie (zadanie "ESBLU — INTENT ENGINE + INTELIGENTNÉ TEXTOVÉ
// VYHĽADÁVANIE + AUTOMATICKÉ UPOZORNENIA NA LEHOTY").
//
// Pipeline (bod 2 zadania, doslovne):
//   TEXT → intent parser → structured intent → permission check →
//   allowlisted server-side handler → response/navigation
//
//   1) verifyRequestUser  — Bearer token → auth.uid() (rovnaký vzor ako
//      app/api/scan-document, app/api/account/preflight).
//   2) company_members    — potvrdí AKTÍVNY membership (fail closed, ak
//      chýba — appka nikdy "nehádá" firmu).
//   3) parseIntentDeterministic (lib/intents/parse.ts) → ak je null,
//      classifyIntentWithAi (lib/intents/ai-fallback.ts) ako fallback.
//   4) isRegisteredReadOnlyIntent / isRegisteredWriteIntent (lib/intents/
//      registry.ts) — DRUHÁ, nezávislá kontrola, že intent je naozaj v
//      allowliste, a KTORÁ z dvoch ciest sa spustí.
//   5a) READ intent → executeIntent (lib/intents/handlers.ts) — beží
//      VÝHRADNE cez user-scoped Supabase klienta (getUserScopedSupabaseClient),
//      takže RLS (company_id = esblu_my_active_company_id()) je posledná a
//      jediná autorita nad tým, čo sa vráti (bod 12 zadania). Vykoná sa a
//      vráti výsledok PRIAMO.
//   5b) WRITE intent (EXPORT_DOCUMENTS/CREATE_DOCUMENT_CATEGORY/
//      RENAME_DOCUMENT_CATEGORY/ASSIGN_DOCUMENTS_TO_CATEGORY) → NIKDY sa
//      nespustí priamo tu — buildActionPreview (lib/intents/actions.ts)
//      iba READ-only prepočíta, čo by sa stalo, a vráti `action_preview`
//      (čaká na explicitné potvrdenie v UI cez samostatný endpoint
//      app/api/assistant/action/execute) — pozri doplnenie zadania, bod 6.
// -----------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 200;

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    const { user, error: authError } = await verifyRequestUser(req, locale);
    if (authError || !user) {
      return Response.json({ success: false, error: authError }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as
      | { text?: string; conversationId?: string; localDate?: string }
      | null;
    const rawText = typeof body?.text === "string" ? body.text.trim() : "";

    // Kalendárny deň používateľa. Server beží v UTC, takže o polnoci
    // stredoeurópskeho času by sám odvodil včerajšok — a `issue_date` je
    // daňovo relevantný údaj. Klient preto pošle svoj deň a server ho
    // OVERÍ: tvar, reálnosť dátumu a odchýlku najviac jeden deň od UTC
    // (viac už nie je časové pásmo, ale iný dátum). Neplatná hodnota sa
    // ticho nahradí UTC dneškom, príkaz sa kvôli nej neodmieta.
    //
    // Toto NIE JE autorizačný vstup: rozhoduje iba o predvyplnenom dátume,
    // ktorý používateľ v koncepte vidí a môže zmeniť. Kto smie doklad
    // vytvoriť, drží rola a RLS nezávisle od tejto hodnoty.
    const issueDate = boundClientCalendarDate(body?.localDate);

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

    const readCtx = {
      role: membership.role as CompanyMemberRole,
      financeView: financeViewResult.data === true,
      canOperate: canOperateResult.data === true,
    };
    const financeManage = financeManageResult.data === true;

    // ------------------------------------------------------------------
    // Prebiehajúci dialóg má prednosť pred klasifikáciou.
    //
    // Keď sa appka pred chvíľou spýtala "Aká suma?", je odpoveď "300 eur"
    // odpoveďou — nie novým príkazom. Keby sa najprv klasifikovala, model
    // by z nej urobil nezmysel alebo nič, a otázka by sa položila znova.
    //
    // Kontext sa NAČÍTAVA Z DATABÁZY podľa totožnosti volajúceho; to, že
    // klient nejaké conversationId poslal, samo osebe neznamená, že
    // nejaký dialóg existuje.
    // ------------------------------------------------------------------
    if (conversationId && financeManage) {
      const continued = await continueInvoiceDraftFlow(
        supabase,
        locale,
        {
          companyId: membership.company_id as string,
          userId: user.id,
          conversationId,
          issueDate,
        },
        rawText
      );

      if (continued) {
        return Response.json({
          success: true,
          recognized: true,
          intent: "CREATE_INVOICE_DRAFT",
          source: "conversation",
          result: continued,
        });
      }
    }

    let intent: ParsedIntent | null = parseIntentDeterministic(rawText);
    if (!intent) {
      intent = await classifyIntentWithAi(rawText);
    }

    if (
      !intent ||
      (!isRegisteredReadOnlyIntent(intent.name) &&
        !isRegisteredWriteIntent(intent.name) &&
        !isRegisteredReviewableDraftIntent(intent.name))
    ) {
      return Response.json({
        success: true,
        recognized: false,
        result: { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") },
      });
    }

    // ------------------------------------------------------------------
    // Tri cesty, tri rôzne stupne opatrnosti:
    //
    //  READ            — vykoná sa priamo, RLS je posledná autorita.
    //  WRITE           — NIKDY sa nevykoná tu; vráti sa iba návrh a čaká
    //                    sa na potvrdenie cez /action/execute.
    //  REVIEWABLE DRAFT — zapíše sa, ale výsledok sa POVINNE otvorí na
    //                    kontrolu (dnes výhradne draft faktúry, ktorý nemá
    //                    číslo, nič neúčtuje a dá sa zmazať). Dôvod, prečo
    //                    tu potvrdenie nie je, je pri CREATE_INVOICE_DRAFT
    //                    v lib/intents/types.ts.
    // ------------------------------------------------------------------
    let result;

    if (isRegisteredReadOnlyIntent(intent.name)) {
      result = await executeIntent(supabase, locale, intent, readCtx);
    } else if (isRegisteredReviewableDraftIntent(intent.name)) {
      // Fakturovať smie iba držiteľ finančnej správy. Kontroluje sa PRED
      // akýmkoľvek dotazom aj pred prvou otázkou dialógu — zamestnanec
      // nemá dostať otázku "pre koho?" na príkaz, ktorý by aj tak nesmel
      // dokončiť. Skutočné vynútenie drží RLS pri zápise.
      if (!financeManage) {
        result = { kind: "error" as const, text: translate(locale, "search.voice.states.denied") };
      } else if (!conversationId) {
        // Dialóg bez identifikátora sa viesť nedá — a bez neho by sa prvá
        // chýbajúca hodnota už nemala kam doplniť.
        result = {
          kind: "error" as const,
          text: translate(locale, "search.errors.commandNotUnderstood"),
        };
      } else {
        result = await startInvoiceDraftFlow(
          supabase,
          locale,
          {
            companyId: membership.company_id as string,
            userId: user.id,
            conversationId,
            issueDate,
          },
          rawText,
          intent.args.partnerQuery,
          intent.args.query,
          intent.args.amount
        );
      }
    } else {
      result = await buildActionPreview(
        supabase,
        locale,
        {
          companyId: membership.company_id as string,
          userId: user.id,
          role: membership.role as CompanyMemberRole,
        },
        intent
      );
    }

    return Response.json({
      success: true,
      recognized: true,
      intent: intent.name,
      source: intent.source,
      result,
    });
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
