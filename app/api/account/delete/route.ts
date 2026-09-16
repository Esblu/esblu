import { verifyRequestUser } from "@/lib/server-auth";
import { getSupabaseAdmin } from "@/lib/supabase-admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import type { Locale } from "@/lib/i18n/locales";

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
//   2. Storage objekty firmy — vyčítané PRESNE z DB riadkov (storage_bucket +
//      storage_path/file_path/logo_path), zmazané cez Storage API, PRED
//      akoukoľvek DB zmenou (bezpečné zopakovať pri zlyhaní — remove() na už
//      zmazanej ceste nie je chyba).
//   3. DB časť (business tabuľky / company / memberships / settings / legal
//      acceptances) — JEDNA atomická transakcia cez SECURITY DEFINER RPC
//      (public.esblu_owner_delete_company / esblu_member_delete_self,
//      pozri 20260816100000).
//   4. auth.users zmazanie cez Admin API — VÝHRADNE posledný krok.
//   5. Ľahká nezávislá post-verifikácia (company_members riadok + auth
//      užívateľ skutočne zmizli).
//
// Ak ktorýkoľvek krok zlyhá, funkcia vyhodí výnimku → chytené v POST() →
// klientovi ide zrozumiteľná chyba (nikdy "success"), server-side log
// obsahuje Postgres error code/message (bez akýchkoľvek secretov).
// =============================================================================

type StorageTarget = { bucket: string; path: string };

async function collectOwnerStorageTargets(
  admin: SupabaseClient,
  companyId: string,
  ownerUserId: string
): Promise<StorageTarget[]> {
  const targets: StorageTarget[] = [];

  const [
    documentsRes,
    attachmentsRes,
    aiEvidenceRes,
    machinePhotosRes,
    inventoryPhotosRes,
    vehiclePhotosRes,
    settingsRes,
    billingProfileRes,
  ] = await Promise.all([
    admin
      .from("documents")
      .select("storage_bucket, storage_path")
      .eq("company_id", companyId),
    admin
      .from("document_attachments")
      .select("storage_bucket, storage_path")
      .eq("company_id", companyId),
    admin
      .from("ai_evidence")
      .select("photo_url")
      .eq("company_id", companyId)
      .not("photo_url", "is", null),
    admin
      .from("machine_photos")
      .select("file_path")
      .eq("company_id", companyId)
      .not("file_path", "is", null),
    admin
      .from("inventory_photos")
      .select("file_path")
      .eq("company_id", companyId)
      .not("file_path", "is", null),
    admin
      .from("vehicle_photos")
      .select("storage_path")
      .eq("company_id", companyId)
      .not("storage_path", "is", null),
    admin
      .from("settings")
      .select("logo_path")
      .eq("user_id", ownerUserId)
      .not("logo_path", "is", null),
    // Fáza 1B: company_billing_profile.logo_path je teraz JEDINÝ živý zdroj
    // aktuálneho firemného loga (settings.logo_path vyššie je legacy a od
    // tejto fázy doň appka už nezapisuje — pozri lib/company-billing-
    // profile.ts). Bez tohto riadku by zrušenie firmy nechalo osirelý
    // Storage objekt vždy, keď logo naposledy nahral/zmenil ADMIN (nie
    // owner) — company_billing_profile je company-scoped, nie user-scoped,
    // takže presne túto latentnú medzeru (predtým: logo nahraté adminom sa
    // pri zrušení firmy vôbec nekontrolovalo) zároveň opravuje.
    admin
      .from("company_billing_profile")
      .select("logo_path")
      .eq("company_id", companyId)
      .not("logo_path", "is", null),
  ]);

  for (const [label, res] of [
    ["documents", documentsRes],
    ["document_attachments", attachmentsRes],
    ["ai_evidence", aiEvidenceRes],
    ["machine_photos", machinePhotosRes],
    ["inventory_photos", inventoryPhotosRes],
    ["vehicle_photos", vehiclePhotosRes],
    ["settings", settingsRes],
    ["company_billing_profile", billingProfileRes],
  ] as const) {
    if (res.error) {
      throw new Error(
        `ESBLU_STORAGE_LOOKUP_FAILED:${label}:${res.error.code ?? ""}:${res.error.message}`
      );
    }
  }

  for (const row of documentsRes.data ?? []) {
    if (row.storage_bucket && row.storage_path) {
      targets.push({ bucket: row.storage_bucket, path: row.storage_path });
    }
  }

  for (const row of attachmentsRes.data ?? []) {
    if (row.storage_bucket && row.storage_path) {
      targets.push({ bucket: row.storage_bucket, path: row.storage_path });
    }
  }

  for (const row of aiEvidenceRes.data ?? []) {
    if (row.photo_url) {
      targets.push({ bucket: "ai-evidence-documents", path: row.photo_url });
    }
  }

  for (const row of machinePhotosRes.data ?? []) {
    if (row.file_path) {
      targets.push({ bucket: "machine-photos", path: row.file_path });
    }
  }

  for (const row of inventoryPhotosRes.data ?? []) {
    if (row.file_path) {
      targets.push({ bucket: "inventory-photos", path: row.file_path });
    }
  }

  for (const row of vehiclePhotosRes.data ?? []) {
    if (row.storage_path) {
      targets.push({ bucket: "vehicle-photos", path: row.storage_path });
    }
  }

  for (const row of settingsRes.data ?? []) {
    if (row.logo_path) {
      targets.push({ bucket: "company-logos", path: row.logo_path });
    }
  }

  for (const row of billingProfileRes.data ?? []) {
    if (row.logo_path) {
      targets.push({ bucket: "company-logos", path: row.logo_path });
    }
  }

  return targets;
}

