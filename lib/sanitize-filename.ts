// -----------------------------------------------------------------------------
// Čistá, závislosťami nezaťažená funkcia vyňatá z lib/file-actions.ts (pozri
// tam pre pôvodný kontext/komentáre) — FÁZA 3A (PDF faktúry) ju potrebuje
// importovať priamo zo server-side API route (app/api/invoices/[id]/pdf/
// route.ts). lib/file-actions.ts ako celok obsahuje dynamické `import(
// "@capacitor/...")` volania, ktoré Next.js server bundler (na rozdiel od
// klientskeho, kde IS_MOBILE_BUILD dead-code-elimination beží pred
// bundlovaním) skúša staticky vyriešiť pre KAŽDÝ modul, ktorý ten súbor
// importuje — čo by v Node.js API route builde zlyhalo (@capacitor/* balíky
// existujú iba v mobile/package.json, nie v koreňovom). Táto funkcia sama o
// sebe nemá žiadne importy, takže je bezpečná importovať z oboch strán.
// lib/file-actions.ts ju nižšie re-exportuje, takže existujúci klientský
// kód (`import { sanitizeFileName } from "@/lib/file-actions"`) sa nemení.
// -----------------------------------------------------------------------------

/**
 * Sanitizuje meno súboru pred použitím ako Filesystem cesta (mobile) alebo
 * `<a download>` atribút (web) alebo Content-Disposition filename (server).
 * Odstraňuje path separátory a ".." sekvencie (path traversal), riadiace
 * znaky, a obmedzuje dĺžku. Nikdy nevráti prázdny reťazec.
 */
export function sanitizeFileName(rawName: string): string {
  const fallback = "subor";

  if (!rawName || typeof rawName !== "string") {
    return fallback;
  }

  const withoutSeparators = rawName
    .replace(/[\\/]+/g, "_")
    .replace(/\.\.+/g, ".");

  const withoutControlChars = withoutSeparators.replace(/[\x00-\x1f\x7f]/g, "");

  const trimmed = withoutControlChars.trim().slice(0, 180);

  return trimmed || fallback;
}
