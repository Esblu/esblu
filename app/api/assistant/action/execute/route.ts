import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { executeAction } from "@/lib/intents/actions";
import type { CompanyMemberRole } from "@/lib/company";

// -----------------------------------------------------------------------------
// POST /api/assistant/action/execute
//
// Esblu Intent Engine — DRUHÝ krok write-akcií (CREATE_DOCUMENT_CATEGORY/
// RENAME_DOCUMENT_CATEGORY/ASSIGN_DOCUMENTS_TO_CATEGORY), volaný VÝHRADNE po
// explicitnom potvrdení v UI (klik na [Vytvoriť]/[Premenovať]/[Priradiť] pri
// `action_preview`, ktorý vrátil POST /api/assistant/intent — pozri
// lib/intents/actions.ts#buildActionPreview). EXPORT_DOCUMENTS sem NIKDY
// nepríde — nezapisuje nič do DB, klient ho po potvrdení spustí priamo z
// `exportPayload` (žiadne ďalšie network volanie, pozri komentár pri
// IntentResult#exportPayload v lib/intents/types.ts).
//
// HARDENED bezpečnostný model (bezpečnostné review po pôvodnej implementácii,
// pozri supabase/migrations/20260915120000_add_assistant_action_confirmations.sql):
//
//   Telo requestu obsahuje VÝHRADNE `{ confirmationId: string }` — ŽIADNY
//   `intent`/`args`. Predchádzajúca verzia prijímala `intent`+`args` priamo
//   od klienta (aj keď ich znovu prísne validovala/prepočítavala dotknuté
//   entity) — to NEPREUKAZOVALO, že používateľ skutočne videl a potvrdil
//   KONKRÉTNY preview, a teoreticky umožňovalo zavolať tento endpoint
//   priamo s ľubovoľným povoleným write intentom bez predchádzajúceho
//   preview kroku ("DIRECT CALL").
//
//   Teraz: `confirmationId` je jediný vstup. `executeAction()`
//   (lib/intents/actions.ts) ho atomicky "claim-ne" oproti server-side
//   uloženému `assistant_action_confirmations` riadku (viazanému na
//   presne tohto user_id/company_id, s krátkou expiráciou a
//   jednorazovým `consumed_at`) — intent aj kanonické args sa VŽDY čítajú
//   IBA z tohto riadku, nikdy z tela requestu. Chýbajúci/neplatný/cudzí/
//   expirovaný/už použitý confirmationId → fail closed, žiadny zápis.
//
//   `role`/`companyId`/`userId` sa (rovnako ako predtým, aj ako v
//   /api/assistant/intent) odvodzujú VÝHRADNE zo session JWT, nikdy z tela
//   requestu — toto sa touto zmenou nemení, iba dopĺňa o confirmation-bound
//   overenie vyššie.
// -----------------------------------------------------------------------------

function isValidConfirmationId(value: unknown): value is string {
  // UUID formát (assistant_action_confirmations.id = uuid) — appka tu iba
  // odmietne zjavne neplatný tvar skôr, než ho vôbec pošle do DB; skutočná
  // autorita je aj tak claimActionConfirmation() v lib/intents/actions.ts
  // (nesprávny/neexistujúci/cudzí UUID jednoducho nenájde žiadny riadok).
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    const { user, error: authError } = await verifyRequestUser(req, locale);
    if (authError || !user) {
      return Response.json({ success: false, error: authError }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as { confirmationId?: unknown } | null;

    // DIRECT CALL ochrana (bod 9 zadania) — bez platného confirmationId sa
    // appka ani nepokúsi nič vykonať. Žiadny fallback na intent+args.
    if (!isValidConfirmationId(body?.confirmationId)) {
      return Response.json(
        { success: false, error: translate(locale, "search.actions.confirmation.invalidOrExpired") },
        { status: 400 }
      );
    }
    const confirmationId = body!.confirmationId as string;

    const authorization = req.headers.get("authorization") || "";
    const accessToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const supabase = getUserScopedSupabaseClient(accessToken);

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

    const result = await executeAction(
      supabase,
      locale,
      {
        companyId: membership.company_id as string,
        userId: user.id,
        role: membership.role as CompanyMemberRole,
      },
      confirmationId
    );

    return Response.json({ success: true, result });
  } catch (error) {
    console.error(
      "api/assistant/action/execute: neočakávaná chyba:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      { success: false, error: translate(locale, "search.errors.generic") },
      { status: 500 }
    );
  }
}
