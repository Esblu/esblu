import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// Esblu — user-scoped Supabase klient pre NOVÉ server-side AI routes
// (Intent Engine — app/api/assistant/intent/route.ts).
// =============================================================================
// DÔLEŽITÝ ROZDIEL oproti lib/supabase-admin.ts (service_role):
//
//   getSupabaseAdmin() (existujúce, napr. app/api/account/*)
//     → beží ako service_role, obchádza RLS, company_id/permission scoping
//       si MUSÍ dopočítať a vynútiť RUČNE volajúci kód (viď komentár v
//       app/api/account/preflight/route.ts — explicitne zdokumentovaný
//       výnimočný vzor, nie niečo, čo sa má kopírovať ďalej).
//
//   getUserScopedSupabaseClient(accessToken) (tento modul)
//     → beží AKO PRIHLÁSENÝ POUŽÍVATEĽ (anon key + jeho vlastný Bearer JWT
//       v Authorization hlavičke), takže `auth.uid()` v Postgrese sa
//       vyhodnotí korektne a VŠETKY existujúce RLS politiky
//       (company_id = esblu_my_active_company_id(), viď 20260814160000)
//       platia úplne rovnako, ako keby dopyt poslal priamo prehliadač.
//
// Zadanie (bod 12): "Preferuj user-scoped Supabase/RLS... Nikdy: service_role
// → načítaj všetko → AI rozhodne čo používateľ smie vidieť." Intent Engine
// preto pre VŠETKY read-only handlery (lib/intents/handlers.ts) používa
// výhradne TENTO klient — nikdy getSupabaseAdmin(). RLS teda ostáva
// posledná autorita, presne ako pri bežnom prihlásení cez prehliadač;
// server-side kód sa iba stará o to, aby si klient "obliekol" identitu
// aktuálneho požadovateľa (a nič viac).
// =============================================================================

export function getUserScopedSupabaseClient(accessToken: string): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    }
  );
}
