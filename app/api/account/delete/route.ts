import { verifyRequestUser } from "@/lib/server-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { findOwnerDeletionBlocker } from "@/lib/account-deletion-retention";
import { checkSubscriptionForDeletion } from "@/lib/account-deletion-subscription";
import type { SubscriptionDeletionCheck } from "@/lib/billing/deletion-guard";
import type { Locale } from "@/lib/i18n/locales";
import { orchestrateAccountDeletion, type OrchestrationResult } from "@/lib/account-deletion-orchestrator";
import { supabaseDeletionDeps } from "@/lib/account-deletion-deps";

// =============================================================================
// POST /api/account/delete
//
// Server-side (service_role) samoobslužné zrušenie účtu. Rola a company_id
// prihláseného používateľa sa VŽDY znovu načítajú zo servera (company_members
// podľa auth.uid() z overeného Bearer tokenu) — nikdy sa nepoužívajú
// hodnoty poslané klientom.
//
// Poradie (spoločné pre oba flow, detaily nižšie vo funkciách):
//   1. server-side autorizácia + preflight (verifyRequestUser + znovu-
//      načítanie company_members riadku).
//   1b. owner: retention blocker + owner_id + PREDPLATNÉ (2026-10-12,
//      lib/billing/deletion-guard.ts) — obnovujúce sa / nedokončené externé
//      predplatné alebo otvorený checkout = 409 a nič sa nemaže. Zrušená obnova
//      s bežiacim obdobím = povolené iba s acknowledgeForfeit. DB trigger
//      (20261012120000) je poistka pre súbeh medzi precheckom a transakciou.
//   2. DB NAJPRV (2026-10-12): esblu_account_deletion_commit — JEDNA transakcia
//      (zámok firmy, zber Storage ciest z DB riadkov, esblu_owner_delete_company /
//      esblu_member_delete_self, cleanup job). Odmietnutie = rollback a ŽIADNY
//      Storage delete (lib/account-deletion-orchestrator.ts).
//   3. Až po commite: Storage objekty podľa jobu (remove() je idempotentné).
//   4. auth.users zmazanie cez Admin API + post-verifikácia.
//   5. Čo zlyhá v 3/4, ostáva v jobe pending → /api/cron/account-deletion-cleanup.
//
// Ak ktorýkoľvek krok zlyhá, funkcia vyhodí výnimku → chytené v POST() →
// klientovi ide zrozumiteľná chyba (nikdy "success"), server-side log
// obsahuje Postgres error code/message (bez akýchkoľvek secretov).
// =============================================================================


/**
 * Predplatné blokuje zrušenie (2026-10-12) — 409, NIČ sa nezmazalo (Storage
 * ani DB). Klient zobrazí, kde predplatné spravovať.
 */
function subscriptionBlockedResponse(locale: Locale, check: SubscriptionDeletionCheck): Response {
  return Response.json(
    {
      error: translate(
        locale,
        check.blocking_reason === "SUBSCRIPTION_STATE_UNVERIFIED"
          ? "settings.errors.subscriptionStateUnverified"
          : "settings.errors.subscriptionBlocksDeletion"
      ),
      can_delete: false,
      blocking_reason: check.blocking_reason,
      subscription_status: check.subscription_status,
      subscription: check,
    },
    { status: check.blocking_reason === "SUBSCRIPTION_STATE_UNVERIFIED" ? 503 : 409 }
  );
}

