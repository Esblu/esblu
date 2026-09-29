import { verifyRequestUser } from "@/lib/server-auth";
import { getUserScopedSupabaseClient } from "@/lib/server-supabase-user-client";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import { translate } from "@/lib/i18n/translate";
import { isIntakeDocumentType, isOwnStoragePath, unsealIntakeExtraction, type IntakeExtraction } from "@/lib/intake-seal";
import { parseEntitlementDenial } from "@/lib/entitlements";
import { entitlementDenialResponse } from "@/lib/entitlements-server";
import {
  buildEvidenceIntakeInsert,
  buildEvidenceIntakePatch,
  buildIntakeExtractionPatch,
  buildIntakeInsert,
  evidenceIntakeInsertViolations,
  intakeInsertViolations,
  sanitizeReviewedDocumentFields,
  sanitizeReviewedEvidenceValues,
} from "@/lib/intake-document";
import {
  INTAKE_ATTEST_TTL_SECONDS,
  intakeAttestationSecret,
  sha256HexBytes,
  signIntakeAttestation,
  type IntakeAttestTarget,
} from "@/lib/intake-attest";

// =============================================================================
// POST /api/inbox/intake — príjem dokladu s REVIEW uploaderom (zamestnanec,
// admin bez finance.manage; vážny lístok zamestnanca). M1 produktová korekcia.
//
// Klient nahral fotku do vlastného priečinka v Storage (`<uid>/…`), videl
// vyťažené údaje SVOJHO dokladu, opravil/doplnil ich a potvrdil. Tu sa:
//   1. overí používateľ a firma (user-scoped klient, žiadny service_role),
//   2. overí, že cesta k súboru patrí volajúcemu,
//   3. rozšifruje pečať skenu (GCM, viazaná na používateľa, časovo obmedzená)
//      = serverom atestovaný AI návrh,
//   4. vloží riadok pod identitou volajúceho IBA v počiatočnom tvare príjmu
//      (RLS documents_insert_scoped vetva B / ai_evidence_insert_scoped
//      vetva I — bez údajov, needs_review; žiadny RETURNING),
//      a pripojí AI návrh podpísaným RPC (needs_review → extracted),
//   5. potvrdí používateľom skontrolované hodnoty potvrdzovacím RPC
//      (extracted → confirmed, audit AI → používateľ po poliach, aktér =
//      auth.uid()),
//   6. odpovie bez obsahu dokladu. Po potvrdení ho uploader už nevidí.
// =============================================================================

export const runtime = "nodejs";

