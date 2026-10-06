// =============================================================================
// Oficiálne referenčné kurzy ECB — parser a import (bez sieťového volania pri zobrazení faktúry).
//
// Zdroj: ECB „Euro foreign exchange reference rates“ — súbory eurofxref (gesmes XML):
//   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml  (posledných ~90 dní)
//   https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml      (posledný deň)
// ECB: kurzy sa aktualizujú okolo 16:00 SEČ každý pracovný deň okrem dní zatvorenia TARGET.
// Súbor obsahuje KAŽDÝ deň, keď ECB kurzy vyhlásila; deň, ktorý v súbore chýba, nebol dňom vyhlásenia.
//
// Pokrytie (coverage): od prvého dňa v súbore do dňa pred dňom stiahnutia (Europe/Bratislava); deň stiahnutia
// sa počíta iba vtedy, ak ho súbor už obsahuje (kurz bol vyhlásený). Inak sa nepovažuje za úplný — konzervatívne.
// =============================================================================

import { createHash } from "node:crypto";

export const ECB_HIST_90D_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml";

export type EcbRateRow = { currency: string; rate_date: string; rate: string };
export type EcbParsed = { rows: EcbRateRow[]; dates: string[] };

const RATE = /^\d{1,12}(\.\d{1,6})?$/;

/** Prísny parser gesmes/eurofxref XML. Neznáma štruktúra → výnimka (nič sa neimportuje). */
export function parseEcbEurofxrefXml(xml: string): EcbParsed {
  if (!/<gesmes:Envelope[\s>]/.test(xml) || !/European Central Bank/.test(xml)) {
    throw new Error("ECB_XML_UNEXPECTED_FORMAT");
  }
  const rows: EcbRateRow[] = [];
  const dates: string[] = [];
  const starts = [...xml.matchAll(/<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>/g)];
  starts.forEach((m, k) => {
    const date = m[1];
    if (dates.includes(date)) throw new Error("ECB_XML_DUPLICATE_DATE");
    dates.push(date);
    const body = xml.slice(m.index! + m[0].length, k + 1 < starts.length ? starts[k + 1].index : xml.length);
    let n = 0;
    for (const r of body.matchAll(/<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([^"']+)["']\s*\/>/g)) {
      if (!RATE.test(r[2])) throw new Error("ECB_XML_BAD_RATE");
      rows.push({ currency: r[1], rate_date: date, rate: r[2] });
      n++;
    }
    if (n === 0) throw new Error("ECB_XML_EMPTY_DAY");
  });
  if (dates.length === 0) throw new Error("ECB_XML_NO_DATA");
  return { rows, dates: dates.sort() };
}

/** Kalendárny dátum v Europe/Bratislava (pre určenie, ktorý deň je už „uzavretý“). */
export function bratislavaDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bratislava", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return parts; // en-CA → YYYY-MM-DD
}

function minusOneDay(iso: string): string {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d - 1)).toISOString().slice(0, 10);
}

export type EcbImportBatch = {
  source_url: string;
  document_sha256: string;
  coverage_from: string;
  coverage_to: string;
  rows: EcbRateRow[];
};

/** Pripraví dávku na import: pokrytie = prvý deň v súbore … deň pred stiahnutím (min. posledný deň v súbore). */
export function buildEcbImportBatch(xml: string, sourceUrl: string, fetchedAt: Date): EcbImportBatch {
  if (!sourceUrl.startsWith("https://www.ecb.europa.eu/")) throw new Error("ECB_SOURCE_URL_NOT_OFFICIAL");
  const parsed = parseEcbEurofxrefXml(xml);
  const first = parsed.dates[0];
  const last = parsed.dates[parsed.dates.length - 1];
  const today = bratislavaDate(fetchedAt);
  if (last > today) throw new Error("ECB_XML_FROM_FUTURE");
  // Deň stiahnutia je úplný iba vtedy, ak v ňom súbor už kurz obsahuje; inak pokrytie končí predchádzajúcim dňom.
  const closed = minusOneDay(today);
  return {
    source_url: sourceUrl,
    document_sha256: createHash("sha256").update(xml, "utf8").digest("hex"),
    coverage_from: first,
    coverage_to: last > closed ? last : closed,
    rows: parsed.rows,
  };
}

export type RpcCaller = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

/** Import cez service_role RPC (append-only; rozpor s uloženými dátami = chyba, nič sa neprepíše). */
export async function importEcbBatch(rpc: RpcCaller, batch: EcbImportBatch): Promise<Record<string, unknown>> {
  const { data, error } = await rpc("esblu_fx_import_ecb_batch", {
    p_source_url: batch.source_url,
    p_document_sha256: batch.document_sha256,
    p_coverage_from: batch.coverage_from,
    p_coverage_to: batch.coverage_to,
    p_rows: batch.rows,
  });
  if (error) throw new Error(error.message || "ESBLU_FX_IMPORT_FAILED");
  return (data ?? {}) as Record<string, unknown>;
}