/** Výsledok orchestrácie (DB najprv → Storage → auth) → HTTP odpoveď. */
function orchestrationResponse(locale: Locale, role: string, result: OrchestrationResult): Response {
  const owner = role === "owner";
  switch (result.status) {
    case "blocked_subscription":
      // Súbeh: predplatné/checkout vzniklo medzi precheckom a transakciou.
      // DB transakcia sa vrátila a ŽIADNY súbor sa nezmazal.
      console.error("account/delete: DB subscription guard zastavil zrušenie:", result.code);
      return Response.json(
        {
          error: translate(locale, "settings.errors.subscriptionBlocksDeletion"),
          can_delete: false,
          blocking_reason: result.code.includes("CHECKOUT") ? "CHECKOUT_IN_PROGRESS" : "ACTIVE_SUBSCRIPTION_RENEWING",
        },
        { status: 409 }
      );
    case "db_failed":
      // Nič sa nezmenilo (rollback) a Storage sa nedotkol — bezpečne opakovateľné.
      console.error("account/delete: DB zrušenie zlyhalo:", result.code);
      return Response.json(
        { error: translate(locale, owner ? "settings.errors.companyDeletionFailedRetry" : "settings.errors.deletionFailedRetry") },
        { status: 500 }
      );
    case "auth_failed":
      // DB je commitnutá (nevratné); auth cleanup ostáva v jobe na retry.
      // partial=true → klient vynúti odhlásenie (app/nastavenia confirmDeleteAccount).
      console.error("account/delete: auth cleanup ostal pending:", result.code);
      return Response.json(
        {
          error: translate(
            locale,
            result.code === "ESBLU_AUTH_VERIFY_FAILED"
              ? "settings.errors.accountVerificationFailedContactSupport"
              : owner
                ? "settings.errors.companyDataDeletedButLoginRemained"
                : "settings.errors.membershipDeletedButLoginRemained"
          ),
          partial: true,
        },
        { status: 500 }
      );
    case "deleted":
      return Response.json({
        success: true,
        role,
        storageRemovedCount: result.storageRemoved,
        // Súbory, ktoré sa nepodarilo zmazať, dočistí retry (cron) — účet je zrušený.
        cleanupPending: result.cleanupPending,
        dbSummary: result.summary,
      });
  }
}

