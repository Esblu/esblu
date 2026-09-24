import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { isIntakeDocumentType, isOwnStoragePath, unsealIntakeExtraction, type IntakeExtraction } from "@/lib/intake-seal";

// =============================================================================
// POST /api/inbox/intake — odoslanie finančného dokladu na spracovanie BEZ
// práva ho čítať (zamestnanec, admin bez financií).
//
// Klient už nahral fotku do vlastného priečinka v Storage (`<uid>/…`) a má
// zapečatený výsledok skenu z /api/scan-document. Tu sa:
//   1. overí používateľ a firma (user-scoped klient, žiadny service_role),
//   2. overí, že cesta k súboru patrí volajúcemu,
//   3. rozšifruje pečať (GCM, viazaná na používateľa, časovo obmedzená),
//   4. vloží dokument pod identitou volajúceho — RLS dovolí INSERT, ale
//      následné čítanie nie; preto žiadny RETURNING,
//   5. odpovie iba „odoslané". Žiadne sumy, dodávateľ ani číslo dokladu.
// =============================================================================

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, message: string) {
  return Response.json({ success: false, error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) return fail(401, translate(locale, "inbox.errors.notLoggedIn"));

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));

  const documentType = body.documentType;
  if (!isIntakeDocumentType(documentType)) return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
  if (!isOwnStoragePath(body.storagePath, user.id)) return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
  const storagePath = body.storagePath;
  const documentId = typeof body.documentId === "string" && UUID_RE.test(body.documentId) ? body.documentId : crypto.randomUUID();

  // Pečať je voliteľná (bez tajomstva na serveri doklad prejde bez údajov),
  // ale ak prišla, MUSÍ byť platná a patriť tomuto používateľovi a typu.
  let extraction: IntakeExtraction | null = null;
  if (typeof body.sealedExtraction === "string" && body.sealedExtraction) {
    extraction = unsealIntakeExtraction(body.sealedExtraction, user.id);
    if (!extraction || extraction.documentType !== documentType) {
      return fail(400, translate(locale, "assistant.intake.expired"));
    }
  }

  const accessToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const db = getUserScopedSupabaseClient(accessToken);
  const { data: companyId } = await db.rpc("esblu_my_active_company_id");
  if (!companyId) return fail(403, translate(locale, "folders.package.errors.NO_ACTIVE_COMPANY"));

  const fields = extraction?.fields ?? null;
  const note = text(body.note, 1000);

  if (documentType === "delivery_note") {
    const f = fields ?? {};
    const { error } = await db.from("ai_evidence").insert({
      company_id: companyId,
      user_id: user.id,
      evidence_kind: "delivery_note",
      document_type: translate(locale, "inbox.documentTypes.delivery_note"),
      spz: text(f.spz, 20),
      supplier: text(f.supplier),
      customer: text(f.customer),
      construction_site: text(f.constructionSite),
      document_number: text(f.documentNumber, 100),
      material: text(f.material),
      quantity: numberOrNull(f.quantity),
      unit: text(f.unit, 20),
      brutto: numberOrNull(f.brutto),
      tara: numberOrNull(f.tara),
      netto: numberOrNull(f.netto),
      document_date: text(f.documentDate, 20),
      document_time: text(f.documentTime, 20),
      source_location: text(f.sourceLocation),
      destination_location: text(f.destinationLocation),
      document_language: text(extraction?.documentLanguage, 10),
      confidence_score: numberOrNull(extraction?.confidenceScore),
      raw_text: text(extraction?.rawText, 20000),
      review_status: "needs_review",
      photo_url: storagePath,
    });
    if (error) {
      console.error("inbox/intake: dodací list sa nepodarilo uložiť:", error.code);
      return fail(500, translate(locale, "assistant.intake.failed"));
    }
  } else {
    const { error } = await db.from("documents").insert({
      id: documentId,
      user_id: user.id,
      storage_bucket: "ai-inbox-documents",
      storage_path: storagePath,
      original_filename: text(body.originalFilename, 200),
      mime_type: text(body.mimeType, 100),
      file_size: numberOrNull(body.fileSize),
      content_sha256: typeof body.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(body.contentSha256) ? body.contentSha256 : null,
      document_type: documentType,
      status: "needs_review",
      ai_raw_output: extraction
        ? {
            documentType,
            confidenceScore: extraction.confidenceScore,
            reviewStatus: extraction.reviewStatus,
            documentLanguage: extraction.documentLanguage,
            fieldConfidence: extraction.fieldConfidence,
            fields,
            intake: "sealed",
          }
        : { documentType, intake: "sealed", extraction: "unavailable" },
      extracted_fields: fields ?? {},
      field_confidence: extraction?.fieldConfidence ?? null,
      note,
    });
    if (error) {
      console.error("inbox/intake: doklad sa nepodarilo uložiť:", error.code);
      return fail(500, translate(locale, "assistant.intake.failed"));
    }
  }

  return Response.json(
    { success: true, message: translate(locale, "assistant.intake.submitted") },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
