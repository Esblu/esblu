import { verifyRequestUser } from "@/lib/server-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { findOwnerDeletionBlocker, type OwnerDeletionBlocker } from "@/lib/account-deletion-retention";

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

    const { data: membership, error: membershipError } = await admin
      .from("company_members")
      .select("role, company_id")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

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

    return Response.json({
      role: membership.role,
      otherActiveMembersCount,
      orphan: false,
      ownerDeletionBlocked,
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
