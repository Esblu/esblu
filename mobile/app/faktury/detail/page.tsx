"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import InvoiceDetailView from "@/app/faktury/InvoiceDetailView";

// Mobile M1 (2026-09-28): statická routa /faktury/detail?id=… (web:
// app/faktury/[id]/page.tsx s useParams). Celá stránka je zdieľaná
// InvoiceDetailView; oprávnenia rieši RLS + finance checky v komponente.
function InvoiceDetailMobileRoute() {
  const id = useSearchParams().get("id") ?? "";
  return <InvoiceDetailView entityId={id} />;
}

export default function InvoiceDetailMobilePage() {
  return (
    <Suspense fallback={null}>
      <InvoiceDetailMobileRoute />
    </Suspense>
  );
}
