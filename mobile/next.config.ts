import type { NextConfig } from "next";
import path from "path";

// -----------------------------------------------------------------------------
// KONFIG PRE MOBILE (Capacitor) STATIC BUILD — samostatný Next.js projekt v
// mobile/, ktorý ZDIEĽA lib/, app/components a väčšinu app/ routes z
// koreňového projektu (pozri mobile/app/**/page.tsx — tenké re-export/wrapper
// súbory). Koreňový next.config.ts (web/Vercel) zostáva úplne nedotknutý.
//
// output: "export" → `next build` vyprodukuje statický `out/` adresár bez
// potreby Node servera — presne to, čo Capacitor `webDir` potrebuje (žiadny
// server.url, žiadny remote wrapper, pozri FÁZA 1 zadanie).
//
// images.unoptimized → next/image bez Next Image Optimization API (to
// vyžaduje bežiaci server, čo pri static exporte nie je k dispozícii).
//
// outputFileTracingRoot → ukazuje na koreň repozitára (o úroveň vyššie), lebo
// tento build importuje súbory FYZICKY mimo mobile/ (napr. @/lib/supabase,
// @/app/vozidla/VehicleDetailView) — bez tohto Next.js pri output file
// tracingu nesprávne odhaduje monorepo root a môže vypisovať varovania.
// -----------------------------------------------------------------------------
const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  outputFileTracingRoot: path.join(__dirname, ".."),
  env: {
    // Build-time konštanta, ktorú číta lib/build-target.ts. Web build ju
    // vôbec nenastavuje (zostáva undefined → IS_MOBILE_BUILD === false).
    NEXT_PUBLIC_ESBLU_MOBILE: "1",
    // Mobile M1 (2026-09-28): identifikátor buildu (UTC čas buildu). Appka ho
    // ukazuje v paneli „Viac" a na <html data-esblu-build>, aby sa na
    // zariadení dalo jednoznačne overiť, ktorý bundle práve beží
    // (scripts/verify-mobile-bundle.mjs vypíše ten istý identifikátor).
    NEXT_PUBLIC_ESBLU_BUILD_ID: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    // ESBLU_LEGAL_CONTENT_ROOT ZÁMERNE NIE JE v `env` (Mobile Platform
    // 2026-10-08): `env` hodnoty Next.js vkladá do bundlu, absolútna cesta
    // build stroja by unikla do appky. lib/legal-content.ts nájde ../legal sám.
  },
};

export default nextConfig;
