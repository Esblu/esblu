import { companyLookupHandlers } from "@/lib/company-lookup/server";

// -----------------------------------------------------------------------------
// POST /api/company-lookup/search   body: { "q": "<názov alebo IČO>" }
//
// Dopyt je v JSON tele, nikdy v URL (minimalizácia osobných údajov v
// proxy/Vercel logoch). Číselný vstup (6–8 číslic) = IČO, inak názov
// (min. 3 znaky). Max 10 návrhov z Registra právnických osôb ŠÚ SR. Iba pre
// používateľa s finance.manage (rovnaké oprávnenie ako zápis obchodného
// partnera). Text dopytu sa nikde neloguje ani neukladá. GET nie je
// exportovaný → Next.js vráti 405.
// -----------------------------------------------------------------------------

export async function POST(req: Request) {
  return companyLookupHandlers.search(req);
}
