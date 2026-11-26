// =============================================================================
// Testovací „hosted checkout" FAKE providera — dostupný IBA v režime
// ESBLU_BILLING_MODE=fake (staging / Preview). Inak 404:
//   - produkcia (VERCEL_ENV=production) → getBillingServerMode nikdy nevráti "fake",
//   - Preview / lokálne bez fake režimu → off → 404.
// Rozhodnutie je na serveri pri každej požiadavke (nie statický prerender), takže
// stránka sa do produkčného buildu nedostane ako dostupná trasa.
// =============================================================================

import { notFound } from "next/navigation";
import { getBillingServerMode } from "@/lib/billing/config";
import { FakeCheckoutClient } from "./FakeCheckoutClient";

export const dynamic = "force-dynamic";

export default function FakeCheckoutPage() {
  if (getBillingServerMode() !== "fake") notFound();
  return <FakeCheckoutClient />;
}