/** Horná hranica originálu (rovnaký rád ako limit skenu). */
const MAX_INTAKE_FILE_BYTES = 15 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, message: string) {
  return Response.json({ success: false, error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

function text(value: unknown, max = 500): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
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

  const note = text(body.note, 1000);
  const secret = intakeAttestationSecret();
  const isEvidence = documentType === "delivery_note" || documentType === "weigh_ticket";
  const bucket = isEvidence ? "ai-evidence-documents" : "ai-inbox-documents";

  // Review: predvolene sa uloží ROZPRACOVANÝ príjem (extracted) — uploader ho
  // potvrdí neskôr cez potvrdzovacie RPC (obnoviteľné po páde appky).
  // confirm: true + reviewed = uloženie a potvrdenie v jednom kroku.
  const confirmNow = body.confirm === true;
  const reviewedEvidence = confirmNow && isEvidence ? sanitizeReviewedEvidenceValues(body.reviewed) : null;
  const reviewedFields = confirmNow && !isEvidence ? sanitizeReviewedDocumentFields(body.reviewed) : null;
  if (confirmNow && (isEvidence ? !reviewedEvidence : !reviewedFields)) {
    return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
  }
  const callerId = user.id;

  // ORIGINÁL: hash sa počíta z bajtov objektu v Storage (stiahnutého pod JWT
  // volajúceho — nikdy z hodnoty od klienta) a musí sa zhodovať s hashom
  // bajtov, ktoré server naskenoval (pečať). Tým AI návrh, review aj
  // potvrdenie patria k presne tomu istému súboru.
  const { data: storedBlob, error: downloadError } = await db.storage.from(bucket).download(storagePath);
  if (downloadError || !storedBlob) return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
  const storedBytes = new Uint8Array(await storedBlob.arrayBuffer());
  if (storedBytes.byteLength === 0 || storedBytes.byteLength > MAX_INTAKE_FILE_BYTES) {
    return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
  }
  const contentSha256 = sha256HexBytes(storedBytes);
  if (extraction && extraction.contentSha256 !== contentSha256) {
    // Iný súbor, než aký server naskenoval — AI návrh k nemu nepatrí.
    return fail(400, translate(locale, "assistant.intake.expired"));
  }

  // Vyťažené údaje zo ZAPEČATENÉHO skenu (pečať overená vyššie) sa pripoja
  // podpísaným RPC — stále pod identitou volajúceho (žiadny service_role).
  // DB ich prijme IBA s podpisom servera (HMAC v2, kľúč vo Vault, platnosť
  // 5 min, viazaný na tabuľku, riadok, auth.uid(), typ a presné bajty
  // údajov, jednorazový). Zlyhanie neruší odoslanie: doklad je v príjme,
  // iba bez predvyplnených polí.
  async function attachSigned(
    target: IntakeAttestTarget,
    rpc: "esblu_attach_intake_extraction" | "esblu_attach_evidence_intake_extraction",
    idArg: "p_document_id" | "p_evidence_id",
    rowId: string,
    kind: string,
    payload: unknown
  ) {
    if (!secret) {
      console.error("inbox/intake: ESBLU_INTAKE_ATTEST_SECRET chýba — doklad bez predvyplnených polí.");
      return false;
    }
    const payloadText = JSON.stringify(payload);
    const expiresAt = Math.floor(Date.now() / 1000) + INTAKE_ATTEST_TTL_SECONDS;
    if (!extraction) return false; // bez pečate niet atestovaného AI návrhu
    const { data: attached, error: attachError } = await db.rpc(rpc, {
      [idArg]: rowId,
      p_payload: payloadText,
      p_expires_at: expiresAt,
      p_signature: signIntakeAttestation({ target, rowId, userId: callerId, kind, contentSha256, expiresAt, payloadText, secret }),
    });
    if (attachError || attached !== true) {
      console.error("inbox/intake: vyťažené údaje sa nepodarilo pripojiť:", attachError?.code ?? "rejected");
      return false;
    }
    return true;
  }

  // 5) Potvrdenie UPLOADEROM (review): opravené/doplnené hodnoty → RPC,
  //    ktoré overí vlastníka, firmu, typ a atestovaný stav (extracted),
  //    zaeviduje opravy po poliach a nastaví confirmed. Aktér = auth.uid().
  async function confirmReviewed(
    rpc: "esblu_confirm_intake_document" | "esblu_confirm_evidence_intake",
    args: Record<string, unknown>
  ) {
    const { data: confirmed, error: confirmError } = await db.rpc(rpc, args);
    if (confirmError || confirmed !== true) {
      console.error("inbox/intake: potvrdenie sa nepodarilo:", confirmError?.code ?? "rejected");
      return false;
    }
    return true;
  }

  let confirmed = false;
  let reviewable = false;
  if (documentType === "delivery_note" || documentType === "weigh_ticket") {
    // 4a) INSERT dodacieho listu IBA v počiatočnom tvare príjmu (RLS
    //     ai_evidence_insert_scoped, vetva I): druh delivery_note, stav
    //     needs_review, vlastný súbor, BEZ akýchkoľvek údajov. company_id
    //     doplní trigger (esblu_enforce_plan_limit) z aktívnej firmy.
    const evidenceRow = buildEvidenceIntakeInsert({
      evidenceId: documentId,
      userId: user.id,
      photoPath: storagePath,
      documentTypeLabel: translate(locale, `inbox.documentTypes.${documentType}`),
      kind: documentType,
      contentSha256,
    });
    if (evidenceIntakeInsertViolations(evidenceRow, user.id).length > 0) {
      return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
    }
    const { error } = await db.from("ai_evidence").insert(evidenceRow);
    if (error) {
      const denial = parseEntitlementDenial(error);
      // Štruktúrovaná odpoveď — UI/hlas nemusia parsovať text. Nič sa neuložilo.
      if (denial) return entitlementDenialResponse(locale, denial);
      console.error("inbox/intake: dodací list sa nepodarilo uložiť:", error.code);
      return fail(500, translate(locale, "assistant.intake.failed"));
    }
    // 4b) AI návrh — podpísaný (needs_review → extracted).
    const attached = await attachSigned(
      "ai_evidence",
      "esblu_attach_evidence_intake_extraction",
      "p_evidence_id",
      documentId,
      documentType,
      buildEvidenceIntakePatch(extraction)
    );
    reviewable = attached;
    // 5) Potvrdenie uploaderom (extracted → confirmed) — iba ak ho klient žiada teraz.
    confirmed = attached && confirmNow && (await confirmReviewed("esblu_confirm_evidence_intake", {
      p_evidence_id: documentId,
      p_values: reviewedEvidence,
    }));
  } else {
    // 4a) INSERT pod identitou volajúceho — IBA minimálny tvar príjmu, ktorý
    //     RLS (documents_insert_scoped, vetva B) povolí aj zamestnancovi:
    //     typ faktúra/bloček, stav needs_review, BEZ vyťažených polí. Klient
    //     by rovnaký INSERT vedel spraviť aj priamo — preto v ňom nesmie byť
    //     nič, čo by mohol podvrhnúť.
    const row = buildIntakeInsert({
      documentId,
      userId: user.id,
      storagePath,
      documentType,
      originalFilename: text(body.originalFilename, 200),
      mimeType: text(body.mimeType, 100),
      fileSize: storedBytes.byteLength,
      contentSha256,
      note,
    });
    if (intakeInsertViolations(row, user.id).length > 0) return fail(400, translate(locale, "folders.package.errors.BAD_REQUEST"));
    const { error } = await db.from("documents").insert(row);
    if (error) {
      console.error("inbox/intake: doklad sa nepodarilo uložiť:", error.code);
      return fail(500, translate(locale, "assistant.intake.failed"));
    }
    // 4b) AI návrh — podpísaný (needs_review → extracted).
    const attached = await attachSigned(
      "documents",
      "esblu_attach_intake_extraction",
      "p_document_id",
      documentId,
      documentType,
      buildIntakeExtractionPatch(documentType, extraction)
    );
    reviewable = attached;
    // 5) Potvrdenie uploaderom (extracted → confirmed) — iba ak ho klient žiada teraz.
    confirmed = attached && confirmNow && (await confirmReviewed("esblu_confirm_intake_document", {
      p_document_id: documentId,
      p_fields: reviewedFields,
      p_note: note,
    }));
  }

  // Odpoveď bez obsahu dokladu. confirmed=false: doklad je v príjme
  // (needs_review/extracted) a dokončí ho finančný správca.
  if (!confirmed) {
    // Rozpracovaný review (extracted): klient ho dokončí potvrdzovacím RPC,
    // aj po páde appky (esblu_list_my_intake_reviews / esblu_get_my_intake_review).
    // Bez atestovaného návrhu (reviewable=false) doklad dokončí finančný správca.
    return Response.json(
      {
        success: true,
        confirmed: false,
        reviewable,
        review: reviewable ? { target: isEvidence ? "ai_evidence" : "documents", id: documentId } : null,
        message: translate(locale, reviewable ? "assistant.intake.reviewPending" : "assistant.intake.submitted"),
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  }

  return Response.json(
    { success: true, confirmed: true, message: translate(locale, "assistant.intake.confirmed") },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
