import { verifyRequestUser } from "@/lib/server-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { findOwnerDeletionBlocker, type OwnerDeletionBlocker } from "@/lib/account-deletion-retention";
import { checkSubscriptionForDeletion } from "@/lib/account-deletion-subscription";
import type { SubscriptionDeletionCheck } from "@/lib/billing/deletion-guard";
import { resolveActiveMembershipForUser } from "@/lib/active-membership-server";
import { requestSessionId } from "@/lib/request-session";

// Bez firmy (orphan) nie je čo účtovať.
const NO_SUBSCRIPTION: SubscriptionDeletionCheck = {
  can_delete: true,
  blocking_reason: null,
  subscription_status: "none",
  provider: null,
  managed_via: null,
  current_period_end: null,
  cancel_at_period_end: false,
  forfeits_remaining_period: false,
  store_subscription_notice: false,
};

// -----------------------------------------------------------------------------
// GET /api/account/preflight
//
// Read-only. Vracia aktívnu rolu prihláseného používateľa a — iba pre
// ownera — počet OSTATNÝCH aktívnych členov firmy, ktorí by zrušením
// ownerovho účtu stratili prístup. Slúži výhradne na to, aby confirmation
// modal v Nastaveniach mohol pred finálnym potvrdením zobraziť presné
// číslo (požiadavka: "zobraz počet ostatných členov firmy, ktorí stratia
// prístup" PRED finálnym zmazaním). Nič nemaže ani nemení.
//
// company_id/rola sa vždy odvodzujú zo servera (company_members podľa
// auth.uid() z overeného Bearer tokenu) — nikdy sa neprijímajú od klienta.
// -----------------------------------------------------------------------------

