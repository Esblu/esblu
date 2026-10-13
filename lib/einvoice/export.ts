import { generateUbl, type UblGenerationResult } from "./ubl/generate.ts";
import type { UblInvoiceSnapshot } from "./ubl/model.ts";

// =============================================================================
// Export XML (UBL) vydanej faktúry — nezávislé od poskytovateľa.
//
// Zákazník si XML aj PDF exportuje a archivuje vo vlastnej réžii. Esblu
// neposkytuje zákonnú dlhodobú archiváciu — tento export je prevádzková kópia.
// Funkcia je pripravená aj na neskoršie zaradenie XML do účtovníckeho ZIP
// exportu (vracia bajty + SHA-256 pre manifest).
// =============================================================================

export type UblExportFile = {
  fileName: string;
  contentType: "application/xml";
  bytes: Uint8Array;
  sha256: string;
};

export function ublExportFileName(invoiceNumber: string | null, invoiceId: string): string {
  const base = (invoiceNumber ?? invoiceId).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "") || invoiceId;
  return `${base}.xml`;
}

export function buildIssuedInvoiceUblExport(
  snapshot: UblInvoiceSnapshot
): { ok: true; file: UblExportFile; warnings: Extract<UblGenerationResult, { ok: true }>["warnings"] } | Extract<UblGenerationResult, { ok: false }> {
  const result = generateUbl(snapshot);
  if (!result.ok) return result;
  return {
    ok: true,
    warnings: result.warnings,
    file: {
      fileName: ublExportFileName(snapshot.invoice.invoice_number, snapshot.invoice.id),
      contentType: "application/xml",
      bytes: result.bytes,
      sha256: result.sha256,
    },
  };
}
