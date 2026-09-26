import type { Metadata } from "next";
import { PricingPageClient } from "./PricingPageClient";

export const metadata: Metadata = {
  title: "Cenník | Esblu",
  description:
    "14 dní zadarmo, potom iba moduly, ktoré vaša firma používa: Fakturácia, AI evidencia, Vozidlá, Stroje, Sklad a Hlasové ovládanie.",
};

export default function PricingPage() {
  return <PricingPageClient />;
}
