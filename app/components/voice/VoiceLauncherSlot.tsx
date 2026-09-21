"use client";

import { VoiceLauncher } from "@/app/components/voice/VoiceLauncher";

// =============================================================================
// Tenký obal okolo VoiceLauncher.
//
// DocumentPageShell je zdieľaná schránka, ktorú používa každá hlavná
// obrazovka. Keby importovala launcher priamo, pritiahla by si doň aj
// Supabase klienta a hook mikrofónu — a tým pádom do KAŽDEJ stránky, aj
// keby launcher nebol vidieť. Tento obal je jediné miesto, kde sa dá
// launcher v budúcnosti podmieniť (napr. vypnúť na konkrétnej obrazovke)
// bez zásahu do schránky.
// =============================================================================

export function VoiceLauncherSlot() {
  return <VoiceLauncher />;
}
