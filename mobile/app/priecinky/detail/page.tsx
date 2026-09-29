"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import FolderDetailView from "@/app/priecinky/FolderDetailView";

// Mobile M1 (2026-09-28): statická routa /priecinky/detail?id=…
// (web: app/priecinky/[id]/page.tsx). Zdieľaný FolderDetailView.
function FolderDetailMobileRoute() {
  const id = useSearchParams().get("id") ?? "";
  return <FolderDetailView folderId={id} />;
}

export default function FolderDetailMobilePage() {
  return (
    <Suspense fallback={null}>
      <FolderDetailMobileRoute />
    </Suspense>
  );
}
