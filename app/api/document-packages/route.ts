import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import type { Locale } from "@/lib/i18n/locales";
import { translate } from "@/lib/i18n/translate";
import {
  buildDocumentPackage,
  loadFolderRefs,
  type DocumentPackageErrorCode,
  type PackageRef,
} from "@/lib/invoicing/document-package-server";
import {
  encodeExcludedHeader,
  isDocumentPackageKind,
  isPackageEntityType,
  DOCUMENT_PACKAGE_MAX_ENTRIES,
  type FolderManifestExcluded,
} from "@/lib/invoicing/document-package";

// =============================================================================
// POST /api/document-packages — ZIP s dokladmi A ICH ORIGINÁLMI.
//
// Vstup (JSON):
//   { kind: "folder", folderId }                       celý priečinok
//   { kind: "selection" | "inbox_selection", items }   výber [{type, id}]
//
// Výstup: ZIP + hlavičky
//   X-Esblu-Package-Id       — id záznamu v document_export_packages
//   X-Esblu-Package-Sha256   — odtlačok, ktorý klient porovná s prijatými bajtami
//   X-Esblu-Item-Count       — koľko dokladov v balíku NAOZAJ je
//   X-Esblu-Excluded         — ktoré sa vynechali a prečo (kódované)
//
// Tento endpoint NEZAPISUJE stiahnutie. Začatá odpoveď nie je doručená
// odpoveď. Klient po prijatí celých bajtov a overení odtlačku zavolá
// esblu_confirm_package_download() — až to je „Stiahnuté".
//
// Autorizácia: user-scoped klient (RLS) + explicitná kontrola finance.manage.
// Zamestnanec s podvrhnutým permissions JSON neprejde: esblu_my_finance_manage()
// pre rolu employee vracia false.
// =============================================================================

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(
  locale: Locale,
  status: number,
  code: DocumentPackageErrorCode,
  excluded?: FolderManifestExcluded[]
): Response {
  return Response.json(
    {
      code,
      error: translate(locale, `folders.package.errors.${code}`, { max: DOCUMENT_PACKAGE_MAX_ENTRIES }),
      ...(excluded ? { excluded: excluded.slice(0, 50) } : {}),
    },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);

  // 1. Vstup ------------------------------------------------------------------
  let kind: "folder" | "selection" | "inbox_selection";
  let folderId: string | null = null;
  let refs: PackageRef[] = [];
  try {
    const body = (await req.json()) as { kind?: unknown; folderId?: unknown; items?: unknown };
    if (!isDocumentPackageKind(body.kind)) throw new Error("kind");
    kind = body.kind;

    if (kind === "folder") {
      if (typeof body.folderId !== "string" || !UUID_RE.test(body.folderId)) throw new Error("folderId");
      folderId = body.folderId;
    } else {
      if (!Array.isArray(body.items)) throw new Error("items");
      if (body.items.length > DOCUMENT_PACKAGE_MAX_ENTRIES) {
        return errorResponse(locale, 422, "TOO_MANY_DOCUMENTS");
      }
      for (const raw of body.items) {
        if (!raw || typeof raw !== "object") continue;
        const { type, id } = raw as { type?: unknown; id?: unknown };
        if (!isPackageEntityType(type) || typeof id !== "string" || !UUID_RE.test(id)) continue;
        // Inbox export smie obsahovať iba dokumenty z Inboxu.
        if (kind === "inbox_selection" && type !== "document") continue;
        refs.push({ type, id });
      }
    }
  } catch {
    return errorResponse(locale, 400, "BAD_REQUEST");
  }

  // 2. Autorizácia -------------------------------------------------------------
  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) return errorResponse(locale, 401, "UNAUTHORIZED");

  const authorization = req.headers.get("authorization") ?? "";
  const accessToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!accessToken) return errorResponse(locale, 401, "UNAUTHORIZED");
  const db = getUserScopedSupabaseClient(accessToken);

  const [{ data: companyId }, { data: canManage }] = await Promise.all([
    db.rpc("esblu_my_active_company_id"),
    db.rpc("esblu_my_finance_manage"),
  ]);
  if (!companyId) return errorResponse(locale, 403, "NO_ACTIVE_COMPANY");
  if (canManage !== true) return errorResponse(locale, 403, "FORBIDDEN");

  if (kind === "folder" && folderId) {
    const folder = await loadFolderRefs(db, folderId);
    if (!folder) return errorResponse(locale, 404, "FOLDER_NOT_FOUND");
    refs = folder.refs;
  }

  // 3. Zloženie ----------------------------------------------------------------
  const result = await buildDocumentPackage({
    db,
    locale,
    companyId: String(companyId),
    userId: user.id,
    kind,
    folderId,
    refs,
  });

  if (!result.ok) return errorResponse(locale, result.status, result.code, result.excluded);

  return new Response(new Uint8Array(result.zipBytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Content-Length": String(result.zipBytes.byteLength),
      "X-Esblu-Package-Id": result.packageId,
      "X-Esblu-Package-Sha256": result.packageSha256,
      "X-Esblu-Manifest-Sha256": result.manifestSha256,
      "X-Esblu-Item-Count": String(result.manifest.entry_count),
      "X-Esblu-File-Count": String(result.manifest.file_count),
      "X-Esblu-Excluded-Count": String(result.manifest.excluded_count),
      "X-Esblu-Excluded": encodeExcludedHeader(result.manifest.excluded),
      "Access-Control-Expose-Headers":
        "Content-Disposition, X-Esblu-Package-Id, X-Esblu-Package-Sha256, X-Esblu-Item-Count, X-Esblu-File-Count, X-Esblu-Excluded-Count, X-Esblu-Excluded",
      "Cache-Control": "private, no-store",
    },
  });
}
