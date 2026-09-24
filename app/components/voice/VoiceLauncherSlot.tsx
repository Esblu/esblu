"use client";

import { VoiceLauncher, type VoiceModuleContext, type VoiceSelection } from "@/app/components/voice/VoiceLauncher";
import type { UiContext } from "@/lib/intents/ui-context";

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

export function VoiceLauncherSlot({
  uiContext,
  selection,
  folderContextId,
  moduleContext,
}: {
  uiContext?: UiContext | null;
  selection?: VoiceSelection | null;
  folderContextId?: string | null;
  moduleContext?: VoiceModuleContext | null;
}) {
  return (
    <VoiceLauncher
      uiContext={uiContext ?? null}
      selection={selection ?? null}
      folderContextId={folderContextId ?? null}
      moduleContext={moduleContext ?? null}
    />
  );
}
