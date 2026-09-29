"use client";

import { useParams } from "next/navigation";
import { PartnerDetailView } from "@/app/obchodni-partneri/PartnerDetailView";

// Tenký WEB route wrapper (/obchodni-partneri/[id]). Celá stránka je v
// PartnerDetailView (zdieľaná s mobilným ?id= wrapperom, Mobile M1).
export default function ObchodnyPartnerDetailPage() {
  const { id } = useParams();
  return <PartnerDetailView partnerId={String(id)} />;
}