// -----------------------------------------------------------------------------
// Orphan recovery — BEZ novej SECURITY DEFINER RPC. Rieši stav, kedy
// auth.users existuje, ale volajúci nemá žiadny aktívny company_members
// riadok (napr. pozostatok po skôr neúplne dokončenom zrušení účtu — pozri
// "partial" vetvy nižšie v owner/member flow). company_members samotný sa
// tu už nedá znovu skontrolovať (volajúci ho poslednýkrát mal, keď sa
// dostal do tohto stavu), takže jediná ďalšia fail-closed poistka pred
// akoukoľvek deštruktívnou akciou je: over, že tento človek nie je
// owner_id ŽIADNEJ firmy (companies.owner_id) — inak by táto vetva mohla
// obísť owner-only "ZRUŠIŤ FIRMU" potvrdzovací flow. Ak je čokoľvek
// nejednoznačné, funkcia ZLYHÁ (fail-closed), nikdy nepokračuje.
//
// Poradie (odlišné od owner/member flow vyššie — orphan nemá žiadne
// company-scoped dáta, ktoré treba pred zmazaním ochrániť):
//   1. over, že nie je owner_id žiadnej firmy (fail-closed, 409 ak je),
//   2. auth.admin.deleteUser() — PRVÝ a JEDINÝ deštruktívny krok. Ak zlyhá,
//      NIČ ĎALŠIE sa nemaže — bezpečne opakovateľná chyba (žiadny partial
//      stav, lebo nič sa ešte nezmenilo),
//   3. post-verifikácia (getUserById),
//   4. best-effort dočistenie osirelého public.settings riadku (service-role
//      DELETE, žiadna nová RPC). user_legal_acceptances a company_members sa
//      NEMAŽÚ ručne — FK audit potvrdil ON DELETE CASCADE z auth.users pre
//      obe tabuľky, takže zaniknú automaticky pri kroku 2.
// -----------------------------------------------------------------------------
async function handleOrphanDelete(
  admin: SupabaseClient,
  userId: string,
  locale: Locale
): Promise<Response> {
  const { data: ownedCompany, error: ownedCompanyError } = await admin
    .from("companies")
    .select("id")
    .eq("owner_id", userId)
    .limit(1)
    .maybeSingle();

  if (ownedCompanyError) {
    console.error(
      "account/delete (orphan): overenie owner_id zlyhalo:",
      ownedCompanyError.code,
      ownedCompanyError.message
    );
    return Response.json(
      { error: translate(locale, "settings.errors.membershipVerifyFailed") },
      { status: 500 }
    );
  }

  if (ownedCompany) {
    // Fail-closed: owner_id-anomália (owner bez aktívneho membershipu) sa
    // NIKDY nesmie vyriešiť touto zjednodušenou vetvou — vyžaduje manuálne
    // vyriešenie/podporu, nie automatické zmazanie.
    console.error(
      "account/delete (orphan): owner_id-anomália (companies.owner_id bez aktívneho company_members):",
      userId
    );
    return Response.json(
      {
        error: translate(locale, "settings.errors.ownerWithoutMembership"),
      },
      { status: 409 }
    );
  }

  // Genuine non-owner orphan potvrdený — auth.admin.deleteUser() je prvý a
  // jediný deštruktívny krok.
  const { error: deleteAuthError } = await admin.auth.admin.deleteUser(
    userId
  );

  if (deleteAuthError) {
    console.error(
      "account/delete (orphan): auth.admin.deleteUser zlyhalo:",
      JSON.stringify({
        userId,
        name: deleteAuthError.name,
        status: deleteAuthError.status,
        code: deleteAuthError.code,
        message: deleteAuthError.message,
      })
    );
    // NIE partial — nič sa ešte nezmenilo (membership už predtým
    // neexistoval, toto bol jediný pokus o zmazanie) — bezpečne
    // opakovateľná chyba.
    return Response.json(
      {
        error: translate(locale, "settings.errors.deletionFailedRetry"),
      },
      { status: 500 }
    );
  }

  const { data: verifyUser } = await admin.auth.admin.getUserById(userId);

  if (verifyUser?.user) {
    console.error(
      "account/delete (orphan): post-verifikácia zlyhala — auth.users stále existuje po deleteUser().",
      JSON.stringify({ userId })
    );
    return Response.json(
      {
        error: translate(
          locale,
          "settings.errors.accountVerificationFailedContactSupport"
        ),
      },
      { status: 500 }
    );
  }

  // auth.users je už nenávratne zmazaný. Dočistenie osirelého settings
  // riadku je "best effort" — jeho prípadné zlyhanie sa loguje pre podporu,
  // ale klientovi sa napriek tomu vráti success (session sa musí ukončiť
  // bez ohľadu naň, auth účet skutočne zanikol).
  const { error: settingsCleanupError, count: settingsRemovedCount } =
    await admin
      .from("settings")
      .delete({ count: "exact" })
      .eq("user_id", userId);

  if (settingsCleanupError) {
    console.error(
      "account/delete (orphan): dočistenie settings zlyhalo (auth.users už zmazaný):",
      JSON.stringify({
        userId,
        code: settingsCleanupError.code,
        message: settingsCleanupError.message,
      })
    );
  }

  return Response.json({
    success: true,
    role: null,
    orphan: true,
    storageRemovedCount: 0,
    dbSummary: {
      settings: settingsCleanupError ? null : (settingsRemovedCount ?? 0),
    },
  });
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  try {
    const { user, error: authError } = await verifyRequestUser(req, locale);

    if (authError || !user) {
      return Response.json({ error: authError }, { status: 401 });
    }

    const admin = getSupabaseAdmin();

    const { data: membership, error: membershipError } = await admin
      .from("company_members")
      .select("role, company_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    if (membershipError) {
      console.error(
        "account/delete: načítanie membershipu zlyhalo:",
        membershipError.code,
        membershipError.message
      );
      return Response.json(
        {
          error: translate(locale, "settings.errors.companyMembershipLoadFailed"),
        },
        { status: 500 }
      );
    }

    if (!membership) {
      return handleOrphanDelete(admin, user.id, locale);
    }

    if (membership.role === "owner") {
      let body: { confirmPhrase?: string; acknowledgeForfeit?: boolean } = {};

      try {
        body = await req.json();
      } catch {
        body = {};
      }

      if (body.confirmPhrase !== "ZRUŠIŤ FIRMU") {
        return Response.json(
          { error: translate(locale, "settings.errors.confirmPhraseMismatch") },
          { status: 400 }
        );
      }

      // PRED akýmkoľvek mazaním (Storage aj DB): firma s finalizovanými
      // účtovnými dokladmi sa samoobslužne zrušiť nedá. Chyba overenia →
      // fail closed (nič sa nezmaže).
      let blocker: Awaited<ReturnType<typeof findOwnerDeletionBlocker>>;
      try {
        blocker = await findOwnerDeletionBlocker(admin, membership.company_id);
      } catch (retentionError) {
        console.error(
          "account/delete (owner): overenie archivácie zlyhalo:",
          retentionError instanceof Error ? retentionError.message : retentionError
        );
        return Response.json(
          { error: translate(locale, "settings.errors.companyDeletionFailedRetry") },
          { status: 500 }
        );
      }
      if (blocker) {
        return Response.json(
          { error: translate(locale, "settings.deleteModal.ownerBlockedRetention"), blocked: blocker },
          { status: 409 }
        );
      }

      // RC 2026-10-12: rovnaká podmienka ako ESBLU_OWNER_MISMATCH v
      // esblu_owner_delete_company — overená PRED mazaním súborov, aby DB
      // odmietnutie nenastalo až po odstránení Storage objektov.
      const { data: ownedCompany, error: ownerCheckError } = await admin
        .from("companies")
        .select("owner_id")
        .eq("id", membership.company_id)
        .maybeSingle();
      if (ownerCheckError) {
        console.error(
          "account/delete (owner): overenie owner_id zlyhalo:",
          ownerCheckError.code
        );
        return Response.json(
          { error: translate(locale, "settings.errors.companyDeletionFailedRetry") },
          { status: 500 }
        );
      }
      if (!ownedCompany || ownedCompany.owner_id !== user.id) {
        console.error("account/delete (owner): owner_id nesúhlasí s rolou owner — zastavené pred mazaním");
        return Response.json(
          { error: translate(locale, "settings.errors.ownerWithoutMembership") },
          { status: 409 }
        );
      }

      // Predplatné: overené PRED mazaním súborov aj DB. Obnovujúce sa /
      // nedokončené externé predplatné = 409, nič sa nemaže (fail closed).
      const subscriptionCheck = await checkSubscriptionForDeletion(admin, {
        companyId: membership.company_id,
        userId: user.id,
        scope: "company",
      });
      if (!subscriptionCheck.can_delete) {
        return subscriptionBlockedResponse(locale, subscriptionCheck);
      }

      // Zrušená obnova, ale zaplatené obdobie ešte beží: zrušenie je povolené,
      // ale iba s výslovným potvrdením straty zvyšku obdobia (texty: LEGAL/CLIA
      // REVIEW REQUIRED). Žiadny automatický refund.
      if (subscriptionCheck.forfeits_remaining_period && body.acknowledgeForfeit !== true) {
        return Response.json(
          {
            error: translate(locale, "settings.errors.forfeitAcknowledgementRequired"),
            can_delete: true,
            blocking_reason: "FORFEIT_ACKNOWLEDGEMENT_REQUIRED",
            subscription_status: subscriptionCheck.subscription_status,
            subscription: subscriptionCheck,
          },
          { status: 409 }
        );
      }

      // DB NAJPRV (2026-10-12): Storage sa maže až po úspešnom commite
      // (lib/account-deletion-orchestrator.ts). Odmietnutie DB = žiadny súbor
      // sa nezmaže.
      const ownerResult = await orchestrateAccountDeletion(
        supabaseDeletionDeps(admin, { companyId: membership.company_id }),
        "owner",
        user.id
      );
      return orchestrationResponse(locale, "owner", ownerResult);
    }

    // ADMIN / EMPLOYEE / ACCOUNTANT flow — firemné dáta ani predplatné firmy sa
    // nedotýkajú. Blokácia člena iba pri OVERENEJ identite platiteľa (dnes ju
    // architektúra nepozná — store účet je viazaný na firmu, nie osobu).
    const memberSubscriptionCheck = await checkSubscriptionForDeletion(admin, {
      companyId: membership.company_id,
      userId: user.id,
      scope: "member",
      memberCanManageBilling: membership.role === "admin",
    });
    if (!memberSubscriptionCheck.can_delete) {
      return subscriptionBlockedResponse(locale, memberSubscriptionCheck);
    }

    const memberResult = await orchestrateAccountDeletion(
      supabaseDeletionDeps(admin, { companyId: membership.company_id }),
      "member",
      user.id
    );
    return orchestrationResponse(locale, membership.role, memberResult);
  } catch (error) {
    console.error(
      "account/delete: neočakávaná chyba:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      {
        error: translate(
          locale,
          "settings.errors.deletionFailedNothingConfirmed"
        ),
      },
      { status: 500 }
    );
  }
}
