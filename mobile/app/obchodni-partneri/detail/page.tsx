"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { PartnerDetailView } from "@/app/obchodni-partneri/PartnerDetailView";

// Mobile M1 (2026-09-28): statická routa /obchodni-partneri/detail?id=…
// (web: app/obchodni-partneri/[id]/page.tsx). Zdieľaný PartnerDetailView.
function PartnerDetailMobileRoute() {
  const id = useSearchParams().get("id") ?? "";
  return <PartnerDetailView partnerId={id} />;
}

export default function PartnerDetailMobilePage() {
  return (
    <Suspense fallback={null}>
      <PartnerDetailMobileRoute />
    </Suspense>
  );
}
