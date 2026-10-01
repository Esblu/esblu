import { companyLookupHandlers } from "@/lib/company-lookup/server";

// -----------------------------------------------------------------------------
// POST /api/company-lookup/detail   body: { "ico": "<IČO>" }
//
// IČO je v JSON tele, nikdy v URL (IČO živnostníka je osobný údaj).
// RPO detail (názov, sídlo, právna forma, stav) + RÚZ doplnenie DIČ.
// Čiastočný úspech je povolený: bez RÚZ je DIČ null a odpoveď nesie
// varovanie. Iba pre používateľa s finance.manage. GET nie je exportovaný.
// -----------------------------------------------------------------------------

export async function POST(req: Request) {
  return companyLookupHandlers.detail(req);
}
