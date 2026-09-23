import { createHash } from "node:crypto";
import JSZip from "jszip";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { verifyRequestUser } from "@/lib/server-auth";
import { getRequestLocale } from "@/lib/i18n/request-locale";
import type { Locale } from "@/lib/i18n/locales";
import { translate, translateWithFallback } from "@/lib/i18n/translate";
import {
  handoffErrorCode,
  handoffErrorKey,
  HANDOFF_GENERIC_ERROR_KEY,
  type HandoffErrorCode,
} from "@/lib/invoicing/handoff-errors";
import { renderInvoicePdfBuffer } from "@/lib/invoicing/pdf-renderer";
import {
  buildManifest,
  directionFolder,
  eligibilityProblems,
  invoiceFolderName,
  isSafeZipPath,
  packageFileName,
  packageProblems,
  packageRootFolder,
  safeExtension,
  safeSegment,
  MANIFEST_DISCLAIMER,
  MANIFEST_SCHEMA_VERSION,
  PACKAGE_LIMITS,
  type ManifestFile,
  type ManifestInvoice,
} from "@/lib/invoicing/handoff-package";
import type {
  Invoice,
  InvoiceItem,
  InvoiceParty,
  InvoiceTaxBreakdown,
} from "@/lib/invoices";

// =============================================================================
// POST /api/accounting-handoff/package — úplný balík pre účtovníka.
//
// ČO ROBÍ
// -------
// Zozbiera doklady, ich originály, PDF a prílohy, zabalí ich do ZIP-u s
// manifestom a odtlačkami, overí výsledok a zapíše záznam o odovzdaní.
// Až potom balík vráti. Poradie je podstatné a je v ňom celý zmysel:
//
//   zozbieraj → over → zabal → prekontroluj → zapíš → odovzdaj
//
// Keď čokoľvek z požadovaného chýba alebo sa nedá prečítať, vznikne záznam
// so stavom `failed` a dôvodom — NIE `complete_handoff`. Polovičný úspech
// vydávaný za odovzdanie by bol horší než žiadne odovzdanie, lebo na
// `complete_handoff` sa má raz viazať odstránenie prevádzkovej kópie.
//
// ČO TENTO ENDPOINT DOKÁŽE A ČO NIE
// ----------------------------------
// Dokáže: balík sa zložil, overil, spočítali sa odtlačky a odpoveď začala
// odchádzať. To je všetko, a preto sa do databázy zapisuje presne to.
//
// NEDOKÁŽE: či sa súbor v prehliadači naozaj uložil, či sa prenos dokončil,
// a už vôbec nie, či ho niekto poslal účtovníkovi. Server o tom nemá ako
// vedieť — HTTP odpoveď sa môže prerušiť kedykoľvek po odoslaní hlavičiek a
// klient to serveru spoľahlivo neoznámi.
//
// Preto sa stav volá „balík vytvorený", nie „doklady odovzdané". Tvrdiť
// prevzatie, ktoré Esblu nevie doložiť, by bolo to isté ako tvrdiť ho o
// stiahnutom zošite — chyba, ktorú tento projekt už raz opravoval.
//
// PREČO SA BALÍK NEUKLADÁ
// -----------------------
// ZIP sa vracia priamo a nikde sa neukladá. Uložiť ho by znamenalo nový
// bucket, nové RLS politiky, podpísané odkazy a otázku, ako dlho tam kópia
// všetkých dokladov firmy má ležať — čo je presne tá otázka o dlhodobom
// uchovávaní, na ktorú Esblu odpoveď nemá a mať nechce. Dôkazom je záznam
// s odtlačkami, nie uložená kópia.
//
// AUTORIZÁCIA
// -----------
// User-scoped Supabase klient, nikdy service_role. RLS na invoices,
// invoice_items, invoice_parties, invoice_tax_breakdowns, documents,
// document_links, document_attachments aj Storage vynucuje company_id a
// finance scope pre každý jeden dotaz. Explicitné RPC kontroly nižšie sú
// DRUHÁ nezávislá vrstva, nie náhrada.
//
// Vytvorenie balíka vyžaduje finance.manage, nie iba finance.view. Je to
// zápis do evidencie odovzdania a vynáša kópie dokladov z Esblu von.
// =============================================================================

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prevádzkové prílohy do účtovného balíka nepatria. */
const ACCOUNTING_BUCKETS = new Set(["ai-inbox-documents", "ai-evidence-documents"]);

