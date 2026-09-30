import type { CapacitorConfig } from "@capacitor/cli";

// -----------------------------------------------------------------------------
// capacitor.config.ts — úmyselne v mobile/, NIE v koreni repozitára.
//
// PREČO mobile/, nie root:
// - mobile/ je už zavedený ako samostatný, self-contained mobile subprojekt
//   (vlastný package.json, next.config.ts, build output `out/`) — Capacitor
//   config + natívny `android/` projekt patria do rovnakej hranice, aby
//   koreňový (webový/Vercel) projekt zostal 100% bez natívnych mobile
//   artefaktov.
// - `npx cap` príkazy hľadajú capacitor.config.ts v CWD — umiestnením configu
//   tu sa všetky `cap` príkazy prirodzene spúšťajú z `mobile/` (rovnaké
//   miesto, odkiaľ sa spúšťa aj `npm run build --workspace mobile`), takže
//   `webDir: "out"` je jednoduchá relatívna cesta (mobile/out), netreba
//   žiadnu krížovú "../mobile/out" cestu z rootu.
// - Výsledný `android/` adresár vznikne ako `mobile/android/` — presne
//   zodpovedá štandardnej (nie monorepo) štruktúre Capacitor projektu, takže
//   je to najmenej prekvapivé usporiadanie pre kohokoľvek, kto bude neskôr
//   pracovať s Capacitor dokumentáciou/tooling.
//
// ŽIADNY server.url / server.allowNavigation — vynechaním celého `server`
// bloku Capacitor defaultne načíta LOKÁLNE zabalené assets z `webDir`
// (žiadny remote wrapper, presne podľa FÁZA 1 zadania).
// -----------------------------------------------------------------------------
//
// PUSH (2026-10-01): @capacitor/push-notifications (oficiálny Capacitor plugin,
// v8 — kompatibilný s Capacitor 8). presentationOptions platí pre iOS, keď je
// appka v popredí (Android v popredí notifikáciu nezobrazí — obsah ukáže
// samotná appka). Firebase/APNs konfigurácia NIE JE v repozitári:
// google-services.json (Android) a Push capability (iOS) pridáva vlastník
// projektu — pozri docs/push-notifications-setup.md.
const config: CapacitorConfig = {
  appId: "com.esblu.app",
  appName: "Esblu",
  webDir: "out",
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
