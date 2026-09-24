"use client";

import { useParams } from "next/navigation";
import FolderDetailView from "@/app/priecinky/FolderDetailView";

// Tenký route wrapper — rovnaký vzor ako app/faktury/[id]/page.tsx.
export default function FolderDetailPage() {
  const { id } = useParams();
  return <FolderDetailView folderId={String(id)} />;
}
