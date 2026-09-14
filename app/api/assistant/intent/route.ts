import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { parseIntentDeterministic } from "@/lib/intents/parse";
import { classifyIntentWithAi } from "@/lib/intents/ai-fallback";
import { isRegisteredReadOnlyIntent } from "@/lib/intents/registry";
import { executeIntent } from "@/lib/intents/handlers";
import type { ParsedIntent } from "@/lib/intents/types";

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
//   4) isRegisteredReadOnlyIntent (lib/intents/registry.ts) — DRUHÁ,
//      nezávislá kontrola, že intent je naozaj v allowliste a readOnly.
//   5) executeIntent (lib/intents/handlers.ts) — beží VÝHRADNE cez
//      user-scoped Supabase klienta (getUserScopedSupabaseClient), takže
//      RLS (company_id = esblu_my_active_company_id()) je posledná a
//      jediná autorita nad tým, čo sa vráti (bod 12 zadania).
//
// Táto fáza je VÝHRADNE READ-ONLY (bod 14 zadania) — v lib/intents/types.ts
// (INTENT_NAMES) dnes NEEXISTUJE ani jeden write/delete intent, takže krok
// 4) ich ani teoreticky nemôže spustiť.
// -----------------------------------------------------------------------------

const MAX_TEXT_LENGTH = 200;

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    const { user, error: authError } = await verifyRequestUser(req, locale);
    if (authError || !user) {
      return Response.json({ success: false, error: authError }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as { text?: string } | null;
    const rawText = typeof body?.text === "string" ? body.text.trim() : "";

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
      .select("company_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (membershipError || !membership) {
      return Response.json(
        { success: false, error: translate(locale, "search.errors.noActiveCompany") },
        { status: 403 }
      );
    }

    let intent: ParsedIntent | null = parseIntentDeterministic(rawText);
    if (!intent) {
      intent = await classifyIntentWithAi(rawText);
    }

    if (!intent || !isRegisteredReadOnlyIntent(intent.name)) {
      return Response.json({
        success: true,
        recognized: false,
        result: { kind: "not_found", text: translate(locale, "search.errors.commandNotUnderstood") },
      });
    }

    const result = await executeIntent(supabase, locale, intent);

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