async function collectMemberOwnStorageTargets(
  admin: SupabaseClient,
  userId: string
): Promise<StorageTarget[]> {
  // Admin/employee flow NIKDY nemaže firemné dáta/Storage — jediný Storage
  // objekt, ktorý mu môže patriť VÝHRADNE osobne, je jeho vlastný nahraný
  // logo súbor v jeho vlastnom (typicky prázdnom) settings riadku.
  const { data, error } = await admin
    .from("settings")
    .select("logo_path")
    .eq("user_id", userId)
    .not("logo_path", "is", null);

  if (error) {
    throw new Error(
      `ESBLU_STORAGE_LOOKUP_FAILED:settings:${error.code ?? ""}:${error.message}`
    );
  }

  return (data ?? [])
    .filter((row) => row.logo_path)
    .map((row) => ({ bucket: "company-logos", path: row.logo_path as string }));
}

async function removeStorageTargets(
  admin: SupabaseClient,
  targets: StorageTarget[]
): Promise<number> {
  const byBucket = new Map<string, string[]>();

  for (const target of targets) {
    const list = byBucket.get(target.bucket) ?? [];
    list.push(target.path);
    byBucket.set(target.bucket, list);
  }

  let removed = 0;

  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { data, error } = await admin.storage.from(bucket).remove(batch);

      if (error) {
        throw new Error(
          `ESBLU_STORAGE_REMOVE_FAILED:${bucket}:${error.message}`
        );
      }

      removed += data?.length ?? batch.length;
    }
  }

  return removed;
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
      let body: { confirmPhrase?: string } = {};

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

      const storageTargets = await collectOwnerStorageTargets(
        admin,
        membership.company_id,
        user.id
      );

      const storageRemovedCount = await removeStorageTargets(
        admin,
        storageTargets
      );

      const { data: dbSummary, error: rpcError } = await admin.rpc(
        "esblu_owner_delete_company",
        { p_owner_user_id: user.id }
      );

      if (rpcError) {
        console.error(
          "account/delete (owner): esblu_owner_delete_company zlyhalo:",
          rpcError.code,
          rpcError.message,
          rpcError.details,
          rpcError.hint
        );
        return Response.json(
          {
            error: translate(
              locale,
              "settings.errors.companyDeletionFailedRetry"
            ),
          },
          { status: 500 }
        );
      }

      const { error: deleteAuthError } =
        await admin.auth.admin.deleteUser(user.id);

      if (deleteAuthError) {
        // Granulárne, bezpečné (bez secretov) logovanie — .status/.code sú
        // štruktúrované info z GoTrue REST API (AuthApiError), nikdy
        // citlivé. Toto je JEDINÝ spôsob, ako z Vercel logov zistiť presnú
        // príčinu zlyhania deleteUser() (predtým sa logovala iba .message).
        console.error(
          "account/delete (owner): auth.admin.deleteUser zlyhalo:",
          JSON.stringify({
            userId: user.id,
            name: deleteAuthError.name,
            status: deleteAuthError.status,
            code: deleteAuthError.code,
            message: deleteAuthError.message,
          })
        );
        // partial=true: firemné dáta/DB časť je NEVRATNE zmazaná (RPC
        // uspela), ale auth.users účet ostáva existovať — klient MUSÍ na
        // tento flag reagovať vynúteným odhlásením (pozri
        // app/nastavenia/page.tsx confirmDeleteAccount()).
        return Response.json(
          {
            error: translate(
              locale,
              "settings.errors.companyDataDeletedButLoginRemained"
            ),
            partial: true,
          },
          { status: 500 }
        );
      }

      const { data: verifyUser } = await admin.auth.admin.getUserById(
        user.id
      );

      if (verifyUser?.user) {
        console.error(
          "account/delete (owner): post-verifikácia zlyhala — auth.users stále existuje po deleteUser().",
          JSON.stringify({ userId: user.id })
        );
        return Response.json(
          {
            error: translate(
              locale,
              "settings.errors.accountVerificationFailedContactSupport"
            ),
            partial: true,
          },
          { status: 500 }
        );
      }

      return Response.json({
        success: true,
        role: "owner",
        storageRemovedCount,
        dbSummary,
      });
    }

    // ADMIN / EMPLOYEE flow — firemné dáta sa nedotýkajú.
    const storageTargets = await collectMemberOwnStorageTargets(
      admin,
      user.id
    );

    const storageRemovedCount = await removeStorageTargets(
      admin,
      storageTargets
    );

    const { data: dbSummary, error: rpcError } = await admin.rpc(
      "esblu_member_delete_self",
      { p_user_id: user.id }
    );

    if (rpcError) {
      console.error(
        "account/delete (member): esblu_member_delete_self zlyhalo:",
        rpcError.code,
        rpcError.message,
        rpcError.details,
        rpcError.hint
      );
      return Response.json(
        {
          error: translate(locale, "settings.errors.deletionFailedRetry"),
        },
        { status: 500 }
      );
    }

    const { error: deleteAuthError } = await admin.auth.admin.deleteUser(
      user.id
    );

    if (deleteAuthError) {
      // Granulárne, bezpečné (bez secretov) logovanie — .status/.code sú
      // štruktúrované info z GoTrue REST API (AuthApiError), nikdy citlivé.
      // Toto je JEDINÝ spôsob, ako z Vercel logov zistiť presnú príčinu
      // zlyhania deleteUser() (predtým sa logovala iba .message).
      console.error(
        "account/delete (member): auth.admin.deleteUser zlyhalo:",
        JSON.stringify({
          userId: user.id,
          role: membership.role,
          name: deleteAuthError.name,
          status: deleteAuthError.status,
          code: deleteAuthError.code,
          message: deleteAuthError.message,
        })
      );
      // partial=true: membership/settings sú NEVRATNE zmazané (RPC uspela),
      // ale auth.users účet ostáva existovať — klient MUSÍ na tento flag
      // reagovať vynúteným odhlásením (pozri app/nastavenia/page.tsx
      // confirmDeleteAccount()), aby nezostala aktívna session pre už
      // odstránené členstvo.
      return Response.json(
        {
          error: translate(
            locale,
            "settings.errors.membershipDeletedButLoginRemained"
          ),
          partial: true,
        },
        { status: 500 }
      );
    }

    const { data: verifyUser } = await admin.auth.admin.getUserById(user.id);

    if (verifyUser?.user) {
      console.error(
        "account/delete (member): post-verifikácia zlyhala — auth.users stále existuje po deleteUser().",
        JSON.stringify({ userId: user.id, role: membership.role })
      );
      return Response.json(
        {
          error: translate(
            locale,
            "settings.errors.accountVerificationFailedContactSupport"
          ),
          partial: true,
        },
        { status: 500 }
      );
    }

    return Response.json({
      success: true,
      role: membership.role,
      storageRemovedCount,
      dbSummary,
    });
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
