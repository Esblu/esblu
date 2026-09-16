"use client";

import { useParams } from "next/navigation";
import InvoiceDetailView from "@/app/faktury/InvoiceDetailView";

// -----------------------------------------------------------------------------
// Tenký WEB route wrapper (App Router dynamická routa /faktury/[id]).
// Business logika, Supabase queries a JSX žijú v
// @/app/faktury/InvoiceDetailView.tsx (zdieľané s prípadným mobile buildom,
// pozri lib/entity-links.ts invoiceDetailHref() a rovnaký vzor v
// app/vozidla/[id]/page.tsx). Tento súbor volá VÝHRADNE useParams() — presne
// jeden hook, unconditionally — a odovzdáva výsledok ako obyčajný `entityId`
// prop.
// -----------------------------------------------------------------------------
export default function InvoiceDetailPage() {
  const { id } = useParams();
  return <InvoiceDetailView entityId={String(id)} />;
}
