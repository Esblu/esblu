import "server-only";

import { handleReceptionEnroll } from "@/lib/einvoice/ui/reception-routes";

// POST /api/einvoice/reception/enroll — aktivácia príjmu FS overovacím kódom.
// Telo presne { verification_code, confirm_enroll: true }; finance.manage + nárok + rollout.
// Kód sa neukladá, nevracia ani neloguje.

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(req: Request) {
  return handleReceptionEnroll(req);
}
