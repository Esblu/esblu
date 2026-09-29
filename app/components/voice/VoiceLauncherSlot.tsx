"use client";

import { VoiceLauncher, type VoiceModuleContext, type VoiceSelection } from "@/app/components/voice/VoiceLauncher";
import type { UiContext } from "@/lib/intents/ui-context";
import { useActiveMembership } from "@/hooks/use-active-membership";
import { IS_MOBILE_BUILD } from "@/lib/build-target";
import { assistantLauncherAllowed } from "@/lib/mobile-nav";

// =============================================================================
// Tenký obal okolo VoiceLauncher.
//
// DocumentPageShell je zdieľaná schránka, ktorú používa každá hlavná
// obrazovka. Keby importovala launcher priamo, pritiahla by si doň aj
// Supabase klienta a hook mikrofónu — a tým pádom do KAŽDEJ stránky, aj
// keby launcher nebol vidieť. Tento obal je jediné miesto, kde sa dá
// launcher podmieniť bez zásahu do schránky.
//
// Mobile M1 (2026-09-28):
//   - zamestnanec nemá všeobecného asistenta (server ho odmietne) — vstup sa
//     mu zobrazí IBA v Inboxe, kde platí úzky príjem finančných dokladov,
//   - kým sa nevie rola, nič sa nevykreslí (žiadne preblikanie tlačidla),
//   - v mobilnom builde je zatvorený launcher kompaktné ikonové tlačidlo
//     v pravom hornom rohu obrazovky (na úrovni tlačidla Späť) namiesto
//     samostatného riadku — jediný vstup do asistenta na obrazovkách
//     modulov; hlas ostáva platený doplnok (VoiceSessionControl).
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
  const { loading, membership } = useActiveMembership();
  if (loading || !membership) return null;
  // AI asistent ≠ human chat (lib/mobile-nav.ts): zamestnanec iba v Inboxe.
  if (!assistantLauncherAllowed(membership.role, moduleContext ?? null)) return null;

  return (
    <VoiceLauncher
      uiContext={uiContext ?? null}
      selection={selection ?? null}
      folderContextId={folderContextId ?? null}
      moduleContext={moduleContext ?? null}
      compact={IS_MOBILE_BUILD}
      closedClassName={IS_MOBILE_BUILD ? "absolute right-4 top-4 z-20 sm:right-6" : undefined}
      openClassName={IS_MOBILE_BUILD ? "mb-4" : undefined}
    />
  );
}

/** Obal riadku launchera: na webe riadok vpravo, v appke bez vlastnej výšky. */
export const VOICE_SLOT_ROW_CLASS = IS_MOBILE_BUILD ? "" : "mb-4 flex justify-end";