type DocumentRow = {
  id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size: number | null;
  content_sha256: string | null;
  deleted_at: string | null;
};

type AttachmentRow = {
  id: string;
  document_id: string;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  file_size: number | null;
};

/**
 * Odpoveď s chybou.
 *
 * ČO IDE VON A ČO NIE
 * -------------------
 * Von ide strojový kód a preložená veta pre človeka. NIKDY nie hlásenie z
 * databázy, cesta v úložisku, názov objektu, id dokumentu ani stack trace —
 * to všetko patrí do serverového logu, kam sa používateľ nepozerá a útočník
 * tiež nie.
 *
 * `reason` a `invoice_id` sa v odpovedi zámerne NEVRACAJÚ. Vnútorný dôvod je
 * podrobnejší než kód a jeho jediný účel je hľadanie chyby v logu.
 */
function errorResponse(
  locale: Locale,
  status: number,
  code: HandoffErrorCode,
  vars?: Record<string, string | number>,
  extra?: Record<string, unknown>
): Response {
  return Response.json(
    {
      code,
      error: translateWithFallback(locale, handoffErrorKey(code), HANDOFF_GENERIC_ERROR_KEY, vars),
      ...extra,
    },
    { status, headers: { "Cache-Control": "private, no-store" } }
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function POST(req: Request) {
  const locale = getRequestLocale(req);
  const failed = (code: HandoffErrorCode, extra?: Record<string, unknown>, vars?: Record<string, string | number>) =>
    errorResponse(locale, 422, code, vars, extra);

  // ---------------------------------------------------------------------------
  // 1. Vstup
  // ---------------------------------------------------------------------------
  let invoiceIds: string[];
  let note: string | null = null;
  try {
    const body = (await req.json()) as { invoiceIds?: unknown; note?: unknown };
    if (!Array.isArray(body.invoiceIds)) throw new Error("invoiceIds");
    invoiceIds = Array.from(
      new Set(body.invoiceIds.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))
    );
    if (typeof body.note === "string" && body.note.trim()) note = body.note.trim().slice(0, 500);
  } catch {
    return errorResponse(locale, 400, "BAD_REQUEST");
  }

  if (invoiceIds.length === 0) {
    return errorResponse(locale, 400, "NO_DOCUMENTS_SELECTED");
  }
  if (invoiceIds.length > PACKAGE_LIMITS.maxInvoices) {
    return failed("TOO_MANY_INVOICES", undefined, { max: PACKAGE_LIMITS.maxInvoices });
  }

  // ---------------------------------------------------------------------------
  // 2. Autorizácia
  // ---------------------------------------------------------------------------
  const { user, error: authError } = await verifyRequestUser(req, locale);
  if (authError || !user) {
    return errorResponse(locale, 401, "UNAUTHORIZED");
  }

  const accessToken = (req.headers.get("authorization") ?? "").slice("Bearer ".length).trim();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !accessToken) {
    console.error("handoff/package: chýba Supabase konfigurácia alebo token.");
    return errorResponse(locale, 500, "INTERNAL_ERROR");
  }

  const db: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  const [{ data: companyId }, { data: canManage }] = await Promise.all([
    db.rpc("esblu_my_active_company_id"),
    db.rpc("esblu_my_finance_manage"),
  ]);

  if (!companyId) return errorResponse(locale, 403, "NO_ACTIVE_COMPANY");
  if (!canManage) return errorResponse(locale, 403, "FORBIDDEN");

  // ---------------------------------------------------------------------------
  // 3. Zber. Každý dotaz beží pod RLS ako prihlásený používateľ.
  // ---------------------------------------------------------------------------
  const { data: invoiceRows, error: invoiceError } = await db
    .from("invoices")
    .select("*")
    .in("id", invoiceIds)
    .order("issue_date", { ascending: true })
    .returns<Invoice[]>();

  if (invoiceError) {
    console.error("handoff/package: načítanie faktúr zlyhalo:", invoiceError.code);
    return errorResponse(locale, 500, "INTERNAL_ERROR");
  }

  // Cudzia firma sa sem cez RLS nedostane; explicitný filter je druhá vrstva.
  const invoices = (invoiceRows ?? []).filter((i) => i.company_id === companyId);
  if (invoices.length === 0) {
    return errorResponse(locale, 404, "NO_DOCUMENTS_SELECTED");
  }

  const ids = invoices.map((i) => i.id);

  const [itemsRes, partiesRes, taxRes, linksRes] = await Promise.all([
    db.from("invoice_items").select("*").in("invoice_id", ids)
      .order("position", { ascending: true }).returns<InvoiceItem[]>(),
    db.from("invoice_parties").select("*").in("invoice_id", ids).returns<InvoiceParty[]>(),
    db.from("invoice_tax_breakdowns").select("*").in("invoice_id", ids)
      .returns<InvoiceTaxBreakdown[]>(),
    db.from("document_links").select("document_id, invoice_id").in("invoice_id", ids)
      .returns<{ document_id: string; invoice_id: string }[]>(),
  ]);

  if (itemsRes.error || partiesRes.error || taxRes.error || linksRes.error) {
    console.error("handoff/package: načítanie súvisiacich záznamov zlyhalo.");
    return errorResponse(locale, 500, "INTERNAL_ERROR");
  }

  const itemsByInvoice = groupBy(itemsRes.data ?? [], (x) => x.invoice_id);
  const partiesByInvoice = groupBy(partiesRes.data ?? [], (x) => x.invoice_id);
  const taxByInvoice = groupBy(taxRes.data ?? [], (x) => x.invoice_id);

  // ---------------------------------------------------------------------------
  // ČO JE ORIGINÁL A ČO JE LEN PRÍLOHA
  //
  // `invoices.source_document_id` je JEDINÝ zdroj originálu prijatého dokladu.
  // Je to ten súbor, ktorý prišiel od dodávateľa a z ktorého doklad vznikol.
  //
  // `document_links` je niečo iné: ľubovoľné účtovné prepojenie dokumentu na
  // doklad. Môže tam byť dodací list, potvrdenie o úhrade, druhý sken. Také
  // dokumenty do balíka patria — ale ako SPRIEVODNÉ, pod vlastným menom.
  //
  // Predtým sa originál hľadal iba cez `document_links` a stačila existencia
  // akéhokoľvek prepojeného dokumentu. Prijatá faktúra bez originálu, ale s
  // pripnutým potvrdením o úhrade, by tak prešla ako úplne odovzdaná — a
  // účtovník by dostal balík bez jediného dokladu od dodávateľa. To je presne
  // tá zámena, ktorá sa stať nesmie.
  // ---------------------------------------------------------------------------
  const originalDocIdByInvoice = new Map<string, string>();
  for (const invoice of invoices) {
    if (invoice.source_document_id) originalDocIdByInvoice.set(invoice.id, invoice.source_document_id);
  }

  const supportingDocsByInvoice = new Map<string, string[]>();
  for (const link of linksRes.data ?? []) {
    // Originál sa medzi sprievodné dokumenty nezaradí, aj keď je naň aj link.
    if (originalDocIdByInvoice.get(link.invoice_id) === link.document_id) continue;
    supportingDocsByInvoice.set(link.invoice_id, [
      ...(supportingDocsByInvoice.get(link.invoice_id) ?? []),
      link.document_id,
    ]);
  }

  const allDocIds = Array.from(
    new Set([
      ...originalDocIdByInvoice.values(),
      ...Array.from(supportingDocsByInvoice.values()).flat(),
    ])
  );

  let documents: DocumentRow[] = [];
  let attachments: AttachmentRow[] = [];
  if (allDocIds.length > 0) {
    const [docRes, attRes] = await Promise.all([
      db.from("documents")
        .select("id, storage_bucket, storage_path, original_filename, mime_type, file_size, content_sha256, deleted_at")
        .in("id", allDocIds).returns<DocumentRow[]>(),
      db.from("document_attachments")
        .select("id, document_id, storage_bucket, storage_path, original_filename, mime_type, file_size")
        .in("document_id", allDocIds).returns<AttachmentRow[]>(),
    ]);
    if (docRes.error || attRes.error) {
      console.error("handoff/package: načítanie dokumentov/príloh zlyhalo.");
      return errorResponse(locale, 500, "INTERNAL_ERROR");
    }
    documents = (docRes.data ?? []).filter((d) => !d.deleted_at);
    attachments = attRes.data ?? [];
  }

  const documentById = new Map(documents.map((d) => [d.id, d]));
  const attachmentsByDoc = groupBy(attachments, (a) => a.document_id);

  // ---------------------------------------------------------------------------
  // 4. Kto do balíka ide, kto sa vynechá a kto ho zastaví
  //
  // Sú to TRI rôzne veci a miešať ich bola chyba.
  //
  //   koncept          → vynechá sa a povie sa to
  //   pokazený doklad  → zastaví celý balík
  //   ostatné          → zabalí sa
  //
  // Koncept nie je pokazený doklad. Je to rozpracovaná vec, ktorá do
  // účtovníctva ešte nepatrí. Keby kvôli nemu zlyhal celý balík, používateľ
  // by nedostal ani tie doklady, ktoré sú v poriadku — a jediné riešenie by
  // bolo koncept zmazať. To je zlá rada.
  //
  // Doklad, ktorý si protirečí alebo ktorému chýba originál, je iná vec.
  // Ten balík zastaví, lebo ticho vynechaný účtovný doklad by bol horší než
  // žiadny balík.
  // ---------------------------------------------------------------------------
  const DRAFT_ONLY_PROBLEMS = new Set(["not_finalized", "missing_invoice_number"]);

  const eligible: Invoice[] = [];
  const excludedDrafts: { invoice_id: string; label: string }[] = [];
  const rejected: { invoice_id: string; label: string; problems: string[] }[] = [];

  for (const invoice of invoices) {
    const label = invoice.invoice_number ?? invoice.supplier_invoice_number ?? invoice.id;
    const problems = eligibilityProblems({
      invoice,
      itemCount: (itemsByInvoice.get(invoice.id) ?? []).length,
      // IBA kanonický originál. Sprievodné dokumenty sa sem nezapočítavajú.
      hasOriginalDocument: Boolean(
        documentById.get(originalDocIdByInvoice.get(invoice.id) ?? "")
      ),
    });

    if (problems.length === 0) {
      eligible.push(invoice);
      continue;
    }

    // Bežný koncept: iba chýbajúca finalizácia (a s ňou číslo dokladu).
    if (invoice.document_status === "draft" && problems.every((p) => DRAFT_ONLY_PROBLEMS.has(p))) {
      excludedDrafts.push({ invoice_id: invoice.id, label });
      continue;
    }

    rejected.push({ invoice_id: invoice.id, label, problems });
  }

  if (rejected.length > 0) {
    // Zámerne sa NEZAPISUJE záznam `failed`: nič sa nezačalo vyrábať, iba sa
    // zistilo, že výber je nevhodný. Zapisovať zlyhanie za zle zvolený filter
    // by zahltilo históriu odovzdaní šumom.
    return failed("NOT_ELIGIBLE", { rejected, excludedDrafts });
  }

  // Samé koncepty. Prázdny „hotový" balík by tvrdil, že sa niečo odovzdalo.
  if (eligible.length === 0) {
    return failed("NO_FINALIZED_DOCUMENTS", { excludedDrafts, eligibleCount: 0 });
  }

  // ---------------------------------------------------------------------------
  // 5. Artefakty
  // ---------------------------------------------------------------------------
  const exportId = crypto.randomUUID();
  const generatedAt = new Date();
  const fileName = packageFileName(generatedAt);
  const root = packageRootFolder(fileName);

  const files: ManifestFile[] = [];
  const manifestInvoices: ManifestInvoice[] = [];
  const payloads = new Map<string, Uint8Array>();

  const addFile = (file: Omit<ManifestFile, "sha256" | "bytes">, bytes: Uint8Array) => {
    files.push({ ...file, bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
    payloads.set(file.path, bytes);
  };

  const fetchObject = async (bucket: string, path: string): Promise<Uint8Array | null> => {
    if (!ACCOUNTING_BUCKETS.has(bucket)) return null;
    const { data, error } = await db.storage.from(bucket).download(path);
    if (error || !data) return null;
    return new Uint8Array(await data.arrayBuffer());
  };

  try {
    for (const invoice of eligible) {
      const folder = directionFolder(invoice.direction);
      if (!folder) throw new HandoffFailure("unknown_direction", invoice.id);

      const dir = `${folder}/${invoiceFolderName(invoice)}`;
      const items = itemsByInvoice.get(invoice.id) ?? [];
      const parties = partiesByInvoice.get(invoice.id) ?? [];
      const breakdown = taxByInvoice.get(invoice.id) ?? [];
      let artifactCount = 0;

      // --- metadata.json: kanonické údaje dokladu, nie prerozprávanie
      const metadata = {
        invoice: {
          id: invoice.id,
          direction: invoice.direction,
          kind: invoice.kind,
          document_status: invoice.document_status,
          payment_status: invoice.payment_status,
          invoice_number: invoice.invoice_number,
          supplier_invoice_number: invoice.supplier_invoice_number,
          issue_date: invoice.issue_date,
          delivery_date: invoice.delivery_date,
          tax_point_date: invoice.tax_point_date,
          due_date: invoice.due_date,
          currency: invoice.currency,
          variable_symbol: invoice.variable_symbol,
          subtotal_amount: invoice.subtotal_amount,
          vat_total_amount: invoice.vat_total_amount,
          rounding_amount: invoice.rounding_amount,
          total_amount: invoice.total_amount,
          finalized_at: invoice.finalized_at,
        },
        parties: parties.map((p) => ({
          role: p.role, legal_name: p.legal_name, ico: p.ico, dic: p.dic, ic_dph: p.ic_dph,
          address_line1: p.address_line1, address_line2: p.address_line2, city: p.city,
          postal_code: p.postal_code, country_code: p.country_code, iban: p.iban, bic: p.bic,
        })),
        items: items.map((i) => ({
          position: i.position, description: i.description, quantity: i.quantity,
          unit: i.unit, unit_code: i.unit_code, unit_price: i.unit_price,
          price_mode: i.price_mode,
          vat_category_code: i.vat_category_code, vat_rate: i.vat_rate,
          line_net_amount: i.line_net_amount, line_vat_amount: i.line_vat_amount,
          line_gross_amount: i.line_gross_amount,
        })),
        vat_breakdown: breakdown.map((b) => ({
          vat_category_code: b.vat_category_code, vat_rate: b.vat_rate,
          taxable_amount: b.taxable_amount, vat_amount: b.vat_amount,
        })),
        disclaimer: MANIFEST_DISCLAIMER,
      };

      addFile(
        {
          path: `${dir}/metadata.json`, kind: "invoice_metadata", invoice_id: invoice.id,
          source_document_id: null, provenance: "generated", mime_type: "application/json",
          original_filename: null,
        },
        new TextEncoder().encode(JSON.stringify(metadata, null, 2))
      );
      artifactCount++;

      // --- vydaná faktúra: PDF z kanonického finalizovaného dokladu
      if (invoice.direction === "issued") {
        const seller = parties.find((p) => p.role === "seller") ?? null;
        if (!seller) throw new HandoffFailure("missing_seller_snapshot", invoice.id);

        let pdf: Buffer;
        try {
          pdf = await renderInvoicePdfBuffer({
            invoice, seller,
            buyer: parties.find((p) => p.role === "buyer") ?? null,
            items, taxBreakdowns: breakdown, locale,
          });
        } catch (renderError) {
          console.error("handoff/package: PDF zlyhalo:", invoice.id,
            renderError instanceof Error ? renderError.message : renderError);
          throw new HandoffFailure("pdf_generation_failed", invoice.id);
        }

        addFile(
          {
            path: `${dir}/invoice.pdf`, kind: "invoice_pdf", invoice_id: invoice.id,
            source_document_id: null, provenance: "generated", mime_type: "application/pdf",
            original_filename: null,
          },
          new Uint8Array(pdf)
        );
        artifactCount++;
      }

      // --- originál (kanonický) a sprievodné dokumenty
      //
      // `original.<ext>` dostane VÝHRADNE dokument z `source_document_id`.
      // Ostatné prepojené dokumenty idú do `supporting/` a nikdy sa netvária
      // ako doklad od dodávateľa.
      const originalDoc = documentById.get(originalDocIdByInvoice.get(invoice.id) ?? "");
      const supportingDocs = (supportingDocsByInvoice.get(invoice.id) ?? [])
        .map((id) => documentById.get(id))
        .filter((d): d is DocumentRow => Boolean(d));

      const packDocument = async (doc: DocumentRow, isOriginal: boolean, index: number) => {
        const bytes = await fetchObject(doc.storage_bucket, doc.storage_path);
        if (!bytes) {
          throw new HandoffFailure(
            isOriginal ? "missing_original_document" : "missing_supporting_document",
            invoice.id
          );
        }

        // Originál sa nikdy neprepisuje ani neprebaľuje. Keď Esblu pozná
        // jeho odtlačok z času nahratia, musí sedieť — inak sa bajty medzitým
        // zmenili a balík by tvrdil niečo nepravdivé.
        if (doc.content_sha256 && doc.content_sha256 !== sha256Hex(bytes)) {
          throw new HandoffFailure("original_hash_mismatch", invoice.id);
        }

        const ext = safeExtension(doc.original_filename, doc.mime_type);
        const path = isOriginal
          ? `${dir}/original.${ext}`
          : `${dir}/supporting/${safeSegment(
              (doc.original_filename ?? doc.id).replace(/\.[A-Za-z0-9]{1,8}$/, ""),
              `dokument-${index + 1}`
            )}.${ext}`;

        addFile(
          {
            path,
            kind: isOriginal ? "received_original" : "attachment",
            invoice_id: invoice.id,
            source_document_id: doc.id,
            provenance: "original",
            mime_type: doc.mime_type,
            original_filename: doc.original_filename,
          },
          bytes
        );
        artifactCount++;

        for (const att of attachmentsByDoc.get(doc.id) ?? []) {
          const attBytes = await fetchObject(att.storage_bucket, att.storage_path);
          if (!attBytes) throw new HandoffFailure("missing_attachment", invoice.id);

          const attExt = safeExtension(att.original_filename, att.mime_type);
          const attName = `${safeSegment(
            (att.original_filename ?? att.id).replace(/\.[A-Za-z0-9]{1,8}$/, ""),
            att.id.slice(0, 8)
          )}.${attExt}`;

          addFile(
            {
              path: `${dir}/attachments/${attName}`,
              kind: "attachment", invoice_id: invoice.id, source_document_id: doc.id,
              provenance: "original", mime_type: att.mime_type,
              original_filename: att.original_filename,
            },
            attBytes
          );
          artifactCount++;
        }
      };

      if (originalDoc) await packDocument(originalDoc, true, 0);
      for (const [index, doc] of supportingDocs.entries()) {
        await packDocument(doc, false, index);
      }

      manifestInvoices.push({
        invoice_id: invoice.id,
        direction: invoice.direction,
        kind: invoice.kind,
        invoice_number: invoice.invoice_number,
        supplier_invoice_number: invoice.supplier_invoice_number,
        issue_date: invoice.issue_date,
        currency: invoice.currency,
        subtotal_amount: invoice.subtotal_amount.toFixed(2),
        vat_total_amount: invoice.vat_total_amount.toFixed(2),
        total_amount: invoice.total_amount.toFixed(2),
        folder: dir,
        artifact_count: artifactCount,
      });
    }

    // --- README
    addFile(
      {
        path: "README.txt", kind: "readme", invoice_id: null, source_document_id: null,
        provenance: "generated", mime_type: "text/plain", original_filename: null,
      },
      new TextEncoder().encode(readmeText(locale, manifestInvoices.length))
    );

    // ---------------------------------------------------------------------------
    // 6. Kontrola pred zbalením
    // ---------------------------------------------------------------------------
    const problems = packageProblems(files, manifestInvoices.length);
    if (problems.length > 0) {
      console.error("handoff/package: balík neprešiel kontrolou:", JSON.stringify(problems));
      throw new HandoffFailure(problems[0].code, null);
    }

    // ---------------------------------------------------------------------------
    // 7. Manifest a ZIP
    // ---------------------------------------------------------------------------
    const manifest = buildManifest({
      exportId,
      companyId: String(companyId),
      generatedAt: generatedAt.toISOString(),
      generatedBy: user.id,
      appCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      invoices: manifestInvoices,
      files,
    });

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
    const manifestSha256 = sha256Hex(manifestBytes);

    const zip = new JSZip();
    zip.file(`${root}/manifest.json`, manifestBytes);
    for (const [path, bytes] of payloads) {
      if (!isSafeZipPath(path)) throw new HandoffFailure("unsafe_path", null);
      zip.file(`${root}/${path}`, bytes);
    }

    const zipBytes = await zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    const packageSha256 = sha256Hex(zipBytes);

    // ---------------------------------------------------------------------------
    // 8. Overenie hotového ZIP-u
    //
    // Balík sa otvorí znova a porovná s manifestom. Je to lacné a chytí to
    // presne tú triedu chýb, ktorú by nikto nečakal: súbor, ktorý sa do ZIP-u
    // nedostal, alebo bajty, ktoré sa cestou zmenili.
    // ---------------------------------------------------------------------------
    const reopened = await JSZip.loadAsync(zipBytes);
    for (const file of manifest.files) {
      const entry = reopened.file(`${root}/${file.path}`);
      if (!entry) throw new HandoffFailure("verification_missing_file", null);
      const actual = sha256Hex(await entry.async("uint8array"));
      if (actual !== file.sha256) throw new HandoffFailure("verification_hash_mismatch", null);
    }
    if (!reopened.file(`${root}/manifest.json`)) {
      throw new HandoffFailure("verification_missing_manifest", null);
    }

    // ---------------------------------------------------------------------------
    // 9. Záznam. Až keď balík existuje a je overený.
    // ---------------------------------------------------------------------------
    const { error: exportError } = await db.from("accounting_handoff_exports").insert({
      id: exportId,
      company_id: companyId,
      created_by: user.id,
      export_kind: "complete_package",
      status: "completed",
      invoice_count: manifestInvoices.length,
      file_count: manifest.file_count,
      manifest_sha256: manifestSha256,
      package_sha256: packageSha256,
      package_filename: fileName,
      package_bytes: zipBytes.byteLength,
      manifest_schema_version: MANIFEST_SCHEMA_VERSION,
      completed_at: new Date().toISOString(),
      app_commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      note,
    });

    if (exportError) {
      console.error("handoff/package: zápis záznamu zlyhal:", exportError.code, exportError.message);
      return errorResponse(locale, 500, "RECORD_FAILED");
    }

    const { error: itemsError } = await db.from("accounting_handoff_export_items").insert(
      eligible.map((invoice) => {
        const mi = manifestInvoices.find((m) => m.invoice_id === invoice.id);
        return {
          export_id: exportId,
          invoice_id: invoice.id,
          company_id: companyId,
          invoice_number_snapshot: invoice.invoice_number,
          supplier_invoice_number_snapshot: invoice.supplier_invoice_number,
          direction_snapshot: invoice.direction,
          issue_date_snapshot: invoice.issue_date,
          total_amount_snapshot: invoice.total_amount,
          currency_snapshot: invoice.currency,
          artifact_count: mi?.artifact_count ?? null,
        };
      })
    );

    if (itemsError) {
      console.error("handoff/package: zápis položiek zlyhal:", itemsError.code, itemsError.message);
      return errorResponse(locale, 500, "RECORD_FAILED");
    }

    return new Response(new Uint8Array(zipBytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": String(zipBytes.byteLength),
        "X-Esblu-Export-Id": exportId,
        "X-Esblu-Package-Sha256": packageSha256,
        "X-Esblu-Manifest-Sha256": manifestSha256,
        "X-Esblu-File-Count": String(manifest.file_count),
        "X-Esblu-Invoice-Count": String(eligible.length),
        // Koľko konceptov sa vynechalo. UI to povie nahlas — vynechanie,
        // o ktorom sa mlčí, je to isté ako strata.
        "X-Esblu-Excluded-Drafts": String(excludedDrafts.length),
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    const reason =
      error instanceof HandoffFailure ? error.reason : "unexpected_error";
    const invoiceId = error instanceof HandoffFailure ? error.invoiceId : null;

    console.error("handoff/package: balík sa nedokončil:", reason, invoiceId ?? "");

    // Neúspešný pokus je súčasťou histórie. Zapisuje sa BEZ odtlačkov a so
    // stavom `failed` — databázový CHECK sám nepustí `complete_package` +
    // `completed` bez odtlačku, veľkosti a času dokončenia.
    await db.from("accounting_handoff_exports").insert({
      id: exportId,
      company_id: companyId,
      created_by: user.id,
      export_kind: "complete_package",
      status: "failed",
      invoice_count: eligible.length,
      manifest_sha256: "0".repeat(64),
      failure_reason: invoiceId ? `${reason}:${invoiceId}` : reason,
      note,
    });

    return failed(handoffErrorCode(reason));
  }
}

/** Dôvod, pre ktorý balík nevznikol. Nesie sa až k používateľovi. */
class HandoffFailure extends Error {
  constructor(
    readonly reason: string,
    readonly invoiceId: string | null
  ) {
    super(reason);
    this.name = "HandoffFailure";
  }
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    map.set(k, [...(map.get(k) ?? []), row]);
  }
  return map;
}

function readmeText(locale: Locale, invoiceCount: number): string {
  return [
    translate(locale, "handoff.package.readmeTitle"),
    "",
    translate(locale, "handoff.package.readmeIntro", { count: invoiceCount }),
    "",
    translate(locale, "handoff.package.readmeStructure"),
    "",
    translate(locale, "handoff.package.readmeIntegrity"),
    "",
    translate(locale, "handoff.package.readmeDisclaimer"),
    "",
  ].join("\n");
}