export async function GET(req: Request) {
  const locale = getRequestLocale(req);

  try {
    const { user, error: authError } = await verifyRequestUser(req, locale);

    if (authError || !user) {
      return Response.json({ error: authError }, { status: 401 });
    }

    const admin = getSupabaseAdmin();

    // Multi-company: aktívna firma zo servera (nie „prvé" členstvo).
    const { data: active, error: membershipError } = await resolveActiveMembershipForUser(admin, user.id, requestSessionId(req, user.id));
    const membership = active?.companyId && active.role ? { company_id: active.companyId, role: active.role } : null;
    const membershipCount = active?.activeMembershipCount ?? 0;

    // Globálny login: povolený iba bez vlastnených firiem (DB to overí znova).
    const { count: ownedCount, error: ownedError } = await admin
      .from("company_members")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "active")
      .eq("role", "owner");
    if (ownedError) {
      console.error("account/preflight: počet vlastnených firiem zlyhal:", ownedError.code);
      return Response.json({ error: translate(locale, "settings.errors.membershipVerifyFailed") }, { status: 500 });
    }
    const multi = {
      membershipCount,
      ownedCompanyCount: ownedCount ?? 0,
      // Akcia nad aktívnou firmou zruší aj login iba pri poslednej firme.
      deletesAccount: membershipCount <= 1,
      canDeleteGlobalAccount: (ownedCount ?? 0) === 0,
      companyId: membership?.company_id ?? null,
    };

    if (membershipError) {
      console.error(
        "account/preflight: načítanie membershipu zlyhalo:",
        membershipError.code,
        membershipError.message
      );
      return Response.json(
        { error: translate(locale, "settings.errors.membershipVerifyFailed") },
        { status: 500 }
      );
    }

    if (!membership && membershipCount > 0) {
      // 2+ firiem bez platnej aktívnej firmy → appka najprv ukáže výber firmy.
      return Response.json({
        role: null,
        otherActiveMembersCount: 0,
        orphan: false,
        needsCompanySelection: true,
        can_delete: false,
        blocking_reason: "ACTIVE_COMPANY_REQUIRED",
        subscription_status: NO_SUBSCRIPTION.subscription_status,
        subscription: NO_SUBSCRIPTION,
        ...multi,
      });
    }

    if (!membership) {
      // Orphan kontrola (bez novej RPC — priamy service-role SELECT):
      // auth.users existuje, žiadny aktívny company_members riadok. Pred
      // tým, než appka ponúkne samoobslužné zrušenie účtu, MUSÍ overiť, že
      // tento človek nie je owner_id žiadnej firmy (dátová anomália — napr.
      // pozostatok po neúplne dokončenom zrušení účtu) — inak by recovery
      // flow mohol obísť owner-only "ZRUŠIŤ FIRMU" potvrdzovací flow.
      const { data: ownedCompany, error: ownedCompanyError } = await admin
        .from("companies")
        .select("id")
        .eq("owner_id", user.id)
        .limit(1)
        .maybeSingle();

      if (ownedCompanyError) {
        console.error(
          "account/preflight: overenie owner_id zlyhalo:",
          ownedCompanyError.code,
          ownedCompanyError.message
        );
        return Response.json(
          { error: translate(locale, "settings.errors.membershipVerifyFailed") },
          { status: 500 }
        );
      }

      if (ownedCompany) {
        // Fail-closed: nikdy neponúkni recovery-delete owner_id-vlastníkovi
        // bez aktívneho membershipu — vyžaduje manuálne vyriešenie.
        console.error(
          "account/preflight: owner_id-anomália (companies.owner_id bez aktívneho company_members):",
          user.id
        );
        return Response.json(
          {
            error: translate(locale, "settings.errors.ownerWithoutMembership"),
          },
          { status: 409 }
        );
      }

      return Response.json({
        role: null,
        otherActiveMembersCount: 0,
        orphan: true,
        can_delete: true,
        blocking_reason: null,
        subscription_status: NO_SUBSCRIPTION.subscription_status,
        subscription: NO_SUBSCRIPTION,
        ...multi,
      });
    }

    let otherActiveMembersCount = 0;
    let ownerDeletionBlocked: OwnerDeletionBlocker | null = null;

    if (membership.role === "owner") {
      const { count, error: countError } = await admin
        .from("company_members")
        .select("id", { count: "exact", head: true })
        .eq("company_id", membership.company_id)
        .eq("status", "active")
        .neq("user_id", user.id);

      if (countError) {
        console.error(
          "account/preflight: počítanie ostatných členov zlyhalo:",
          countError.code,
          countError.message
        );
        return Response.json(
          {
            error: translate(
              locale,
              "settings.errors.otherMembersCountLoadFailed"
            ),
          },
          { status: 500 }
        );
      }

      otherActiveMembersCount = count ?? 0;

      // Firma s finalizovanými účtovnými dokladmi sa nedá zrušiť samoobslužne
      // (archivácia) — UI to vysvetlí a zrušenie vôbec neponúkne.
      ownerDeletionBlocked = await findOwnerDeletionBlocker(admin, membership.company_id);
    }

    // Predplatné (2026-10-12): firma s obnovujúcim sa / nedokončeným externým
    // predplatným sa nezruší, kým ho používateľ neukončí u providera
    // (lib/billing/deletion-guard.ts). Člen blokuje iba ako platiteľ cez obchod.
    const subscription = await checkSubscriptionForDeletion(admin, {
      companyId: membership.company_id,
      userId: user.id,
      scope: membership.role === "owner" ? "company" : "member",
      memberCanManageBilling: false, // billing = iba owner (20261012140000)
    });

    return Response.json({
      role: membership.role,
      otherActiveMembersCount,
      orphan: false,
      ownerDeletionBlocked,
      can_delete: !ownerDeletionBlocked && subscription.can_delete,
      blocking_reason: ownerDeletionBlocked ?? subscription.blocking_reason,
      subscription_status: subscription.subscription_status,
      subscription,
      ...multi,
    });
  } catch (error) {
    console.error(
      "account/preflight: neočakávaná chyba:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      { error: translate(locale, "settings.errors.deletionPreflightFailed") },
      { status: 500 }
    );
  }
}
