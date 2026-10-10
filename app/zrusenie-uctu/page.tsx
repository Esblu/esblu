import type { Metadata } from "next";
import { AccountDeletionPageClient } from "./AccountDeletionPageClient";

export const metadata: Metadata = {
  title: "Zrušenie účtu | Esblu",
  description: "Ako zrušiť účet Esblu a požiadať o vymazanie údajov.",
};

// Verejná stránka (bez prihlásenia) pre Google Play „Delete account URL".
export default function AccountDeletionPage() {
  return <AccountDeletionPageClient />;
}
